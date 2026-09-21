import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ManufacturingDxf,
  Project,
  SheetMaterial,
  Shapes,
  cad,
  type SheetPart,
} from "../src/index.js";
import { OpenCascadeEngine } from "../src/engine.js";
import {
  narrowestNeck,
  partEntities,
  thinMaterial,
} from "../src/manufacturing.js";

const stock = new SheetMaterial({ id: "thin-stock", thickness: 6 });

@cad.project({ id: "thin-test", units: "mm" })
class Fixture extends Project {
  readonly grazing: SheetPart;
  readonly sound: SheetPart;
  constructor() {
    super({ id: "thin-test" });
    // A pocket centred on the blank's edge: it leaves almost nothing beside it.
    this.grazing = stock
      .makePart({ id: "grazing", width: 200, height: 100 })
      .orient("XY", { x: 0, y: 0, z: 0 });
    this.grazing.subtract(new Shapes.Cylinder({ diameter: 20, length: 4 }), {
      x: 10.5,
      y: 50,
      z: 2,
    });
    // The same pocket, well inside the blank.
    this.sound = stock
      .makePart({ id: "sound", width: 200, height: 100 })
      .orient("XY", { x: 0, y: 200, z: 0 });
    this.sound.subtract(new Shapes.Cylinder({ diameter: 20, length: 4 }), {
      x: 100,
      y: 50,
      z: 2,
    });
  }
}

test("a part left too thin between a cut and its edge is reported", async () => {
  const project = new Fixture(),
    engine = new OpenCascadeEngine();
  try {
    await engine.evaluate({ root: project, revision: 1 });
    const grazing = thinMaterial(
      await partEntities(engine, project.grazing),
      10,
    );
    assert.ok(grazing, "expected a finding");
    assert.ok(grazing.mm < 1, `${grazing.mm} mm`);
    assert.deepEqual(grazing.between, ["CUT_BOTTOM_D4.000", "blank edge"]);
    // 90 mm of material all round, so nothing to report.
    assert.equal(
      thinMaterial(await partEntities(engine, project.sound), 10),
      undefined,
    );
  } finally {
    engine.dispose();
  }
});

test("the check runs with the CAM export and names the part", async () => {
  const project = new Fixture(),
    engine = new OpenCascadeEngine();
  try {
    await engine.evaluate({ root: project, revision: 1 });
    const found: string[] = [];
    await engine.exportDxf(
      new ManufacturingDxf({
        parts: "all",
        layout: "one-file-per-part",
        minimumMaterial: 10,
      }),
      (part, finding) => found.push(`${part.id}: ${finding.mm.toFixed(2)}`),
    );
    assert.equal(found.length, 1);
    assert.match(found[0]!, /^grazing: 0\./);
  } finally {
    engine.dispose();
  }
});

const box = (points: [number, number][]) => points.map(([x, y]) => ({ x, y }));

test("a finger left hanging on a sliver is reported as a neck", () => {
  // The back corner of a drawer side as two joints once left it: the floor's
  // last notch ends 0.93 mm short of the back wall's first, so the corner
  // hangs on that much.
  const side = box([
    [160, 0],
    [180, 0],
    [180, 6],
    [200.07, 6],
    [200.07, 0],
    [207, 0],
    [207, 6],
    [201, 6],
    [201, 26],
    [207, 26],
    [207, 43],
    [0, 43],
    [0, 0],
    [20, 0],
    [20, 6],
    [160, 6],
  ]);
  const neck = narrowestNeck(side, 10);
  assert.ok(neck);
  assert.ok(Math.abs(neck.mm - 0.93) < 0.01, `${neck.mm} mm`);
  assert.deepEqual(neck.at, { x: 200.07, y: 6 });
});

test("a corner both joints cut behind is a neck of nothing", () => {
  const side = box([
    [214, 0],
    [220, 0],
    [220, 6],
    [214, 6],
    [214, 26],
    [220, 26],
    [220, 100],
    [0, 100],
    [0, 0],
    [200, 0],
    [200, 6],
    [214, 6],
  ]);
  const neck = narrowestNeck(side, 10);
  assert.ok(neck);
  assert.equal(neck.mm, 0);
});

test("ordinary fingers and notches are not necks", () => {
  // Tabs 20 wide and 6 deep along the bottom, a 6 mm notch up one side.
  const side = box([
    [0, 6],
    [0, 100],
    [100, 100],
    [100, 26],
    [94, 26],
    [94, 6],
    [80, 6],
    [80, 0],
    [60, 0],
    [60, 6],
    [40, 6],
    [40, 0],
    [20, 0],
    [20, 6],
  ]);
  assert.equal(narrowestNeck(side, 10), undefined);
  // The same contour as the finished outline of a part with no other cuts.
  assert.equal(
    thinMaterial(
      [{ kind: "polyline", layer: "PART_OUTLINE", closed: true, points: side }],
      10,
    ),
    undefined,
  );
});
