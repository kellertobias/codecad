// Edits to a sketch, as pure functions from one sketch to the next: the
// editor calls them, the history keeps their results, and tests can check
// them without a browser.
import type {
  CadDocument,
  SketchConstraint,
  SketchEntity,
  SketchFeature,
} from "./schema.js";
import type { SketchSolution, SketchSolver } from "./sketch-solver.js";
import { evaluateVariables, type VariableValues } from "./variables.js";

type Entity<T extends SketchEntity["type"]> = Extract<
  SketchEntity,
  { type: T }
>;
export type NewConstraint = SketchConstraint extends infer C
  ? C extends SketchConstraint
    ? Omit<C, "id">
    : never
  : never;

/** A short random id with a readable prefix, unique within a sketch. */
export function newId(prefix: string, sketch?: SketchFeature): string {
  for (;;) {
    const id = `${prefix}${Math.random().toString(36).slice(2, 7)}`;
    if (
      !sketch?.entities.some((e) => e.id === id) &&
      !sketch?.constraints.some((c) => c.id === id)
    )
      return id;
  }
}

/** Where a new curve starts or ends: an existing point, or a new one. */
export type PointInput =
  { readonly id: string } | { readonly x: number; readonly y: number };

export interface Edit {
  readonly sketch: SketchFeature;
  /** Ids of the entities the edit created. */
  readonly created: readonly string[];
}

function withEntities(
  sketch: SketchFeature,
  entities: readonly SketchEntity[],
  constraints: readonly NewConstraint[] = [],
): SketchFeature {
  let next: SketchFeature = {
    ...sketch,
    entities: [...sketch.entities, ...entities],
  };
  for (const constraint of constraints)
    next = addConstraint(next, constraint).sketch;
  return next;
}

/** Resolves a point input to an id, adding the point when it is new. */
function point(
  sketch: SketchFeature,
  input: PointInput,
  added: SketchEntity[],
): string {
  if ("id" in input) return input.id;
  const id = newId("p", {
    ...sketch,
    entities: [...sketch.entities, ...added],
  });
  added.push({ id, type: "point", x: input.x, y: input.y });
  return id;
}

export function position(sketch: SketchFeature, id: string) {
  const entity = sketch.entities.find((e) => e.id === id);
  if (entity?.type !== "point") throw new Error(`"${id}" is not a point`);
  return entity;
}

export function addConstraint(
  sketch: SketchFeature,
  constraint: NewConstraint,
): { sketch: SketchFeature; id: string } {
  const id = newId("c", sketch);
  return {
    sketch: {
      ...sketch,
      constraints: [
        ...sketch.constraints,
        { ...constraint, id } as SketchConstraint,
      ],
    },
    id,
  };
}

/** Within this many degrees of horizontal or vertical, a new line gets
 * that constraint. */
const snapAngle = 3;

function straightness(
  sketch: SketchFeature,
  line: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
): NewConstraint[] {
  const angle = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
  const off = (target: number) =>
    Math.min(
      ...[target, target + 180, target - 180].map((t) => Math.abs(angle - t)),
    );
  if (off(0) <= snapAngle) return [{ type: "horizontal", line }];
  if (off(90) <= snapAngle) return [{ type: "vertical", line }];
  return [];
}

export function addLine(
  sketch: SketchFeature,
  start: PointInput,
  end: PointInput,
  options: { construction?: boolean } = {},
): Edit {
  const added: SketchEntity[] = [];
  const a = point(sketch, start, added);
  const b = point(sketch, end, added);
  const id = newId("l", {
    ...sketch,
    entities: [...sketch.entities, ...added],
  });
  const line: Entity<"line"> = {
    id,
    type: "line",
    start: a,
    end: b,
    ...(options.construction ? { construction: true } : {}),
  };
  const next = withEntities(sketch, [...added, line]);
  return {
    sketch: withEntities(
      next,
      [],
      straightness(next, id, position(next, a), position(next, b)),
    ),
    created: [...added.map((e) => e.id), id],
  };
}

/** Four lines sharing their corners, kept square by two horizontal and two
 * vertical constraints. */
