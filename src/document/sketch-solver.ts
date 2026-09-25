// Solves a sketch with planegcs, FreeCAD's constraint solver compiled to
// WebAssembly. Each document constraint becomes one or two planegcs
// constraints; results (conflicts, redundancies) are reported back under the
// document's own constraint ids so the editor can point at them.
//
// A dimension whose expression cannot be evaluated is left out and reported,
// instead of failing the whole sketch.
import {
  DebugMode,
  SolveStatus,
  make_gcs_wrapper,
  type GcsWrapper,
  type SketchPrimitive,
} from "@salusoft89/planegcs";
import { ExpressionError } from "./expressions.js";
import type {
  SketchConstraint,
  SketchEntity,
  SketchFeature,
} from "./schema.js";
import { evaluateWith, type VariableValues } from "./variables.js";

export interface SketchSolution {
  /** The sketch with solved point positions and circle radii. Unchanged
   * when the solve failed. */
  readonly sketch: SketchFeature;
  readonly status: "solved" | "failed";
  /** Degrees of freedom left; 0 means fully constrained. */
  readonly dof: number;
  /** Constraints that contradict others, by document id. */
  readonly conflicting: readonly string[];
  /** Constraints that repeat what others already say. */
  readonly redundant: readonly string[];
  /** Constraints left out, by id, with the reason. */
  readonly errors: ReadonlyMap<string, string>;
}

/** Pull a point towards a position, as far as the constraints allow. */
export interface Drag {
  readonly point: string;
  readonly x: number;
  readonly y: number;
}

/** planegcs constraint ids for document constraints that need more than
 * one: `<id>#x`, `<id>#y`. */
const part = (id: string, suffix: string) => `${id}#${suffix}`;
const documentId = (id: string) => id.split("#")[0]!;

export class SketchSolver {
  private constructor(private readonly gcs: GcsWrapper) {
    // Without this the solver prints diagnostics to stdout.
    gcs.debug_mode = DebugMode.NoDebug;
  }

  /** Loads the solver. In a browser pass the URL of planegcs.wasm. */
  static async create(options: { wasm?: string } = {}): Promise<SketchSolver> {
    return new SketchSolver(await make_gcs_wrapper(options.wasm));
  }

