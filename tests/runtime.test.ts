import { test } from "node:test";
import assert from "node:assert/strict";
import { Vector3 } from "three";
import {
  Project,
  Assembly,
  Part,
  Shapes,
  PartInterface,
  SheetMaterial,
  SheetPart,
  Drill,
  Arrangement,
  cad,
  Bend,
} from "../src/index.js";
import { OpenCascadeEngine } from "../src/engine.js";
import { nest, sheetParts } from "../src/manufacturing.js";
import { ManufacturingDxf } from "../src/outputs.js";
import { partEntities } from "../src/manufacturing.js";
import { LinearJoint, MotionStudy } from "../src/motion.js";
import { RouterBit } from "../src/tools.js";
import { KitchenCabinet } from "../examples/kitchen-cabinet/project.js";

@cad.part({ id: "drawer-test", revision: "1" })
class Drawer extends Assembly {
  constructor() {
    super({ id: "drawer" });
    new Part({
      id: "front",
      shape: new Shapes.Box({ width: 10, depth: 10, height: 10 }),
    });
  }
}
@cad.project({ id: "test", units: "mm" })
class TestProject extends Project {
  constructor() {
    super({ id: "test" });
    const m = new SheetMaterial({
      id: "wood",
      width: 100,
      height: 100,
      thickness: 18,
    });
    const left = m.makePart({ id: "left", width: 60, height: 90 }).place({
      x: 100,
      y: 200,
      z: 300,
      rotate: { y: 90 },
      relativeTo: "world",
    });
    new Drill({ size: 8 }).drill(left, { x: 20, y: 30, z: [18, -6] });
    left.copy({ id: "right" }).place({ relativeTo: left, x: 100 });
    new Drill({ size: 8 }).drill(left, { x: 40, y: 30, z: [18, -6] });
    const drawer = new Drawer();
    drawer.copy({ id: "drawer-2" });
  }
}
test("registry scopes, nested copies and independent project instances", () => {
  const a = new TestProject(),
    c = new TestProject();
  assert.equal(a.parts.all.length, 4);
  assert.equal(c.parts.all.length, 4);
  assert.equal(a.registry.tree.component, a);
  assert.deepEqual(
    a.parts.tree.children.map((n) => n.component.id),
    ["left", "right", "drawer", "drawer-2"],
  );
  assert.equal(
    a.parts.tree.children[3]?.children[0]?.component.path,
    "test/drawer-2/front",
  );
  assert.equal(a.parts.require("left", SheetPart).operations.length, 2);
  assert.equal(a.parts.require("right", SheetPart).operations.length, 1);
  assert.throws(() => a.registry.get("front"), /Ambiguous/);
  assert.equal(
    a.parts.require("test/drawer-2/front", Part).parent?.id,
    "drawer-2",
  );
  assert.notEqual(
    a.parts.require("left", SheetPart),
    c.parts.require("left", SheetPart),
  );
});
test("relative placements follow references and cycles are rejected", () => {
  const p = new TestProject(),
    left = p.parts.require("left", Part),
    right = p.parts.require("right", Part);
  let pos = new Vector3().setFromMatrixPosition(right.worldMatrix());
  assert.ok(pos.distanceTo(new Vector3(100, 200, 200)) < 1e-8);
  left.place({ relativeTo: "world", x: 50 });
  pos.setFromMatrixPosition(right.worldMatrix());
  assert.equal(pos.x, 150);
  assert.throws(() => left.place({ relativeTo: right }), /Circular/);
  assert.equal(new Vector3().setFromMatrixPosition(left.worldMatrix()).x, 50);
});
test("stock nests across multiple sheets and rejects oversize blanks", () => {
  const p = new TestProject(),
    parts = p.parts.all.filter((p): p is SheetPart => p instanceof SheetPart);
  assert.equal(nest(parts).length, 2);
  const m = new SheetMaterial({ width: 20, height: 20, thickness: 18 });
  assert.throws(
    () => nest([m.makePart({ width: 30, height: 30 })]),
    /does not fit/,
  );
});
test("material visual properties stay within valid physical ranges", () => {
  assert.throws(
    () => new SheetMaterial({ thickness: 18, opacity: -0.1 }),
    /opacity/,
  );
  assert.throws(
    () => new SheetMaterial({ thickness: 18, reflectivity: 1.1 }),
    /reflectivity/,
  );
  const glass = new SheetMaterial({
    thickness: 6,
    opacity: 0.3,
    reflectivity: 0.8,
  });
  assert.equal(glass.options.opacity, 0.3);
  assert.equal(glass.options.reflectivity, 0.8);
});
test("guillotine nesting preserves tall off-cuts and sequences kerf-aware cuts", () => {
  const stock = new SheetMaterial({
    width: 100,
    height: 100,
    thickness: 18,
    kerf: 2,
    rotations: [0],
  });
  const large = stock.makePart({ id: "large", width: 60, height: 60 });
  const tall = stock.makePart({ id: "tall", width: 30, height: 90 });
  const layouts = nest([large, tall]);
  assert.equal(
    layouts.length,
    1,
    "a full-height right off-cut avoids a second sheet",
  );
  const layout = layouts[0]!;
  // Two columns: the tall blank and, past the kerf, the large one with the
  // 68 × 38 off-cut kept whole below it. Blanks read top-left to bottom-right.
  assert.deepEqual(
    layout.parts.map((part) => [part.x, part.y, part.width, part.height]),
    [
      [0, 0, 30, 90],
      [32, 0, 60, 60],
    ],
  );
  assert.deepEqual(
    layout.cuts.map((cut) => cut.sequence),
    [1, 2, 3, 4],
  );
  // The first cut rips the whole sheet; every cut spans its source piece.
  assert.deepEqual(layout.cuts[0], {
    sequence: 1,
    source: "stock",
    axis: "x",
    at: 30,
    from: 0,
    to: 100,
    kerf: 2,
  });
  assert.equal(layout.usedArea, 6300);
  assert.deepEqual(
    layout.offcuts.map((offcut) => [offcut.width, offcut.height]),
    [[68, 38]],
  );
  assert.equal(layout.usedArea + layout.offcutArea + layout.wasteArea, 10000);
});
test("nesting rotates a blank when it saves a stock sheet", () => {
  const stock = new SheetMaterial({
    width: 100,
    height: 100,
    thickness: 18,
    kerf: 2,
    grain: "height",
    rotations: [0, 90],
  });
  const wide = stock.makePart({ id: "wide", width: 70, height: 40 });
  const tall = stock.makePart({
    id: "tall",
    width: 30,
    height: 90,
    grain: "height",
  });
  const layout = nest([wide, tall]);
  assert.equal(layout.length, 1);
  const placed = layout[0]!.parts;
  assert.equal(placed.find((p) => p.part === wide)!.rotation, 90);
  assert.equal(placed.find((p) => p.part === tall)!.rotation, 0);
});
test("representative kitchen cabinet fits one kerf-aware sheet per stock thickness", () => {
  const layouts = nest(sheetParts(new KitchenCabinet()));
  assert.deepEqual(
    layouts.map((layout) => layout.material.thickness).sort((a, b) => a - b),
    [6, 12, 18],
  );
  for (const layout of layouts) {
    assert.equal(layout.material.options.kerf, 3.2);
    assert.ok(layout.offcutArea > 0);
    assert.ok(layout.wasteArea > 0);
    assert.ok(
      layout.usedArea + layout.offcutArea + layout.wasteArea <=
        layout.material.width! * layout.material.height! + 1e-6,
    );
  }
});
test("real B-rep drilling uses local coordinates and copy snapshots", async () => {
  const p = new TestProject(),
    engine = new OpenCascadeEngine();
  try {
    const result = await engine.evaluate({ root: p, revision: 1 });
    assert.deepEqual(result.diagnostics, []);
    const left = result.meshes.find((m) => m.componentPath.endsWith("/left"))!,
      right = result.meshes.find((m) => m.componentPath.endsWith("/right"))!;
    assert.equal(left.holes.length, 2);
    assert.deepEqual(
      left.holes.map((hole) => hole.diameter),
      [8, 8],
    );
    assert.ok(
      Math.abs(left.volume - (60 * 90 * 18 - 2 * Math.PI * 16 * 6)) < 0.01,
    );
    assert.ok(
      Math.abs(right.volume - (60 * 90 * 18 - Math.PI * 16 * 6)) < 0.01,
    );
    const step = new TextDecoder().decode(await engine.exportStep(p));
    assert.match(step, /ISO-10303-21/);
    const dxf = await engine.exportDxf(
      new ManufacturingDxf({ parts: "all", layout: "one-file-per-part" }),
    );
    assert.equal(dxf.size, 2);
    assert.match(
      new TextDecoder().decode([...dxf.values()][0]),
      /DRILL_TOP_D6.000/,
    );
  } finally {
    engine.dispose();
  }
});
test("arrangements include both endpoints and validate counts", () => {
  assert.deepEqual(
    Arrangement.linear({
      start: { x: 0, y: 10 },
      end: { x: 10, y: 20 },
      steps: 3,
    }).values,
    [
      { x: 0, y: 10 },
      { x: 5, y: 15 },
      { x: 10, y: 20 },
    ],
  );
  assert.throws(() =>
    Arrangement.linear({
      start: { x: 0, y: 0 },
      end: { x: 1, y: 1 },
      steps: 1,
    }),
  );
});
test("straight sheet-metal bend produces a valid folded B-rep", async () => {
  @cad.project({ id: "bend-test", units: "mm" })
  class Fold extends Project {
    constructor() {
      super({ id: "fold" });
      new SheetMaterial({ width: 1000, height: 1000, thickness: 1.5 })
        .makeSheetMetalPart({
          id: "bracket",
          outline: new Shapes.Rectangle({ width: 100, height: 50 }),
          bendRules: {
            kFactor: 0.42,
            minimumInsideRadius: 1.5,
            defaultRelief: "rectangular",
          },
        })
        .bend(
          new Bend({
            id: "bend",
            start: { x: 40, y: 0 },
            end: { x: 40, y: 50 },
            direction: "up",
            angle: 90,
            insideRadius: 1.5,
          }),
        );
    }
  }
  const e = new OpenCascadeEngine();
  try {
    const result = await e.evaluate({ root: new Fold(), revision: 1 });
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.meshes.length, 1);
    assert.ok(Math.max(...result.meshes[0]!.positions) > 50);
  } finally {
    e.dispose();
  }
});
test("failed constructors restore the active registry scope", () => {
  @cad.project({ id: "bad", units: "mm" })
  class Bad extends Project {
    constructor() {
      super({ id: "bad" });
      new Part({ shape: new Shapes.Box({ width: 1, depth: 1, height: 1 }) });
      throw new Error("construction failure");
    }
  }
  assert.throws(() => new Bad(), /construction failure/);
  assert.equal(new TestProject().parts.all.length, 4);
});
test("global drilling and rotated pattern placement resolve into target coordinates", async () => {
  @cad.project({ id: "global", units: "mm" })
  class Global extends Project {
    constructor() {
      super({ id: "global" });
      const p = new SheetMaterial({ thickness: 18 })
        .makePart({ id: "panel", width: 100, height: 100 })
        .place({ x: 100, y: 200, z: 300 });
      new Drill({ size: 8 }).drill(p, {
        x: 120,
        y: 230,
        z: [318, -6],
        relativeTo: "world",
      });
      new Drill({ size: 4 }).pattern(
        p,
        new PartInterface({
          features: {
            one: { kind: "hole", x: 10, y: 0, diameter: 4, source: "measured" },
          },
        }),
        { z: [18, -6], placement: { x: 50, y: 50, rotate: { z: 90 } } },
      );
    }
  }
  const p = new Global(),
    e = new OpenCascadeEngine();
  try {
    assert.deepEqual(
      (await e.evaluate({ root: p, revision: 1 })).diagnostics,
      [],
    );
    const entities = await partEntities(e, p.parts.require("panel", SheetPart));
    const circles = entities.filter((e) => e.kind === "circle");
    assert.equal(circles.length, 2);
    assert.ok(Math.abs(circles[0]!.x - 20) < 1e-8);
    assert.ok(Math.abs(circles[0]!.y - 30) < 1e-8);
    assert.ok(Math.abs(circles[1]!.x - 50) < 1e-8);
    assert.ok(Math.abs(circles[1]!.y - 60) < 1e-8);
  } finally {
    e.dispose();
  }
});
test("linear joint moves assembly children without changing their construction geometry", () => {
  const p = new TestProject(),
    drawer = p.registry.require("drawer", Drawer),
    front = p.parts.require("test/drawer/front", Part);
  const original = structuredClone(front.recipe),
    joint = new LinearJoint({
      id: "slide",
      fixed: p,
      moving: drawer,
      axis: "y",
      limits: { min: 0, max: 100 },
    });
  const study = new MotionStudy({ of: p }).animate({
    joint,
    from: 0,
    to: 100,
    durationSeconds: 1,
  });
  assert.equal(
    new Vector3().setFromMatrixPosition(study.pose(front, 0.5)).y,
    50,
  );
  assert.deepEqual(front.recipe, original);
  assert.throws(() => joint.delta(101), /limits/);
  const fast = new MotionStudy({ of: p }).animate({
    joint,
    from: 0,
    to: 100,
    durationSeconds: 0.5,
  });
  assert.equal(fast.duration, 0.5);
  assert.equal(
    new Vector3().setFromMatrixPosition(fast.pose(front, 0.5)).y,
    50,
  );
});
test("grain constraints and margins cannot silently rotate an incompatible blank", () => {
  const stock = new SheetMaterial({
    width: 100,
    height: 60,
    thickness: 18,
    grain: "height",
    sheetMargin: 5,
  });
  const p = stock.makePart({ width: 40, height: 80, grain: "height" });
  assert.throws(() => nest([p]), /does not fit/);
});
test("custom material subclasses remain shared when parts are copied", () => {
  class Birch extends SheetMaterial {}
  const material = new Birch({ width: 100, height: 100, thickness: 18 });
  const part = material.makePart({ width: 30, height: 30 });
  assert.equal(part.copy().material, material);
  const only180 = new SheetMaterial({
    width: 100,
    height: 100,
    thickness: 18,
    rotations: [180],
  });
  assert.equal(
    nest([only180.makePart({ width: 30, height: 30 })])[0]!.parts[0]!.rotation,
    180,
  );
});
test("pocket allowance expands XY clearance without changing cut depth", async () => {
  @cad.project({ id: "pocket-clearance", units: "mm" })
  class Pocket extends Project {
    constructor() {
      super({ id: "pocket-clearance" });
      const panel = new SheetMaterial({ thickness: 18 }).makePart({
        id: "panel",
        width: 100,
        height: 100,
      });
      new RouterBit({ diameter: 6 }).pocket(
        panel,
        new Shapes.Rectangle({ width: 20, height: 20 }),
        { depth: 6, placement: { x: 30, y: 30, z: 12 }, allowance: 0.5 },
      );
    }
  }
  const e = new OpenCascadeEngine(),
    p = new Pocket();
  try {
    assert.deepEqual(
      (await e.evaluate({ root: p, revision: 1 })).diagnostics,
      [],
    );
    const panel = p.parts.require("panel", SheetPart),
      tool = await e.recipe(panel.operations[0]!.recipe),
      bounds = e.bounds(tool);
    assert.ok(Math.abs(bounds.min.z - 12) < 0.001);
    assert.ok(Math.abs(bounds.max.z - 18) < 0.001);
    assert.ok(bounds.min.x < 30 && bounds.max.x > 50);
  } finally {
    e.dispose();
  }
});
