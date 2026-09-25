// Stands in for "brepjs/quick" in browser bundles. The quick entry finds its
// kernel through a computed dynamic import, which a browser cannot resolve,
// so here the kernel is loaded explicitly from the served WASM file before
// anything else in the bundle runs.
import { OcctKernel } from "occt-wasm";
import { OcctWasmAdapter, registerKernel } from "brepjs";

const started = performance.now();
const wasm =
  (globalThis as { CODECAD_OCCT_WASM?: string }).CODECAD_OCCT_WASM ??
  new URL("/occt-wasm.wasm", globalThis.location.href).href;
registerKernel(
  "occt-wasm",
  OcctWasmAdapter.fromKernel(await OcctKernel.init({ wasm })),
);
/** Milliseconds the kernel took to download, compile and initialise. */
export const kernelInitMs = performance.now() - started;

export * from "brepjs";
