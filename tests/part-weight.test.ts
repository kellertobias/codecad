import { test } from "node:test";
import assert from "node:assert/strict";
import { Project, SheetMaterial, cad } from "../src/index.js";
import { OpenCascadeEngine } from "../src/engine.js";
import { inspectComponent } from "../src/inspection.js";
import { formatMass, inspectorDetails } from "../web/inspector.js";

@cad.project({ id: "weights", units: "mm" })
class WeighedProject extends Project {
  constructor() {
    super({ id: "weights" });
    // 200 x 100 x 18 mm of 680 kg/m³ birch plywood: 360 cm³, 244.8 g.
    new SheetMaterial({
      name: "birch multiplex",
      thickness: 18,
      densityKgPerM3: 680,
    }).makePart({ id: "shelf", width: 200, height: 100 });
    new SheetMaterial({ name: "unknown board", thickness: 18 }).makePart({
      id: "back",
      width: 200,
      height: 100,
    });
  }
}

test("material density is checked and weighs the parts made from it", async () => {
  assert.throws(
    () => new SheetMaterial({ thickness: 18, densityKgPerM3: 0 }),
    /material density/,
  );
  const project = new WeighedProject();
  const engine = new OpenCascadeEngine();
  try {
    const built = await engine.evaluate({ root: project, revision: 1 });
    const part = (id: string) =>
      project.parts.all.find((candidate) => candidate.id === id)!;
    const shelf = inspectComponent(part("shelf"), built.meshes);
    assert.ok(Math.abs(shelf.mass! - 244.8) < 0.1);
    assert.equal(shelf.massPartial, undefined);
    // Stock without a density weighs nothing rather than guessing at one.
    assert.equal(inspectComponent(part("back"), built.meshes).mass, undefined);
    // The assembly adds up what it can and says the total is incomplete.
    const whole = inspectComponent(project, built.meshes);
    assert.ok(Math.abs(whole.mass! - 244.8) < 0.1);
    assert.equal(whole.massPartial, true);
  } finally {
    engine.dispose();
  }
});

test("weights read as grams up to a kilogram and as kilograms above it", () => {
  assert.deepEqual([12.34, 244.8, 999, 1234, 45678].map(formatMass), [
    "12.3 g",
    "245 g",
    "999 g",
    "1.23 kg",
    "45.7 kg",
  ]);
  const weight = (inspection: Parameters<typeof inspectorDetails>[0]) =>
    inspectorDetails(inspection).rows.find(([name]) => name === "Weight")![1];
  assert.equal(
    weight({
      kind: "part",
      volume: 360000,
      mass: 244.8,
      partCount: 1,
      operations: [],
    }),
    "245 g",
  );
  assert.equal(
    weight({
      kind: "assembly",
      volume: 720000,
      mass: 244.8,
      massPartial: true,
      partCount: 2,
      operations: [],
    }),
    "245 g · parts with a density only",
  );
  assert.equal(
    weight({ kind: "part", volume: 360000, partCount: 1, operations: [] }),
    "No material density",
  );
});
