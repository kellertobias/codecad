import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as b from "brepjs/quick";
import { SketchSolver } from "../src/document/sketch-solver.js";
import type {
  Feature,
  JointFeature,
  MaterialDefinition,
} from "../src/document/schema.js";
import {
  DocumentEvaluator,
  type Body,
  type Evaluation,
} from "../src/kernel/evaluator.js";
import {
  contact,
  jointsFor,
  panelOf,
  type Panel,
} from "../src/kernel/joints.js";
import { describeParts, sheetProject } from "../src/kernel/parts.js";
import { billOfMaterials } from "../src/kernel/bom.js";
import { OpenCascadeEngine } from "../src/engine.js";
import { dominoEdgeFiles, partEntities } from "../src/manufacturing.js";
import { extrude, rectangle, solvedDocument } from "./support/documents.js";

let solver: SketchSolver;
before(async () => {
  solver = await SketchSolver.create();
});
after(() => solver.dispose());

const ply: MaterialDefinition = {
  id: "ply",
  name: "Ply 18",
  kind: "sheet",
  thickness: "18",
};

/** A side standing on the YZ plane (x 0..18, y 0..300, z 0..h) and
 * whatever else is given. */
function build(features: Feature[], h = "400") {
  const document = solvedDocument(
    solver,
    { h },
    [
      rectangle("side-s", "YZ", "0", "0", "300", "h"),
      extrude("side", "side-s"),
      ...features,
    ],
    { materials: [ply] },
  );
  const evaluator = new DocumentEvaluator();
  return { document, evaluator, result: evaluator.evaluate(document) };
}

/** An 18 mm panel on the XY plane from (x, y), `w` by `d`. */
const flat = (id: string, x: string, y: string, w: string, d: string) => [
  rectangle(`${id}-s`, "XY", x, y, w, d),
  extrude(id, `${id}-s`),
];

const panel = (result: Evaluation, id: string): Panel => {
  const body = result.bodies.find((b) => b.id === id)!;
  const p = panelOf(body);
  assert.ok(typeof p !== "string", String(p));
  return p;
};
const volume = (body: Body) => b.unwrap(b.measureVolume(body.shape));
const bodyOf = (result: Evaluation, id: string) =>
  result.bodies.find((body) => body.id === id)!;
const ok = (evaluation: Evaluation) => {
  for (const [id, status] of evaluation.status)
    assert.ok(
      status.state === "ok",
      `${id}: ${status.state === "error" ? status.message : status.state}`,
    );
};
/** How much two bodies share: nothing, when a joint fits. */
const clash = (a: Body, c: Body) => {
  const common = b.intersect(a.shape, c.shape);
  return common.ok ? b.unwrap(b.measureVolume(common.value)) : 0;
};
const near = (actual: number, expected: number, tolerance = 1e-6) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)),
    `${actual} ≈ ${expected}`,
  );

const joint = (
  kind: JointFeature["kind"],
  a: string,
  c: string,
  rest: Partial<JointFeature> = {},
): JointFeature => ({
  id: "j",
  type: "joint",
  name: "Joint",
  kind,
  a,
  b: c,
  ...rest,
});

test("joints are offered by how two panels meet", () => {
  // A bottom at the side's foot (an L), a shelf half-way (a T), a panel
  // beside the bottom (edge to edge), one on top of it (face to face) and
  // one far away.
  const { result, evaluator } = build([
    ...flat("bottom", "18", "0", "400", "300"),
    rectangle("shelf-s", "YZ", "0", "150", "300", "18", {
      face: { body: "side:0", origin: "side", role: "end" },
    }),
    extrude("shelf", "shelf-s", { distance: "400" }),
    ...flat("beside", "418", "0", "200", "300"),
    rectangle("lid-s", "XY", "18", "0", "400", "300", {
      face: { body: "bottom:0", origin: "bottom", role: "end" },
    }),
    extrude("lid", "lid-s"),
    ...flat("far", "2000", "0", "100", "100"),
  ]);
  ok(result);
  const offered = (a: string, c: string) =>
    jointsFor(contact(panel(result, a), panel(result, c)));
  assert.deepEqual(offered("bottom:0", "side:0"), [
    "finger",
    "domino",
    "dowel",
    "screw",
    "rabbet",
    "miter",
  ]);
  assert.deepEqual(offered("shelf:0", "side:0"), [
    "domino",
    "dowel",
    "screw",
    "dado",
    "finger",
  ]);
  assert.deepEqual(offered("bottom:0", "beside:0"), ["domino", "dowel"]);
  assert.deepEqual(offered("bottom:0", "lid:0"), ["screw"]);
  assert.deepEqual(offered("bottom:0", "far:0"), []);
  const apart = contact(panel(result, "bottom:0"), panel(result, "far:0"));
  assert.equal(
    apart.kind === "none" && apart.reason,
    "bottom and far do not touch",
  );
  evaluator.dispose();
});

