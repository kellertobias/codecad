import { test } from "node:test";
import assert from "node:assert/strict";
import { SheetMaterial } from "../src/index.js";
import { groupCutRows, nest, sheetParts } from "../src/manufacturing.js";
import { KitchenCabinet } from "../examples/kitchen-cabinet/project.js";

test("blanks of one height share a strip so the remnant stays whole", () => {
  const stock = new SheetMaterial({ width: 1000, height: 1000, thickness: 18 });
  const panel = stock.makePart({ id: "panel", width: 1000, height: 800 });
  const rails = stock.makePart({
    id: "rail",
    width: 250,
    height: 100,
    quantity: 4,
  });
  const [layout, ...more] = nest([rails, panel]);
  assert.equal(more.length, 0);
  assert.equal(layout!.parts.length, 5);
  // The four rails fill one 100 mm strip beside each other, leaving the
  // last 100 mm of the sheet as a single full-width off-cut.
  assert.deepEqual(
    layout!.offcuts.map((o) => [o.width, o.height]),
    [[1000, 100]],
  );
  assert.equal(layout!.wasteArea, 0);
  assert.equal(
    layout!.parts.filter((p) => p.part === rails).every((p) => p.y === 800),
    true,
  );
});

test("free pieces narrower than the minimum off-cut are waste, not off-cuts", () => {
  const make = (minimumOffcut?: number) =>
    new SheetMaterial({
      width: 100,
      height: 100,
      thickness: 18,
      kerf: 2,
      ...(minimumOffcut === undefined ? {} : { minimumOffcut }),
    });
  const sliver = nest([make().makePart({ width: 90, height: 90 })])[0]!;
  assert.deepEqual(sliver.offcuts, []);
  assert.equal(sliver.usedArea, 8100);
  assert.equal(sliver.wasteArea, 1900);
  const kept = nest([make(5).makePart({ width: 90, height: 90 })])[0]!;
  assert.equal(kept.offcuts.length, 2);
  assert.equal(kept.usedArea + kept.offcutArea + kept.wasteArea, 10000);
  assert.throws(
    () => new SheetMaterial({ thickness: 18, minimumOffcut: -1 }),
    /nonnegative/,
  );
});

test("the kitchen cabinet nests each stock into one sheet with a large remnant", () => {
  const parts = sheetParts(new KitchenCabinet());
  const layouts = nest(parts);
  // Deterministic: the same parts always give the same plan.
  assert.deepEqual(
    nest(parts).map((l) => l.parts.map((p) => [p.x, p.y, p.rotation])),
    layouts.map((l) => l.parts.map((p) => [p.x, p.y, p.rotation])),
  );
  const byThickness = new Map(layouts.map((l) => [l.material.thickness, l]));
  assert.deepEqual([...byThickness.keys()].sort(), [12, 18, 6]);
  for (const layout of layouts) {
    const expected = parts
      .filter((p) => p.material === layout.material)
      .reduce((sum, p) => sum + p.quantity, 0);
    assert.equal(layout.parts.length, expected);
    // Every cut spans its source piece and no blank overlaps another.
    for (const a of layout.parts)
      for (const b of layout.parts)
        if (a !== b)
          assert.ok(
            a.x + a.width <= b.x + 1e-6 ||
              b.x + b.width <= a.x + 1e-6 ||
              a.y + a.height <= b.y + 1e-6 ||
              b.y + b.height <= a.y + 1e-6,
            `${a.part.path} overlaps ${b.part.path}`,
          );
  }
  const sheet = byThickness.get(18)!;
  const area = sheet.material.width! * sheet.material.height!;
  const largest = Math.max(...sheet.offcuts.map((o) => o.width * o.height));
  // A quarter of the board comes back as one piece, not as a comb of slivers.
  assert.ok(largest > area / 4, `largest off-cut ${largest} of ${area}`);
  assert.ok(sheet.offcuts.length <= 4, `${sheet.offcuts.length} off-cuts`);
  assert.ok(byThickness.get(12)!.offcuts.length <= 9);
});

test("identical blanks group into one cut-list line with their parts listed", () => {
  const row = (path: string, width: number, quantity = 1) => ({
    path,
    label: path,
    material: "Birch 12 mm",
    width,
    height: 150,
    thickness: 12,
    quantity,
  });
  const grouped = groupCutRows([
    row("cab/drawer-1/left", 440),
    row("cab/drawer-1/back", 516),
    row("cab/drawer-1/right", 440),
    row("cab/drawer-2/left", 440, 2),
  ]);
  assert.deepEqual(
    grouped.map((g) => [g.width, g.quantity, g.paths]),
    [
      [
        440,
        4,
        ["cab/drawer-1/left", "cab/drawer-1/right", "cab/drawer-2/left"],
      ],
      [516, 1, ["cab/drawer-1/back"]],
    ],
  );
  // A different thickness or material is a different blank.
  assert.equal(
    groupCutRows([row("a", 440), { ...row("b", 440), thickness: 18 }]).length,
    2,
  );
});
