import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectorDetails } from "../web/inspector.js";

test("part inspection labels local outer dimensions and machining steps", () => {
  const details = inspectorDetails({
    kind: "part",
    volume: 540000,
    dimensions: [100, 300, 18],
    material: "Birch multiplex",
    mass: 367.2,
    partCount: 1,
    operations: [{ kind: "drill", toolId: "drill-4", diameter: 4, depth: 12 }],
  });
  assert.deepEqual(details.rows, [
    ["Volume", "540.0 cm³"],
    ["Weight", "367 g"],
    ["Outer width", "100.0 mm"],
    ["Outer height", "300.0 mm"],
    ["Outer thickness", "18.0 mm"],
    ["Material", "Birch multiplex"],
  ]);
  assert.deepEqual(details.operations, ["drill-4 · Ø4.0 mm · depth 12.0 mm"]);
});

test("assembly inspection labels aggregate world bounds", () => {
  const details = inspectorDetails({
    kind: "assembly",
    volume: 1200000,
    dimensions: [600, 500, 900],
    partCount: 12,
    operations: [],
  });
  assert.deepEqual(details.rows.slice(0, 3), [
    ["Volume", "1200.0 cm³"],
    ["Weight", "No material density"],
    ["Parts", "12"],
  ]);
  assert.deepEqual(details.rows.at(-1), ["Overall Z", "900.0 mm"]);
});
