import type { Recipe } from "../../src/model.js";
import type { ShapeMesh } from "../../src/kernel/mesh.js";

/** Messages the page sends to the kernel worker. */
export type KernelRequest = {
  readonly id: number;
  readonly type: "evaluate";
  readonly recipe: Recipe;
};

/** Messages the kernel worker sends back. `ready` is sent once, unasked,
 * when the kernel has loaded. */
export type KernelResponse =
  | {
      readonly type: "ready";
      /** Download, compile and initialisation of the WASM kernel. */
      readonly initMs: number;
      /** Kernel heap size once loaded, when the runtime reports it. */
      readonly heapBytes?: number;
    }
  | {
      readonly id: number;
      readonly type: "mesh";
      readonly mesh: ShapeMesh;
      readonly volume: number;
      /** Building the solid, and tessellating it. */
      readonly buildMs: number;
      readonly meshMs: number;
    }
  | { readonly id: number; readonly type: "error"; readonly message: string };
