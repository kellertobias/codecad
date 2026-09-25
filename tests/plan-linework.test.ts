import { test } from "node:test";
import assert from "node:assert/strict";
import {
  footOnLine,
  pickPair,
  tiledPaths,
  uniqueSegments,
  uniqueSegmentSteps,
} from "../web/plan-linework.js";

test("sheet linework drops repeated and zero-length segments", () => {
  const edge = [0, 0, 10, 0],
    // The same edge the other way round, as a part behind it projects.
    reversed = [10, 0, 0.0001, 0],
    // An edge seen end-on.
    endOn = [5, 5, 5, 5],
    other = [0, 0, 0, 10];
  const { lines, keys } = uniqueSegments([
    ...edge,
    ...reversed,
    ...endOn,
    ...other,
  ]);
  assert.deepEqual(lines, [0, 0, 10, 0, 0, 0, 0, 10]);
  // Hidden edges lying under visible ones are not drawn a second time.
  assert.deepEqual(
    uniqueSegments([10, 0, 0, 0, 3, 3, 4, 4], keys).lines,
    [3, 3, 4, 4],
  );
});

test("sheet linework is split into tiles and joins connected segments", () => {
  const square = [0, 0, 1, 0, 1, 0, 1, 1, 1, 1, 0, 1, 0, 1, 0, 0];
  assert.deepEqual(tiledPaths(square, 0), ["M0,0L1,0L1,1L0,1L0,0"]);
  // A reversed segment still continues the subpath it meets.
  assert.deepEqual(tiledPaths([0, 0, 1, 0, 2, 0, 1, 0], 0), ["M0,0L1,0L2,0"]);
  const far = tiledPaths([0, 0, 1, 0, 100, 100, 101, 100], 10);
  assert.equal(far.length, 2, "distant geometry lands in separate tiles");
});

test("measuring from an edge gives the perpendicular distance", () => {
  const edge = {
    kind: "line" as const,
    a: { u: 0, v: 0 },
    b: { u: 10, v: 0 },
    at: { u: 5, v: 0 },
  };
  const corner = { kind: "point" as const, at: { u: 25, v: 7 } };
  // The foot may lie beyond the edge itself: it is the edge's line that counts.
  assert.deepEqual(pickPair(edge, corner), {
    a: { u: 25, v: 0 },
    b: { u: 25, v: 7 },
  });
  assert.deepEqual(pickPair(corner, edge), {
    a: { u: 25, v: 7 },
    b: { u: 25, v: 0 },
  });
  assert.deepEqual(footOnLine({ u: 1, v: 1 }, { u: 0, v: 0 }, { u: 2, v: 2 }), {
    u: 1,
    v: 1,
  });
});

test("two edges measure their gap when parallel and their length when one", () => {
  const bottom = {
    kind: "line" as const,
    a: { u: 0, v: 0 },
    b: { u: 10, v: 0 },
    at: { u: 2, v: 0 },
  };
  const top = {
    kind: "line" as const,
    a: { u: 10, v: 4 },
    b: { u: 0, v: 4 },
    at: { u: 3, v: 4 },
  };
  assert.deepEqual(pickPair(bottom, top), {
    a: { u: 3, v: 0 },
    b: { u: 3, v: 4 },
  });
  assert.deepEqual(pickPair(bottom, { ...bottom, at: { u: 8, v: 0 } }), {
    a: { u: 0, v: 0 },
    b: { u: 10, v: 0 },
  });
  const slanted = { ...top, b: { u: 0, v: 9 } };
  assert.match(String(pickPair(bottom, slanted)), /not parallel/);
  const onEdge = { kind: "point" as const, at: { u: 4, v: 0 } };
  assert.match(String(pickPair(bottom, onEdge)), /touch/);
});

test("sheet linework deduplicates in steps that report how far along they are", () => {
  const lines: number[] = [];
  for (let i = 0; i < 5000; i++) lines.push(i, 0, i + 1, 0, i + 1, 0, i, 0);
  const steps = uniqueSegmentSteps(lines),
    reported: number[] = [];
  let step = steps.next();
  for (; !step.done; step = steps.next()) reported.push(step.value);
  assert.ok(reported.length > 1);
  assert.ok(
    reported.every((f, i) => f > 0 && f < 1 && f > (reported[i - 1] ?? 0)),
  );
  assert.deepEqual(step.value.lines, uniqueSegments(lines).lines);
  assert.equal(step.value.lines.length, 5000 * 4);
});
