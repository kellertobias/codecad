import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ManufacturingDxf,
  Project,
  SheetMaterial,
  View2D,
  cad,
  type SheetPart,
} from "../src/index.js";
import { OpenCascadeEngine } from "../src/engine.js";
import { drawManufacturing } from "../src/manufacturing.js";

const stock = new SheetMaterial({
  id: "plane-stock",
  thickness: 6,
  width: 1250,
  height: 2500,
});

@cad.project({ id: "plane-test", units: "mm" })
class Fixture extends Project {
  readonly rounded: SheetPart;
  readonly plain: SheetPart;
  constructor() {
    super({ id: "plane-test" });
    this.rounded = stock
      .makePart({ id: "rounded", width: 200, height: 100, cornerRadius: 20 })
      .orient("XY", { x: 0, y: 0, z: 0 });
    this.plain = stock
      .makePart({ id: "plain", width: 120, height: 80 })
      .orient("XY", { x: 0, y: 300, z: 0 });
  }
}

test("the CAM geometry can be laid out on the Drawings plane", async () => {
  const project = new Fixture(),
    engine = new OpenCascadeEngine(),
    view = new View2D();
  try {
    await engine.evaluate({ root: project, revision: 1 });
    await drawManufacturing(
      engine,
      new ManufacturingDxf({ parts: "all", layout: "one-file-per-part" }),
      view,
    );
    const paths = view.primitives.filter((entry) => entry.kind === "path");
    assert.equal(paths.length, 2);
    // One label per piece, naming the part it came from.
    assert.deepEqual(
      view.primitives.flatMap((entry) => (entry.label ? [entry.label] : [])),
      ["plane-test/rounded", "plane-test/plain"],
    );
    const span = (index: number) => {
      const points = (paths[index] as { points: { x: number; y: number }[] })
        .points;
      const xs = points.map((point) => point.x);
      return {
        points: points.length,
        from: Math.round(Math.min(...xs)),
        to: Math.round(Math.max(...xs)),
      };
    };
    // The rounded blank's arcs are sampled, not dropped: a rectangle would be
    // four points. Its corners still reach the blank's full 200 mm width.
    const rounded = span(0);
    assert.ok(rounded.points > 8, `${rounded.points} points`);
    assert.deepEqual([rounded.from, rounded.to], [0, 200]);
    // The parts are placed in a row, in the order they are exported.
    assert.deepEqual(span(1), { points: 4, from: 220, to: 340 });
  } finally {
    engine.dispose();
  }
});
