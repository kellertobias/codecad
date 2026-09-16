import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BlockMaterial,
  Project,
  Shapes,
  TechnicalDrawing,
  cad,
} from "../src/index.js";
import { hatchTriangles } from "../src/drawing-style.js";
import { OpenCascadeEngine } from "../src/engine.js";
import { renderDrawingFormats } from "../src/drawing.js";

@cad.project({ id: "styled", units: "mm" })
class Styled extends Project {
  constructor() {
    super({ id: "styled" });
    const material = new BlockMaterial({
      drawingStyle: {
        regular: { stroke: "#112233", lineWidth: 0.2 },
        cutaway: {
          stroke: "#334455",
          lineWidth: 0.5,
          hatch: { stroke: "#123456", spacing: 2, angle: 45, lineWidth: 0.13 },
        },
      },
    });
    material
      .makePart({ width: 30, depth: 30, height: 10 })
      .subtract(new Shapes.Box({ width: 10, depth: 10, height: 20 }), {
        x: 10,
        y: 10,
        z: -1,
      });
  }
}
test("material regular and cutaway styles reach SVG and DXF; openings stay unhatched", async () => {
  const project = new Styled(),
    engine = new OpenCascadeEngine();
  try {
    await engine.evaluate({ root: project, revision: 1 });
    const drawing = (cut: boolean) =>
      new TechnicalDrawing({ title: "Style test" }).view({
        id: "plan",
        of: project,
        kind: "top",
        at: { x: 30, y: 30 },
        scale: 1,
        ...(cut ? { cutHeight: 5 } : {}),
      });
    const regular = await renderDrawingFormats(engine, drawing(false));
    assert.match(Buffer.from(regular.svg).toString(), /stroke="#112233"/);
    assert.doesNotMatch(
      Buffer.from(regular.svg).toString(),
      /stroke="#123456"/,
    );
    const cut = await renderDrawingFormats(engine, drawing(true));
    const svg = Buffer.from(cut.svg).toString(),
      dxf = Buffer.from(cut.dxf).toString();
    assert.match(svg, /stroke="#334455" stroke-width="0.5"/);
    assert.match(dxf, /420\n1193046\n370\n13\n/);
    const hatches = [
      ...svg.matchAll(
        /<path d="M([^,]+),([^L]+)L([^,]+),([^"]+)"[^>]*stroke="#123456"/g,
      ),
    ];
    assert.ok(hatches.length > 5);
    for (const hatch of hatches) {
      const x = (Number(hatch[1]) + Number(hatch[3])) / 2;
      const y = (Number(hatch[2]) + Number(hatch[4])) / 2;
      assert.ok(
        !(x > 40.0001 && x < 49.9999 && y > 40.0001 && y < 49.9999),
        "hatch entered the opening",
      );
    }
  } finally {
    engine.dispose();
  }
});

test("title block has an alternating printed scale and configured dimension precision", async () => {
  const project = new Styled(),
    engine = new OpenCascadeEngine();
  try {
    await engine.evaluate({ root: project, revision: 1 });
    const drawing = new TechnicalDrawing({
      title: "Scale test",
      mmPrecision: 1,
    })
      .view({
        id: "plan",
        of: project,
        kind: "top",
        at: { x: 30, y: 30 },
        scale: 0.5,
      })
      .dimension({
        view: "plan",
        from: { x: 0, y: 0, z: 0 },
        to: { x: 12.34, y: 0, z: 0 },
        offset: 8,
      });
    const { svg, dxf } = await renderDrawingFormats(engine, drawing);
    const text = new TextDecoder().decode(svg);
    assert.equal((text.match(/<path[^>]+fill="#20252a"/g) ?? []).length, 3);
    assert.equal((text.match(/<path[^>]+fill="white"/g) ?? []).length, 2);
    assert.match(text, /50 mm PRINTED/);
    assert.match(text, /100\.0 mm REAL/);
    assert.match(text, />12\.3</);
    assert.match(new TextDecoder().decode(dxf), /SCALE_DARK/);
  } finally {
    engine.dispose();
  }
});
test("hatching merges triangle seams and respects line spacing", () => {
  const lines = hatchTriangles(
    [
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
      [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
    ],
    2,
    0,
  );
  assert.equal(lines.length, 5);
  for (const [a, b] of lines) {
    assert.equal(a.x, 0);
    assert.equal(b.x, 10);
    assert.equal(a.y % 2, 0);
  }
});
test("invalid material drawing styles fail early", () => {
  assert.throws(
    () =>
      new BlockMaterial({
        drawingStyle: { cutaway: { hatch: { spacing: 0 } } },
      }),
    /spacing/,
  );
  assert.throws(
    () =>
      new BlockMaterial({
        drawingStyle: { regular: { stroke: "#bad-colour" } },
      }),
    /hex/,
  );
  assert.throws(
    () => new BlockMaterial({ drawingStyle: { regular: { lineWidth: NaN } } }),
    /lineWidth/,
  );
});
