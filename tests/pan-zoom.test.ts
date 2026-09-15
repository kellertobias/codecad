import { test } from "node:test";
import assert from "node:assert/strict";
import { PanZoom } from "../web/pan-zoom.js";

test("drawing zoom retains the point under the pointer and reset fits the page", () => {
  const view = new PanZoom();
  view.pan(30, -20);
  const point = {
    x: (100 - view.x) / view.scale,
    y: (50 - view.y) / view.scale,
  };
  view.zoom(2, 100, 50);
  assert.equal(point.x * view.scale + view.x, 100);
  assert.equal(point.y * view.scale + view.y, 50);
  view.reset();
  assert.deepEqual([view.scale, view.x, view.y], [1, 0, 0]);
});
test("drawing zoom is bounded and pages retain independent views", () => {
  const a = new PanZoom(),
    b = new PanZoom();
  a.zoom(100);
  assert.equal(a.scale, 12);
  a.zoom(0.0001);
  assert.equal(a.scale, 0.25);
  a.pan(200, 100);
  assert.deepEqual([b.scale, b.x, b.y], [1, 0, 0]);
});
