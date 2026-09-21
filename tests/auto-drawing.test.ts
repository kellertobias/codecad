import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BlockMaterial,
  Project,
  SheetMaterial,
  Shapes,
  TechnicalDrawing,
  cad,
} from "../src/index.js";
import { OpenCascadeEngine } from "../src/engine.js";
import {
  arrangeViews,
  renderDrawingFormats,
  viewCamera,
  type PreparedView,
} from "../src/drawing.js";
import { partEntities } from "../src/manufacturing.js";
import { validateDrawingPlan } from "../src/drawing-plan.js";
import { planDrawing } from "../src/drawing-plan-render.js";
import { viewAngles, viewBasis } from "../src/view-basis.js";

@cad.project({ id: "crate", title: "Crate", units: "mm" })
class Crate extends Project {
  readonly body;
  readonly panel;
  constructor() {
    super();
    // 400 wide (X) × 200 deep (Y) × 100 high (Z), with an off-centre lug so
    // mirrored side views are distinguishable.
    this.body = new BlockMaterial({ id: "pine" }).makePart({
      id: "body",
      width: 400,
      depth: 200,
      height: 100,
    });
    this.body.union(new Shapes.Box({ width: 20, depth: 30, height: 40 }), {
      x: 380,
      y: 0,
      z: 100,
    });
    this.panel = new SheetMaterial({ id: "ply", thickness: 18 })
      .makePart({ id: "panel", width: 300, height: 200 })
      .place({ z: 500 });
    // A notch through the south edge and a window inside the panel.
    this.panel.subtract(new Shapes.Box({ width: 40, depth: 30, height: 30 }), {
      x: 100,
      y: -10,
      z: -5,
    });
    this.panel.subtract(new Shapes.Box({ width: 50, depth: 50, height: 30 }), {
      x: 200,
      y: 100,
      z: -5,
    });
  }
}

test("decorator metadata names a project constructed without options", () => {
  const crate = new Crate();
  assert.equal(crate.id, "crate");
  assert.equal(crate.label, "Crate");
  assert.equal(crate.body.path, "crate/body");
});

test("every view basis is right-handed and looks from its named side", () => {
  for (const angle of viewAngles) {
    const { x, y, toward } = viewBasis(angle);
    const cross = [
      x[1] * y[2] - x[2] * y[1],
      x[2] * y[0] - x[0] * y[2],
      x[0] * y[1] - x[1] * y[0],
    ];
    cross.forEach((value, i) => assert.ok(Math.abs(value - toward[i]!) < 1e-9));
    const camera = viewCamera(angle);
    camera.xAxis.forEach((value, i) =>
      assert.ok(Math.abs(value - x[i]!) < 1e-9, `${angle} x axis`),
    );
    camera.yAxis.forEach((value, i) =>
      assert.ok(Math.abs(value - y[i]!) < 1e-9, `${angle} y axis`),
    );
  }
  assert.deepEqual(viewBasis("right").toward, [1, 0, 0]);
  assert.deepEqual(viewBasis("left").toward, [-1, 0, 0]);
});

test("automatic views share a standard scale and line up in third angle", () => {
  const placed = arrangeViews(
    [
      { kind: "front", width: 1200, height: 700 },
      { kind: "top", width: 1200, height: 600 },
      { kind: "right", width: 600, height: 700 },
      { kind: "isometric", width: 1300, height: 1100 },
    ],
    { x: 20, y: 16, width: 380, height: 203 },
  );
  const [front, top, right, iso] = placed;
  assert.ok(placed.every((view) => view.scale === 0.1));
  assert.equal(top!.left, front!.left);
  assert.ok(top!.top + 600 * 0.1 < front!.top);
  assert.equal(right!.top, front!.top);
  assert.ok(right!.left > front!.left + 1200 * 0.1);
  assert.ok(iso!.left > right!.left + 600 * 0.1);
  for (const [view, width, height] of [
    [front, 120, 70],
    [top, 120, 60],
    [right, 60, 70],
    [iso, 130, 110],
  ] as const) {
    assert.ok(view!.left >= 20 && view!.left + width <= 400);
    assert.ok(view!.top >= 16 && view!.top + height <= 219);
  }
});

test("standard views need no positions or scales and dimension the subject", async () => {
  const project = new Crate(),
    engine = new OpenCascadeEngine();
  try {
    await engine.evaluate({ root: project, revision: 1 });
    const views: PreparedView[] = [];
    const { svg } = await renderDrawingFormats(
      engine,
      new TechnicalDrawing({ title: "Crate" }).standardViews(project.body),
      (view) => views.push(view),
    );
    assert.deepEqual(
      views.map((entry) => entry.view.id),
      ["front", "top", "right", "isometric"],
    );
    const text = Buffer.from(svg).toString();
    for (const value of ["400", "200", "140"])
      assert.match(text, new RegExp(`>${value}<`), `dimension ${value}`);
    assert.match(text, /FRONT {3}1:5</);
    // Seen from +X the lug at the front (Y=0) is at the left of the view.
    const right = views[2]!,
      lug = right.linework!.visible.filter((_, i) => i % 3 === 1);
    assert.ok(right.min.x === 0 || Math.abs(right.min.x) < 1e-6);
    assert.ok(Math.max(...lug) > 139);
    const high = right.linework!.visible.flatMap((value, i, all) =>
      i % 3 === 0 && all[i + 1]! > 100.5 ? [value] : [],
    );
    assert.ok(Math.max(...high) <= 30 + 1e-6);
  } finally {
    engine.dispose();
  }
});

