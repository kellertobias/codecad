// Builders for test documents: sketches whose geometry is pinned by
// expressions, and extrudes with the usual defaults.
import { SketchSolver } from "../../src/document/sketch-solver.js";
import {
  addConstraint,
  addRectangle,
  solveDocument,
} from "../../src/document/sketch-edit.js";
import {
  emptyDocument,
  readDocument,
  type CadDocument,
  type ExtrudeFeature,
  type Feature,
  type Plane,
  type SketchFeature,
} from "../../src/document/schema.js";

/** A sketch with a rectangle whose corner, width and height are
 * expressions. Its lines are called `<id>.bottom`, `.right`, `.top`,
 * `.left`. */
export function rectangle(
  id: string,
  plane: Plane,
  x: string,
  y: string,
  width: string,
  height: string,
  extra: Partial<SketchFeature> = {},
): SketchFeature {
  let sketch: SketchFeature = {
    id,
    type: "sketch",
    name: id,
    plane,
    entities: [],
    constraints: [],
    ...extra,
  };
  sketch = addRectangle(sketch, { x: 0, y: 0 }, { x: 10, y: 10 }).sketch;
  // Stable names instead of random ids, so tests can refer to them.
  const names = ["p0", "p1", "p2", "p3", "bottom", "right", "top", "left"];
  const rename = new Map(
    sketch.entities.map((e, i) => [e.id, `${id}.${names[i]}`]),
  );
  const renamed = (value: string) => rename.get(value) ?? value;
  sketch = {
    ...sketch,
    entities: sketch.entities.map((e) => {
      const next: Record<string, unknown> = { ...e, id: renamed(e.id) };
      for (const key of ["start", "end", "center"])
        if (typeof next[key] === "string")
          next[key] = renamed(next[key] as string);
      return next as unknown as SketchFeature["entities"][number];
    }),
    constraints: sketch.constraints.map((c) => {
      const next: Record<string, unknown> = { ...c };
      for (const key of ["line", "a", "b", "point", "entity"])
        if (typeof next[key] === "string")
          next[key] = renamed(next[key] as string);
      return next as unknown as SketchFeature["constraints"][number];
    }),
  };
  sketch = addConstraint(sketch, {
    type: "fix",
    point: `${id}.p0`,
    x,
    y,
  }).sketch;
  sketch = addConstraint(sketch, {
    type: "distance",
    a: `${id}.p0`,
    b: `${id}.p1`,
    value: width,
    direction: "horizontal",
  }).sketch;
  sketch = addConstraint(sketch, {
    type: "distance",
    a: `${id}.p1`,
    b: `${id}.p2`,
    value: height,
    direction: "vertical",
  }).sketch;
  return {
    ...sketch,
    constraints: sketch.constraints.map((c, i) => ({
      ...c,
      id: `${id}.c${i}`,
    })),
  };
}

/** Points to drill at, fixed by expressions. */
export function points(
  id: string,
  at: readonly (readonly [string, string])[],
  extra: Partial<SketchFeature> = {},
): SketchFeature {
  return {
    id,
    type: "sketch",
    name: id,
    plane: "XY",
    entities: at.map((_, i) => ({
      id: `${id}.h${i}`,
      type: "point" as const,
      x: 0,
      y: 0,
    })),
    constraints: at.map(([x, y], i) => ({
      id: `${id}.f${i}`,
      type: "fix" as const,
      point: `${id}.h${i}`,
      x,
      y,
    })),
    ...extra,
  };
}

export const extrude = (
  id: string,
  sketch: string,
  rest: Partial<ExtrudeFeature> = {},
): ExtrudeFeature => ({
  id,
  type: "extrude",
  name: id,
  sketch,
  operation: "new",
  extent: "blind",
  distance: "18",
  ...rest,
});

/** A solved document with these variables (all in mm) and features. */
export function solvedDocument(
  solver: SketchSolver,
  variables: Record<string, string>,
  features: Feature[],
  extra: Partial<CadDocument> = {},
): CadDocument {
  const doc = readDocument({
    ...extra,
    ...emptyDocument(),
    variables: Object.entries(variables).map(([name, expression], i) => ({
      id: `v${i}`,
      name,
      expression,
      unit: "mm",
    })),
    features,
  });
  return solveDocument(doc, solver).document;
}
