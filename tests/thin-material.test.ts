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
import { partEntities, thinMaterial } from "../src/manufacturing.js";

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
