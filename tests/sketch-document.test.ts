import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { SketchSolver } from "../src/document/sketch-solver.js";
import { evaluateVariables } from "../src/document/variables.js";
import type {
  SketchConstraint,
  SketchEntity,
  SketchFeature,
  Variable,
} from "../src/document/schema.js";

let solver: SketchSolver;
before(async () => {
  solver = await SketchSolver.create();
});
after(() => solver.dispose());

const variables = (values: Record<string, string>) =>
  evaluateVariables(
    Object.entries(values).map(([name, expression]): Variable => ({
      id: name,
      name,
      expression,
      unit: "mm",
    })),
  );

const sketch = (
  entities: SketchEntity[],
  constraints: SketchConstraint[],
): SketchFeature => ({
  id: "s",
  type: "sketch",
  name: "Sketch",
  plane: "XY",
  entities,
  constraints,
});

/** A rough rectangle near `at` whose four lines share their corner points.
 * Unsigned dimensions keep the side points start on, so it starts where it
 * will end up, as a drawn sketch does. */
function rectangle(prefix = "", at = { x: 0, y: 0 }): SketchEntity[] {
  const p = (n: number) => `${prefix}p${n}`;
  return [
    { id: p(0), type: "point", x: at.x + 1, y: at.y - 2 },
    { id: p(1), type: "point", x: at.x + 90, y: at.y + 3 },
    { id: p(2), type: "point", x: at.x + 85, y: at.y + 45 },
    { id: p(3), type: "point", x: at.x - 4, y: at.y + 52 },
    { id: `${prefix}bottom`, type: "line", start: p(0), end: p(1) },
    { id: `${prefix}right`, type: "line", start: p(1), end: p(2) },
    { id: `${prefix}top`, type: "line", start: p(2), end: p(3) },
    { id: `${prefix}left`, type: "line", start: p(3), end: p(0) },
  ];
}
function rectangleConstraints(
  prefix = "",
  at = { x: "0", y: "0" },
): SketchConstraint[] {
  return [
    { id: `${prefix}h1`, type: "horizontal", line: `${prefix}bottom` },
    { id: `${prefix}h2`, type: "horizontal", line: `${prefix}top` },
    { id: `${prefix}v1`, type: "vertical", line: `${prefix}left` },
    { id: `${prefix}v2`, type: "vertical", line: `${prefix}right` },
    { id: `${prefix}origin`, type: "fix", point: `${prefix}p0`, ...at },
    {
      id: `${prefix}width`,
      type: "distance",
      a: `${prefix}p0`,
      b: `${prefix}p1`,
      value: "width",
    },
    {
      id: `${prefix}depth`,
      type: "distance",
      a: `${prefix}p1`,
      b: `${prefix}p2`,
      value: "depth / 2",
    },
  ];
}

const position = (s: SketchFeature, id: string) => {
  const entity = s.entities.find((e) => e.id === id);
  assert.equal(entity?.type, "point");
  return entity.type === "point" ? { x: entity.x, y: entity.y } : undefined!;
};
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

test("a rectangle takes its size from variables and is fully constrained", () => {
  const result = solver.solve(
    sketch(rectangle(), rectangleConstraints()),
    variables({ width: "600", depth: "2 * 150" }),
  );
  assert.equal(result.status, "solved");
  assert.equal(result.dof, 0);
  const corner = position(result.sketch, "p2");
  assert.ok(near(corner.x, 600) && near(corner.y, 150), JSON.stringify(corner));
  // Changing a variable changes the geometry.
  const wider = solver.solve(
    result.sketch,
    variables({ width: "800", depth: "300" }),
  );
  assert.ok(near(position(wider.sketch, "p1").x, 800));
});

test("without its dimensions the sketch reports the freedom left", () => {
  const result = solver.solve(
    sketch(
      rectangle(),
      rectangleConstraints().filter((c) => c.type !== "distance"),
    ),
    variables({}),
  );
  assert.equal(result.status, "solved");
  assert.equal(result.dof, 2);
});

test("a contradicting dimension is reported under its own id", () => {
  const result = solver.solve(
    sketch(rectangle(), [
      ...rectangleConstraints(),
      { id: "too-short", type: "distance", a: "p2", b: "p3", value: "100" },
    ]),
    variables({ width: "600", depth: "300" }),
  );
  assert.ok(
    result.conflicting.includes("too-short"),
    result.conflicting.join(),
  );
});

