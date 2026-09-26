// Kernel jobs (exports and the phone viewer's files) run each in a worker
// thread of its own: a JavaScript heap limit, a watchdog on everything the
// worker holds (OpenCascade's WebAssembly memory included), and a time
// limit. A job past either is ended and reported; the server carries on.
import type { CadDocument } from "./document/schema.js";
import type { CodeResult } from "./document/code-part.js";
import {
  NeedsRegeneration,
  OutputError,
  type OutputFile,
  type OutputRequest,
} from "./kernel/outputs.js";
import type { ViewerBundle } from "./kernel/viewer.js";
import type { KernelJob } from "./kernel-job-worker.js";
import { startWorker } from "./worker-threads.js";

export interface KernelJobLimits {
  readonly timeoutMs: number;
  /** All the worker holds: its heap and outside memory (WASM). */
  readonly memoryMb: number;
}

export const defaultJobLimits: KernelJobLimits = {
  timeoutMs: Number(process.env.CODECAD_JOB_TIMEOUT_MS ?? 120_000),
  memoryMb: Number(process.env.CODECAD_JOB_MEMORY_MB ?? 2048),
};

export class JobLimitExceeded extends Error {}

function run<T>(
  job: KernelJob,
  limits: KernelJobLimits,
  progress?: (fraction: number, message: string) => void,
): Promise<T> {
  const worker = startWorker(
    import.meta.url,
    "kernel-job-worker",
    { maxOldGenerationSizeMb: Math.max(64, Math.floor(limits.memoryMb / 2)) },
    job,
  );
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(watch);
      void worker.terminate();
      if (error) reject(error);
      else resolve(value as T);
    };
    const timer = setTimeout(
      () =>
        finish(
          new JobLimitExceeded(
            `The job was stopped after ${Math.round(limits.timeoutMs / 1000)} s`,
          ),
        ),
      limits.timeoutMs,
    );
    const watch = setInterval(async () => {
      try {
        const heap = await worker.getHeapStatistics();
        if (
          (heap.used_heap_size + heap.external_memory) / 1024 / 1024 >
          limits.memoryMb
        )
          finish(
            new JobLimitExceeded(
              `The job was stopped: it needed more than ${limits.memoryMb} MB`,
            ),
          );
      } catch {
        // The worker ended in between.
      }
    }, 200);
    worker.on("message", (message) => {
      if (message.type === "progress")
        progress?.(message.fraction, message.message);
      else if (message.type === "done") finish(undefined, message.value as T);
      else if (message.type === "error")
        finish(
          message.kind === "regenerate"
            ? new NeedsRegeneration(message.message)
            : message.kind === "output"
              ? new OutputError(message.message)
              : new Error(message.message),
        );
    });
    worker.on("error", (error: Error) =>
      finish(
        /heap|memory/i.test(error.message)
          ? new JobLimitExceeded(
              `The job was stopped: it needed more than ${limits.memoryMb} MB`,
            )
          : error,
      ),
    );
    worker.on("exit", (code) =>
      finish(new Error(`The job's worker stopped (${code})`)),
    );
  });
}

/** An export, made in a bounded worker. */
export const outputJob = (
  document: CadDocument,
  request: OutputRequest,
  results: readonly CodeResult[],
  limits: KernelJobLimits = defaultJobLimits,
) =>
  run<OutputFile>({ kind: "output", document, request, results }, limits).then(
    (file) => ({ ...file, bytes: new Uint8Array(file.bytes) }),
  );

/** The phone viewer's files, made in a bounded worker. */
export const viewerJob = (
  document: CadDocument,
  project: { id: string; name: string; revision: number },
  results: readonly CodeResult[],
  progress?: (fraction: number, message: string) => void,
  limits: KernelJobLimits = defaultJobLimits,
) =>
  run<{
    manifest: ViewerBundle["manifest"];
    files: [string, { bytes: Uint8Array; type: string }][];
  }>({ kind: "viewer", document, project, results }, limits, progress).then(
    ({ manifest, files }): ViewerBundle => ({
      manifest,
      files: new Map(
        files.map(([name, file]) => [
          name,
          { ...file, bytes: new Uint8Array(file.bytes) },
        ]),
      ),
    }),
  );
