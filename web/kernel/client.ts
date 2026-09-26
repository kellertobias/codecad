import type { Recipe } from "../../src/model.js";
import type {
  CadDocument,
  DrawingSheet,
  Layout,
  StockPiece,
} from "../../src/document/schema.js";
import type { LayoutPart } from "../../src/document/layout.js";
import type { CodeResult } from "../../src/document/code-part.js";
import type { KernelRequest, KernelResponse } from "./protocol.js";

type Answer<T extends KernelResponse["type"]> = Extract<
  KernelResponse,
  { type: T }
>;
type Request = KernelRequest extends infer R
  ? R extends KernelRequest
    ? Omit<R, "id">
    : never
  : never;

/** The page's handle on the kernel worker: sends requests and resolves
 * with the worker's answers. */
export class KernelClient {
  readonly ready: Promise<Answer<"ready">>;
  private readonly worker: Worker;
  private readonly pending = new Map<
    number,
    { resolve(result: KernelResponse): void; reject(error: Error): void }
  >();
  private next = 1;
  private stop: (error: Error) => void = () => {};
  private stopped = false;

  constructor(url = "/kernel.worker.js") {
    this.worker = new Worker(url, { type: "module" });
    this.ready = new Promise((resolve, reject) => {
      this.stop = reject;
      this.worker.onerror = (event) =>
        reject(new Error(event.message || "Kernel worker failed to start"));
      this.worker.onmessage = (event: MessageEvent<KernelResponse>) => {
        const message = event.data;
        if (message.type === "ready") {
          resolve(message);
          return;
        }
        const waiting = this.pending.get(message.id);
        if (!waiting) return;
        this.pending.delete(message.id);
        if (message.type === "error")
          waiting.reject(new Error(message.message));
        else waiting.resolve(message);
      };
    });
  }

  evaluate(recipe: Recipe): Promise<Answer<"mesh">> {
    return this.send({ type: "evaluate", recipe });
  }

  /** Evaluates a solved document, up to feature index `until`. */
  evaluateDocument(
    document: CadDocument,
    until?: number,
  ): Promise<Answer<"model">> {
    return this.send({
      type: "document",
      document,
      ...(until === undefined ? {} : { until }),
    });
  }

  pickFace(body: string, face: number): Promise<Answer<"face">> {
    return this.send({ type: "pick-face", body, face });
  }

  pickEdge(body: string, edge: number): Promise<Answer<"edge">> {
    return this.send({ type: "pick-edge", body, edge });
  }

  /** Loads the sketch solver in the worker. */
  useSolver(wasm: string): Promise<Answer<"solver">> {
    return this.send({ type: "solver", wasm });
  }

  /** Builds a code part's output (recipes from the sandbox) into exact
   * geometry, to upload and to use. */
  buildCode(
    output: unknown,
    key: string,
    files?: Readonly<Record<string, string>>,
  ): Promise<Answer<"code-build">> {
    return this.send({
      type: "code-build",
      output,
      key,
      ...(files ? { files } : {}),
    });
  }

  /** Hands the worker stored results of code parts. */
  useCodeResults(
    results: readonly CodeResult[],
  ): Promise<Answer<"code-results">> {
    return this.send({ type: "code-results", results });
  }

  /** A drawing sheet as SVG. */
  drawing(
    document: CadDocument,
    sheet: DrawingSheet,
    options: { scratch?: boolean } = {},
  ): Promise<Answer<"drawing">> {
    return this.send({
      type: "drawing",
      document,
      sheet,
      ...(options.scratch ? { scratch: true } : {}),
    });
  }

  /** Fills a stock piece with the parts still to place. */
  nest(
    layout: Layout,
    piece: StockPiece,
    parts: readonly LayoutPart[],
    others: readonly Layout[],
  ): Promise<Answer<"nest">> {
    return this.send({ type: "nest", layout, piece, parts, others });
  }

  /** How two bodies meet, and the joints that fit. */
  contact(
    document: CadDocument,
    until: number | undefined,
    a: string,
    b: string,
  ): Promise<Answer<"contact">> {
    return this.send({
      type: "contact",
      document,
      ...(until === undefined ? {} : { until }),
      a,
      b,
    });
  }

  /** Waits for the kernel first: the worker only starts listening once its
   * WASM has loaded, and a message sent before that would be lost. */
  private async send<T>(request: Request): Promise<T> {
    if (this.stopped) throw new Error("Kernel worker stopped");
    await this.ready;
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (result: KernelResponse) => void,
        reject,
      });
      this.worker.postMessage({ id, ...request });
    });
  }

  /** Stops the worker. Requests still waiting, including ones waiting for
   * the kernel to load, fail instead of waiting forever. */
  terminate(): void {
    this.stopped = true;
    this.worker.terminate();
    this.stop(new Error("Kernel worker stopped"));
    for (const waiting of this.pending.values())
      waiting.reject(new Error("Kernel worker stopped"));
    this.pending.clear();
  }
}
