import { test } from "node:test";
import assert from "node:assert/strict";
import { Vector3 } from "three";
import { SheetMaterial, type PanelEdge, type PanelFace } from "../src/stock.js";
import { Shapes } from "../src/model.js";
import { FingerJoint } from "../src/techniques.js";

const stock = new SheetMaterial({
  id: "panel-reference-stock",
  thickness: 6,
  width: 500,
  height: 500,
});
const close = (actual: Vector3, expected: Vector3) =>
  assert.ok(
    actual.distanceTo(expected) < 1e-8,
    `${actual.toArray()} != ${expected.toArray()}`,
  );

test("named panel edges and faces produce measured local frames", () => {
  const panel = stock.makePart({
    id: "reference-panel",
    width: 100,
    height: 60,
  });
  const expected: Record<PanelEdge, [number, number, number, number]> = {
    south: [0, 0, 1, 0],
    east: [100, 0, 0, 1],
    north: [100, 60, -1, 0],
    west: [0, 60, 0, -1],
  };
  for (const face of ["front", "back"] as PanelFace[])
    for (const edge of ["south", "east", "north", "west"] as PanelEdge[]) {
      const reference = panel.edge({ edge, face });
      const [x, y, dx, dy] = expected[edge];
      assert.deepEqual(reference.frame?.origin, {
        x,
        y,
        z: face === "front" ? 6 : 0,
      });
      assert.deepEqual(reference.frame?.xAxis, { x: dx, y: dy, z: 0 });
      assert.equal(reference.owner, panel);
      assert.equal(
        Math.max(...reference.outline!.points.map((point) => point.x)),
        edge === "north" || edge === "south" ? 100 : 60,
      );
    }
  assert.deepEqual(
    panel.edge({ edge: "south", face: "front", from: 20, length: 35, inset: 5 })
      .frame?.origin,
    { x: 20, y: 5, z: 6 },
  );
  assert.throws(
    () => panel.edge({ edge: "north", face: "front", from: 99, length: 2 }),
    /outside/,
  );
  assert.throws(
    () => panel.edge({ edge: "west", face: "back", inset: 100 }),
    /outside/,
  );
  const clipped = stock.makePart({
    id: "clipped-panel",
    outline: new Shapes.Polygon({
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 40 },
        { x: 80, y: 60 },
        { x: 20, y: 60 },
        { x: 0, y: 40 },
      ],
    }),
  });
  assert.throws(
    () => clipped.edge({ edge: "north", face: "front" }),
    /not straight/,
  );
  assert.ok(
    clipped.edge({ edge: "north", face: "front", from: 20, length: 60 }),
  );
});

test("named references can drive existing sheet joinery", () => {
  const left = stock.makePart({ id: "joined-left", width: 100, height: 60 });
  const right = stock.makePart({ id: "joined-right", width: 80, height: 60 });
  const target = left.edge({ edge: "east", face: "front" });
  right.attach({ own: { edge: "west", face: "front" }, to: target });
  new FingerJoint({ fingerWidth: 20 }).connect({
    first: target,
    second: right.edge({ edge: "west", face: "front" }),
  });
  assert.ok(left.operations.length > 0);
  assert.ok(right.operations.length > 0);
});

test("front-to-back attachment defaults to opposing sheet interiors", () => {
  const fixed = stock.makePart({ id: "face-fixed", width: 100, height: 60 });
  const moving = stock.makePart({ id: "face-moving", width: 100, height: 60 });
  const target = fixed.edge({ edge: "south", face: "front" });
  moving.attach({ own: { edge: "north", face: "back" }, to: target });
  const own = moving.edge({ edge: "north", face: "back" });
  close(
    new Vector3().setFromMatrixPosition(own.worldMatrix()),
    new Vector3().setFromMatrixPosition(target.worldMatrix()),
  );
  const fixedInterior = new Vector3(0, 1, 0).transformDirection(
    target.worldMatrix(),
  );
  const movingInterior = new Vector3(0, -1, 0).transformDirection(
    own.worldMatrix(),
  );
  close(movingInterior, fixedInterior.clone().negate());
});

test("orientation and edge attachment compose through rotated world frames", () => {
  const fixed = stock.makePart({ id: "fixed-panel", width: 100, height: 60 });
  fixed.orient("YZ", { x: 25, y: 40, z: 50 });
  const moving = stock.makePart({ id: "moving-panel", width: 80, height: 30 });
  const target = fixed.edge({
    edge: "east",
    face: "front",
    from: 10,
    length: 20,
  });
  moving.attach({
    own: { edge: "west", face: "front" },
    to: target,
    offset: { x: 5, y: 0, z: 0 },
  });
  const own = moving.edge({ edge: "west", face: "front" });
  close(
    new Vector3().setFromMatrixPosition(own.worldMatrix()),
    new Vector3(5, 0, 0).applyMatrix4(target.worldMatrix()),
  );
  const fixedNormal = new Vector3(0, 0, 1).transformDirection(
    target.worldMatrix(),
  );
  const movingNormal = new Vector3(0, 0, 1).transformDirection(
    own.worldMatrix(),
  );
  close(movingNormal, fixedNormal);

  const perpendicular = stock.makePart({
    id: "perpendicular-panel",
    width: 70,
    height: 40,
  });
  perpendicular.attach({
    own: { edge: "south", face: "back" },
    to: target,
    rotate: { x: 90, z: 180 },
  });
  const perpendicularNormal = new Vector3(0, 0, 1).transformDirection(
    perpendicular.edge({ edge: "south", face: "back" }).worldMatrix(),
  );
  assert.ok(Math.abs(perpendicularNormal.dot(fixedNormal)) < 1e-8);
  assert.throws(
    () =>
      fixed.attach({
        own: { edge: "west", face: "front" },
        to: fixed.edge({ edge: "east", face: "front" }),
      }),
    /another component/,
  );
});

test("plain place remains compatible with named orientation", () => {
  const panel = stock.makePart({ id: "legacy-panel", width: 50, height: 20 });
  panel.place({ x: 3, y: 4, z: 5, rotate: { x: 90 } });
  close(
    new Vector3().setFromMatrixPosition(panel.worldMatrix()),
    new Vector3(3, 4, 5),
  );
  panel.orient("XZ", { x: 10, y: 11, z: 12 });
  close(
    new Vector3(0, 20, 0).applyMatrix4(panel.worldMatrix()),
    new Vector3(10, 11, 32),
  );
});
