import { test } from "node:test";
import assert from "node:assert/strict";
import { PanZoom, typedZoom, viewBoxFor } from "../web/pan-zoom.js";

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
test("the sheet viewBox shows the page crisply and follows pan and zoom", () => {
  const page = { width: 420, height: 297 };
  const view = new PanZoom();
  const fit = viewBoxFor(view, page, 800, 400);
  // At rest the page is centred and fully covered, letterboxed on the long axis.
  assert.deepEqual(
    [fit.minY, fit.height],
    [0, 297],
    "the tighter axis fills the element exactly",
  );
  assert.equal(fit.minX + fit.width / 2, page.width / 2);
  assert(fit.width > page.width);

  // Zooming in halves the region on show, so twice the detail is asked for.
  view.zoom(2);
  const near = viewBoxFor(view, page, 800, 400);
  assert.equal(near.width, fit.width / 2);
  assert.equal(near.height, fit.height / 2);
  assert.equal(near.minX + near.width / 2, page.width / 2);

  // A pan of n pixels moves the region by exactly those pixels' worth of page.
  const perMm = 800 / near.width;
  view.pan(-40, 25);
  const moved = viewBoxFor(view, page, 800, 400);
  const close = (a: number, b: number) => assert(Math.abs(a - b) < 1e-9);
  close(moved.minX - near.minX, 40 / perMm);
  close(moved.minY - near.minY, -25 / perMm);
  assert.equal(moved.width, near.width);
});

test("a typed zoom level is read loosely and applied within the same bounds", () => {
  assert.deepEqual(
    ["200", "200%", " 150 % ", "1,5%", "75.5%"].map(typedZoom),
    [2, 2, 1.5, 0.015, 0.755],
  );
  for (const text of ["", "%", "abc", "0", "-50%"])
    assert.equal(typedZoom(text), undefined, text);
  const view = new PanZoom();
  view.zoomTo(2);
  assert.equal(view.scale, 2);
  // Typing past the ends of the range lands on the end, as the buttons do.
  view.zoomTo(50);
  assert.equal(view.scale, 12);
  view.zoomTo(0.01);
  assert.equal(view.scale, 0.25);
  // Zooming to a level holds the point it is centred on still.
  view.zoomTo(1);
  view.pan(30, -20);
  const point = { x: (10 - view.x) / view.scale, y: (5 - view.y) / view.scale };
  view.zoomTo(3, 10, 5);
  assert.equal(view.scale, 3);
  assert.equal(point.x * view.scale + view.x, 10);
  assert.equal(point.y * view.scale + view.y, 5);
});