test("a finger joint interlocks and follows a changed panel", () => {
  for (const h of ["400", "455"]) {
    const plain = build([...flat("bottom", "18", "0", "400", "300")], h);
    const before = plain.result.bodies.map(volume);
    const { result, evaluator } = build(
      [
        ...flat("bottom", "18", "0", "400", "300"),
        joint("finger", "bottom:0", "side:0", { fingerWidth: "40" }),
      ],
      h,
    );
    ok(result);
    const side = bodyOf(result, "side:0");
    const bottom = bodyOf(result, "bottom:0");
    // The bottom now reaches through the side, and the two share nothing:
    // what one gained at the corner the other lost.
    near(clash(side, bottom), 0, 1e-6);
    near(volume(side) + volume(bottom), before[0]! + before[1]!, 1e-9);
    assert.ok(volume(side) < before[0]!);
    // The bottom's blank grew by the side's thickness.
    const grownX = bottom.blank!.outline.map((p) => p.x);
    near(Math.max(...grownX) - Math.min(...grownX), 418);
    assert.ok(bottom.machining.length > 2);
    plain.evaluator.dispose();
    evaluator.dispose();
  }
});

test("dominos cut matching mortises, edge setups and a BOM line", async () => {
  const { result, evaluator, document } = build([
    ...flat("bottom", "18", "0", "400", "300"),
    joint("domino", "bottom:0", "side:0", { count: "3", domino: "5x30" }),
  ]);
  ok(result);
  const bottom = bodyOf(result, "bottom:0");
  const side = bodyOf(result, "side:0");
  assert.equal(bottom.machining.filter((m) => m.kind === "domino").length, 3);
  assert.equal(side.machining.filter((m) => m.kind === "domino").length, 3);
  assert.deepEqual(result.hardware, [
    { kind: "domino", size: "5x30", count: 3, feature: "j" },
  ]);
  const { parts } = sheetProject(document, result.bodies);
  const engine = new OpenCascadeEngine();
  try {
    // Into the bottom's edge: a separate edge setup, noted on the face DXF
    // and drawn in an edge file.
    const edge = await partEntities(engine, parts.get("bottom:0")!);
    assert.equal(
      edge.filter((e) => e.layer === "REFERENCE_EDGE_SETUP").length,
      3,
    );
    const files = await dominoEdgeFiles(engine, parts.get("bottom:0")!);
    assert.equal(files.size, 1);
    const [drawing] = [...files.values()];
    assert.equal(
      drawing!.filter((e) => e.layer.startsWith("DOMINO_EDGE_")).length,
      3,
    );
    // Into the side's face: pockets 15 mm deep.
    const face = await partEntities(engine, parts.get("side:0")!);
    assert.equal(
      face.filter((e) => /^DOMINO_(TOP|BOTTOM)_D15\.000$/.test(e.layer)).length,
      3,
    );
  } finally {
    engine.dispose();
    evaluator.dispose();
  }
});