export function addRectangle(
  sketch: SketchFeature,
  corner: PointInput,
  opposite: { x: number; y: number },
): Edit {
  const added: SketchEntity[] = [];
  const a = point(sketch, corner, added);
  const at = "id" in corner ? position(sketch, corner.id) : corner;
  const scratch = () => ({
    ...sketch,
    entities: [...sketch.entities, ...added],
  });
  const corners = [
    a,
    point(scratch(), { x: opposite.x, y: at.y }, added),
    point(scratch(), opposite, added),
    point(scratch(), { x: at.x, y: opposite.y }, added),
  ];
  const lines = corners.map((from, i): Entity<"line"> => {
    const id = newId("l", scratch());
    const line: Entity<"line"> = {
      id,
      type: "line",
      start: from,
      end: corners[(i + 1) % 4]!,
    };
    added.push(line);
    return line;
  });
  const next = withEntities(sketch, added, [
    { type: "horizontal", line: lines[0]!.id },
    { type: "horizontal", line: lines[2]!.id },
    { type: "vertical", line: lines[1]!.id },
    { type: "vertical", line: lines[3]!.id },
  ]);
  return { sketch: next, created: added.map((e) => e.id) };
}

export function addCircle(
  sketch: SketchFeature,
  center: PointInput,
  radius: number,
): Edit {
  const added: SketchEntity[] = [];
  const c = point(sketch, center, added);
  const id = newId("k", {
    ...sketch,
    entities: [...sketch.entities, ...added],
  });
  added.push({ id, type: "circle", center: c, radius });
  return {
    sketch: withEntities(sketch, added),
    created: added.map((e) => e.id),
  };
}

/** An arc around `center` from `start`, counter-clockwise to the direction
 * of `towards`; its end lies on the same radius. */
export function addArc(
  sketch: SketchFeature,
  center: PointInput,
  start: PointInput,
  towards: { x: number; y: number },
): Edit {
  const added: SketchEntity[] = [];
  const c = point(sketch, center, added);
  const s = point(sketch, start, added);
  const scratch = () => ({
    ...sketch,
    entities: [...sketch.entities, ...added],
  });
  const cp = position(scratch(), c);
  const sp = position(scratch(), s);
  const radius = Math.hypot(sp.x - cp.x, sp.y - cp.y);
  const angle = Math.atan2(towards.y - cp.y, towards.x - cp.x);
  const e = point(
    scratch(),
    { x: cp.x + radius * Math.cos(angle), y: cp.y + radius * Math.sin(angle) },
    added,
  );
  const id = newId("a", scratch());
  added.push({ id, type: "arc", center: c, start: s, end: e });
  return {
    sketch: withEntities(sketch, added),
    created: added.map((x) => x.id),
  };
}

/** A slot from `a` to `b`: two half circles joined by two straight sides,
 * tangent where they meet and with equal radii. */
export function addSlot(
  sketch: SketchFeature,
  a: { x: number; y: number },
  b: { x: number; y: number },
  radius: number,
): Edit {
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  // Unit normal to the slot's axis, to the left of a → b.
  const nx = -(b.y - a.y) / length;
  const ny = (b.x - a.x) / length;
  const added: SketchEntity[] = [];
  const scratch = () => ({
    ...sketch,
    entities: [...sketch.entities, ...added],
  });
  const at = (x: number, y: number) => point(scratch(), { x, y }, added);
  const ca = at(a.x, a.y);
  const cb = at(b.x, b.y);
  const aLeft = at(a.x + nx * radius, a.y + ny * radius);
  const aRight = at(a.x - nx * radius, a.y - ny * radius);
  const bLeft = at(b.x + nx * radius, b.y + ny * radius);
  const bRight = at(b.x - nx * radius, b.y - ny * radius);
  const entity = (make: (id: string) => SketchEntity, prefix: string) => {
    const e = make(newId(prefix, scratch()));
    added.push(e);
    return e.id;
  };
  // Counter-clockwise: at b from right to left, at a from left to right.
  const capB = entity(
    (id) => ({ id, type: "arc", center: cb, start: bRight, end: bLeft }),
    "a",
  );
  const capA = entity(
    (id) => ({ id, type: "arc", center: ca, start: aLeft, end: aRight }),
    "a",
  );
  const left = entity(
    (id) => ({ id, type: "line", start: bLeft, end: aLeft }),
    "l",
  );
  const right = entity(
    (id) => ({ id, type: "line", start: aRight, end: bRight }),
    "l",
  );
  const next = withEntities(sketch, added, [
    { type: "tangent", a: left, b: capA },
    { type: "tangent", a: left, b: capB },
    { type: "tangent", a: right, b: capA },
    { type: "tangent", a: right, b: capB },
    { type: "equal", a: capA, b: capB },
  ]);
  return { sketch: next, created: added.map((e) => e.id) };
}

/** Removes entities and constraints. Curves on a removed point, constraints
 * on a removed entity, and points no longer used by anything go too. */
