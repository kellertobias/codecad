import { test } from "node:test";
import assert from "node:assert/strict";
import { Matrix4, Vector3 } from "three";
import {
  Drill,
  FingerJoint,
  PartInterface,
  SheetMaterial,
  Shapes,
  screwHole,
} from "../src/index.js";

test("mating screw interfaces preserve names and frames and centre both slot orientations", () => {
  const mount = new PartInterface({
    frame: {
      origin: { x: 4, y: 5, z: 6 },
      xAxis: { x: 0, y: 1, z: 0 },
      yAxis: { x: 1, y: 0, z: 0 },
    },
    features: {
      horizontal: {
        kind: "slot",
        x: 10,
        y: 20,
        length: 12,
        width: 4,
        axis: "x",
        source: "measured",
      },
      vertical: {
        kind: "slot",
        x: 30,
        y: 40,
        length: 12,
        width: 4,
        axis: "y",
        source: "measured",
      },
    },
  });
  const holes = mount.screwHoles();
  assert.deepEqual(
    [holes.features.horizontal.x, holes.features.horizontal.y],
    [16, 22],
  );
  assert.deepEqual(
    [holes.features.vertical.x, holes.features.vertical.y],
    [32, 46],
  );
  assert.equal(holes.features.horizontal.diameter, 4);
  assert.equal(holes.frame, mount.frame);
  assert.equal(mount.features.horizontal.kind, "slot");
  const part = new SheetMaterial({ thickness: 6 }).makePart({
    width: 100,
    height: 100,
  });
  new Drill({ diameter: 3 }).pattern(part, mount, { z: [6, -6] });
  assert.equal(part.operations.length, 2);
  assert.ok(
    part.operations.every((op) => op.kind === "drill" && op.diameter === 3),
  );
  assert.throws(() =>
    screwHole({
      kind: "slot",
      x: 0,
      y: 0,
      length: 2,
      width: 4,
      axis: "x",
      source: "measured",
    }),
  );
});

test("internal finger joints reserve 20% at both ends and notch the entering sheet", () => {
  assert.deepEqual(
    FingerJoint.interval(220, { internal: true, edgeMargin: 30 }),
    { start: 44, end: 176 },
  );
  assert.deepEqual(FingerJoint.interval(220, { internal: false }), {
    start: 0,
    end: 220,
  });
  assert.throws(() =>
    FingerJoint.interval(100, { internal: true, edgeMargin: 50 }),
  );
  const material = new SheetMaterial({ thickness: 6 });
  const receiver = material.makePart({ width: 100, height: 100 });
  const entering = material.makePart({ width: 100, height: 100 });
  const port = (y: number) =>
    new PartInterface({
      outline: new Shapes.Rectangle({ width: 100, height: 6 }),
      frame: {
        origin: { x: 0, y, z: 6 },
        xAxis: { x: 1, y: 0, z: 0 },
        yAxis: { x: 0, y: 1, z: 0 },
      },
    });
  receiver.addInterface("join", port(40));
  entering.addInterface("join", port(0));
  new FingerJoint({ fingerWidth: 12, clearance: 0.2 }).connect({
    first: receiver.interface("join"),
    second: entering.interface("join"),
  });
  // Evaluate operation cutter bounds directly in the sheet-local coordinate frame.
  const bounds = (
    recipe: import("../src/model.js").Recipe,
    matrix = new Matrix4(),
  ): number[] => {
    if (recipe.kind === "transform")
      return bounds(
        recipe.source,
        matrix.clone().multiply(new Matrix4().fromArray(recipe.matrix)),
      );
    assert.equal(recipe.kind, "box");
    if (recipe.kind !== "box") throw new Error("Expected a box cutter");
    return [
      new Vector3().applyMatrix4(matrix).x,
      new Vector3(recipe.width, recipe.depth, recipe.height).applyMatrix4(
        matrix,
      ).x,
    ];
  };
  for (const operation of receiver.operations) {
    const [start, end] = bounds(operation.recipe!);
    assert.ok(start! >= 20 - 1e-9 && end! <= 80 + 1e-9);
  }
  assert.ok(entering.operations.length >= 2);
});