test("dowels and screws drill both panels and go into the BOM", async () => {
  const { result, evaluator, document } = build([
    ...flat("bottom", "18", "0", "400", "300"),
    joint("dowel", "bottom:0", "side:0", { count: "2" }),
    { ...joint("screw", "bottom:0", "side:0", { count: "3" }), id: "k" },
  ]);
  ok(result);
  const side = bodyOf(result, "side:0");
  const bottom = bodyOf(result, "bottom:0");
  assert.deepEqual(
    side.machining.map((m) => m.kind),
    ["drill", "drill", ...Array(3).fill(["drill", "countersink"]).flat()],
  );
  assert.deepEqual(
    bottom.machining.map((m) => m.kind),
    Array(5).fill("edge-drill"),
  );
  const bom = billOfMaterials(
    describeParts(document, result.bodies),
    result.hardware,
  );
  assert.deepEqual(
    bom
      .filter((row) => row.kind === "hardware")
      .map((row) => [row.name, row.size, row.quantity]),
    [
      ["Dowel", "8x30", 2],
      ["Screw", "4x40", 3],
    ],
  );
  const { parts } = sheetProject(document, result.bodies);
  const engine = new OpenCascadeEngine();
  try {
    const files = await dominoEdgeFiles(engine, parts.get("bottom:0")!);
    const [drawing] = [...files.values()];
    assert.equal(
      drawing!.filter((e) => e.layer.startsWith("DRILL_EDGE_")).length,
      5,
    );
    const face = await partEntities(engine, parts.get("side:0")!);
    assert.equal(face.filter((e) => e.kind === "circle").length, 2 + 6);
  } finally {
    engine.dispose();
    evaluator.dispose();
  }
});

test("dados, rabbets and miters keep the panels apart", () => {
  const cases: [JointFeature["kind"], Feature[]][] = [
    [
      "dado",
      [
        rectangle("shelf-s", "YZ", "0", "150", "300", "18", {
          face: { body: "side:0", origin: "side", role: "end" },
        }),
        extrude("shelf", "shelf-s", { distance: "400" }),
      ],
    ],
    ["rabbet", flat("shelf", "18", "0", "400", "300")],
    ["miter", flat("shelf", "18", "0", "400", "300")],
  ];
  for (const [kind, panels] of cases) {
    const plain = build(panels);
    const before = plain.result.bodies.map(volume);
    const { result, evaluator } = build([
      ...panels,
      joint(kind, "shelf:0", "side:0", kind === "miter" ? {} : { depth: "8" }),
    ]);
    ok(result);
    const side = bodyOf(result, "side:0");
    const shelf = bodyOf(result, "shelf:0");
    near(clash(side, shelf), 0);
    // A housing takes from the side what the shelf gains; a miter splits
    // the corner between them.
    near(volume(side) + volume(shelf), before[0]! + before[1]!, 1e-9);
    plain.evaluator.dispose();
    evaluator.dispose();
  }
});

test("a joint that no longer fits fails with the reason", () => {
  const { result, evaluator } = build([
    ...flat("bottom", "50", "0", "400", "300"),
    joint("finger", "bottom:0", "side:0"),
  ]);
  const status = result.status.get("j")!;
  assert.equal(status.state, "error");
  assert.match(status.state === "error" ? status.message : "", /do not touch/);
  evaluator.dispose();
});

test("crossing panels get a half-lap, a shelf a through finger joint", () => {
  // A side from y -150..150, z -200..200, crossed by a panel lying across
  // it at mid-height.
  const document = solvedDocument(solver, {}, [
    rectangle("side-s", "YZ", "-150", "-200", "300", "400"),
    extrude("side", "side-s"),
    rectangle("cross-s", "XY", "-100", "-50", "200", "100"),
    extrude("cross", "cross-s", { extent: "symmetric", distance: "18" }),
    joint("halfLap", "side:0", "cross:0"),
  ]);
  const evaluator = new DocumentEvaluator();
  const result = evaluator.evaluate(document);
  ok(result);
  const offered = jointsFor(
    contact(panel(result, "side:0"), panel(result, "cross:0")),
  );
  assert.deepEqual(offered, ["halfLap"]);
  near(clash(bodyOf(result, "side:0"), bodyOf(result, "cross:0")), 0);
  evaluator.dispose();

  const tee = build([
    rectangle("shelf-s", "YZ", "0", "150", "300", "18", {
      face: { body: "side:0", origin: "side", role: "end" },
    }),
    extrude("shelf", "shelf-s", { distance: "400" }),
    joint("finger", "shelf:0", "side:0", { fingerWidth: "30" }),
  ]);
  ok(tee.result);
  near(clash(bodyOf(tee.result, "side:0"), bodyOf(tee.result, "shelf:0")), 0);
  tee.evaluator.dispose();
});