export function remove(
  sketch: SketchFeature,
  ids: ReadonlySet<string>,
): SketchFeature {
  const gone = new Set(ids);
  const uses = (e: SketchEntity): string[] =>
    e.type === "line"
      ? [e.start, e.end]
      : e.type === "circle"
        ? [e.center]
        : e.type === "arc"
          ? [e.center, e.start, e.end]
          : [];
  for (const entity of sketch.entities)
    if (uses(entity).some((id) => gone.has(id))) gone.add(entity.id);
  const referenced = (c: SketchConstraint) =>
    Object.entries(c)
      .filter(([key]) => ["a", "b", "line", "point", "entity"].includes(key))
      .map(([, value]) => value as string);
  let entities = sketch.entities.filter((e) => !gone.has(e.id));
  // Points that only served removed curves.
  const removedCurvePoints = new Set(
    sketch.entities.filter((e) => gone.has(e.id)).flatMap(uses),
  );
  const stillUsed = new Set(entities.flatMap(uses));
  entities = entities.filter(
    (e) =>
      !(
        e.type === "point" &&
        removedCurvePoints.has(e.id) &&
        !stillUsed.has(e.id)
      ),
  );
  const kept = new Set(entities.map((e) => e.id));
  const constraints = sketch.constraints.filter(
    (c) => !gone.has(c.id) && referenced(c).every((id) => kept.has(id)),
  );
  return { ...sketch, entities, constraints };
}

export function toggleConstruction(
  sketch: SketchFeature,
  ids: ReadonlySet<string>,
): SketchFeature {
  const selected = sketch.entities.filter(
    (e) => ids.has(e.id) && e.type !== "point",
  );
  const on = selected.some((e) => !e.construction);
  return {
    ...sketch,
    entities: sketch.entities.map((e) => {
      if (!ids.has(e.id) || e.type === "point") return e;
      const { construction: _, ...rest } = e;
      return (on ? { ...rest, construction: true } : rest) as SketchEntity;
    }),
  };
}

/** Constraints that can join the selected entities, in the order the
 * toolbar shows them. */
export function applicableConstraints(
  sketch: SketchFeature,
  selection: readonly string[],
): { label: string; constraint: NewConstraint }[] {
  const selected = selection
    .map((id) => sketch.entities.find((e) => e.id === id))
    .filter((e): e is SketchEntity => !!e);
  const of = <T extends SketchEntity["type"]>(type: T) =>
    selected.filter((e): e is Entity<T> => e.type === type);
  const points = of("point");
  const lines = of("line");
  const curves = [...of("circle"), ...of("arc")];
  const n = selected.length;
  const options: { label: string; constraint: NewConstraint }[] = [];
  if (n === 1 && lines.length === 1) {
    options.push({
      label: "Horizontal",
      constraint: { type: "horizontal", line: lines[0]!.id },
    });
    options.push({
      label: "Vertical",
      constraint: { type: "vertical", line: lines[0]!.id },
    });
  }
  if (n === 2 && lines.length === 2) {
    const [a, b] = [lines[0]!.id, lines[1]!.id];
    options.push({ label: "Parallel", constraint: { type: "parallel", a, b } });
    options.push({
      label: "Perpendicular",
      constraint: { type: "perpendicular", a, b },
    });
    options.push({ label: "Equal", constraint: { type: "equal", a, b } });
  }
  if (n === 2 && curves.length === 2)
    options.push({
      label: "Equal",
      constraint: { type: "equal", a: curves[0]!.id, b: curves[1]!.id },
    });
  if (n === 2 && curves.length >= 1 && lines.length + curves.length === 2)
    options.push({
      label: "Tangent",
      constraint: { type: "tangent", a: selected[0]!.id, b: selected[1]!.id },
    });
  if (n === 2 && points.length === 2)
    options.push({
      label: "Coincident",
      constraint: { type: "coincident", a: points[0]!.id, b: points[1]!.id },
    });
  if (
    n === 2 &&
    points.length === 1 &&
    (lines.length === 1 || curves.length === 1)
  ) {
    const other = (lines[0] ?? curves[0])!;
    options.push({
      label: "On",
      constraint: { type: "onEntity", point: points[0]!.id, entity: other.id },
    });
    if (lines.length === 1)
      options.push({
        label: "Midpoint",
        constraint: {
          type: "midpoint",
          point: points[0]!.id,
          line: lines[0]!.id,
        },
      });
  }
  if (n === 3 && points.length === 2 && lines.length === 1)
    options.push({
      label: "Symmetric",
      constraint: {
        type: "symmetric",
        a: points[0]!.id,
        b: points[1]!.id,
        line: lines[0]!.id,
      },
    });
  if (n === 1 && points.length === 1)
    options.push({
      label: "Fix",
      constraint: {
        type: "fix",
        point: points[0]!.id,
        x: round(points[0]!.x),
        y: round(points[0]!.y),
      },
    });
  return options;
}