test("a dimension with a bad expression is left out and reported", () => {
  const result = solver.solve(
    sketch(rectangle(), rectangleConstraints()),
    variables({ width: "600" }),
  );
  assert.match(result.errors.get("depth")!, /Unknown name "depth"/);
  assert.equal(result.status, "solved");
  assert.equal(result.dof, 1);
});

test("dragging a corner of a free rectangle keeps it a rectangle", () => {
  const free = sketch(
    rectangle(),
    rectangleConstraints().filter((c) => c.type !== "distance"),
  );
  const settled = solver.solve(free, variables({})).sketch;
  const dragged = solver.solve(settled, variables({}), {
    point: "p2",
    x: 300,
    y: 120,
  });
  assert.equal(dragged.status, "solved");
  const corner = position(dragged.sketch, "p2");
  assert.ok(near(corner.x, 300) && near(corner.y, 120));
  // The neighbouring corners follow; the fixed origin stays.
  assert.ok(near(position(dragged.sketch, "p1").x, 300));
  assert.ok(near(position(dragged.sketch, "p3").y, 120));
  assert.ok(near(position(dragged.sketch, "p0").x, 0));
});

test("an axis distance keeps the side the points are on", () => {
  const result = solver.solve(
    sketch(
      [
        { id: "a", type: "point", x: 0, y: 0 },
        { id: "b", type: "point", x: -10, y: 5 },
      ],
      [
        { id: "fix", type: "fix", point: "a", x: "0", y: "0" },
        {
          id: "dx",
          type: "distance",
          a: "a",
          b: "b",
          value: "40",
          direction: "horizontal",
        },
        {
          id: "dy",
          type: "distance",
          a: "a",
          b: "b",
          value: "25",
          direction: "vertical",
        },
      ],
    ),
    variables({}),
  );
  const b = position(result.sketch, "b");
  assert.ok(near(b.x, -40) && near(b.y, 25), JSON.stringify(b));
  assert.equal(result.dof, 0);
});

test("a circle takes a diameter and an arc stays tangent to a line", () => {
  const result = solver.solve(
    sketch(
      [
        { id: "c", type: "point", x: 1, y: 1 },
        { id: "hole", type: "circle", center: "c", radius: 3 },
        { id: "ac", type: "point", x: 0, y: 20 },
        { id: "as", type: "point", x: 10, y: 20 },
        { id: "ae", type: "point", x: 0, y: 30 },
        { id: "round", type: "arc", center: "ac", start: "as", end: "ae" },
        { id: "l0", type: "point", x: 10, y: 0 },
        { id: "l1", type: "point", x: 10, y: 19 },
        { id: "wall", type: "line", start: "l0", end: "l1" },
      ],
      [
        { id: "cfix", type: "fix", point: "c", x: "0", y: "0" },
        { id: "d", type: "diameter", entity: "hole", value: "hole" },
        { id: "wv", type: "vertical", line: "wall" },
        { id: "join", type: "coincident", a: "l1", b: "as" },
        { id: "tan", type: "tangent", a: "wall", b: "round" },
        { id: "r", type: "radius", entity: "round", value: "10" },
      ],
    ),
    variables({ hole: "8mm" }),
  );
  assert.equal(result.status, "solved");
  const hole = result.sketch.entities.find((e) => e.id === "hole");
  assert.ok(hole?.type === "circle" && near(hole.radius, 4));
  // Tangent to a vertical wall: the arc's centre is level with the joint.
  const centre = position(result.sketch, "ac");
  const joint = position(result.sketch, "as");
  assert.ok(near(centre.y, joint.y), `${centre.y} vs ${joint.y}`);
  assert.ok(near(Math.abs(centre.x - joint.x), 10));
});

test("a furniture-sized sketch re-solves within a frame, rebuilt each time", (t) => {
  // Twenty panels, each a dimensioned rectangle: about 160 solver primitives.
  const entities = [];
  const constraints = [];
  for (let i = 0; i < 20; i++) {
    const at = { x: (i % 5) * 700, y: Math.floor(i / 5) * 400 };
    entities.push(...rectangle(`r${i}-`, at));
    constraints.push(
      ...rectangleConstraints(`r${i}-`, { x: String(at.x), y: String(at.y) }),
    );
  }
  let current = sketch(entities, constraints);
  const times: number[] = [];
  for (let i = 0; i < 30; i++) {
    const started = performance.now();
    current = solver.solve(
      current,
      variables({ width: String(600 + i), depth: "300" }),
    ).sketch;
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)]!;
  t.diagnostic(`median solve ${median.toFixed(2)} ms`);
  assert.ok(median < 16);
  assert.ok(near(position(current, "r19-p1").x, 2800 + 629));
});
