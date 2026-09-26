import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { SketchSolver } from "../src/document/sketch-solver.js";
import type {
  DrawingSheet,
  MaterialDefinition,
} from "../src/document/schema.js";
import { DocumentEvaluator } from "../src/kernel/evaluator.js";
import { describeParts } from "../src/kernel/parts.js";
import { partSheets, renderSheet } from "../src/kernel/drawings.js";
import { OpenCascadeEngine } from "../src/engine.js";
import { pageSvg, pagesDxf } from "../src/reports.js";
import { pdf } from "../src/exporters.js";
import { extrude, rectangle, solvedDocument } from "./support/documents.js";

let solver: SketchSolver;
before(async () => {
  solver = await SketchSolver.create();
});
after(() => solver.dispose());

const ply: MaterialDefinition = {
  id: "ply",
  name: "Ply",
  kind: "sheet",
  thickness: "18",
};
const oak: MaterialDefinition = { id: "oak", name: "Oak", kind: "solid" };

function model() {
  const document = solvedDocument(
    solver,
    {},
    [
      rectangle("side-s", "YZ", "0", "0", "300", "400"),
      extrude("side", "side-s"),
      rectangle("bottom-s", "XY", "18", "0", "400", "300"),
      extrude("bottom", "bottom-s"),
      rectangle("block-s", "XY", "100", "100", "80", "80"),
      extrude("block", "block-s", { distance: "120" }),
    ],
    {
      materials: [ply, oak],
      parts: [{ body: "block:0", material: "oak", stock: "solid" }],
    },
  );
  const evaluator = new DocumentEvaluator();
  const { bodies } = evaluator.evaluate(document);
  return { document, evaluator, bodies, info: describeParts(document, bodies) };
}

test("a sheet renders views, an oblique section, a detail and an exploded view", async () => {
  const { document, evaluator, bodies, info } = model();
  const sheet: DrawingSheet = {
    id: "s",
    name: "Cabinet",
    size: "A3",
    views: [
      { id: "front", kind: "view", angle: "front" },
      { id: "aux", kind: "view", angle: "auxiliary", direction: [1, -1, 0.5] },
      // Diagonally through the side, the bottom and the block.
      {
        id: "cut",
        kind: "section",
        origin: ["100", "150", "0"],
        normal: [1, 1, 0],
        label: "Section A-A",
      },
      {
        id: "zoom",
        kind: "detail",
        of: "front",
        center: { x: 18, y: 18 },
        radius: 40,
      },
      { id: "apart", kind: "exploded", distance: "100" },
      { id: "blank", kind: "flat", part: "bottom:0" },
    ],
  };
  const engine = new OpenCascadeEngine();
  try {
    const page = await renderSheet(engine, document, bodies, info, sheet);
    const layers = new Set(page.entities.map((e) => e.layer));
    // Each material hatched its own way: sheet stock once, solid crossed.
    assert.ok(layers.has("SECTION_HATCH_ply"), [...layers].join(","));
    assert.ok(layers.has("SECTION_HATCH_oak"));
    const hatch = (layer: string) =>
      page.entities.filter((e) => e.layer === layer).length;
    assert.ok(
      hatch("SECTION_HATCH_ply") > 10 && hatch("SECTION_HATCH_oak") > 10,
    );
    assert.ok(hatch("VISIBLE") > 30);
    assert.equal(page.entities.filter((e) => e.layer === "DETAIL").length, 2);
    assert.ok(layers.has("PART_OUTLINE"));
    const labels = page.entities.flatMap((e) =>
      e.kind === "text" ? [e.text] : [],
    );
    assert.ok(labels.some((t) => t.startsWith("Section A-A")));
    // The same page as SVG, DXF and PDF.
    const svg = new TextDecoder().decode(pageSvg(page));
    assert.match(svg, /^<svg/);
    assert.ok(svg.length > 10000);
    const dxf = new TextDecoder().decode(pagesDxf([page]));
    assert.match(dxf, /SECTION_HATCH_oak/);
    const file = await pdf(pageSvg(page));
    assert.equal(new TextDecoder().decode(file.slice(0, 5)), "%PDF-");
  } finally {
    engine.dispose();
    evaluator.dispose();
  }
});

test("every sheet part gets a manufacturing sheet", async () => {
  const { document, evaluator, bodies, info } = model();
  const sheets = partSheets(info);
  assert.deepEqual(
    sheets.map((s) => s.id),
    ["part:side:0", "part:bottom:0"],
  );
  const engine = new OpenCascadeEngine();
  try {
    const page = await renderSheet(engine, document, bodies, info, sheets[1]!);
    assert.ok(page.entities.some((e) => e.layer === "PART_OUTLINE"));
    assert.ok(page.entities.some((e) => e.layer === "VISIBLE"));
  } finally {
    engine.dispose();
    evaluator.dispose();
  }
});

test("a section's cut line is drawn on the views that see its plane edge-on", async () => {
  const { document, evaluator, bodies, info } = model();
  const sheet: DrawingSheet = {
    id: "s",
    name: "Sections",
    size: "A3",
    views: [
      { id: "top", kind: "view", angle: "top" },
      { id: "front", kind: "view", angle: "front" },
      {
        id: "cut",
        kind: "section",
        label: "B-B",
        origin: ["0", "150", "0"],
        normal: [0, 1, 0],
      },
    ],
  };
  const engine = new OpenCascadeEngine();
  try {
    const page = await renderSheet(engine, document, bodies, info, sheet);
    const marks = page.entities.filter((e) => e.layer === "SECTION_LINE");
    // One line on the top view (the front view looks along the normal)
    // and the letter at both of its ends.
    const lines = marks.filter((e) => e.kind !== "text");
    const letters = marks.filter((e) => e.kind === "text");
    assert.equal(lines.length, 1);
    assert.deepEqual(
      letters.map((e) => (e.kind === "text" ? e.text : "")),
      ["B", "B"],
    );
    // Across the top view, level: y = 150 is a horizontal line there.
    const [line] = lines;
    assert.ok(line!.kind === "polyline");
    const ys = line!.kind === "polyline" ? line!.points.map((p) => p.y) : [];
    assert.ok(Math.abs(ys[0]! - ys[1]!) < 1e-6);
    assert.match(new TextDecoder().decode(pageSvg(page)), /stroke-dasharray/);
  } finally {
    engine.dispose();
    evaluator.dispose();
  }
});
