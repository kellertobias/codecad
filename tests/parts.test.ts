import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { SketchSolver } from "../src/document/sketch-solver.js";
import type {
  CadDocument,
  Feature,
  MaterialDefinition,
} from "../src/document/schema.js";
import { DocumentEvaluator } from "../src/kernel/evaluator.js";
import { describeParts, sheetProject } from "../src/kernel/parts.js";
import { OpenCascadeEngine } from "../src/engine.js";
import { csv, cutRows, encodeDxf, partEntities } from "../src/manufacturing.js";
import { nest } from "../src/nesting.js";
import {
  extrude,
  points,
  rectangle,
  solvedDocument,
} from "./support/documents.js";

let solver: SketchSolver;
before(async () => {
  solver = await SketchSolver.create();
});
after(() => solver.dispose());

const birch: MaterialDefinition = {
  id: "birch",
  name: "Birch ply 18",
  kind: "sheet",
  thickness: "t",
  width: "2500",
  height: "1250",
};

/** A shelf panel with a pocket and two drilled holes, and a block that is
 * not sheet stock. */
function shop(parts: CadDocument["parts"] = []) {
  const top = { body: "panel:0", origin: "panel", role: "end" } as const;
  const features: Feature[] = [
    rectangle("s", "XY", "0", "0", "800", "300"),
    extrude("panel", "s", { distance: "t", name: "Shelf" }),
    rectangle("p", "XY", "100", "100", "60", "40", { face: top }),
    extrude("pocket", "p", { operation: "cut", distance: "8", reverse: true }),
    points(
      "at",
      [
        ["30", "150"],
        ["770", "150"],
      ],
      { face: top },
    ),
    {
      id: "holes",
      type: "hole",
      name: "holes",
      sketch: "at",
      kind: "simple",
      diameter: "8",
    },
    rectangle("b", "XY", "1000", "0", "50", "50"),
    extrude("block", "b", { distance: "40", name: "Block" }),
  ];
  return solvedDocument(solver, { t: "18" }, features, {
    materials: [birch],
    parts,
  });
}

test("a blank as deep as a sheet material is thick is a sheet part", () => {
  const document = shop();
  const evaluator = new DocumentEvaluator();
  const { bodies } = evaluator.evaluate(document);
  const info = describeParts(document, bodies);
  assert.deepEqual(
    info.map((p) => [p.name, p.stock, p.material?.id, p.thickness]),
    [
      ["Shelf", "sheet", "birch", 18],
      ["Block", "solid", undefined, undefined],
    ],
  );
  evaluator.dispose();
});

test("forcing sheet stock on a body that does not fit explains why", () => {
  const document = shop([
    { body: "block:0", stock: "sheet", material: "birch", name: "Plinth" },
  ]);
  const evaluator = new DocumentEvaluator();
  const info = describeParts(document, evaluator.evaluate(document).bodies);
  const plinth = info.find((p) => p.body === "block:0")!;
  assert.equal(plinth.name, "Plinth");
  assert.equal(plinth.stock, "solid");
  assert.match(plinth.problem!, /40 mm deep, but Birch ply 18 is 18 mm thick/);
  evaluator.dispose();
});

test("sheet bodies go through the cut list, nesting and DXF output", async () => {
  const document = shop([{ body: "panel:0", quantity: 2 }]);
  const evaluator = new DocumentEvaluator();
  const { bodies } = evaluator.evaluate(document);
  const { root, parts } = sheetProject(document, bodies);
  const rows = cutRows(root);
  assert.deepEqual(
    rows.map((row) => [
      row.label,
      row.material,
      row.width,
      row.height,
      row.thickness,
      row.quantity,
    ]),
    [["Shelf", "Birch ply 18", 800, 300, 18, 2]],
  );
  assert.match(csv(rows), /Shelf/);
  const layouts = nest([...parts.values()]);
  assert.equal(layouts.length, 1);
  assert.equal(layouts[0]!.parts.length, 2);

  const engine = new OpenCascadeEngine();
  try {
    const entities = await partEntities(engine, parts.get("panel:0")!);
    const layers = entities.map((e) => e.layer);
    assert.ok(layers.includes("BLANK_OUTLINE"));
    assert.ok(layers.includes("PART_OUTLINE"));
    // The pocket, 8 mm deep from the top, and two through holes as exact
    // circles where the sketch put them.
    assert.ok(layers.includes("CUT_TOP_D8.000"), layers.join(", "));
    const circles = entities.filter((e) => e.kind === "circle");
    assert.deepEqual(
      circles.map((c) => [c.layer, c.x, c.y, c.radius].map(roundish)),
      [
        ["DRILL_THROUGH_D18.000", 30, 150, 4],
        ["DRILL_THROUGH_D18.000", 770, 150, 4],
      ],
    );
    assert.ok(encodeDxf(entities).length > 1000);
  } finally {
    engine.dispose();
    evaluator.dispose();
  }
});

const roundish = (value: string | number | undefined) =>
  typeof value === "number" ? Math.round(value * 1000) / 1000 : value;
