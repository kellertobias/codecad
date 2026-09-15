import { test } from "node:test";
import assert from "node:assert/strict";
import * as b from "brepjs/quick";
import { OpenCascadeEngine } from "../src/engine.js";
import { projectedLines, drawingCurveLines } from "../src/drawing.js";
import { pageSvg } from "../src/reports.js";

test("isometric cube retains all nine visible sharp edges and suppresses rear edges", () => {
  const engine = new OpenCascadeEngine();
  try {
    const shape = engine.own(b.box(10, 10, 10));
    const camera = b.unwrap(b.createCamera([0, 0, 0], [1, -1, 1], [1, 1, 0]));
    const lines = projectedLines(engine, shape, camera);
    assert.equal(lines.visible.length / 6, 9);
    assert.equal(lines.hidden.length, 0);
    const withHidden = projectedLines(engine, shape, camera, true);
    assert.equal(withHidden.hidden.length / 6, 3);
  } finally {
    engine.dispose();
  }
});
test("drawing curves have round joins and caps in the SVG/PDF source", () => {
  const svg = new TextDecoder().decode(
    pageSvg({ width: 100, height: 100, entities: [] }),
  );
  assert.match(svg, /stroke-linecap="round" stroke-linejoin="round"/);
});
test("drawing curve sampling preserves trimmed arc endpoints without chords across the opening", () => {
  const engine = new OpenCascadeEngine();
  try {
    const edge = engine.own(
      b.threePointArc(
        [10, 0, 0],
        [Math.SQRT1_2 * 10, Math.SQRT1_2 * 10, 0],
        [0, 10, 0],
      ),
    );
    const lines = drawingCurveLines(edge);
    assert.ok(lines.length > 12);
    assert.ok(Math.abs(lines[0]! - 10) < 1e-8);
    assert.ok(Math.abs(lines.at(-2)! - 10) < 1e-8);
    for (let n = 0; n < lines.length; n += 6) {
      const midpoint = Math.hypot(
        (lines[n]! + lines[n + 3]!) / 2,
        (lines[n + 1]! + lines[n + 4]!) / 2,
      );
      assert.ok(
        10 - midpoint < 0.011,
        "arc chord error must stay below drawing tolerance",
      );
    }
  } finally {
    engine.dispose();
  }
});
