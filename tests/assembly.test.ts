import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as b from "brepjs/quick";
import { SketchSolver } from "../src/document/sketch-solver.js";
import type { Feature, MateFeature } from "../src/document/schema.js";
import { DocumentEvaluator } from "../src/kernel/evaluator.js";
import { extrude, rectangle, solvedDocument } from "./support/documents.js";

let solver: SketchSolver;
before(async () => {
  solver = await SketchSolver.create();
});
after(() => solver.dispose());

/** A side (x 0..18, y 0..300, z 0..400) and a loose 200 × 100 × 18 panel
 * lying far off on the XY plane. */
function evaluate(features: Feature[]) {
  const document = solvedDocument(solver, {}, [
    rectangle("side-s", "YZ", "0", "0", "300", "400"),
    extrude("side", "side-s"),
    rectangle("p-s", "XY", "1000", "1000", "200", "100"),
    extrude("panel", "p-s"),
    ...features,
  ]);
  const evaluator = new DocumentEvaluator();
  const result = evaluator.evaluate(document);
  for (const [id, status] of result.status)
    assert.ok(
      status.state === "ok",
      `${id}: ${status.state === "error" ? status.message : status.state}`,
    );
  // Measured before the shapes are freed.
  const r = (v: number) => Math.round(v * 1000) / 1000 + 0;
  const boxes = new Map(
    result.bodies.map((body) => {
      const bb = b.getBounds(body.shape);
      return [
        body.id,
        {
          x: [r(bb.xMin), r(bb.xMax)],
          y: [r(bb.yMin), r(bb.yMax)],
          z: [r(bb.zMin), r(bb.zMax)],
        },
      ];
    }),
  );
  evaluator.dispose();
  return boxes;
}
const bounds = (boxes: Map<string, Box>, id: string) => boxes.get(id)!;
type Box = { x: number[]; y: number[]; z: number[] };
const inner = { body: "side:0", origin: "side", role: "end" } as const;
const underside = { body: "panel:0", origin: "panel", role: "start" } as const;
const mate = (rest: Partial<MateFeature>): MateFeature => ({
  id: "m",
  type: "mate",
  name: "m",
  kind: "planar",
  moving: underside,
  target: inner,
  ...rest,
});

test("a planar mate lays one face against another", () => {
  const result = evaluate([mate({ offset: "2" })]);
  // The panel's underside now faces the side's inner face, 2 mm off it.
  assert.deepEqual(bounds(result, "panel:0").x, [20, 38]);
});

test("a fastened mate also centres the faces", () => {
  const result = evaluate([mate({ kind: "fastened" })]);
  const bb = bounds(result, "panel:0");
  assert.deepEqual(bb.x, [18, 36]);
  assert.equal((bb.y[0]! + bb.y[1]!) / 2, 150);
  assert.equal((bb.z[0]! + bb.z[1]!) / 2, 200);
});

test("an edge mate lines an edge up with another, flush at one end", () => {
  const result = evaluate([
    mate({
      kind: "edge",
      movingEdge: {
        a: underside,
        b: { body: "panel:0", origin: "panel", role: "side:p-s.bottom" },
      },
      targetEdge: {
        a: inner,
        b: { body: "side:0", origin: "side", role: "side:side-s.bottom" },
      },
    }),
  ]);
  const bb = bounds(result, "panel:0");
  assert.deepEqual(bb.x, [18, 36]);
  // Along the side's bottom edge (z = 0), starting at one of its ends.
  assert.equal(bb.z[0], 0);
  assert.equal(bb.y[1]! - bb.y[0]!, 200);
  assert.ok(bb.y[0] === 0 || bb.y[1] === 300, JSON.stringify(bb));
});

test("a move shifts or turns bodies, and can place copies", () => {
  const result = evaluate([
    {
      id: "mv",
      type: "move",
      name: "mv",
      bodies: ["panel:0"],
      copy: true,
      translate: ["-1000", "-1000", "100"],
      rotate: { axis: "Z", angle: "90", center: ["1000", "1000", "0"] },
    },
  ]);
  assert.deepEqual(bounds(result, "panel:0").x, [1000, 1200]);
  // Turned a quarter about (1000, 1000), then moved.
  const copy = bounds(result, "mv#1:panel:0");
  assert.deepEqual(copy, { x: [-100, 0], y: [0, 200], z: [100, 118] });
});
