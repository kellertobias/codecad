import type { Recipe } from "../../src/model.js";
import type { KernelResponse } from "./protocol.js";

type Result = Extract<KernelResponse, { type: "mesh" }>;

/** The page's handle on the kernel worker: evaluates recipes and resolves
 * with their meshes. */
export class KernelClient {
  readonly ready: Promise<Extract<KernelResponse, { type: "ready" }>>;
  private readonly worker: Worker;
  private readonly pending = new Map<
    number,
    { resolve(result: Result): void; reject(error: Error): void }
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

  /** Waits for the kernel first: the worker only starts listening once its
   * WASM has loaded, and a message sent before that would be lost. */
  async evaluate(recipe: Recipe): Promise<Result> {
    if (this.stopped) throw new Error("Kernel worker stopped");
    await this.ready;
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type: "evaluate", recipe });
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
