// Stored results of code parts (see document/code-part.ts), one JSON file
// per key under <storage>/code-results. The server never runs a code
// part's code: results arrive from editors, are checked, stored, and read
// back for drawings, exports and the phone viewer.
//
// Uploads are untrusted. Their structure is checked here; their geometry
// is parsed in a worker thread with a memory limit and a time limit, which
// is ended and replaced when a check takes too long or the worker dies.
import type { Worker } from "node:worker_threads";
import { startWorker } from "./worker-threads.js";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  codeInstances,
  isResultKey,
  readCodeResult,
  type CodeResult,
} from "./document/code-part.js";
import type { CadDocument } from "./document/schema.js";
import { CodeResults } from "./kernel/code-parts.js";

export class RejectedResult extends Error {
  constructor(
    message: string,
    /** The HTTP status that says why. */
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface ResultCheckOptions {
  /** How long one upload's geometry may take to check. */
  readonly timeoutMs?: number;
  /** The checking worker's heap limit. */
  readonly memoryMb?: number;
}

/** Parses results' BREP in a worker, one check at a time. */
export class ResultChecker {
  private worker: Worker | undefined;
  private next = 1;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: ResultCheckOptions = {}) {}

  private start(): Worker {
    const worker = startWorker(import.meta.url, "code-result-check", {
      maxOldGenerationSizeMb: this.options.memoryMb ?? 1024,
    });
    worker.unref();
    return worker;
  }

  /** Resolves when the geometry reads as solids; rejects with the reason
   * otherwise. */
  check(result: CodeResult): Promise<void> {
    const run = async () => {
      const worker = (this.worker ??= this.start());
      const id = this.next++;
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new RejectedResult("Checking the geometry took too long"));
          }, this.options.timeoutMs ?? 30_000);
          const done = () => {
            clearTimeout(timer);
            worker.off("message", onMessage);
            worker.off("error", onError);
            worker.off("exit", onExit);
          };
          const onMessage = (message: {
            id: number;
            ok: boolean;
            error?: string;
          }) => {
            if (message.id !== id) return;
            done();
            if (message.ok) resolve();
            else
              reject(
                new RejectedResult(
                  `The geometry does not read: ${message.error}`,
                ),
              );
          };
          const onError = (error: Error) => {
            done();
            reject(
              new RejectedResult(
                `Checking the geometry failed: ${error.message}`,
              ),
            );
          };
          const onExit = () => {
            done();
            reject(new RejectedResult("Checking the geometry failed"));
          };
          worker.on("message", onMessage);
          worker.on("error", onError);
          worker.on("exit", onExit);
          worker.postMessage({
            id,
            bodies: result.bodies.map(({ name, brep }) => ({ name, brep })),
          });
        });
      } catch (error) {
        // A worker that timed out or crashed is not used again.
        if (this.worker === worker) this.worker = undefined;
        void worker.terminate();
        throw error;
      }
    };
    const checked = this.queue.then(run, run);
    this.queue = checked.catch(() => {});
    return checked;
  }

  async close(): Promise<void> {
    await this.worker?.terminate();
    this.worker = undefined;
  }
}

export interface CodeResultStore {
  get(key: string): Promise<CodeResult | undefined>;
  has(key: string): Promise<boolean>;
  /** Checks and stores an upload; `replace` overwrites an existing one. */
  put(value: unknown, options?: { replace?: boolean }): Promise<CodeResult>;
  /** The results a document's code parts need, loaded (callers dispose
   * it); those not stored yet are left out, and the evaluator reports
   * them as needing regeneration. */
  load(document: CadDocument): Promise<CodeResults>;
  /** The same, as stored (for a kernel job to load itself). */
  results(document: CadDocument): Promise<CodeResult[]>;
  /** Bytes stored. */
  size(): Promise<number>;
  close(): Promise<void>;
}

export function openCodeResults(
  directory: string,
  options: ResultCheckOptions & {
    /** Most bytes this store keeps; uploads past it are refused. */
    readonly quotaBytes?: number;
  } = {},
): CodeResultStore {
  const checker = new ResultChecker(options);
  const file = (key: string) => {
    if (!isResultKey(key)) throw new RejectedResult("Not a result key");
    return join(directory, `${key}.json`);
  };
  const store: CodeResultStore = {
    async get(key) {
      try {
        return readCodeResult(JSON.parse(await readFile(file(key), "utf8")));
      } catch (error) {
        if (error instanceof RejectedResult) throw error;
        return undefined;
      }
    },
    async has(key) {
      return stat(file(key)).then(
        () => true,
        () => false,
      );
    },
    async put(value, { replace = false } = {}) {
      let result: CodeResult;
      try {
        result = readCodeResult(value);
      } catch (error) {
        throw new RejectedResult(
          error instanceof Error ? error.message : String(error),
        );
      }
      // Content-addressed: the same key is the same code and values.
      if (!replace && (await store.has(result.key))) return result;
      const text = JSON.stringify(result);
      if (
        options.quotaBytes !== undefined &&
        (await store.size()) + text.length > options.quotaBytes
      )
        throw new RejectedResult(
          `Stored code-part results may take at most ${Math.round(options.quotaBytes / 1024 / 1024)} MB; delete projects or code parts to make room`,
          413,
        );
      await checker.check(result);
      await mkdir(directory, { recursive: true });
      const target = file(result.key);
      const staging = `${target}.${process.pid}.${Date.now()}.part`;
      await writeFile(staging, text);
      await rename(staging, target);
      return result;
    },
    async load(document) {
      const loaded = new CodeResults(Number.POSITIVE_INFINITY);
      try {
        for (const need of codeInstances(document)) {
          if (!need.key || loaded.has(need.key)) continue;
          const result = await store.get(need.key);
          if (result) loaded.add(result);
        }
        return loaded;
      } catch (error) {
        loaded.dispose();
        throw error;
      }
    },
    async results(document) {
      const found: CodeResult[] = [];
      for (const need of codeInstances(document)) {
        if (!need.key || found.some((r) => r.key === need.key)) continue;
        const result = await store.get(need.key);
        if (result) found.push(result);
      }
      return found;
    },
    async size() {
      let total = 0;
      for (const name of await readdir(directory).catch(() => [] as string[]))
        if (name.endsWith(".json"))
          total += await stat(join(directory, name)).then(
            (s) => s.size,
            () => 0,
          );
      return total;
    },
    close: () => checker.close(),
  };
  return store;
}