  solve(
    sketch: SketchFeature,
    variables: VariableValues,
    drag?: Drag,
  ): SketchSolution {
    const entities = new Map(sketch.entities.map((e) => [e.id, e]));
    const errors = new Map<string, string>();
    const primitives: SketchPrimitive[] = sketch.entities.flatMap((entity) =>
      geometry(entity, entities),
    );
    for (const constraint of sketch.constraints) {
      try {
        primitives.push(...translate(constraint, entities, variables));
      } catch (error) {
        errors.set(
          constraint.id,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    if (drag)
      primitives.push(
        {
          id: "drag#x",
          type: "coordinate_x",
          p_id: drag.point,
          x: drag.x,
          temporary: true,
        },
        {
          id: "drag#y",
          type: "coordinate_y",
          p_id: drag.point,
          y: drag.y,
          temporary: true,
        },
      );

    this.gcs.clear_data();
    this.gcs.push_primitives_and_params(primitives);
    const status = this.gcs.solve();
    const ids = (list: readonly string[]) =>
      [...new Set(list.map(documentId))].filter((id) => id !== "drag");
    const conflicting = ids(this.gcs.get_gcs_conflicting_constraints());
    const redundant = ids(this.gcs.get_gcs_redundant_constraints());
    const dof = this.gcs.gcs.dof();
    if (status !== SolveStatus.Success && status !== SolveStatus.Converged)
      return { sketch, status: "failed", dof, conflicting, redundant, errors };
    this.gcs.apply_solution();
    const solved = sketch.entities.map((entity): SketchEntity => {
      const primitive = this.gcs.sketch_index.get_primitive(entity.id);
      if (entity.type === "point" && primitive?.type === "point")
        return { ...entity, x: primitive.x, y: primitive.y };
      if (entity.type === "circle" && primitive?.type === "circle")
        return { ...entity, radius: primitive.radius };
      return entity;
    });
    return {
      sketch: { ...sketch, entities: solved },
      status: "solved",
      dof,
      conflicting,
      redundant,
      errors,
    };
  }

  dispose(): void {
    this.gcs.destroy_gcs_module();
  }
}

type Entities = ReadonlyMap<string, SketchEntity>;

function point(entities: Entities, id: string) {
  const entity = entities.get(id);
  if (entity?.type !== "point") throw new Error(`"${id}" is not a point`);
  return entity;
}

function geometry(entity: SketchEntity, entities: Entities): SketchPrimitive[] {
  switch (entity.type) {
    case "point":
      return [
        {
          id: entity.id,
          type: "point",
          x: entity.x,
          y: entity.y,
          fixed: false,
        },
      ];
    case "line":
      return [
        { id: entity.id, type: "line", p1_id: entity.start, p2_id: entity.end },
      ];
    case "circle":
      return [
        {
          id: entity.id,
          type: "circle",
          c_id: entity.center,
          radius: entity.radius,
        },
      ];
    case "arc": {
      const c = point(entities, entity.center);
      const s = point(entities, entity.start);
      const e = point(entities, entity.end);
      const start = Math.atan2(s.y - c.y, s.x - c.x);
      let end = Math.atan2(e.y - c.y, e.x - c.x);
      // Counter-clockwise from start to end.
      while (end <= start) end += 2 * Math.PI;
      return [
        {
          id: entity.id,
          type: "arc",
          c_id: entity.center,
          start_id: entity.start,
          end_id: entity.end,
          radius: Math.hypot(s.x - c.x, s.y - c.y),
          start_angle: start,
          end_angle: end,
        },
        // Keeps the end points on the circle at the arc's angles.
        { id: part(entity.id, "rules"), type: "arc_rules", a_id: entity.id },
      ];
    }
  }
}

function translate(
  constraint: SketchConstraint,
  entities: Entities,
  variables: VariableValues,
): SketchPrimitive[] {
  const id = constraint.id;
  const kind = (entity: string) => entities.get(entity)?.type;
  const value = (source: string) => {
    try {
      return evaluateWith(source, variables);
    } catch (error) {
      throw new Error(
        error instanceof ExpressionError
          ? `${error.message} in "${source}"`
          : String(error),
      );
    }
  };
  const unsupported = (): never => {
    throw new Error(
      `A ${constraint.type} constraint cannot join these kinds of entities`,
    );
  };
  switch (constraint.type) {
    case "coincident": {
      const [a, b] = [kind(constraint.a), kind(constraint.b)];
      if (a === "point" && b === "point")
        return [
          {
            id,
            type: "p2p_coincident",
            p1_id: constraint.a,
            p2_id: constraint.b,
          },
        ];
      // A point coincident with a curve lies on it.
      if (a === "point")
        return onEntity(id, constraint.a, constraint.b, entities);
      if (b === "point")
        return onEntity(id, constraint.b, constraint.a, entities);
      return unsupported();
    }
    case "onEntity":
      return onEntity(id, constraint.point, constraint.entity, entities);
    case "horizontal":
      return [{ id, type: "horizontal_l", l_id: constraint.line }];
    case "vertical":
      return [{ id, type: "vertical_l", l_id: constraint.line }];
    case "parallel":
      return [
        { id, type: "parallel", l1_id: constraint.a, l2_id: constraint.b },
      ];
    case "perpendicular":
      return [
        {
          id,
          type: "perpendicular_ll",
          l1_id: constraint.a,
          l2_id: constraint.b,
        },
      ];
    case "equal": {
      const [a, b] = [constraint.a, constraint.b];
      const pair = `${kind(a)}-${kind(b)}`;
      if (pair === "line-line")
        return [{ id, type: "equal_length", l1_id: a, l2_id: b }];
      if (pair === "circle-circle")
        return [{ id, type: "equal_radius_cc", c1_id: a, c2_id: b }];
      if (pair === "circle-arc")
        return [{ id, type: "equal_radius_ca", c1_id: a, a2_id: b }];
      if (pair === "arc-circle")
        return [{ id, type: "equal_radius_ca", c1_id: b, a2_id: a }];
      if (pair === "arc-arc")
        return [{ id, type: "equal_radius_aa", a1_id: a, a2_id: b }];
      return unsupported();
    }
    case "tangent": {
      const [a, b] = [constraint.a, constraint.b];
      // Curves that already meet at an end point are tangent *there*: a
      // tangency between whole curves would be degenerate at a shared
      // point and the solver would find it redundant.
      const joint = endpointTangency(id, a, b, entities);
      if (joint) return [joint];
      const pair = `${kind(a)}-${kind(b)}`;
      if (pair === "line-circle")
        return [{ id, type: "tangent_lc", l_id: a, c_id: b }];
      if (pair === "circle-line")
        return [{ id, type: "tangent_lc", l_id: b, c_id: a }];
      if (pair === "line-arc")
        return [{ id, type: "tangent_la", l_id: a, a_id: b }];
      if (pair === "arc-line")
        return [{ id, type: "tangent_la", l_id: b, a_id: a }];
      if (pair === "circle-circle")
        return [{ id, type: "tangent_cc", c1_id: a, c2_id: b }];
      if (pair === "arc-arc")
        return [{ id, type: "tangent_aa", a1_id: a, a2_id: b }];
      if (pair === "circle-arc")
        return [{ id, type: "tangent_ca", c_id: a, a_id: b }];
      if (pair === "arc-circle")
        return [{ id, type: "tangent_ca", c_id: b, a_id: a }];
      return unsupported();
    }
    case "midpoint": {
      const line = entities.get(constraint.line);
      if (line?.type !== "line") return unsupported();
      return [
        {
          id,
          type: "p2p_symmetric_ppp",
          p1_id: line.start,
          p2_id: line.end,
          p_id: constraint.point,
        },
      ];
    }
    case "symmetric":
      return [
        {
          id,
          type: "p2p_symmetric_ppl",
          p1_id: constraint.a,
          p2_id: constraint.b,
          l_id: constraint.line,
        },
      ];
    case "fix":
      return [
        {
          id: part(id, "x"),
          type: "coordinate_x",
          p_id: constraint.point,
          x: value(constraint.x),
        },
        {
          id: part(id, "y"),
          type: "coordinate_y",
          p_id: constraint.point,
          y: value(constraint.y),
        },
      ];
    case "distance": {
      const distance = value(constraint.value);
      if (distance < 0) throw new Error("A distance cannot be negative");
      const [a, b] = [constraint.a, constraint.b];
      const pair = `${kind(a)}-${kind(b)}`;
      if (pair === "point-point") {
        if (!constraint.direction)
          return [{ id, type: "p2p_distance", p1_id: a, p2_id: b, distance }];
        // Along one axis, keeping the side the points are on now.
        const axis = constraint.direction === "horizontal" ? "x" : "y";
        const pa = point(entities, a);
        const pb = point(entities, b);
        const sign = (axis === "x" ? pb.x - pa.x : pb.y - pa.y) < 0 ? -1 : 1;
        return [
          {
            id,
            type: "difference",
            param1: { o_id: a, prop: axis },
            param2: { o_id: b, prop: axis },
            difference: sign * distance,
          },
        ];
      }
      if (pair === "point-line")
        return [{ id, type: "p2l_distance", p_id: a, l_id: b, distance }];
      if (pair === "line-point")
        return [{ id, type: "p2l_distance", p_id: b, l_id: a, distance }];
      if (pair === "line-line") {
        // Between parallel lines: from one line's start to the other line.
        const line = entities.get(a);
        if (line?.type !== "line") return unsupported();
        return [
          { id, type: "p2l_distance", p_id: line.start, l_id: b, distance },
        ];
      }
      return unsupported();
    }
    case "angle": {
      const [a, b] = [entities.get(constraint.a), entities.get(constraint.b)];
      if (a?.type !== "line" || b?.type !== "line") return unsupported();
      // Keep the turning direction the lines have now.
      const direction = (line: typeof a) => {
        const s = point(entities, line.start);
        const e = point(entities, line.end);
        return Math.atan2(e.y - s.y, e.x - s.x);
      };
      const current = Math.atan2(
        Math.sin(direction(b) - direction(a)),
        Math.cos(direction(b) - direction(a)),
      );
      const radians = (value(constraint.value) * Math.PI) / 180;
      return [
        {
          id,
          type: "l2l_angle_ll",
          l1_id: a.id,
          l2_id: b.id,
          angle: current < 0 ? -radians : radians,
        },
      ];
    }
    case "radius":
    case "diameter": {
      const size = value(constraint.value);
      if (size <= 0) throw new Error(`A ${constraint.type} must be positive`);
      const target = kind(constraint.entity);
      if (target === "circle")
        return constraint.type === "radius"
          ? [
              {
                id,
                type: "circle_radius",
                c_id: constraint.entity,
                radius: size,
              },
            ]
          : [
              {
                id,
                type: "circle_diameter",
                c_id: constraint.entity,
                diameter: size,
              },
            ];
      if (target === "arc")
        return constraint.type === "radius"
          ? [{ id, type: "arc_radius", a_id: constraint.entity, radius: size }]
          : [
              {
                id,
                type: "arc_diameter",
                a_id: constraint.entity,
                diameter: size,
              },
            ];
      return unsupported();
    }
  }
}

function onEntity(
  id: string,
  pointId: string,
  entityId: string,
  entities: Entities,
): SketchPrimitive[] {
  switch (entities.get(entityId)?.type) {
    case "line":
      return [{ id, type: "point_on_line_pl", p_id: pointId, l_id: entityId }];
    case "circle":
      return [{ id, type: "point_on_circle", p_id: pointId, c_id: entityId }];
    case "arc":
      return [{ id, type: "point_on_arc", p_id: pointId, a_id: entityId }];
    default:
      throw new Error("A point can only lie on a line, circle or arc");
  }
}

/** For two curves sharing an end point: keep their directions there
 * parallel, aligned or opposed as they are now. */
function endpointTangency(
  id: string,
  a: string,
  b: string,
  entities: Entities,
): SketchPrimitive | undefined {
  const ends = (entity: SketchEntity | undefined) =>
    entity?.type === "line" || entity?.type === "arc"
      ? [entity.start, entity.end]
      : [];
  const [ea, eb] = [entities.get(a), entities.get(b)];
  const shared = ends(ea).find((p) => ends(eb).includes(p));
  if (!shared || !ea || !eb) return undefined;
  const at = point(entities, shared);
  // Each curve's direction of travel at the shared point.
  const direction = (entity: SketchEntity) => {
    if (entity.type === "line") {
      const s = point(entities, entity.start);
      const e = point(entities, entity.end);
      return { x: e.x - s.x, y: e.y - s.y };
    }
    if (entity.type !== "arc") throw new Error("Only lines and arcs");
    const c = point(entities, entity.center);
    // Counter-clockwise: the radius turned a quarter to the left.
    return { x: -(at.y - c.y), y: at.x - c.x };
  };
  const u = direction(ea);
  const v = direction(eb);
  const angle = Math.atan2(u.x * v.y - u.y * v.x, u.x * v.x + u.y * v.y);
  return {
    id,
    type: "angle_via_point",
    crv1_id: a,
    crv2_id: b,
    p_id: shared,
    angle: Math.abs(angle) > Math.PI / 2 ? Math.PI : 0,
  };
}
