import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CounterSink,
  Drill,
  RouterBit,
  SheetMaterial,
  Shapes,
} from "../src/index.js";

test("drilling requires an explicit signed depth and rejects unsupported side axes without machining", () => {
  const part = new SheetMaterial({ thickness: 12 }).makePart({
    width: 80,
    height: 60,
  });
  const drill = new Drill({ diameter: 5 });
  assert.throws(
    () =>
      drill.drill(part, { x: 10, y: 10, z: 12 as unknown as [number, number] }),
    /safe explicit drilling depth/,
  );
  assert.throws(
    () => drill.drill(part, { x: 10, y: 10, z: [12, -6], axis: "x" }),
    /rotated interface frame/,
  );
  assert.equal(part.operations.length, 0);
  assert.equal(drill.drill(part, { x: 10, y: 10, z: [12, -6] }), part);
  assert.deepEqual(
    {
      kind: part.operations[0]?.kind,
      diameter: part.operations[0]?.diameter,
      depth: part.operations[0]?.depth,
    },
    { kind: "drill", diameter: 5, depth: 6 },
  );
  assert.throws(() => new Drill({ diameter: 5, size: 6 }), /disagree/);
});

test("countersinks enforce cone geometry and record a successful cut", () => {
  const part = new SheetMaterial({ thickness: 12 }).makePart({
    width: 80,
    height: 60,
  });
  const sink = new CounterSink({ diameter: 10, angle: 90 });
  assert.throws(
    () => sink.cut(part, { x: 10, y: 10, z: [12, -4] }),
    /depth must be 5/,
  );
  assert.equal(part.operations.length, 0);
  assert.equal(sink.cut(part, { x: 10, y: 10, z: [12, -5] }), part);
  assert.deepEqual(
    {
      kind: part.operations[0]?.kind,
      diameter: part.operations[0]?.diameter,
      depth: part.operations[0]?.depth,
    },
    { kind: "countersink", diameter: 10, depth: 5 },
  );
  assert.throws(() => new CounterSink({ diameter: 10, angle: 180 }), /angle/);
});

test("router pockets validate depth before adding an operation", () => {
  const part = new SheetMaterial({ thickness: 12 }).makePart({
    width: 80,
    height: 60,
  });
  const router = new RouterBit({ diameter: 6 });
  const outline = new Shapes.Rectangle({ width: 20, height: 10 });
  assert.throws(() => router.pocket(part, outline, { depth: 0 }), /depth/);
  assert.equal(part.operations.length, 0);
  router.pocket(part, outline, { depth: 3, allowance: 0.25 });
  assert.equal(part.operations[0]?.kind, "pocket");
  assert.equal(part.operations[0]?.depth, 3);
  assert.match(JSON.stringify(part.operations[0]?.recipe), /"distance":0\.25/);
});
