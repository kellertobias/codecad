// Checks the geometry of uploaded code-part results, in a worker thread
// with its own memory limit (see code-results.ts): a malformed or hostile
// BREP can make OpenCascade fail, hang or run out of memory, and must not
// take the server with it.
import { parentPort } from "node:worker_threads";
import * as b from "brepjs/quick";
import { codeLimits } from "./document/code-part.js";

interface Check {
  readonly id: number;
  readonly bodies: readonly { readonly name: string; readonly brep: string }[];
}

parentPort!.on("message", ({ id, bodies }: Check) => {
  try {
    const summary = bodies.map((body) => {
      const shape = b.unwrap(b.deserializeShape(body.brep));
      try {
        if (!b.isShape3D(shape)) throw new Error(`${body.name} is not a solid`);
        const volume = b.unwrap(b.measureVolume(shape));
        if (!(Number.isFinite(volume) && volume > 0))
          throw new Error(`${body.name} has no volume`);
        const box = b.getBounds(shape);
        const reach = Math.max(
          ...[box.xMin, box.xMax, box.yMin, box.yMax, box.zMin, box.zMax].map(
            Math.abs,
          ),
        );
        if (!(reach <= codeLimits.extent))
          throw new Error(
            `${body.name} reaches further than ${codeLimits.extent} mm from the origin`,
          );
        return { name: body.name, volume };
      } finally {
        shape[Symbol.dispose]();
      }
    });
    parentPort!.postMessage({ id, ok: true, summary });
  } catch (error) {
    parentPort!.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
