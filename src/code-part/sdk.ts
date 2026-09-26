// The API a code part is written against, imported as "codecad/part". It
// runs in the editor's sandbox, with no kernel: shapes are recipes (plain
// data) that the editor's kernel builds once the code has returned.
//
//   import { definePart, Shapes, cut, plane } from "codecad/part";
//
//   export default definePart({
//     parameters: { width: { default: 400, min: 100 }, thickness: { default: 18 } },
//     build({ width, thickness }) {
//       const top = new Shapes.Box({ width, depth: 300, height: thickness });
//       return { bodies: [{ name: "Top", shape: top }] };
//     },
//   });
import { Shapes, SolidShape, type Shape, type Point2 } from "../model.js";
import type {
  CodeInterface,
  CodeOutput,
  CodeParameter,
} from "../document/code-part.js";
import type { Vec3 } from "../document/frames.js";

export { Shapes };
export type { Shape, Point2 };

export interface ParameterSpec {
  readonly default: number;
  readonly min?: number;
  readonly max?: number;
  readonly label?: string;
  readonly unit?: "mm" | "deg" | "";
}

export interface InterfaceSpec {
  readonly id: string;
  readonly name?: string;
  readonly kind?: "screw" | "dowel" | "point";
  /** The plane the points lie in; its normal points away from the part.
   * The part's underside (`plane()`) when left out. */
  readonly plane?: PlaneFrame;
  readonly points: readonly Point2[];
  readonly diameter?: number;
  readonly depth?: number;
}

export interface PartBody {
  readonly name: string;
  readonly shape: Shape;
}

export interface PartOutput {
  readonly bodies: readonly PartBody[];
  readonly interfaces?: readonly InterfaceSpec[];
}

export interface PartDefinition<P extends Record<string, ParameterSpec>> {
  readonly parameters: P;
  build(values: { readonly [K in keyof P]: number }): PartOutput;
}

export interface PlaneFrame {
  readonly origin: Vec3;
  readonly x: Vec3;
  readonly y: Vec3;
  readonly normal: Vec3;
}

export function definePart<P extends Record<string, ParameterSpec>>(
  definition: PartDefinition<P>,
): PartDefinition<P> {
  return definition;
}

const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(...v);
  if (!(l > 0)) throw new Error("A direction must not be zero");
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** A plane: points `origin`, facing `normal` (away from the part), with
 * its x axis along `x`. The part's underside by default. */
export function plane(
  options: { origin?: Vec3; normal?: Vec3; x?: Vec3 } = {},
): PlaneFrame {
  const normal = unit(options.normal ?? [0, 0, -1]);
  const x = unit(options.x ?? [1, 0, 0]);
  if (Math.abs(x[0] * normal[0] + x[1] * normal[1] + x[2] * normal[2]) > 1e-9)
    throw new Error("A plane's x axis must lie in the plane");
  // y = normal × x, so that x × y is the normal.
  const y: Vec3 = [
    normal[1] * x[2] - normal[2] * x[1],
    normal[2] * x[0] - normal[0] * x[2],
    normal[0] * x[1] - normal[1] * x[0],
  ];
  return { origin: options.origin ?? [0, 0, 0], x, y, normal };
}

const pair = (
  kind: "union" | "cut" | "intersect",
  left: Shape,
  right: Shape,
): Shape => new SolidShape({ kind, left: left.recipe, right: right.recipe });

/** One solid of all the shapes. */
export function union(first: Shape, ...rest: Shape[]): Shape {
  return rest.reduce((all, next) => pair("union", all, next), first);
}
/** The first shape with every other taken away. */
export function cut(base: Shape, ...tools: Shape[]): Shape {
  return tools.reduce((all, tool) => pair("cut", all, tool), base);
}
/** What the shapes have in common. */
export function intersect(first: Shape, ...rest: Shape[]): Shape {
  return rest.reduce((all, next) => pair("intersect", all, next), first);
}

/** A face of a shape, by the way it faces: a name, or a direction. */
export type FaceSide =
  "top" | "bottom" | "left" | "right" | "front" | "back" | Vec3;

const sides: Record<string, Vec3> = {
  right: [1, 0, 0],
  left: [-1, 0, 0],
  back: [0, 1, 0],
  front: [0, -1, 0],
  top: [0, 0, 1],
  bottom: [0, 0, -1],
};

/** The edges where faces facing these ways meet: ["top"] is every edge of
 * the top face, ["top", "front"] the one between top and front. Normals
 * within `tolerance` degrees count. */
function edgeSelection(faces: readonly FaceSide[], tolerance = 45) {
  if (!faces.length || faces.length > 3)
    throw new Error("Name one to three faces whose edges to take");
  return {
    directions: faces.map((face) => {
      const v = typeof face === "string" ? sides[face] : face;
      if (!v) throw new Error(`There is no ${String(face)} face`);
      const [x, y, z] = unit(v);
      return { x, y, z };
    }),
    labels: faces.map((face) =>
      typeof face === "string" ? face : `[${face.join(", ")}]`,
    ),
    tolerance,
  };
}

/** Rounds the edges between the named faces. */
export function fillet(
  shape: Shape,
  radius: number,
  faces: readonly FaceSide[],
  options: { tolerance?: number } = {},
): Shape {
  return new SolidShape({
    kind: "fillet",
    source: shape.recipe,
    edges: edgeSelection(faces, options.tolerance),
    radius,
  });
}

/** Bevels the edges between the named faces. */
export function chamfer(
  shape: Shape,
  distance: number,
  faces: readonly FaceSide[],
  options: { tolerance?: number } = {},
): Shape {
  return new SolidShape({
    kind: "chamfer",
    source: shape.recipe,
    edges: edgeSelection(faces, options.tolerance),
    distance,
  });
}

/** Runs a definition for some values; what the sandbox hands back. */
export function runPart(
  definition: unknown,
  given: Readonly<Record<string, number>>,
): CodeOutput {
  const def = definition as PartDefinition<Record<string, ParameterSpec>>;
  if (!def || typeof def.build !== "function")
    throw new Error(
      "The code must `export default definePart({ parameters, build })`",
    );
  const parameters: CodeParameter[] = Object.entries(def.parameters ?? {}).map(
    ([name, spec]) => ({
      name,
      default: spec.default,
      ...(spec.min === undefined ? {} : { min: spec.min }),
      ...(spec.max === undefined ? {} : { max: spec.max }),
      ...(spec.label === undefined ? {} : { label: spec.label }),
      ...(spec.unit === undefined ? {} : { unit: spec.unit }),
    }),
  );
  const values = Object.fromEntries(
    parameters.map((p) => [p.name, given[p.name] ?? p.default]),
  );
  const output = def.build(values);
  if (!output || !Array.isArray(output.bodies))
    throw new Error("build() must return { bodies: [...] }");
  return {
    parameters,
    bodies: output.bodies.map((body) => ({
      name: String(body?.name ?? ""),
      recipe: body?.shape?.recipe as never,
    })),
    interfaces: (output.interfaces ?? []).map((i): CodeInterface => ({
      id: i.id,
      name: i.name ?? i.id,
      kind: i.kind ?? "screw",
      frame: i.plane ?? plane(),
      points: i.points.map((p) => ({ x: p.x, y: p.y })),
      ...(i.diameter === undefined ? {} : { diameter: i.diameter }),
      ...(i.depth === undefined ? {} : { depth: i.depth }),
    })),
  };
}
