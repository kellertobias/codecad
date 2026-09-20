import { Box3, Matrix4, Vector3 as V3 } from "three";
import {
  finite,
  positive,
  type Part,
  type Point3,
  type Recipe,
  type Vector3,
} from "./model.js";

/** Named world directions. Z is up and the front of a model faces -Y, matching
 * the drawing views: `right` is +X, `back` is +Y, `top` is +Z. */
export type FaceDirection =
  "top" | "bottom" | "left" | "right" | "front" | "back";
/** The panel compass, which sheet parts answer to as well: a standing blank's
 * north is its top, south its bottom, east its right and west its left. */
export type PanelDirection = "north" | "south" | "east" | "west";
export type DirectionName = FaceDirection | PanelDirection;
const directions: Record<FaceDirection, Vector3> = {
  right: { x: 1, y: 0, z: 0 },
  left: { x: -1, y: 0, z: 0 },
  back: { x: 0, y: 1, z: 0 },
  front: { x: 0, y: -1, z: 0 },
  top: { x: 0, y: 0, z: 1 },
  bottom: { x: 0, y: 0, z: -1 },
};
export const directionNames = Object.keys(directions) as FaceDirection[];
export function directionVector(name: FaceDirection): Vector3 {
  const d = directions[name];
  if (!d) throw new Error(`Unknown direction: ${String(name)}`);
  return d;
}
/** Resolve a written direction against the names this part answers to. */
export function faceDirection(part: Part, name: DirectionName): FaceDirection {
  if (name in directions) return name as FaceDirection;
  const alias = part.directionAliases()[name];
  if (alias) return alias;
  throw new Error(
    `${part.path} has no ${String(name)} face; name one of ${directionNames.join(", ")}`,
  );
}
export interface SelectionOptions {
  /** `material` (the default) names directions in the part's own stock
   * frame, so a selection does not change when the part is moved. `world`
   * names world directions and resolves them through the placement. */
  readonly frame?: "material" | "world";
  /** Degrees a face normal may deviate from a named direction. Default 45. */
  readonly tolerance?: number;
}
/** A face-direction edge selection, resolved into the part's local axes.
 * Plain data so it survives the `structuredClone` every recipe goes through. */
export interface EdgeQuery {
  readonly directions: readonly Vector3[];
  /** The direction names as written, for diagnostics. */
  readonly labels: readonly string[];
  readonly tolerance: number;
}
function unit(v: Vector3, what: string): V3 {
  const result = new V3(
    finite(v.x, what),
    finite(v.y, what),
    finite(v.z, what),
  );
  if (result.lengthSq() < 1e-12) throw new Error(`${what} must not be zero`);
  return result.normalize();
}
/** Rotation-only part transform: world direction × this = local direction. */
function localBasis(part: Part): Matrix4 {
  return new Matrix4().extractRotation(part.worldMatrix()).invert();
}
/** Maps a named direction into the part's local axes for a given frame. */
export function selectionBasis(
  part: Part,
  options: SelectionOptions = {},
): Matrix4 {
  return options.frame === "world" ? localBasis(part) : part.materialBasis();
}
export function edgeQuery(
  part: Part,
  names: readonly DirectionName[],
  options: SelectionOptions = {},
): EdgeQuery {
  if (!names.length) throw new Error("Select at least one face direction");
  if (names.length > 3)
    throw new Error("An edge or corner is named by at most three directions");
  const faces = names.map((name) => faceDirection(part, name));
  if (new Set(faces).size !== faces.length)
    throw new Error(`Repeated direction in selection: ${names.join(", ")}`);
  // Opposite faces never meet, so such a pair names no edge and no corner.
  for (const [first, second] of [
    ["top", "bottom"],
    ["left", "right"],
    ["front", "back"],
  ] as const)
    if (faces.includes(first) && faces.includes(second))
      throw new Error(
        `${names.join(" and ")} are opposite faces and share no edge`,
      );
  const tolerance = options.tolerance ?? 45;
  if (!(tolerance > 0 && tolerance < 90))
    throw new Error("Direction tolerance must be between 0 and 90 degrees");
  const basis = selectionBasis(part, options);
  return {
    directions: faces.map((face) => {
      const v = unit(directionVector(face), face).applyMatrix4(basis);
      return { x: v.x, y: v.y, z: v.z };
    }),
    labels: [...names],
    tolerance,
  };
}
/** Analytic local bounds of a recipe. Exact for boxes, extrusions and their
 * transforms; a conservative superset once material is removed. */
export function recipeBounds(recipe: Recipe): Box3 {
  switch (recipe.kind) {
    case "box":
      return new Box3(
        new V3(0, 0, 0),
        new V3(recipe.width, recipe.depth, recipe.height),
      );
    case "cylinder": {
      const r = recipe.diameter / 2,
        h = recipe.length / 2;
      return new Box3(new V3(-r, -r, -h), new V3(r, r, h));
    }
    case "cone": {
      const r = recipe.diameter / 2;
      return new Box3(new V3(-r, -r, 0), new V3(r, r, recipe.length));
    }
    case "extrude": {
      const box = new Box3();
      for (const p of recipe.points) {
        box.expandByPoint(new V3(p.x, p.y, 0));
        box.expandByPoint(new V3(p.x, p.y, recipe.height));
      }
      return box;
    }
    case "transform": {
      const source = recipeBounds(recipe.source),
        m = new Matrix4().fromArray(recipe.matrix);
      const box = new Box3();
      for (let corner = 0; corner < 8; corner++)
        box.expandByPoint(
          new V3(
            corner & 1 ? source.max.x : source.min.x,
            corner & 2 ? source.max.y : source.min.y,
            corner & 4 ? source.max.z : source.min.z,
          ).applyMatrix4(m),
        );
      return box;
    }
    case "cut":
      return recipeBounds(recipe.left);
    case "union":
      return recipeBounds(recipe.left).union(recipeBounds(recipe.right));
    case "intersect":
      return recipeBounds(recipe.left).intersect(recipeBounds(recipe.right));
    case "offset":
      return recipeBounds(recipe.source).expandByScalar(recipe.distance);
    case "fillet":
    case "chamfer":
      return recipeBounds(recipe.source);
    case "step":
      throw new Error(
        "Imported STEP geometry has no analytic bounds; place it with an explicit interface frame instead of a named corner",
      );
  }
}
/** The bounding-box point furthest along the selected directions. Several
 * corners tie whenever the selection leaves an axis free, and their average is
 * the midpoint of the edge, or the centre of the face, that they span. */
