import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { SketchSolver } from "../src/document/sketch-solver.js";
import type {
  Layout,
  MaterialDefinition,
  StockPiece,
} from "../src/document/schema.js";
import {
  checkLayout,
  parseOutline,
  placedOutline,
  rectangleOutline,
  type LayoutPart,
} from "../src/document/layout.js";
import { DocumentEvaluator } from "../src/kernel/evaluator.js";
import { describeParts } from "../src/kernel/parts.js";
import {
  autoNest,
  layoutEntities,
  layoutParts,
} from "../src/kernel/layouts.js";
import { OpenCascadeEngine } from "../src/engine.js";
import { extrude, rectangle, solvedDocument } from "./support/documents.js";

let solver: SketchSolver;
before(async () => {
  solver = await SketchSolver.create();
});
after(() => solver.dispose());

/** An L-shaped offcut: 1000 × 600 with a 400 × 300 notch out of its top
 * right corner. */
const offcut: StockPiece = {
  id: "off",
  name: "Offcut",
  material: "ply",
  kind: "offcut",
  outline: parseOutline("0,0 1000,0 1000,300 600,300 600,600 0,600") as never,
  grain: "x",
};
const panel = (
  id: string,
  w: number,
  h: number,
  grain: LayoutPart["grain"] = "none",
): LayoutPart => ({
  id,
  name: id,
  outline: rectangleOutline(w, h),
  quantity: 1,
  grain,
});
const layout = (
  placements: Layout["placements"],
  rest: Partial<Layout> = {},
): Layout => ({
  id: "l",
  name: "l",
  stock: "off",
  placements,
  ...rest,
});
const kinds = (l: Layout, parts: LayoutPart[]) =>
  checkLayout(l, offcut, parts).map((issue) => issue.kind);

test("outlines are read from x,y pairs, counter-clockwise", () => {
  assert.deepEqual(parseOutline("0,0 0,10 10,10"), [
    { x: 10, y: 10 },
    { x: 0, y: 10 },
    { x: 0, y: 0 },
  ]);
  assert.match(String(parseOutline("0,0 10")), /x,y pairs/);
  assert.match(String(parseOutline("0,0 10,0 20,0")), /no area/);
});

test("parts must lie on the offcut, clear of each other by the kerf", () => {
  const parts = [panel("a", 500, 250), panel("b", 300, 200)];
  const at = (x: number, y: number, part = "a") => ({
    part,
    x,
    y,
    rotation: 0,
  });
  assert.deepEqual(
    kinds(layout([at(10, 10), at(10, 300, "b")], { kerf: 4 }), parts),
    [],
  );
  // Into the notch.
  assert.deepEqual(kinds(layout([at(550, 320)]), parts), ["outside"]);
  // Flush in the corner is fine; with a margin it is not.
  assert.deepEqual(kinds(layout([at(0, 0)]), parts), []);
  assert.deepEqual(kinds(layout([at(0, 0)], { margin: 10 }), parts), [
    "margin",
  ]);
  assert.deepEqual(kinds(layout([at(10, 10), at(100, 100, "b")]), parts), [
    "overlap",
  ]);
  assert.deepEqual(
    kinds(layout([at(10, 10), at(512, 10, "b")], { kerf: 4 }), parts),
    ["kerf"],
  );
  assert.deepEqual(
    kinds(
      layout([at(10, 10), at(520, 10, "b")], { kerf: 4, minimumStrip: 20 }),
      parts,
    ),
    ["strip"],
  );
  assert.deepEqual(
    kinds(layout([at(10, 10), at(10, 300), at(10, 300, "b")]), parts).sort(),
    ["count", "overlap"],
  );
});

test("a part turned across the grain is flagged", () => {
  const parts = [panel("a", 500, 250, "x")];
  // Turning about the placement point: each is moved to stay on the piece.
  const placed = (rotation: number, x: number, y: number) =>
    kinds(layout([{ part: "a", x, y, rotation }]), parts);
  assert.deepEqual(placed(0, 10, 10), []);
  assert.deepEqual(placed(90, 300, 10), ["grain"]);
  assert.deepEqual(placed(180, 510, 260), []);
});

