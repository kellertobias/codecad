import { test } from "node:test";
import assert from "node:assert/strict";
import * as b from "brepjs/quick";
import {
  Project,
  SheetMaterial,
  Shapes,
  Bend,
  cad,
  TechnicalDrawing,
} from "../src/index.js";
import { OpenCascadeEngine } from "../src/engine.js";
import { partEntities } from "../src/manufacturing.js";
import { renderDrawingFormats, projectedLines } from "../src/drawing.js";
import { pdfPages } from "../src/exporters.js";

const rules = {
  kFactor: 0.42,
  minimumInsideRadius: 2,
  defaultRelief: "round" as const,
};
const metal = () => new SheetMaterial({ thickness: 1.5 });

for (const relief of ["round", "rectangular"] as const)
  test(`${relief} relief releases a partial-width flange and unfolds into closed cut contours`, async () => {
    @cad.project({ id: "relief", units: "mm" })
    class Demo extends Project {
      panel;
      constructor() {
        super({ id: "relief" });
        this.panel = metal().makeSheetMetalPart({
          outline: new Shapes.Rectangle({ width: 100, height: 80 }),
          bendRules: rules,
        });
        this.panel.bend(
          new Bend({
            id: "tab",
            start: { x: 20, y: 35 },
            end: { x: 80, y: 35 },
            angle: 90,
            insideRadius: 2,
            direction: "up",
            movingSide: "left",
            autoRelief: true,
            relief,
            reliefWidth: 2,
            reliefDepth: 4,
          }),
        );
        this.panel.subtract(
          new Shapes.Cylinder({ diameter: 5, length: 4, x: 50, y: 60, z: 1 }),
        );
      }
    }
    const project = new Demo(),
      engine = new OpenCascadeEngine();
    try {
      const result = await engine.evaluate({ root: project, revision: 1 });
      assert.deepEqual(result.diagnostics, []);
      assert.equal(result.meshes.length, 1);
      const development = project.panel.unfold();
      assert.equal(development.bends.length, 1);
      assert.equal(
        development.bends[0]!.allowance,
        (Math.PI / 2) * (2 + 0.42 * 1.5),
      );
      assert.ok(engine.bounds(engine.shapes.get(project.panel)!).max.z > 30);
      const flat = await engine.recipe(development.shape.recipe);
      assert.ok(Math.abs(engine.bounds(flat).max.z - 1.5) < 1e-6);
      const unfold = await engine.unfoldFrames(project.panel, 5);
      assert.equal(unfold.length, 5);
      assert.deepEqual(unfold[0]?.matrix, result.meshes[0]?.matrix);
      assert.ok(unfold[0]!.positions.length > 0);
      assert.ok(unfold.at(-1)!.positions.length > 0);
      const entities = await partEntities(engine, project.panel);
      const cuts = entities.filter(
        (e) => e.kind === "polyline" && !/BEND|TANGENT/.test(e.layer),
      );
      assert.equal(
        cuts.length,
        2,
        "one edge-relieved outside loop plus one drilled hole",
      );
      assert.ok(cuts.every((e) => e.kind === "polyline" && e.closed));
      assert.ok(cuts.some((e) => e.kind === "polyline" && e.points.length > 8));
      const drawing = new TechnicalDrawing({
        title: "Relieved bracket",
        drawingNumber: "TEST-01",
      })
        .view({
          id: "iso",
          of: project.panel,
          kind: "isometric",
          at: { x: 20, y: 30 },
          scale: 1,
        })
        .dimension({
          from: { x: 0, y: 0, z: 0 },
          to: { x: 100, y: 0, z: 0 },
          offset: 10,
        })
        .page(
          new TechnicalDrawing({ title: "Flat" }).view({
            id: "flat",
            of: project.panel,
            kind: "flat",
            at: { x: 20, y: 30 },
            scale: 1,
          }),
        );
      const formats = await renderDrawingFormats(engine, drawing);
      assert.equal(formats.pages.length, 2);
      assert.match(new TextDecoder().decode(formats.pages[0]), /100<\/text>/);
      assert.match(new TextDecoder().decode(formats.pages[1]), /2 \/ 2/);
      assert.match(
        Buffer.from(await pdfPages(formats.pages)).toString("latin1"),
        /\/Count 2\b/,
      );
    } finally {
      engine.dispose();
    }
  });

test("folded-profile development adds allowances automatically and preserves snapshot independence", async () => {
  @cad.project({ id: "profile", units: "mm" })
  class Demo extends Project {
    panel;
    constructor() {
      super({ id: "profile" });
      this.panel = metal().makeBentProfile({
        width: 100,
        lengths: [30, 80, 25],
        bendRules: rules,
        bends: [
          { id: "a", direction: "up", angle: 90, insideRadius: 2 },
          { id: "b", direction: "down", angle: 60, insideRadius: 2 },
        ],
      });
    }
  }
  const project = new Demo(),
    engine = new OpenCascadeEngine();
  try {
    const flat = project.panel.unfold();
    assert.ok(
      Math.abs(
        Math.max(...flat.outline.points.map((p) => p.y)) -
          (135 + ((150 * Math.PI) / 180) * (2 + 0.42 * 1.5)),
      ) < 1e-8,
    );
    const recipe = structuredClone(flat.shape.recipe);
    project.panel.subtract(
      new Shapes.Cylinder({ diameter: 5, length: 4, x: 50, y: 10, z: 1 }),
    );
    assert.deepEqual(flat.shape.recipe, recipe);
    assert.deepEqual(
      (await engine.evaluate({ root: project, revision: 1 })).diagnostics,
      [],
    );
    const cam = b.unwrap(b.createCamera([0, 0, 0], [1, -1, 1]));
    const s = engine.subject(project.panel);
    assert.ok(
      projectedLines(engine, s, cam).visible.length <
        projectedLines(engine, s, cam, false, true).visible.length,
      "smooth bend seams are omitted",
    );
  } finally {
    engine.dispose();
  }
});

test("unreleased partial flanges and pierced bend bands are rejected", async () => {
  for (const pierced of [false, true]) {
    @cad.project({ id: "bad", units: "mm" })
    class Demo extends Project {
      constructor() {
        super({ id: "bad" });
        const panel = metal().makeSheetMetalPart({
          outline: new Shapes.Rectangle({ width: 100, height: 80 }),
          bendRules: rules,
        });
        panel.bend(
          new Bend({
            id: "bad",
            start: { x: pierced ? 0 : 20, y: 30 },
            end: { x: pierced ? 100 : 80, y: 30 },
            angle: 90,
            insideRadius: 2,
            direction: "up",
            movingSide: "left",
          }),
        );
        if (pierced)
          panel.subtract(
            new Shapes.Cylinder({ diameter: 3, length: 4, x: 50, y: 32, z: 1 }),
          );
      }
    }
    const engine = new OpenCascadeEngine();
    try {
      const result = await engine.evaluate({ root: new Demo(), revision: 1 });
      assert.equal(result.diagnostics.length, 1);
      assert.match(
        result.diagnostics[0]!.message,
        pierced ? /uncut rectangular/ : /autoRelief/,
      );
    } finally {
      engine.dispose();
    }
  }
});
