import { test } from "node:test";
import assert from "node:assert/strict";
import * as b from "brepjs/quick";
import {
  KeyboardCase,
  caseWidth,
  keyboardCase,
  insideProfile,
} from "../examples/keyboard-case/project.js";
import { OpenCascadeEngine } from "../src/engine.js";
import { partEntities } from "../src/manufacturing.js";
import { Vector3 } from "three";
import { renderDrawingFormats } from "../src/drawing.js";
import { pdfPages } from "../src/exporters.js";

test("keyboard shell has twelve slots, four bends, aligned MDF interfaces and no wood/metal overlap", async () => {
  const project = new KeyboardCase(),
    engine = new OpenCascadeEngine();
  try {
    assert.equal(caseWidth, 216);
    assert.equal(keyboardCase.columns, 2);
    assert.equal(keyboardCase.rows, 6);
    const slotOrigins = project.shell.operations.map((op) =>
      op.recipe.kind === "transform" ? op.recipe.matrix : [],
    );
    assert.equal(new Set(slotOrigins.map((m) => m[12])).size, 2);
    assert.equal(new Set(slotOrigins.map((m) => m[13])).size, 6);
    assert.equal(project.shell.operations.length, 12);
    assert.deepEqual(
      project.shell.bends.map((b) => b.options.angle),
      [90, 90, 70, 110],
    );
    assert.ok(project.shell.bends.every((b) => b.options.insideRadius === 5));
    assert.equal(
      project.registry.all.filter((c) => c.id.startsWith("stud-")).length,
      4,
    );
    const result = await engine.evaluate({ root: project, revision: 1 });
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.meshes.length, 7);
    const unfolding = await engine.unfoldFrames(project.shell, 5);
    assert.equal(unfolding.length, 5);
    assert.ok(unfolding.every((frame) => frame.indices.length > 0));
    const shell = engine.subject(project.shell);
    for (const wood of [project.left, project.right]) {
      const common = engine.own(
        b.unwrap(b.intersect(shell, engine.subject(wood))),
      );
      assert.ok(
        Math.abs(b.unwrap(b.measureVolume(common))) < 0.01,
        "Wood must not intersect the bent shell",
      );
    }
    const frame = project.shell.interface("wood-cheek").worldMatrix();
    assert.ok(new Vector3().applyMatrix4(frame).length() < 1e-6);
    assert.ok(
      new Vector3(1, 0, 0)
        .transformDirection(frame)
        .distanceTo(new Vector3(0, 1, 0)) < 1e-6,
    );
    const edges = await partEntities(engine, project.shell);
    assert.equal(edges.filter((e) => e.layer.startsWith("BEND_")).length, 4);
    assert.equal(
      edges.filter((e) => e.layer === "TANGENT_BEND_LIMIT").length,
      8,
    );
    assert.equal(
      edges.filter((e) => e.layer.startsWith("CUT_THROUGH")).length,
      12,
    );
    const ends = insideProfile();
    assert.ok(Math.abs(ends[0]!.y) < 1e-6);
    assert.ok(Math.abs(ends.at(-1)!.y) < 1e-6);
    assert.equal(project.left.material.thickness, keyboardCase.mdfThickness);
    const drawing = await renderDrawingFormats(engine, project.drawing());
    assert.equal(drawing.pages.length, 2);
    const page1 = new TextDecoder().decode(drawing.pages[0]);
    const page2 = new TextDecoder().decode(drawing.pages[1]);
    assert.match(page1, /216 SHELL/);
    assert.match(page1, /20°/);
    assert.match(page1, /GRAPHIC SCALE/);
    assert.match(page1, /KB-001/);
    assert.match(page2, /BEND SCHEDULE/);
    assert.match(page2, /2 \/ 2/);
    assert.match(new TextDecoder().decode(drawing.dxf), /CENTER/);
    assert.match(
      Buffer.from(await pdfPages(drawing.pages)).toString("latin1"),
      /\/Count 2\b/,
    );
  } finally {
    engine.dispose();
  }
});