test("auto-nest fills a sheet with rectangular parts, and an offcut with what fits", () => {
  const parts = [
    { ...panel("side", 560, 720), quantity: 2 },
    panel("top", 562, 560),
    panel("bottom", 562, 560),
    { ...panel("shelf", 562, 540), quantity: 2 },
  ];
  const sheet: StockPiece = {
    ...offcut,
    id: "sheet",
    outline: rectangleOutline(2500, 1250),
    grain: "none",
  };
  const settings = layout([], { stock: "sheet", kerf: 4, margin: 10 });
  const { placements, left } = autoNest(settings, sheet, parts, []);
  assert.equal(placements.length, 6);
  assert.deepEqual(left, []);
  assert.deepEqual(checkLayout({ ...settings, placements }, sheet, parts), []);
  const onOffcut = autoNest(layout([], { kerf: 4 }), offcut, parts, []);
  assert.ok(onOffcut.placements.length >= 1 && onOffcut.left.length >= 1);
  assert.deepEqual(
    checkLayout(layout(onOffcut.placements, { kerf: 4 }), offcut, parts),
    [],
  );
});

test("a layout's DXF puts every part where the layout shows it", async () => {
  const ply: MaterialDefinition = {
    id: "ply",
    name: "Ply",
    kind: "sheet",
    thickness: "18",
  };
  const document = {
    ...solvedDocument(
      solver,
      {},
      [
        rectangle("a-s", "XY", "0", "0", "400", "200"),
        extrude("a", "a-s"),
        rectangle("b-s", "YZ", "0", "0", "300", "150"),
        extrude("b", "b-s"),
      ],
      { materials: [ply] },
    ),
    stock: [offcut],
  };
  const evaluator = new DocumentEvaluator();
  const { bodies } = evaluator.evaluate(document);
  const info = describeParts(document, bodies);
  const parts = layoutParts(info, "ply");
  assert.equal(parts.length, 2);
  const l = layout([
    { part: "a:0", x: 20, y: 20, rotation: 0 },
    { part: "b:0", x: 580, y: 320, rotation: 90, flip: true },
  ]);
  assert.deepEqual(checkLayout(l, offcut, parts), []);
  const engine = new OpenCascadeEngine();
  try {
    const entities = await layoutEntities(engine, document, bodies, info, l);
    const outlines = entities.filter(
      (e) => e.kind === "polyline" && e.layer === "PART_OUTLINE",
    );
    assert.equal(outlines.length, 2);
    const box = (points: readonly { x: number; y: number }[]) =>
      [
        Math.min(...points.map((p) => p.x)),
        Math.min(...points.map((p) => p.y)),
        Math.max(...points.map((p) => p.x)),
        Math.max(...points.map((p) => p.y)),
      ].map((v) => Math.round(v * 1000) / 1000);
    l.placements.forEach((placement, i) => {
      const part = parts.find((p) => p.id === placement.part)!;
      const drawn = outlines[i]!;
      assert.deepEqual(
        box(drawn.kind === "polyline" ? drawn.points : []),
        box(placedOutline(part, placement)),
      );
    });
    assert.ok(entities.some((e) => e.layer === "STOCK_BOUNDARY"));
  } finally {
    engine.dispose();
    evaluator.dispose();
  }
});

test("what the layouts cost in stock, and pieces used too often", async () => {
  const { stockUsage } = await import("../src/document/layout.js");
  const { billOfMaterials, bomCsv } = await import("../src/kernel/bom.js");
  const sheet = {
    id: "s",
    name: "Birch 18",
    material: "ply",
    kind: "sheet" as const,
    outline: [
      { x: 0, y: 0 },
      { x: 2500, y: 0 },
      { x: 2500, y: 1250 },
      { x: 0, y: 1250 },
    ],
    cost: 89.5,
    quantity: 1,
  };
  const { cost: _cost, ...unpriced } = sheet;
  const offcut = { ...unpriced, id: "o", name: "Offcut", quantity: 3 };
  const placed = [{ part: "a", x: 0, y: 0, rotation: 0 }];
  const usage = stockUsage({
    stock: [sheet, offcut],
    layouts: [
      { id: "1", name: "1", stock: "s", placements: placed },
      { id: "2", name: "2", stock: "s", placements: placed },
      { id: "3", name: "3", stock: "o", placements: placed },
      // An empty layout uses nothing.
      { id: "4", name: "4", stock: "o", placements: [] },
    ],
  });
  assert.equal(usage.total, 179);
  assert.deepEqual(usage.unpriced, ["Offcut"]);
  assert.deepEqual(usage.short, ["Birch 18: 2 layouts, 1 on hand"]);
  const csv = bomCsv(billOfMaterials([], [], usage.pieces));
  assert.match(csv, /"stock","Birch 18","","2500 × 1250","2","179"/);
  assert.match(csv, /"stock","Offcut","","2500 × 1250","1",""/);
});
