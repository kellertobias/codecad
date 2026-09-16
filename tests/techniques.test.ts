import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DominoJoint,
  FingerJoint,
  Groove,
  MiterJoint,
  PartInterface,
  SheetMaterial,
  Shapes,
} from "../src/index.js";

const material = new SheetMaterial({ thickness: 6 });
function edge() {
  const part = material.makePart({ width: 100, height: 50 });
  part.addInterface(
    "edge",
    new PartInterface({
      outline: new Shapes.Rectangle({ width: 100, height: 6 }),
      frame: {
        origin: { x: 0, y: 0, z: 6 },
        xAxis: { x: 1, y: 0, z: 0 },
        yAxis: { x: 0, y: 1, z: 0 },
      },
    }),
  );
  return { part, port: part.interface("edge") };
}

test("grooves use interface clearance by default and permit an explicit override", () => {
  const { part } = edge();
  const profile = new PartInterface({
    outline: new Shapes.Rectangle({ width: 20, height: 6 }),
    defaultClearance: 0.2,
  });
  const groove = new Groove({ toolDiameter: 4 });
  assert.equal(groove.cut({ target: part, profile, depth: 3 }), part);
  assert.match(JSON.stringify(part.operations[0]?.recipe), /"distance":0\.2/);
  groove.cut({ target: part, profile, depth: 3, clearance: 0.4 });
  assert.match(JSON.stringify(part.operations[1]?.recipe), /"distance":0\.4/);
  assert.throws(
    () =>
      groove.cut({
        target: part,
        profile: new Shapes.Box({ width: 2, depth: 2, height: 2 }),
        depth: 1,
      }),
    /2D outline/,
  );
  assert.equal(part.operations.length, 2);
});

test("domino joints cut both partners equally and reject invalid spacing before machining", () => {
  const first = edge(),
    second = edge();
  const joint = new DominoJoint({ width: 20, thickness: 6, depthPerSide: 10 });
  joint.connect({
    first: first.port,
    second: second.port,
    count: 3,
    edgeOffset: 20,
  });
  assert.equal(first.part.operations.length, 3);
  assert.equal(second.part.operations.length, 3);
  assert.ok(
    first.part.operations.every(
      (op) => op.kind === "domino" && op.depth === 10,
    ),
  );
  assert.ok(
    second.part.operations.every(
      (op) => op.kind === "domino" && op.depth === 10,
    ),
  );
  const invalidFirst = edge(),
    invalidSecond = edge();
  assert.throws(
    () =>
      joint.connect({
        first: invalidFirst.port,
        second: invalidSecond.port,
        count: 3,
        edgeOffset: 20,
        distribution: { spacing: 80 },
      }),
    /spacing/,
  );
  assert.equal(invalidFirst.part.operations.length, 0);
  assert.equal(invalidSecond.part.operations.length, 0);
  for (const distribution of [{ spacing: 0 }, { spacing: NaN }])
    assert.throws(
      () =>
        joint.connect({
          first: invalidFirst.port,
          second: invalidSecond.port,
          count: 2,
          distribution,
        }),
      /spacing/,
    );
  assert.throws(
    () =>
      joint.connect({
        first: invalidFirst.port,
        second: invalidSecond.port,
        count: 2,
        edgeOffset: 5,
      }),
    /spacing/,
  );
  assert.equal(invalidFirst.part.operations.length, 0);
  assert.equal(invalidSecond.part.operations.length, 0);
});

test("finger joints alternate the receiving partner and honor the startWith side", () => {
  const first = edge(),
    second = edge();
  new FingerJoint({ fingerWidth: 20 }).connect({
    first: first.port,
    second: second.port,
    startWith: "second",
  });
  assert.equal(first.part.operations.length, 2);
  assert.equal(second.part.operations.length, 3);
  assert.throws(
    () =>
      new FingerJoint({ fingerWidth: 20, clearance: -0.1 }).connect({
        first: edge().port,
        second: edge().port,
      }),
    /clearance/,
  );
});

test("miter joints cut both sheets and reject impossible angles without mutation", () => {
  const first = edge(),
    second = edge();
  assert.throws(
    () =>
      new MiterJoint({ angle: 90 }).connect({
        first: first.port,
        second: second.port,
      }),
    /angle/,
  );
  assert.equal(first.part.operations.length, 0);
  new MiterJoint({ angle: 45, gap: 0.2 }).connect({
    first: first.port,
    second: second.port,
  });
  assert.equal(first.part.operations[0]?.kind, "miter");
  assert.equal(first.part.operations[0]?.angle, 45);
  assert.equal(second.part.operations[0]?.kind, "miter");
});
