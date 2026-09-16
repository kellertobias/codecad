import { test } from "node:test";
import assert from "node:assert/strict";
import { View2D } from "../src/view2d.js";
import { Plane2DViewport, gridStep, planeBounds } from "../web/plane2d.js";

test("code-defined 2D paths and circles are validated and copied", () => {
  const point = { x: 4, y: 8 };
  const view = new View2D()
    .path([point, { x: 20, y: 8 }, { x: 20, y: 30 }], {
      closed: true,
      label: "outline",
    })
    .circle({ x: 10, y: 10 }, 5, { color: "#ffffff" });
  point.x = 999;
  assert.deepEqual(view.primitives[0], {
    kind: "path",
    points: [
      { x: 4, y: 8 },
      { x: 20, y: 8 },
      { x: 20, y: 30 },
    ],
    closed: true,
    label: "outline",
    color: "#69d2ba",
  });
  assert.deepEqual(planeBounds(view.primitives), {
    minX: 4,
    minY: 5,
    maxX: 20,
    maxY: 30,
  });
  assert.throws(() => view.path([{ x: 0, y: 0 }]), /at least two/);
  assert.throws(
    () =>
      view.path(
        [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
        { closed: true },
      ),
    /at least three/,
  );
  assert.throws(() => view.line({ x: NaN, y: 0 }, { x: 1, y: 1 }), /finite/);
  assert.throws(() => view.circle({ x: 0, y: 0 }, 0), /positive/);
  assert.throws(() => view.circle({ x: 0, y: 0 }, 1, { color: "red" }), /hex/);
});

test("2D viewport fits geometry and zooms around the cursor without drift", () => {
  const viewport = new Plane2DViewport();
  const view = new View2D().path([
    { x: -50, y: -20 },
    { x: 50, y: 20 },
  ]);
  viewport.fit(view.primitives, 800, 600);
  const point = { x: 20, y: 10 };
  const before = viewport.toScreen(point, 800, 600);
  const roundTrip = viewport.toWorld(before, 800, 600);
  assert.ok(Math.abs(roundTrip.x - point.x) < 1e-8);
  assert.ok(Math.abs(roundTrip.y - point.y) < 1e-8);
  viewport.zoomAt(2, before, 800, 600);
  const after = viewport.toScreen(point, 800, 600);
  assert.ok(Math.abs(after.x - before.x) < 1e-8);
  assert.ok(Math.abs(after.y - before.y) < 1e-8);
  viewport.pan(30, -15);
  assert.deepEqual(viewport.toScreen(point, 800, 600), {
    x: after.x + 30,
    y: after.y - 15,
  });
  assert.equal(gridStep(4), 20);
});
