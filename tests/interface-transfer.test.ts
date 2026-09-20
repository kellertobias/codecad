import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Assembly,
  HardwarePart,
  PartInterface,
  Project,
  SheetMaterial,
  Shapes,
  cad,
  type SheetPart,
} from "../src/index.js";
import { Drill } from "../src/tools.js";
import { recipeBounds } from "../src/edges.js";

const r = (n: number) => Math.round(n * 100) / 100;
/** Where a cut sits in the part it was applied to. */
const at = (recipe: Parameters<typeof recipeBounds>[0]) => {
  const box = recipeBounds(recipe);
  return {
    x: r((box.min.x + box.max.x) / 2),
    y: r((box.min.y + box.max.y) / 2),
    top: r(box.max.z),
    bottom: r(box.min.z),
  };
};

const sheet = new SheetMaterial({ id: "transfer-stock", thickness: 6 });

/** A fitting that knows its own screw holes, and the assembly that carries it. */
@cad.part({ id: "transfer-fitting", revision: "1" })
class Fitting extends Assembly {
  readonly body: HardwarePart;
  constructor() {
    super({ id: "fitting" });
    this.body = new HardwarePart({
      id: "body",
      shape: new Shapes.Box({ width: 80, depth: 20, height: 5 }),
      measurementStatus: "measured",
    });
    this.body.addInterface(
      "mounts",
      new PartInterface({
        features: {
          front: {
            kind: "hole",
            x: 10,
            y: 10,
            diameter: 4,
            source: "measured",
          },
          back: { kind: "hole", x: 70, y: 10, diameter: 4, source: "measured" },
        },
      }),
    );
  }
}

@cad.project({ id: "transfer-test", units: "mm" })
class Fixture extends Project {
  readonly panel: SheetPart;
  readonly carrier: Assembly;
  constructor() {
    super({ id: "transfer-test" });
    this.panel = sheet
      .makePart({ id: "panel", width: 200, height: 100 })
      .orient("XY", { x: 0, y: 0, z: 0 });
    const fitting = new Fitting().place({ x: 40, y: 25, z: 6 });
    // An assembly can publish the holes it has to be mounted by.
    this.carrier = fitting;
    fitting.addInterface(
      "mounts",
      fitting.body.interface("mounts").relativeTo(fitting),
    );
    new Drill({ diameter: 4 }).transfer(
      this.panel,
      fitting.interface("mounts"),
      { depth: 4 },
    );
  }
}

test("a fitting's holes transfer onto the panel it is screwed to", () => {
  const project = new Fixture();
  const holes = project.panel.operations.map((operation) => operation.kind);
  assert.deepEqual(holes, ["drill", "drill"]);
  // The fitting sits at x 40, y 25 on the panel, so its own 10/70 mm holes
  // land there — nobody restated the other's coordinates.
  const cut = project.panel.operations.map((operation) => {
    const point = at(operation.recipe);
    return [point.x, point.y];
  });
  assert.deepEqual(cut, [
    [50, 35],
    [110, 35],
  ]);
});

test("the pattern is drilled from the face the fitting sits on", () => {
  const project = new Fixture();
  // The fitting is on the panel's top face, so the holes are sunk from z = 6.
  const depths = project.panel.operations.map((operation) => operation.depth);
  assert.deepEqual(depths, [4, 4]);
  // Sunk from the top face at z = 6, 4 mm deep, leaving 2 mm of material.
  const spans = project.panel.operations.map((operation) => {
    const point = at(operation.recipe);
    return [point.bottom, point.top];
  });
  assert.deepEqual(spans, [
    [2, 6],
    [2, 6],
  ]);
});