test("edge-breaking through cuts produce a finished part outline", async () => {
  const project = new Crate(),
    engine = new OpenCascadeEngine();
  try {
    await engine.evaluate({ root: project, revision: 1 });
    const entities = await partEntities(engine, project.panel);
    const layers = entities.map((entity) => entity.layer);
    assert.deepEqual(layers, [
      "BLANK_OUTLINE",
      "PART_OUTLINE",
      "CUT_THROUGH_D18.000",
    ]);
    const outline = entities[1]!;
    assert.ok(outline.kind === "polyline" && outline.closed);
    const area =
      Math.abs(
        outline.points.reduce((sum, p, i) => {
          const q = outline.points[(i + 1) % outline.points.length]!;
          return sum + p.x * q.y - q.x * p.y;
        }, 0),
      ) / 2;
    assert.ok(Math.abs(area - (300 * 200 - 40 * 20)) < 1e-3);
  } finally {
    engine.dispose();
  }
});

test("a saved plan renders centred views and model-space dimensions", async () => {
  const project = new Crate(),
    engine = new OpenCascadeEngine();
  try {
    await engine.evaluate({ root: project, revision: 1 });
    const plan = validateDrawingPlan({
      version: 1,
      title: "Crate sheet",
      items: [
        {
          id: "v1",
          kind: "view",
          subject: "crate/body",
          angle: "front",
          x: 20,
          y: 20,
          width: 200,
          height: 100,
          scale: 5,
          label: "",
        },
        {
          id: "gone",
          kind: "view",
          subject: "crate/missing",
          angle: "top",
          x: 230,
          y: 20,
          width: 100,
          height: 100,
          scale: 5,
          label: "",
        },
        {
          id: "d1",
          kind: "dimension",
          view: "v1",
          u1: 0,
          v1: 0,
          u2: 400,
          v2: 0,
          offset: 8,
          label: "",
        },
        { id: "n1", kind: "text", x: 20, y: 200, text: "Glue up", size: 5 },
      ],
    });
    const { drawing, warnings } = planDrawing(plan, project);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /crate\/missing/);
    const views: PreparedView[] = [];
    const { svg } = await renderDrawingFormats(engine, drawing, (view) =>
      views.push(view),
    );
    const text = Buffer.from(svg).toString();
    assert.match(text, />400</);
    assert.match(text, /font-size="5"[^>]*>Glue up</);
    assert.match(text, />Front {3}1:5</);
    // 400 × 140 at 1:5 is 80 × 28 mm, centred in the 200 × 100 mm frame.
    assert.match(text, /M80,84L160,84|M160,84L80,84/);
  } finally {
    engine.dispose();
  }
});

test("a plan view leaves out the parts switched off for it", async () => {
  const project = new Crate(),
    engine = new OpenCascadeEngine();
  try {
    await engine.evaluate({ root: project, revision: 1 });
    const view = {
      id: "v1",
      kind: "view" as const,
      subject: "*",
      angle: "front" as const,
      x: 20,
      y: 20,
      width: 200,
      height: 100,
      scale: 5,
      label: "",
    };
    const sheet = (hiddenParts: string[]) =>
      validateDrawingPlan({
        version: 1,
        title: "Crate sheet",
        items: [{ ...view, hiddenParts }],
      });
    const height = async (hiddenParts: string[]) => {
      const { drawing, warnings } = planDrawing(sheet(hiddenParts), project);
      const prepared: PreparedView[] = [];
      await renderDrawingFormats(engine, drawing, (item) =>
        prepared.push(item),
      );
      return { span: prepared[0]!.max.y - prepared[0]!.min.y, warnings };
    };
    // The panel floats 500 mm above the 100 mm body, so dropping it collapses
    // the front view to the body alone.
    const whole = await height([]);
    assert.equal(whole.warnings.length, 0);
    assert.ok(whole.span > 500);
    const bodyOnly = await height(["crate/panel"]);
    assert.equal(bodyOnly.warnings.length, 0);
    assert.equal(Math.round(bodyOnly.span), 140);
    const unknown = await height(["crate/gone"]);
    assert.match(unknown.warnings[0]!, /hides missing component crate\/gone/);
    assert.ok(unknown.span > 500);
  } finally {
    engine.dispose();
  }
});
