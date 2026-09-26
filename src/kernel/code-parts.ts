// Code parts in the kernel. `buildCodeResult` turns what a code part's
// code returned (recipes, checked) into exact geometry, in the editor's
// kernel worker; `loadCodeResult` reads a stored result back into shapes
// for the evaluator, wherever it runs. Neither runs any of the part's code.
import * as b from "brepjs/quick";
import { Matrix4, Quaternion, Vector3 } from "three";
import { OpenCascadeEngine, recipeFiles } from "../engine.js";
import type { Recipe } from "../model.js";
import {
  checkCodeOutput,
  codeResultFormat,
  recipeFileNames,
  type CodeBlank,
  type CodeInterface,
  type CodeResult,
  type CodeResultBody,
} from "../document/code-part.js";
import type { Frame, Vec3 } from "../document/frames.js";
import type { RoleTable } from "./roles.js";
import { bore } from "./joints.js";

/** Builds the bodies a code part's code described. */
export async function buildCodeResult(
  output: unknown,
  key: string,
  /** The part's STEP files, base64 by name. */
  files: Readonly<Record<string, string>> = {},
): Promise<CodeResult> {
  const checked = checkCodeOutput(output);
  // Imported files are handed to the engine in memory, under paths only
  // this build uses; a name the part has no file for is an error, never a
  // read from anywhere else.
  const paths = new Map<string, string>();
  for (const body of checked.bodies)
    for (const name of recipeFileNames(body.recipe)) {
      const data = files[name];
      if (data === undefined)
        throw new Error(
          `${body.name} imports ${name}, which the part does not have`,
        );
      const path = `code-file:${key}:${name}`;
      paths.set(name, path);
      recipeFiles.set(path, base64Bytes(data));
    }
  const renamed = (recipe: Recipe): Recipe =>
    recipe.kind === "step"
      ? { kind: "step", path: paths.get(recipe.path)! }
      : "source" in recipe
        ? ({ ...recipe, source: renamed(recipe.source) } as Recipe)
        : "left" in recipe
          ? {
              ...recipe,
              left: renamed(recipe.left),
              right: renamed(recipe.right),
            }
          : recipe;
  const engine = new OpenCascadeEngine();
  try {
    const bodies: CodeResultBody[] = [];
    for (const [i, body] of checked.bodies.entries()) {
      let shape: b.Shape3D;
      try {
        shape = await engine.recipe(renamed(body.recipe));
      } catch (error) {
        throw new Error(
          `${body.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const solids = b.isSolid(shape) ? [shape] : b.getSolids(shape);
      if (!solids.length) throw new Error(`${body.name} has no volume`);
      const flat = flatBlank(body.recipe);
      bodies.push({
        id: `b${i}`,
        name: body.name,
        brep: b.unwrap(b.toBREP(shape)),
        ...(flat?.blank ? { blank: flat.blank } : {}),
        ...(flat?.drills.length ? { machining: flat.drills } : {}),
        ...(flat?.irregular ? { irregular: flat.irregular } : {}),
      });
    }
    return {
      format: codeResultFormat,
      formatVersion: 1,
      key,
      bodies,
      interfaces: checked.interfaces,
    };
  } finally {
    engine.dispose();
    for (const path of paths.values()) recipeFiles.delete(path);
  }
}

function base64Bytes(data: string): Uint8Array {
  const text = atob(data);
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

// ---------------------------------------------------------------- blanks

const vec3 = (v: Vector3): Vec3 => [v.x, v.y, v.z];

/** A rigid placement's frame: the recipe's own x, y and z, moved. */
function frameOf(m: Matrix4): Frame | undefined {
  const origin = new Vector3().applyMatrix4(m);
  const axes = [
    new Vector3(1, 0, 0),
    new Vector3(0, 1, 0),
    new Vector3(0, 0, 1),
  ].map((a) => a.transformDirection(m));
  const scale = new Vector3();
  m.decompose(new Vector3(), new Quaternion(), scale);
  if (
    Math.abs(scale.x - 1) > 1e-9 ||
    Math.abs(scale.y - 1) > 1e-9 ||
    Math.abs(scale.z - 1) > 1e-9 ||
    m.determinant() < 0
  )
    return undefined;
  return {
    origin: vec3(origin),
    x: vec3(axes[0]!),
    y: vec3(axes[1]!),
    normal: vec3(axes[2]!),
  };
}

const counterClockwise = (points: readonly { x: number; y: number }[]) => {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const c = points[(i + 1) % points.length]!;
    area += a.x * c.y - c.x * a.y;
  }
  return area >= 0 ? [...points] : [...points].reverse();
};

/** A cylinder, wherever its transforms put it: centre, axis, size. */
function cylinderOf(recipe: Recipe, m = new Matrix4()) {
  if (recipe.kind === "transform")
    return cylinderOf(
      recipe.source,
      m.clone().multiply(new Matrix4().fromArray(recipe.matrix)),
    );
  if (recipe.kind !== "cylinder") return undefined;
  return {
    centre: new Vector3().applyMatrix4(m),
    axis: new Vector3(0, 0, 1).transformDirection(m),
    diameter: recipe.diameter,
    length: recipe.length,
  };
}

/** The flat blank a body was made from, when it was: an extruded profile
 * or a box, moved, with cylinders cut square into it becoming drillings.
 * Other cuts leave a blank the body is more than (`irregular`). */
function flatBlank(
  recipe: Recipe,
  m = new Matrix4(),
):
  | {
      blank: CodeBlank;
      drills: NonNullable<CodeResultBody["machining"]>[number][];
      irregular?: string;
    }
  | undefined {
  switch (recipe.kind) {
    case "transform":
      return flatBlank(
        recipe.source,
        m.clone().multiply(new Matrix4().fromArray(recipe.matrix)),
      );
    case "box": {
      // A box is a panel as thick as its thinnest side: its blank faces
      // that way, with the other two sides as its outline.
      const { width: w, depth: d, height: h } = recipe;
      const turn =
        w <= d && w <= h
          ? // normal x; outline along y and z
            new Matrix4().set(0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1)
          : d <= h
            ? // normal y; outline along z and x
              new Matrix4().set(0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1)
            : new Matrix4();
      const [a, c, depth] =
        w <= d && w <= h ? [d, h, w] : d <= h ? [h, w, d] : [w, d, h];
      const frame = frameOf(m.clone().multiply(turn));
      if (!frame) return undefined;
      return {
        blank: {
          frame,
          depth,
          outline: [
            { x: 0, y: 0 },
            { x: a, y: 0 },
            { x: a, y: c },
            { x: 0, y: c },
          ],
          openings: [],
          curved: false,
        },
        drills: [],
      };
    }
    case "extrude": {
      const frame = frameOf(m);
      if (!frame) return undefined;
      return {
        blank: {
          frame,
          depth: recipe.height,
          outline: counterClockwise(recipe.points),
          openings: [],
          curved: false,
        },
        drills: [],
      };
    }
    case "cut": {
      const base = flatBlank(recipe.left, m);
      if (!base) return undefined;
      const tool = cylinderOf(recipe.right, m.clone());
      const n = new Vector3(...base.blank.frame.normal);
      const bottom = new Vector3(...base.blank.frame.origin).dot(n);
      const top = bottom + base.blank.depth;
      if (tool && Math.abs(Math.abs(tool.axis.dot(n)) - 1) < 1e-9) {
        const at = tool.centre.dot(n);
        const lo = Math.max(bottom, at - tool.length / 2);
        const hi = Math.min(top, at + tool.length / 2);
        if (hi - lo <= 1e-9) return base;
        const fromTop = Math.abs(hi - top) < 1e-6;
        const fromBottom = Math.abs(lo - bottom) < 1e-6;
        if (fromTop || fromBottom) {
          const surface = fromTop ? top : bottom;
          const entry = tool.centre
            .clone()
            .addScaledVector(n, surface - tool.centre.dot(n));
          const into = fromTop ? n.clone().negate() : n.clone();
          return {
            ...base,
            drills: [
              ...base.drills,
              {
                kind: "drill",
                recipe: bore(entry, into, tool.diameter, hi - lo),
                diameter: tool.diameter,
                depth: hi - lo,
              },
            ],
          };
        }
      }
      return {
        ...base,
        irregular:
          "the code cuts it with more than drillings square to its face",
      };
    }
    case "fillet":
    case "chamfer": {
      // Still cut from the same blank; the rounded edges are machining
      // the DXF does not describe.
      const base = flatBlank(recipe.source, m);
      return base
        ? {
            ...base,
            irregular: "the code rounds or bevels some of its edges",
          }
        : undefined;
    }
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------- loading

export interface LoadedCodeBody {
  readonly id: string;
  readonly name: string;
  readonly shape: b.Shape3D;
  readonly roles: RoleTable;
  readonly blank?: CodeBlank;
  readonly machining: NonNullable<CodeResultBody["machining"]>;
  readonly irregular?: string;
}

export interface LoadedCodeResult {
  readonly key: string;
  readonly bodies: readonly LoadedCodeBody[];
  readonly interfaces: readonly CodeInterface[];
}

const directions: readonly [string, Vec3][] = [
  ["+x", [1, 0, 0]],
  ["-x", [-1, 0, 0]],
  ["+y", [0, 1, 0]],
  ["-y", [0, -1, 0]],
  ["+z", [0, 0, 1]],
  ["-z", [0, 0, -1]],
];

/** Names for a code body's faces: `f<n>` for every face in the order the
 * BREP lists them, and `+z`, `-x`, … for the outermost flat face facing
 * each way, which stays the same when the part's size changes. */
export function codeRoles(shape: b.Shape3D): RoleTable {
  const roles = new Map<string, number[]>();
  const faces = b.getFaces(shape);
  const flat = faces.flatMap((face) => {
    if (b.faceGeomType(face) !== "PLANE") return [];
    const normal = b.normalAt(face) as unknown as Vec3;
    const centre = b.faceCenter(face) as unknown as Vec3;
    return [{ hash: b.getHashCode(face), normal, centre }];
  });
  faces.forEach((face, i) => roles.set(`f${i}`, [b.getHashCode(face)]));
  for (const [name, d] of directions) {
    let best: { hash: number; reach: number } | undefined;
    for (const f of flat) {
      const along =
        f.normal[0] * d[0] + f.normal[1] * d[1] + f.normal[2] * d[2];
      if (along < 1 - 1e-6) continue;
      const reach =
        f.centre[0] * d[0] + f.centre[1] * d[1] + f.centre[2] * d[2];
      if (!best || reach > best.reach + 1e-6) best = { hash: f.hash, reach };
    }
    if (best) roles.set(name, [best.hash]);
  }
  return new Map([["code", roles]]);
}

/** Reads a stored result's bodies back into shapes. */
export function loadCodeResult(result: CodeResult): LoadedCodeResult & {
  dispose(): void;
} {
  const shapes: b.Shape3D[] = [];
  try {
    const bodies = result.bodies.map((body): LoadedCodeBody => {
      const read = b.unwrap(b.deserializeShape(body.brep));
      if (!b.isShape3D(read)) throw new Error(`${body.name} is not a solid`);
      shapes.push(read);
      return {
        id: body.id,
        name: body.name,
        shape: read,
        roles: codeRoles(read),
        ...(body.blank ? { blank: body.blank } : {}),
        machining: body.machining ?? [],
        ...(body.irregular ? { irregular: body.irregular } : {}),
      };
    });
    return {
      key: result.key,
      bodies,
      interfaces: result.interfaces,
      dispose: () => {
        for (const shape of shapes) shape[Symbol.dispose]();
      },
    };
  } catch (error) {
    for (const shape of shapes) shape[Symbol.dispose]();
    throw error;
  }
}

/** Results by key, as the evaluator asks for them. */
export interface CodeResultSource {
  get(key: string): LoadedCodeResult | undefined;
}

/** A small store of loaded results, freeing the oldest past `limit`. */
export class CodeResults implements CodeResultSource {
  private readonly loaded = new Map<
    string,
    ReturnType<typeof loadCodeResult>
  >();
  constructor(private readonly limit = 64) {}

  has(key: string): boolean {
    return this.loaded.has(key);
  }
  get(key: string): LoadedCodeResult | undefined {
    const found = this.loaded.get(key);
    if (found) {
      // Most recently used last.
      this.loaded.delete(key);
      this.loaded.set(key, found);
    }
    return found;
  }
  add(result: CodeResult): void {
    const old = this.loaded.get(result.key);
    const next = loadCodeResult(result);
    old?.dispose();
    this.loaded.delete(result.key);
    this.loaded.set(result.key, next);
    while (this.loaded.size > this.limit) {
      const [oldest, value] = this.loaded.entries().next().value!;
      value.dispose();
      this.loaded.delete(oldest);
    }
  }
  dispose(): void {
    for (const value of this.loaded.values()) value.dispose();
    this.loaded.clear();
  }
}
