import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { SketchSolver } from "../src/document/sketch-solver.js";
import { evaluateVariables } from "../src/document/variables.js";
import {
  addConstraint,
  addLine,
  addRectangle,
  addSlot,
  applicableConstraints,
  applicableDimensions,
  remove,
  solveDocument,
  toggleConstruction,
} from "../src/document/sketch-edit.js";
import { detectProfiles } from "../src/document/profiles.js";
import {
  emptyDocument,
  readDocument,
  type CadDocument,
  type SketchFeature,
} from "../src/document/schema.js";

let solver: SketchSolver;
before(async () => {
  solver = await SketchSolver.create();
});
after(() => solver.dispose());

const empty = (): SketchFeature => ({
  id: "s",
  type: "sketch",
  name: "Sketch",
  plane: "XY",
  entities: [],
  constraints: [],
});
const none = evaluateVariables([]);

test("a drawn rectangle is square and free to move and resize", () => {
  const { sketch, created } = addRectangle(
    empty(),
    { x: 0, y: 0 },
    { x: 60, y: 40 },
  );
  assert.equal(created.length, 8);
  const solved = solver.solve(sketch, none);
  assert.equal(solved.status, "solved");
  // Position (2) and size (2).
  assert.equal(solved.dof, 4);
  assert.equal(detectProfiles(solved.sketch).regions[0]!.area, 2400);
});

test("nearly horizontal lines are made horizontal, others left alone", () => {
  const flat = addLine(empty(), { x: 0, y: 0 }, { x: 100, y: 3 });
  assert.deepEqual(
    flat.sketch.constraints.map((c) => c.type),
    ["horizontal"],
  );
  const steep = addLine(empty(), { x: 0, y: 0 }, { x: 2, y: 100 });
  assert.deepEqual(
    steep.sketch.constraints.map((c) => c.type),
    ["vertical"],
  );
  const slanted = addLine(empty(), { x: 0, y: 0 }, { x: 100, y: 40 });
  assert.equal(slanted.sketch.constraints.length, 0);
});

test("a line can start at an existing point, sharing it", () => {
  const first = addLine(empty(), { x: 0, y: 0 }, { x: 100, y: 0 });
  const end = first.created[1]!;
  const second = addLine(first.sketch, { id: end }, { x: 100, y: 50 });
  const points = second.sketch.entities.filter((e) => e.type === "point");
  assert.equal(points.length, 3);
});

test("a slot keeps round ends and parallel sides when solved", () => {
  const { sketch } = addSlot(empty(), { x: 0, y: 0 }, { x: 80, y: 0 }, 10);
  const solved = solver.solve(sketch, none);
  assert.equal(solved.status, "solved");
  assert.deepEqual(solved.conflicting, []);
  assert.deepEqual(solved.redundant, []);
  // Position (2), direction (1), length (1) and width (1).
  assert.equal(solved.dof, 5);
  const region = detectProfiles(solved.sketch).regions[0]!;
  assert.ok(
    Math.abs(region.area - (80 * 20 + Math.PI * 100)) < 1,
    `${region.area}`,
  );
});

test("deleting a corner point takes its lines, constraints and orphans", () => {
  const { sketch } = addRectangle(empty(), { x: 0, y: 0 }, { x: 60, y: 40 });
  const corner = sketch.entities.find((e) => e.type === "point")!;
  const after = remove(sketch, new Set([corner.id]));
  // Two lines used the corner; the other two stay with their three points.
  assert.equal(after.entities.filter((e) => e.type === "line").length, 2);
  assert.equal(after.entities.filter((e) => e.type === "point").length, 3);
  const lineIds = new Set(after.entities.map((e) => e.id));
  for (const c of after.constraints)
    assert.ok("line" in c && lineIds.has(c.line));
});

test("deleting a line keeps points another line still uses", () => {
  const { sketch } = addRectangle(empty(), { x: 0, y: 0 }, { x: 60, y: 40 });
  const line = sketch.entities.find((e) => e.type === "line")!;
  const after = remove(sketch, new Set([line.id]));
  assert.equal(after.entities.filter((e) => e.type === "point").length, 4);
  assert.equal(after.entities.filter((e) => e.type === "line").length, 3);
});

test("construction toggles on for the selection, then off again", () => {
  const { sketch, created } = addLine(empty(), { x: 0, y: 0 }, { x: 10, y: 5 });
  const line = new Set([created[2]!]);
  const on = toggleConstruction(sketch, line);
  assert.equal(
    on.entities.find((e) => e.id === created[2])?.construction,
    true,
  );
  const off = toggleConstruction(on, line);
  assert.equal(
    off.entities.find((e) => e.id === created[2])?.construction,
    undefined,
  );
});

test("the toolbar offers constraints and dimensions that fit the selection", () => {
  const { sketch } = addRectangle(empty(), { x: 0, y: 0 }, { x: 60, y: 40 });
  const lines = sketch.entities
    .filter((e) => e.type === "line")
    .map((e) => e.id);
  assert.deepEqual(
    applicableConstraints(sketch, [lines[0]!, lines[2]!]).map((o) => o.label),
    ["Parallel", "Perpendicular", "Equal"],
  );
  const dimensions = applicableDimensions(sketch, [lines[0]!]);
  assert.deepEqual(
    dimensions.map((d) => [
      d.label,
      "value" in d.constraint && d.constraint.value,
    ]),
    [
      ["Distance", "60"],
      ["Horizontal distance", "60"],
      ["Vertical distance", "0"],
    ],
  );
  const between = applicableDimensions(sketch, [lines[0]!, lines[2]!]);
  assert.deepEqual(
    between.map((d) => [
      d.label,
      "value" in d.constraint && d.constraint.value,
    ]),
    [["Distance between lines", "40"]],
  );
});

test("changing a variable re-solves every sketch that uses it", () => {
  const panel = (id: string) => {
    const drawn = addRectangle(
      { ...empty(), id },
      { x: 0, y: 0 },
      { x: 50, y: 50 },
    );
    const points = drawn.sketch.entities.filter((e) => e.type === "point");
    return addConstraint(drawn.sketch, {
      type: "distance",
      a: points[0]!.id,
      b: points[1]!.id,
      value: "width",
    }).sketch;
  };
  const document: CadDocument = {
    ...emptyDocument(),
    variables: [{ id: "v", name: "width", expression: "120", unit: "mm" }],
    features: [panel("a"), panel("b")],
  };
  // Round-trips through validation like a stored document.
  const first = solveDocument(readDocument(document), solver).document;
  const widened = solveDocument(
    {
      ...first,
      variables: [{ id: "v", name: "width", expression: "300", unit: "mm" }],
    },
    solver,
  );
  for (const sketch of widened.document.features) {
    const xs = sketch.entities.flatMap((e) =>
      e.type === "point" ? [e.x] : [],
    );
    assert.equal(Math.round(Math.max(...xs) - Math.min(...xs)), 300);
  }
  assert.equal(widened.solutions.size, 2);
});
