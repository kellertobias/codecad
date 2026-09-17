import { test } from "node:test";
import assert from "node:assert/strict";
import { MetalStockMaterial, Project, cad } from "../src/index.js";
import { OpenCascadeEngine } from "../src/engine.js";
import { inspectComponent } from "../src/inspection.js";
import { cutRows, csv } from "../src/manufacturing.js";
import { cutListPages } from "../src/reports.js";

@cad.project({ id: "metal-stock-test", units: "mm" })
class MetalStockProject extends Project {
  constructor() {
    super({ id: "metal-stock-test" });
    new MetalStockMaterial({
      name: "steel",
      color: "#667788",
      width: 20,
      height: 30,
    }).makePart({ id: "square-bar", length: 100 });
    new MetalStockMaterial({
      name: "steel",
      width: 20,
      height: 30,
      cornerRadius: 4,
    })
      .makePart({ id: "rounded-bar", length: 100 })
      .place({ x: 40 });
    new MetalStockMaterial({
      name: "steel",
      width: 20,
      height: 20,
      cornerRadius: true,
      wallThickness: 2,
    })
      .makePart({ id: "round-tube", length: 100 })
      .place({ x: 80 });
    new MetalStockMaterial({
      name: "steel",
      width: 30,
      height: 20,
      cornerRadius: "full",
      wallThickness: 2,
    })
      .makePart({ id: "capsule-tube", length: 100 })
      .place({ x: 120 });
  }
}

test("metal stock validates outside dimensions, radius selectors, and wall", () => {
  const base = { width: 30, height: 20 };
  assert.equal(
    new MetalStockMaterial({ ...base, cornerRadius: true }).cornerRadius,
    10,
  );
  assert.equal(
    new MetalStockMaterial({ ...base, cornerRadius: "full" }).cornerRadius,
    10,
  );
  for (const cornerRadius of [false, null, "none"] as const)
    assert.equal(
      new MetalStockMaterial({ ...base, cornerRadius }).cornerRadius,
      0,
    );
  for (const wallThickness of [null, "solid"] as const)
    assert.equal(
      new MetalStockMaterial({ ...base, wallThickness }).wallThickness,
      null,
    );
  assert.throws(
    () => new MetalStockMaterial({ ...base, cornerRadius: 11 }),
    /corner radius/,
  );
  assert.throws(
    () => new MetalStockMaterial({ ...base, cornerRadius: -1 }),
    /corner radius/,
  );
  assert.throws(
    () => new MetalStockMaterial({ ...base, wallThickness: 10 }),
    /wall thickness/,
  );
  assert.throws(
    () => new MetalStockMaterial({ ...base, wallThickness: 0 }),
    /wall thickness/,
  );
  assert.throws(
    () => new MetalStockMaterial({ width: 0, height: 20 }),
    /stock width/,
  );
  assert.throws(
    () => new MetalStockMaterial({ width: 30, height: Infinity }),
    /stock height/,
  );
  const stock = new MetalStockMaterial(base);
  assert.throws(() => stock.makePart({ length: 0 }), /stock length/);
  assert.throws(() => stock.makePart({ length: 100, quantity: 0 }), /quantity/);
});

test("solid bars and hollow pipes extrude sharp-ended cross sections", async () => {
  const project = new MetalStockProject();
  const engine = new OpenCascadeEngine();
  try {
    const built = await engine.evaluate({ root: project, revision: 1 });
    assert.deepEqual(built.diagnostics, []);
    assert.equal(built.meshes.length, 4);
    const mesh = (id: string) =>
      built.meshes.find((part) => part.componentPath.endsWith("/" + id))!;
    assert.ok(Math.abs(mesh("square-bar").volume - 20 * 30 * 100) < 0.01);
    const roundedArea = 20 * 30 - (4 - Math.PI) * 4 * 4;
    assert.ok(Math.abs(mesh("rounded-bar").volume - roundedArea * 100) < 0.1);
    assert.ok(
      Math.abs(mesh("round-tube").volume - Math.PI * (10 * 10 - 8 * 8) * 100) <
        0.1,
    );
    const capsuleArea = (r: number) => (30 - 20) * (2 * r) + Math.PI * r * r;
    assert.ok(
      Math.abs(
        mesh("capsule-tube").volume - (capsuleArea(10) - capsuleArea(8)) * 100,
      ) < 0.1,
    );
    const square = project.parts.all.find((part) => part.id === "square-bar")!;
    assert.equal(mesh("square-bar").color, "#667788");
    assert.deepEqual(
      inspectComponent(square, built.meshes).dimensions,
      [20, 30, 100],
    );
    assert.equal(inspectComponent(square, built.meshes).material, "steel");
    const rows = cutRows(project);
    assert.equal(rows.length, 4);
    assert.deepEqual(
      rows.find((row) => row.path.endsWith("/round-tube")),
      {
        path: "metal-stock-test/round-tube",
        label: "round-tube",
        material: "steel",
        width: 20,
        height: 20,
        length: 100,
        wallThickness: 2,
        cornerRadius: 10,
        quantity: 1,
      },
    );
    const exported = csv(rows);
    assert.match(
      exported,
      /"length_mm","wall_thickness_mm","corner_radius_mm"/,
    );
    assert.match(
      exported,
      /"metal-stock-test\/round-tube","round-tube","steel","20","20","","1","100","2","10"/,
    );
    const printed = cutListPages(rows)
      .flatMap((page) => page.entities)
      .filter((entity) => entity.kind === "text")
      .map((entity) => entity.text);
    assert.ok(printed.includes("Wall"));
    assert.ok(printed.includes("R"));
    assert.ok(printed.includes("100"));
    for (const part of project.parts.all) {
      const bounds = engine.bounds(engine.subject(part));
      assert.ok(Math.abs(bounds.min.z) < 0.001);
      assert.ok(Math.abs(bounds.max.z - 100) < 0.001);
    }
  } finally {
    engine.dispose();
  }
});
