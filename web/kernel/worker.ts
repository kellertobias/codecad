// The CAD kernel in a Web Worker: one long-lived OpenCascade session that
// builds recipes and sends back meshes without copying them.
import * as b from "brepjs/quick";
import { OpenCascadeEngine, setRecipeFileReader } from "../../src/engine.js";
import { meshShape, meshTransferables } from "../../src/kernel/mesh.js";
import type { KernelRequest, KernelResponse } from "./protocol.js";

// Only the browser-bundled "brepjs/quick" (src/kernel/browser-brepjs.ts)
// exports this; it is read dynamically so the Node typings stay unaware.
const initMs = (b as unknown as { kernelInitMs?: number }).kernelInitMs ?? 0;

setRecipeFileReader(async (path) => {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Could not load ${path}`);
  return new Uint8Array(await response.arrayBuffer());
});

const post = (message: KernelResponse, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(message, transfer);

post({ type: "ready", initMs, ...heap() });

self.onmessage = async (event: MessageEvent<KernelRequest>) => {
  const request = event.data;
  // A fresh engine per request, disposed afterwards, so kernel memory does
  // not grow with every edit. Per-feature caching arrives with the document
  // evaluator; this worker only proves the kernel runs here.
  const engine = new OpenCascadeEngine();
  try {
    const started = performance.now();
    const shape = await engine.recipe(request.recipe);
    const built = performance.now();
    const mesh = meshShape(shape);
    const volume = b.unwrap(b.measureVolume(shape));
    post(
      {
        id: request.id,
        type: "mesh",
        mesh,
        volume,
        buildMs: built - started,
        meshMs: performance.now() - built,
      },
      meshTransferables(mesh),
    );
  } catch (error) {
    post({
      id: request.id,
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    engine.dispose();
  }
};

function heap(): { heapBytes?: number } {
  const memory = (performance as { memory?: { usedJSHeapSize: number } })
    .memory;
  return memory ? { heapBytes: memory.usedJSHeapSize } : {};
}