function anchorPoint(
  part: Part,
  query: EdgeQuery,
  extra: V3 | undefined,
  unique: boolean,
): V3 {
  const box = recipeBounds(part.recipe);
  if (box.isEmpty())
    throw new Error(`Part ${part.path} has no measurable extent`);
  const dirs = query.directions.map((d) => new V3(d.x, d.y, d.z));
  if (extra) dirs.push(extra);
  let best: V3[] = [],
    bestScore = -Infinity;
  for (let corner = 0; corner < 8; corner++) {
    const point = new V3(
      corner & 1 ? box.max.x : box.min.x,
      corner & 2 ? box.max.y : box.min.y,
      corner & 4 ? box.max.z : box.min.z,
    );
    const score = dirs.reduce((sum, d) => sum + point.dot(d), 0);
    if (score > bestScore + 1e-9) {
      bestScore = score;
      best = [point];
    } else if (score > bestScore - 1e-9) best.push(point);
  }
  if (unique && best.length !== 1)
    throw new Error(
      `${query.labels.join("/")} on ${part.path} does not name a single point; name one direction per axis`,
    );
  return best
    .reduce((sum, point) => sum.add(point), new V3())
    .divideScalar(best.length);
}
/** Edges shared by the named faces, resolved against the solid at build time. */
export class PartEdge {
  constructor(
    readonly part: Part,
    readonly query: EdgeQuery,
    /** The frame the directions were read in, for naming a point along them. */
    readonly basis: Matrix4 = new Matrix4(),
  ) {}
  get description(): string {
    return this.query.labels.join("/");
  }
  /** Whether this selection must resolve to exactly one bounding-box corner. */
  protected get singular(): boolean {
    return false;
  }
  private anchor(along: DirectionName | "middle"): V3 {
    const extra =
      along === "middle"
        ? undefined
        : unit(
            directionVector(faceDirection(this.part, along)),
            along,
          ).applyMatrix4(this.basis);
    return anchorPoint(
      this.part,
      this.query,
      extra,
      this.singular || along !== "middle",
    );
  }
  /** A world point on the selection: the middle of the edge by default, or the
   * end of it that lies furthest in a named direction. */
  point(along: DirectionName | "middle" = "middle"): Point3 {
    const p = this.anchor(along).applyMatrix4(this.part.worldMatrix());
    return { x: p.x, y: p.y, z: p.z };
  }
  /** The same point in the part's own coordinates. */
  local(along: DirectionName | "middle" = "middle"): Point3 {
    const p = this.anchor(along);
    return { x: p.x, y: p.y, z: p.z };
  }
  /** Round the selected edges with a constant radius. */
  fillet(radius: number): Part {
    return this.round(positive(radius, "fillet radius"), undefined);
  }
  /** Round one edge with a radius growing from its start to its end. A round
   * is circular in section, so unequal setbacks are a chamfer, not a fillet. */
  taperedFillet(startRadius: number, endRadius: number): Part {
    return this.round(
      positive(startRadius, "start radius"),
      positive(endRadius, "end radius"),
    );
  }
  private round(radius: number, endRadius: number | undefined): Part {
    this.part.recipe = {
      kind: "fillet",
      source: this.part.recipe,
      edges: structuredClone(this.query),
      radius,
      ...(endRadius === undefined ? {} : { endRadius }),
    };
    this.part.edgeTreatments.push({
      kind: "fillet",
      edges: this.description,
      first: radius,
      ...(endRadius === undefined ? {} : { second: endRadius }),
    });
    return this.part;
  }
  /** Bevel the selected edges. One distance is a 45° chamfer. Two are the
   * setbacks on the first and second named faces, in that order. */
  chamfer(distance: number, secondDistance?: number): Part {
    positive(distance, "chamfer distance");
    if (secondDistance !== undefined) {
      positive(secondDistance, "second chamfer distance");
      if (this.query.directions.length !== 2)
        throw new Error(
          "Asymmetric chamfer needs exactly two face directions so each distance has a face",
        );
    }
    this.part.recipe = {
      kind: "chamfer",
      source: this.part.recipe,
      edges: structuredClone(this.query),
      distance,
      ...(secondDistance === undefined ? {} : { secondDistance }),
    };
    this.part.edgeTreatments.push({
      kind: "chamfer",
      edges: this.description,
      first: distance,
      ...(secondDistance === undefined ? {} : { second: secondDistance }),
    });
    return this.part;
  }
}
/** A named bounding-box corner, and the three edges that meet there. */
export class PartCorner extends PartEdge {
  protected override get singular(): boolean {
    return true;
  }
}
export interface EdgeTreatment {
  readonly kind: "fillet" | "chamfer";
  readonly edges: string;
  readonly first: number;
  readonly second?: number;
}