/** Dimensions that fit the selection, each with the value it measures now. */
export function applicableDimensions(
  sketch: SketchFeature,
  selection: readonly string[],
): { label: string; constraint: NewConstraint }[] {
  const selected = selection
    .map((id) => sketch.entities.find((e) => e.id === id))
    .filter((e): e is SketchEntity => !!e);
  const at = (id: string) => position(sketch, id);
  const options: { label: string; constraint: NewConstraint }[] = [];
  const pointPair = (a: string, b: string) => {
    const [pa, pb] = [at(a), at(b)];
    options.push(
      {
        label: "Distance",
        constraint: {
          type: "distance",
          a,
          b,
          value: round(Math.hypot(pb.x - pa.x, pb.y - pa.y)),
        },
      },
      {
        label: "Horizontal distance",
        constraint: {
          type: "distance",
          a,
          b,
          value: round(Math.abs(pb.x - pa.x)),
          direction: "horizontal",
        },
      },
      {
        label: "Vertical distance",
        constraint: {
          type: "distance",
          a,
          b,
          value: round(Math.abs(pb.y - pa.y)),
          direction: "vertical",
        },
      },
    );
  };
  const [first, second] = selected;
  if (selected.length === 1 && first?.type === "line")
    pointPair(first.start, first.end);
  if (
    selected.length === 1 &&
    (first?.type === "circle" || first?.type === "arc")
  ) {
    const radius =
      first.type === "circle"
        ? first.radius
        : Math.hypot(
            at(first.start).x - at(first.center).x,
            at(first.start).y - at(first.center).y,
          );
    options.push(
      {
        label: "Diameter",
        constraint: {
          type: "diameter",
          entity: first.id,
          value: round(radius * 2),
        },
      },
      {
        label: "Radius",
        constraint: { type: "radius", entity: first.id, value: round(radius) },
      },
    );
  }
  if (
    selected.length === 2 &&
    first?.type === "point" &&
    second?.type === "point"
  )
    pointPair(first.id, second.id);
  if (selected.length === 2) {
    const line = selected.find((e): e is Entity<"line"> => e.type === "line");
    const pt = selected.find((e): e is Entity<"point"> => e.type === "point");
    if (line && pt)
      options.push({
        label: "Distance to line",
        constraint: {
          type: "distance",
          a: pt.id,
          b: line.id,
          value: round(distanceToLine(pt, at(line.start), at(line.end))),
        },
      });
    if (first?.type === "line" && second?.type === "line") {
      const angle = angleBetween(first, second, at);
      if (Math.abs(Math.sin((angle * Math.PI) / 180)) < 1e-6)
        options.push({
          label: "Distance between lines",
          constraint: {
            type: "distance",
            a: first.id,
            b: second.id,
            value: round(
              distanceToLine(at(first.start), at(second.start), at(second.end)),
            ),
          },
        });
      else
        options.push({
          label: "Angle",
          constraint: {
            type: "angle",
            a: first.id,
            b: second.id,
            value: round(Math.abs(angle)),
          },
        });
    }
  }
  return options;
}

const round = (value: number) => String(Math.round(value * 100) / 100);

function distanceToLine(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return (
    Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / length
  );
}

function angleBetween(
  a: Entity<"line">,
  b: Entity<"line">,
  at: (id: string) => { x: number; y: number },
): number {
  const direction = (l: Entity<"line">) =>
    Math.atan2(at(l.end).y - at(l.start).y, at(l.end).x - at(l.start).x);
  const d = direction(b) - direction(a);
  return (Math.atan2(Math.sin(d), Math.cos(d)) * 180) / Math.PI;
}

export interface SolvedDocument {
  readonly document: CadDocument;
  readonly variables: VariableValues;
  readonly solutions: ReadonlyMap<string, SketchSolution>;
}

/** Evaluates the variables and solves every sketch, keeping solved
 * positions in the document so the next solve starts from them. A sketch
 * that fails to solve keeps its previous positions. */
export function solveDocument(
  document: CadDocument,
  solver: SketchSolver,
  drag?: { feature: string; point: string; x: number; y: number },
): SolvedDocument {
  const variables = evaluateVariables(document.variables);
  const solutions = new Map<string, SketchSolution>();
  const features = document.features.map((feature) => {
    if (feature.type !== "sketch" || feature.suppressed) return feature;
    const solution = solver.solve(
      feature,
      variables,
      drag?.feature === feature.id ? drag : undefined,
    );
    solutions.set(feature.id, solution);
    return solution.sketch;
  });
  return { document: { ...document, features }, variables, solutions };
}
