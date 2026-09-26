import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkLayout,
  rectangleOutline,
  type LayoutPart,
} from "../src/document/layout.js";
import type { Layout, StockPiece } from "../src/document/schema.js";
import { shapeNest } from "../src/document/shape-nesting.js";
import { autoNest } from "../src/kernel/layouts.js";

/** An L: 400 × 400 with a 300 × 300 bite out of its corner. */
const ell: LayoutPart = {
  id: "ell",
  name: "Bracket",
  quantity: 4,
  grain: "none",
  outline: [
    { x: 0, y: 0 },
    { x: 400, y: 0 },
    { x: 400, y: 100 },
    { x: 100, y: 100 },
    { x: 100, y: 400 },
    { x: 0, y: 400 },
  ],
};

const sheet = (width: number, height: number): StockPiece => ({
  id: "sheet",
  name: "Sheet",
  material: "ply",
  kind: "sheet",
  outline: rectangleOutline(width, height),
});

const layout = (extra: Partial<Layout> = {}): Layout => ({
  id: "l",
  name: "L",
  stock: "sheet",
  kerf: 4,
  margin: 10,
  placements: [],
  ...extra,
});

/** Nothing a layout would flag as a mistake. */
const clean = (l: Layout, piece: StockPiece, parts: LayoutPart[]) =>
  checkLayout(l, piece, parts).filter((issue) =>
    ["outside", "margin", "overlap", "kerf", "grain", "count"].includes(
      issue.kind,
    ),
  );

test("L-shaped parts interlock where their rectangles would not fit", () => {
  // Inside the margins the sheet is 1020 × 510: two 400 × 400 rectangles
  // side by side, no second row. Pairs of Ls, one turned half-way into the
  // other's bite, take 504 × 504 each: two pairs fit.
  const piece = sheet(1040, 530);
  const shaped = shapeNest(layout(), piece, [ell], []);
  assert.equal(shaped.placements.length, 4, shaped.left.join());
  assert.deepEqual(
    clean(layout({ placements: shaped.placements }), piece, [ell]),
    [],
  );
  // Auto-nest picks the true shapes, as they place more.
  const auto = autoNest(layout(), piece, [ell], []);
  assert.equal(auto.method, "shape");
  assert.equal(auto.placements.length, 4);
  const byRectangles = autoNest(
    layout({ nesting: "guillotine" }),
    piece,
    [ell],
    [],
  );
  assert.equal(byRectangles.placements.length, 2);
});

test("an L-shaped offcut is filled by true shapes, and the grain is kept", () => {
  const offcut: StockPiece = {
    ...sheet(0, 0),
    kind: "offcut",
    grain: "x",
    outline: [
      { x: 0, y: 0 },
      { x: 1200, y: 0 },
      { x: 1200, y: 300 },
      { x: 300, y: 300 },
      { x: 300, y: 1200 },
      { x: 0, y: 1200 },
    ],
  };
  const strip: LayoutPart = {
    id: "strip",
    name: "Strip",
    quantity: 6,
    grain: "x",
    outline: rectangleOutline(500, 80),
  };
  const shaped = shapeNest(layout(), offcut, [strip], []);
  assert.equal(shaped.placements.length, 6, shaped.left.join());
  // Along the grain only: turned half-way round at most.
  assert.ok(shaped.placements.every((p) => p.rotation % 180 === 0));
  assert.deepEqual(
    clean(layout({ placements: shaped.placements }), offcut, [strip]),
    [],
  );
});

test("what does not fit is named, and copies elsewhere are not placed twice", () => {
  const piece = sheet(500, 500);
  const other = layout({
    id: "other",
    placements: [{ part: "ell", copy: 0, x: 0, y: 0, rotation: 0 }],
  });
  const shaped = shapeNest(layout(), piece, [ell], [other]);
  assert.equal(shaped.placements.length + 1 <= 4, true);
  assert.ok(shaped.placements.every((p) => p.copy! >= 1));
  assert.match(shaped.left.join(), /Bracket/);
});
