import { test } from "node:test";
import assert from "node:assert/strict";
import { detectProfiles } from "../src/document/profiles.js";
import type { SketchEntity, SketchFeature } from "../src/document/schema.js";

const sketch = (entities: SketchEntity[]): SketchFeature => ({
  id: "s",
  type: "sketch",
  name: "Sketch",
  plane: "XY",
  entities,
  constraints: [],
});

/** Four points and four lines; `name` prefixes every id. */
function rectangle(
  name: string,
  x: number,
  y: number,
  w: number,
  h: number,
): SketchEntity[] {
  const corners = [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
  return [
    ...corners.map(([px, py], i): SketchEntity => ({
      id: `${name}p${i}`,
      type: "point",
      x: px!,
      y: py!,
    })),
    ...[0, 1, 2, 3].map((i): SketchEntity => ({
      id: `${name}l${i}`,
      type: "line",
      start: `${name}p${i}`,
      end: `${name}p${(i + 1) % 4}`,
    })),
  ];
}
const near = (a: number, b: number, tolerance = 1e-6) =>
  Math.abs(a - b) <= tolerance;

test("a rectangle is one counter-clockwise region", () => {
  const { regions, open } = detectProfiles(
    sketch(rectangle("", 0, 0, 600, 300)),
  );
  assert.equal(regions.length, 1);
  assert.equal(regions[0]!.area, 180000);
  assert.ok(regions[0]!.outer.area > 0);
  assert.equal(regions[0]!.id, "l0+l1+l2+l3");
  assert.deepEqual(open, []);
});

test("a rectangle drawn clockwise is still found", () => {
  const entities = rectangle("", 0, 0, 100, 50).map((e) =>
    e.type === "line" ? { ...e, start: e.end, end: e.start } : e,
  );
  const { regions } = detectProfiles(sketch(entities));
  assert.equal(regions.length, 1);
  assert.equal(regions[0]!.area, 5000);
});

test("a line across a rectangle splits it into two regions", () => {
  // The divider's ends lie on the bottom and top edges, which are not split
  // in the sketch itself.
  const { regions } = detectProfiles(
    sketch([
      ...rectangle("", 0, 0, 600, 300),
      { id: "m0", type: "point", x: 200, y: 0 },
      { id: "m1", type: "point", x: 200, y: 300 },
      { id: "divider", type: "line", start: "m0", end: "m1" },
    ]),
  );
  assert.deepEqual(
    regions.map((r) => r.area),
    [120000, 60000],
  );
  assert.ok(
    regions.every((r) => r.outer.curves.some((c) => c.entity === "divider")),
  );
});

test("a line ending on an arc splits the arc", () => {
  // A half disc (arc over a diameter) cut in two by a vertical radius.
  const { regions } = detectProfiles(
    sketch([
      { id: "c", type: "point", x: 0, y: 0 },
      { id: "a", type: "point", x: 10, y: 0 },
      { id: "b", type: "point", x: -10, y: 0 },
      { id: "top", type: "point", x: 0, y: 10 },
      { id: "dome", type: "arc", center: "c", start: "a", end: "b" },
      { id: "base", type: "line", start: "b", end: "a" },
      { id: "split", type: "line", start: "c", end: "top" },
    ]),
  );
  assert.equal(regions.length, 2);
  for (const region of regions)
    assert.ok(near(region.area, (Math.PI * 100) / 4, 0.5), `${region.area}`);
});

test("a circle inside a rectangle is a hole in it and a region of its own", () => {
  const { regions } = detectProfiles(
    sketch([
      ...rectangle("", 0, 0, 600, 300),
      { id: "c", type: "point", x: 100, y: 150 },
      { id: "hole", type: "circle", center: "c", radius: 20 },
    ]),
  );
  assert.equal(regions.length, 2);
  const [panel, disc] = regions;
  assert.equal(panel!.holes.length, 1);
  assert.equal(panel!.holes[0]!.curves[0]!.entity, "hole");
  assert.ok(near(panel!.area, 180000 - Math.PI * 400, 1));
  assert.equal(disc!.id, "hole");
  assert.equal(disc!.holes.length, 0);
});

test("nested outlines are holes only of the region directly around them", () => {
  const { regions } = detectProfiles(
    sketch([
      ...rectangle("a", 0, 0, 100, 100),
      ...rectangle("b", 10, 10, 80, 80),
      ...rectangle("c", 20, 20, 60, 60),
    ]),
  );
  const byId = new Map(regions.map((r) => [r.id, r]));
  assert.equal(byId.get("al0+al1+al2+al3")!.area, 10000 - 6400);
  assert.equal(byId.get("bl0+bl1+bl2+bl3")!.area, 6400 - 3600);
  assert.equal(byId.get("cl0+cl1+cl2+cl3")!.area, 3600);
});

test("open and construction lines bound nothing", () => {
  const entities: SketchEntity[] = [
    ...rectangle("", 0, 0, 100, 100),
    { id: "t0", type: "point", x: 100, y: 50 },
    { id: "t1", type: "point", x: 150, y: 50 },
    { id: "tail", type: "line", start: "t0", end: "t1" },
    { id: "d0", type: "point", x: 0, y: 0 },
    { id: "d1", type: "point", x: 100, y: 100 },
    {
      id: "diagonal",
      type: "line",
      start: "d0",
      end: "d1",
      construction: true,
    },
  ];
  const { regions, open } = detectProfiles(sketch(entities));
  assert.equal(regions.length, 1);
  assert.equal(regions[0]!.area, 10000);
  assert.deepEqual(open, ["tail"]);
});

test("a rounded corner follows the arc", () => {
  // A 100 × 100 square whose top-right corner is a quarter circle of 20.
  const { regions } = detectProfiles(
    sketch([
      { id: "p0", type: "point", x: 0, y: 0 },
      { id: "p1", type: "point", x: 100, y: 0 },
      { id: "p2", type: "point", x: 100, y: 80 },
      { id: "c", type: "point", x: 80, y: 80 },
      { id: "p3", type: "point", x: 80, y: 100 },
      { id: "p4", type: "point", x: 0, y: 100 },
      { id: "bottom", type: "line", start: "p0", end: "p1" },
      { id: "right", type: "line", start: "p1", end: "p2" },
      { id: "round", type: "arc", center: "c", start: "p2", end: "p3" },
      { id: "top", type: "line", start: "p3", end: "p4" },
      { id: "left", type: "line", start: "p4", end: "p0" },
    ]),
  );
  assert.equal(regions.length, 1);
  const expected = 10000 - 400 + (Math.PI * 400) / 4;
  assert.ok(near(regions[0]!.area, expected, 1), `${regions[0]!.area}`);
  const arc = regions[0]!.outer.curves.find((c) => c.entity === "round")!;
  assert.equal(arc.kind, "arc");
  assert.equal(arc.clockwise, false);
});
