import { test } from "node:test";
import assert from "node:assert/strict";
import { Vector3 } from "three";
import { measure, type MeasurePick } from "../web/measurement.js";

const v = (x: number, y: number, z: number) => new Vector3(x, y, z);
const point = (x: number, y: number, z: number): MeasurePick => ({
  kind: "point",
  point: v(x, y, z),
});
const hole = (x: number, y: number, z: number): MeasurePick => ({
  kind: "hole",
  point: v(x, y, z),
  diameter: 8,
});
const edge = (a: Vector3, b: Vector3): MeasurePick => ({ kind: "edge", a, b });
const face = (origin: Vector3, normal: Vector3): MeasurePick => ({
  kind: "face",
  point: origin,
  normal,
});

test("points and holes measure center distance and shortest distances to geometry", () => {
  assert.equal(measure(point(0, 0, 0), point(3, 4, 0)).distance, 5);
  assert.equal(measure(hole(0, 0, 0), hole(0, 0, 10)).distance, 10);
  assert.match(
    measure(hole(0, 0, 0), point(0, 3, 0)).description,
    /Centre distance/,
  );
  assert.equal(
    measure(point(4, 3, 0), edge(v(0, 0, 0), v(10, 0, 0))).distance,
    3,
  );
  assert.equal(
    measure(hole(4, 3, 0), face(v(0, 0, 0), v(0, 1, 0))).distance,
    3,
  );
});

test("edge and face combinations report gaps, intersections, and acute angles", () => {
  const horizontal = edge(v(0, 0, 0), v(10, 0, 0));
  const crossing = edge(v(5, -5, 0), v(5, 5, 0));
  const offset = edge(v(0, 3, 0), v(10, 3, 0));
  assert.equal(measure(horizontal, crossing).distance, 0);
  assert.equal(measure(horizontal, crossing).angle, 90);
  assert.equal(measure(horizontal, offset).distance, 3);
  const plane = face(v(0, 0, 0), v(0, 0, 1));
  assert.equal(measure(edge(v(0, 0, -2), v(0, 0, 2)), plane).distance, 0);
  assert.match(
    measure(edge(v(0, 0, -2), v(0, 0, 2)), plane).description,
    /intersects/,
  );
  assert.equal(measure(horizontal, face(v(0, 0, 2), v(0, 0, 1))).distance, 2);
  assert.equal(measure(plane, face(v(0, 0, 2), v(0, 0, 1))).distance, 2);
  const perpendicular = measure(
    face(v(1, 0, 0), v(1, 0, 0)),
    face(v(0, 2, 0), v(0, 1, 0)),
  );
  assert.equal(perpendicular.distance, 0);
  assert.equal(perpendicular.angle, 90);
  assert.ok(perpendicular.intersection?.distanceTo(v(1, 2, 0))! < 1e-8);
});

test("degenerate measurement geometry is rejected", () => {
  assert.throws(
    () => measure(point(0, 0, 0), edge(v(1, 0, 0), v(1, 0, 0))),
    /length/,
  );
  assert.throws(
    () => measure(point(0, 0, 0), face(v(0, 0, 0), v(0, 0, 0))),
    /normal/,
  );
});
