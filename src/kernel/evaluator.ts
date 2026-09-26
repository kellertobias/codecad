// Turns a document's feature list into bodies. Features run in order, each
// taking the model the previous ones left (its bodies, the placement of
// every sketch, and what each feature made) and returning the next one.
//
// Every step is cached under a key made of the key before it and the
// feature with its expressions evaluated, so an edit only re-runs the
// features from the first one whose key changed. Shapes a step creates are
// owned by that step and freed when it is re-run.
//
// A feature that fails leaves the model as it was and reports why; the
// features after it still run. A reference that no longer resolves exactly
// is an error, never a guess.
import * as b from "brepjs/quick";
import { Matrix4, Quaternion, Vector3 } from "three";
import type { Recipe } from "../model.js";
import {
  axisVector,
  dot,
  faceFrame,
  frameMatrix,
  length,
  normalize,
  offsetFrame,
  planeFrame,
  scale,
  sub,
  toLocal,
  toWorld,
  type Frame,
  type Vec3,
} from "../document/frames.js";
import {
  detectProfiles,
  matchRegions,
  type Loop,
  type Region,
} from "../document/profiles.js";
import {
  mapExpressions,
  type CadDocument,
  type EdgeReference,
  type ExtrudeFeature,
  type FaceReference,
  type Feature,
  type HoleFeature,
  type InstanceFeature,
  type JointFeature,
  type MateFeature,
  type MoveFeature,
  type MirrorFeature,
  type PatternFeature,
  type SketchFeature,
} from "../document/schema.js";
import {
  evaluateVariables,
  evaluateWith,
  type VariableValues,
} from "../document/variables.js";
import type { SketchSolver } from "../document/sketch-solver.js";
import {
  codeResultKey,
  isCodePinned,
  parameterValues,
  type CodePinned,
} from "../document/code-part.js";
import type { CodeResultSource, LoadedCodeResult } from "./code-parts.js";
import { solveDocument } from "../document/sketch-edit.js";
import {
  bore,
  contact,
  grown,
  JointError,
  panelOf,
  planJoint,
  type Hardware,
} from "./joints.js";
import {
  booleanRoles,
  copyRoles,
  remapRoles,
  sweptRoles,
  withRoles,
  type RoleTable,
} from "./roles.js";

/** The flat stock a body was cut from: a region of a sketch extruded
 * `depth` along the frame's normal from the frame's origin. */
export interface Blank {
  readonly frame: Frame;
  readonly depth: number;
  /** Counter-clockwise, in the frame's x/y. */
  readonly outline: readonly { x: number; y: number }[];
  /** Openings in the region itself, clockwise. */
  readonly openings: readonly (readonly { x: number; y: number }[])[];
  /** Whether the outline has arcs, which `outline` only samples. */
  readonly curved: boolean;
}

/** A cut made into a body after it was created, in model coordinates. */
export interface Machining {
  readonly feature: string;
  readonly kind:
    | "cut"
    | "drill"
    | "countersink"
    | "counterbore"
    | "domino"
    | "edge-drill"
    | "dado"
    | "rabbet"
    | "miter";
  readonly recipe: Recipe;
  readonly diameter?: number;
  readonly depth?: number;
}

export interface Body {
  readonly id: string;
  /** The name the feature gives it; parts may rename it. */
  readonly name: string;
  /** The feature that created it. */
  readonly feature: string;
  readonly shape: b.Shape3D;
  readonly roles: RoleTable;
  readonly blank?: Blank;
  readonly machining: readonly Machining[];
  /** Why the body is more than a blank with cuts, if it is. */
  readonly irregular?: string;
}

/** A solid a feature swept or placed, kept so patterns and mirrors can
 * repeat it. */
interface Tool {
  readonly shape: b.Shape3D;
  /** Names of the tool's faces, under the feature's id. */
  readonly roles: ReadonlyMap<string, readonly number[]>;
  /** For the manufacturing outputs: the cuts the tool makes, each a
   * single primitive where it can be. */
  readonly machining?: readonly Omit<Machining, "feature">[];
  readonly blank?: Blank;
  /** `new` tools become bodies with these ids. */
  readonly body?: string;
  /** The part of the tool that has to reach into a body to change it. */
  readonly probe?: b.Shape3D;
}

interface Made {
  readonly operation: "new" | "add" | "cut" | "intersect";
  readonly tools: readonly Tool[];
  readonly name: string;
}

interface Model {
  readonly bodies: ReadonlyMap<string, Body>;
  /** Bodies fused into others: old id → the body it became part of. */
  readonly merged: ReadonlyMap<string, string>;
  readonly frames: ReadonlyMap<string, Frame>;
  readonly made: ReadonlyMap<string, Made>;
  /** Hardware each joint needs, by feature. */
  readonly hardware: ReadonlyMap<string, readonly Hardware[]>;
}

export type FeatureStatus =
  | { readonly state: "ok"; readonly ms: number }
  | { readonly state: "suppressed" }
  | { readonly state: "rolled-back" }
  | {
      readonly state: "error";
      readonly message: string;
      /** A reference to a face, edge, region or body that is gone. */
      readonly broken?: boolean;
      /** A code part's result is missing; the editor regenerates it. */
      readonly regenerate?: boolean;
      readonly ms: number;
    };

export interface Evaluation {
  readonly bodies: readonly Body[];
  readonly status: ReadonlyMap<string, FeatureStatus>;
  /** Where each placed sketch lies. */
  readonly frames: ReadonlyMap<string, Frame>;
  /** For sketches on faces: the face's edges in sketch coordinates, as
   * x1, y1, x2, y2 runs, to draw and snap to. */
  readonly projections: ReadonlyMap<string, Float32Array>;
  /** Library instances evaluated this time: from which of their features
   * they were rebuilt (all of them cached: their feature count). */
  readonly instances: ReadonlyMap<string, { rerunFrom: number; ms: number }>;
  /** Screws, dowels and dominos the joints need. */
  readonly hardware: readonly (Hardware & { readonly feature: string })[];
  /** Index of the first feature that was re-run; features.length when
   * everything came from the cache. */
  readonly rerunFrom: number;
  readonly ms: number;
}

class FeatureError extends Error {
  constructor(
    message: string,
    readonly broken = false,
    /** A code part's result is missing: the editor has to run its code. */
    readonly regenerate = false,
  ) {
    super(message);
  }
}

interface Step {
  readonly key: string;
  readonly model: Model;
  readonly status: FeatureStatus;
  readonly projection?: Float32Array;
  readonly owned: Set<Disposable>;
}

const emptyModel: Model = {
  bodies: new Map(),
  merged: new Map(),
  frames: new Map(),
  made: new Map(),
  hardware: new Map(),
};

export class DocumentEvaluator {
  private steps: Step[] = [];
  /** One evaluator per library instance, so each keeps its own cache. */
  private readonly instances = new Map<string, DocumentEvaluator>();
  /** How the instances evaluated in the last evaluation went. */
  private runs = new Map<string, { rerunFrom: number; ms: number }>();

  /** `solver` re-solves the sketches of library items whose variables an
   * instance sets. */
  constructor(
    private options: {
      solver?: SketchSolver;
      /** Stored results of code parts, by key (see code-parts.ts). */
      codeResults?: CodeResultSource;
    } = {},
  ) {}

  /** Gives the evaluator a sketch solver once one has loaded. */
  useSolver(solver: SketchSolver): void {
    this.options = { ...this.options, solver };
    for (const nested of this.instances.values()) nested.useSolver(solver);
  }

  /** Where code parts' results come from. */
  useCodeResults(codeResults: CodeResultSource): void {
    this.options = { ...this.options, codeResults };
  }

  /** Evaluates the features of a solved document, up to and including
   * the one at index `until` (all of them when left out). */
  evaluate(
    document: CadDocument,
    options: { until?: number } = {},
  ): Evaluation {
    const started = performance.now();
    const variables = evaluateVariables(document.variables);
    const features = document.features;
    const last = Math.min(
      options.until ?? features.length - 1,
      features.length - 1,
    );
    const status = new Map<string, FeatureStatus>();
    const projections = new Map<string, Float32Array>();
    this.runs = new Map();
    let model = emptyModel;
    let key = "";
    let rerunFrom = features.length;
    for (let i = 0; i < features.length; i++) {
      const feature = features[i]!;
      if (i > last) {
        status.set(feature.id, { state: "rolled-back" });
        continue;
      }
      key = hash(key + "\n" + featureKey(feature, variables));
      let step = this.steps[i];
      if (step?.key !== key) {
        if (rerunFrom > i) {
          rerunFrom = i;
          this.drop(i);
        }
        step = this.run(feature, document, variables, model, key);
        this.steps[i] = step;
      }
      model = step.model;
      status.set(feature.id, step.status);
      if (step.projection) projections.set(feature.id, step.projection);
    }
    // Steps past the end belong to features that were deleted.
    if (this.steps.length > features.length) this.drop(features.length);
    for (const [id, nested] of this.instances)
      if (!features.some((f) => f.id === id && f.type === "instance")) {
        nested.dispose();
        this.instances.delete(id);
      }
    return {
      instances: this.runs,
      bodies: [...model.bodies.values()],
      status,
      frames: model.frames,
      projections,
      hardware: [...model.hardware].flatMap(([feature, items]) =>
        items.map((item) => ({ ...item, feature })),
      ),
      rerunFrom,
      ms: performance.now() - started,
    };
  }

  /** Frees every shape the evaluator holds. */
  dispose(): void {
    this.drop(0);
    for (const nested of this.instances.values()) nested.dispose();
    this.instances.clear();
  }

  private drop(from: number): void {
    for (const step of this.steps.splice(from))
      for (const shape of step.owned) shape[Symbol.dispose]();
  }

  private run(
    feature: Feature,
    document: CadDocument,
    variables: VariableValues,
    model: Model,
    key: string,
  ): Step {
    const owned = new Set<Disposable>();
    if (feature.suppressed)
      return { key, model, status: { state: "suppressed" }, owned };
    const started = performance.now();
    const context: Context = {
      document,
      model,
      ...(this.options.solver ? { solver: this.options.solver } : {}),
      nested: (id) => {
        let nested = this.instances.get(id);
        if (!nested) {
          nested = new DocumentEvaluator(this.options);
          this.instances.set(id, nested);
        }
        return nested;
      },
      codeResult: (key) => this.options.codeResults?.get(key),
      ran: (id, evaluation) =>
        this.runs.set(id, {
          rerunFrom: evaluation.rerunFrom,
          ms: evaluation.ms,
        }),
      own: <T extends Disposable>(shape: T) => {
        owned.add(shape);
        return shape;
      },
      value: (expression, name) => {
        try {
          return evaluateWith(expression, variables);
        } catch (error) {
          throw new FeatureError(
            `${name}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    };
    try {
      const result = evaluators[feature.type](feature as never, context);
      return {
        key,
        model: result.model,
        status: { state: "ok", ms: performance.now() - started },
        ...(result.projection ? { projection: result.projection } : {}),
        owned,
      };
    } catch (error) {
      const regenerate = error instanceof FeatureError && error.regenerate;
      return {
        // A missing result may arrive by the next evaluation: never reuse
        // this step for it.
        key: regenerate ? `${key}\0missing` : key,
        model,
        status: {
          state: "error",
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof FeatureError && error.broken
            ? { broken: true }
            : {}),
          ...(regenerate ? { regenerate: true } : {}),
          ms: performance.now() - started,
        },
        owned,
      };
    }
  }
}

interface Context {
  readonly document: CadDocument;
  readonly model: Model;
  readonly solver?: SketchSolver;
  /** The evaluator kept for a library instance. */
  nested(id: string): DocumentEvaluator;
  ran(id: string, evaluation: Evaluation): void;
  codeResult(key: string): LoadedCodeResult | undefined;
  own<T extends Disposable>(shape: T): T;
  /** An expression's value, or a FeatureError naming the field. */
  value(expression: string, name: string): number;
}

interface Result {
  readonly model: Model;
  readonly projection?: Float32Array;
}

type Evaluators = {
  [T in Feature["type"]]: (
    feature: Extract<Feature, { type: T }>,
    context: Context,
  ) => Result;
};

const evaluators: Evaluators = {
  sketch: placeSketch,
  extrude,
  fillet: (feature, context) => roundEdges(feature, context, "fillet"),
  chamfer: (feature, context) => roundEdges(feature, context, "chamfer"),
  shell,
  hole,
  joint,
  move,
  mate,
  instance,
  pattern: (feature, context) => repeat(feature, context),
  mirror: (feature, context) => repeat(feature, context),
};

// ---------------------------------------------------------------- keys

/** A cheap 53-bit string hash (cyrb53), as a short string. */
function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The feature as it affects geometry: expressions replaced by their
 * values, so changing a variable only re-runs the features that use it. */
function featureKey(feature: Feature, variables: VariableValues): string {
  const valued = mapExpressions(feature, (expression) => {
    try {
      return String(evaluateWith(expression, variables));
    } catch {
      return `!${expression}`;
    }
  });
  const { name: _name, ...rest } = valued;
  return JSON.stringify(rest);
}

// ---------------------------------------------------------------- helpers

const v3 = (v: Vec3) => [v[0], v[1], v[2]] as [number, number, number];

function sketchOf(context: Context, id: string): SketchFeature {
  const sketch = context.document.features.find((f) => f.id === id);
  if (sketch?.type !== "sketch")
    throw new FeatureError(`Sketch ${id} does not exist`, true);
  return sketch;
}

function frameOf(context: Context, sketch: SketchFeature): Frame {
  const frame = context.model.frames.get(sketch.id);
  if (!frame)
    throw new FeatureError(
      sketch.suppressed
        ? `${sketch.name} is suppressed`
        : `${sketch.name} could not be placed`,
    );
  return frame;
}

function bodyOf(model: Model, id: string): Body | undefined {
  let current = id;
  for (let i = 0; i < 100 && !model.bodies.has(current); i++) {
    const next = model.merged.get(current);
    if (!next) return undefined;
    current = next;
  }
  return model.bodies.get(current);
}

/** The face a reference names, only when it resolves exactly. */
export function resolveFace(
  model: Pick<Model, "bodies" | "merged">,
  ref: FaceReference,
): { body: Body; face: b.Face } {
  const body = bodyOf(model as Model, ref.body);
  if (!body)
    throw new FeatureError(`The body ${ref.body} no longer exists`, true);
  const hashes = body.roles.get(ref.origin)?.get(ref.role);
  const faces = hashes?.length
    ? b.getFaces(body.shape).filter((f) => hashes.includes(b.getHashCode(f)))
    : [];
  if (!faces.length)
    throw new FeatureError(
      `The face ${ref.role} of ${ref.origin} no longer exists on ${body.name}`,
      true,
    );
  if (faces.length === 1) return { body, face: faces[0]! };
  // The named face was split: take the piece nearest to where it was.
  const at = ref.hint?.centroid as Vec3 | undefined;
  if (!at)
    throw new FeatureError(
      `The face ${ref.role} of ${ref.origin} was split; pick the piece again`,
      true,
    );
  const nearest = faces
    .map((face) => ({
      face,
      distance: length(sub(b.faceCenter(face) as unknown as Vec3, at)),
    }))
    .sort((p, q) => p.distance - q.distance)[0]!;
  return { body, face: nearest.face };
}

function resolveEdge(
  model: Model,
  ref: EdgeReference,
): { body: Body; edge: b.Edge } {
  const a = resolveFace(model, ref.a);
  const other = resolveFace(model, ref.b);
  if (a.body.id !== other.body.id)
    throw new FeatureError("The edge's faces are on different bodies", true);
  const edges = b.sharedEdges(a.face, other.face);
  if (!edges.length)
    throw new FeatureError(
      `The faces ${ref.a.role} and ${ref.b.role} no longer meet at an edge`,
      true,
    );
  if (edges.length === 1 || !ref.near) return { body: a.body, edge: edges[0]! };
  const near = ref.near as Vec3;
  const midpoint = (edge: b.Edge) =>
    b.curvePointAt(edge, 0.5) as unknown as Vec3;
  const edge = [...edges].sort(
    (p, q) => length(sub(midpoint(p), near)) - length(sub(midpoint(q), near)),
  )[0]!;
  return { body: a.body, edge };
}

function planarFrame(face: b.Face, what: string): Frame {
  if (b.faceGeomType(face) !== "PLANE")
    throw new FeatureError(`${what} must be a flat face`);
  return faceFrame(
    b.normalAt(face) as unknown as Vec3,
    b.faceCenter(face) as unknown as Vec3,
  );
}

function withBody(model: Model, body: Body): Model {
  const bodies = new Map(model.bodies);
  bodies.set(body.id, body);
  return { ...model, bodies };
}

function withoutBody(model: Model, id: string, into?: string): Model {
  const bodies = new Map(model.bodies);
  bodies.delete(id);
  const merged = new Map(model.merged);
  if (into) merged.set(id, into);
  return { ...model, bodies, merged };
}

function withMade(model: Model, id: string, made: Made): Model {
  const all = new Map(model.made);
  all.set(id, made);
  return { ...model, made: all };
}

const overlaps = (p: b.Bounds3D, q: b.Bounds3D, slack = 1e-6) =>
  p.xMin <= q.xMax + slack &&
  q.xMin <= p.xMax + slack &&
  p.yMin <= q.yMax + slack &&
  q.yMin <= p.yMax + slack &&
  p.zMin <= q.zMax + slack &&
  q.zMin <= p.zMax + slack;

/** The bodies a tool changes: the listed ones, or every one it reaches. */
function targets(
  model: Model,
  listed: readonly string[] | undefined,
  tool: b.Shape3D,
  operation: "add" | "cut" | "intersect",
  /** What must really reach into a body for the tool to change it: the
   * tool without the bit that reaches past the surface it starts on. */
  probe: b.Shape3D = tool,
): Body[] {
  if (listed?.length)
    return listed.map((id) => {
      const body = bodyOf(model, id);
      if (!body)
        throw new FeatureError(`The body ${id} no longer exists`, true);
      return body;
    });
  const bounds = b.getBounds(probe);
  const near = [...model.bodies.values()].filter((body) =>
    overlaps(b.getBounds(body.shape), bounds),
  );
  // Material is added to what it touches; a cut only changes what it
  // really cuts into, not a neighbour its box happens to reach.
  if (operation === "add") return near;
  return near.filter((body) => {
    const common = b.intersect(body.shape, probe);
    if (!common.ok) return true;
    try {
      return b.unwrap(b.measureVolume(common.value)) > 1e-6;
    } finally {
      common.value[Symbol.dispose]();
    }
  });
}

function solidCount(shape: b.Shape3D): number {
  return b.isSolid(shape) ? 1 : b.getSolids(shape).length;
}

/** Applies a tool to a body with a boolean, carrying its face names. */
function combine(
  context: Context,
  body: Body,
  tool: b.Shape3D,
  toolRoles: ReadonlyMap<string, readonly number[]>,
  origin: string,
  operation: "add" | "cut" | "intersect",
): Body {
  const run =
    operation === "add"
      ? b.fuseWithEvolution
      : operation === "cut"
        ? b.cutWithEvolution
        : b.intersectWithEvolution;
  const result = run(body.shape, tool);
  if (!result.ok)
    throw new FeatureError(
      `The ${operation} failed on ${body.name}: ${String(result.error?.message ?? result.error)}`,
    );
  const shape = context.own(result.value.shape);
  return {
    ...body,
    shape,
    roles: booleanRoles(
      withRoles(body.roles, origin, toolRoles),
      result.value.evolution,
      [body.shape, tool],
      shape,
    ),
  };
}

/** A shape moved by a column-major 4×4 matrix. */
function place<T extends b.AnyShape>(
  context: Context,
  shape: T,
  m: Matrix4,
): T {
  const e = m.elements;
  return context.own(
    b.unwrap(
      b.applyMatrix(shape, {
        linear: [
          e[0]!,
          e[4]!,
          e[8]!,
          e[1]!,
          e[5]!,
          e[9]!,
          e[2]!,
          e[6]!,
          e[10]!,
        ],
        translation: [e[12]!, e[13]!, e[14]!],
      }),
    ),
  );
}

/** A solid from the small set of recipes tools are described with. */
function build(context: Context, recipe: Recipe): b.Shape3D {
  switch (recipe.kind) {
    case "box":
      return context.own(b.box(recipe.width, recipe.depth, recipe.height));
    case "cylinder":
      return context.own(
        b.cylinder(recipe.diameter / 2, recipe.length, { centered: true }),
      );
    case "cone":
      return context.own(b.cone(recipe.diameter / 2, 0, recipe.length));
    case "transform":
      return place(
        context,
        build(context, recipe.source),
        new Matrix4().fromArray(recipe.matrix),
      );
    case "union":
      return context.own(
        b.unwrap(
          b.fuse(build(context, recipe.left), build(context, recipe.right)),
        ),
      );
    case "extrude": {
      const face = context.own(
        b.unwrap(b.polygon(recipe.points.map((p) => [p.x, p.y, 0]))),
      );
      return context.own(b.unwrap(b.extrude(face, recipe.height)));
    }
    case "cut":
      return context.own(
        b.unwrap(
          b.cut(build(context, recipe.left), build(context, recipe.right)),
        ),
      );
    default:
      throw new Error(`Tools cannot be built from ${recipe.kind} recipes`);
  }
}

const transformRecipe = (recipe: Recipe, m: Matrix4): Recipe => ({
  kind: "transform",
  source: recipe,
  matrix: m.toArray(),
});

const frameMatrix4 = (frame: Frame) =>
  new Matrix4().fromArray(frameMatrix(frame));

/** Everything the model's bodies span, for through-all extents. */
function modelBounds(model: Model): b.Bounds3D | undefined {
  let all: b.Bounds3D | undefined;
  for (const body of model.bodies.values()) {
    const bb = b.getBounds(body.shape);
    all = all
      ? {
          xMin: Math.min(all.xMin, bb.xMin),
          xMax: Math.max(all.xMax, bb.xMax),
          yMin: Math.min(all.yMin, bb.yMin),
          yMax: Math.max(all.yMax, bb.yMax),
          zMin: Math.min(all.zMin, bb.zMin),
          zMax: Math.max(all.zMax, bb.zMax),
        }
      : bb;
  }
  return all;
}

/** How far "through all" has to reach from a frame's origin. */
function reach(model: Model, frame: Frame): number {
  const bounds = modelBounds(model);
  if (!bounds) throw new FeatureError("Through all needs a body to go through");
  const center: Vec3 = [
    (bounds.xMin + bounds.xMax) / 2,
    (bounds.yMin + bounds.yMax) / 2,
    (bounds.zMin + bounds.zMax) / 2,
  ];
  const diagonal = Math.hypot(
    bounds.xMax - bounds.xMin,
    bounds.yMax - bounds.yMin,
    bounds.zMax - bounds.zMin,
  );
  return diagonal + length(sub(center, frame.origin)) + 1;
}

// ---------------------------------------------------------------- sketch

function placeSketch(feature: SketchFeature, context: Context): Result {
  const frames = new Map(context.model.frames);
  if (!feature.face) {
    frames.set(feature.id, planeFrame(feature.plane));
    return { model: { ...context.model, frames } };
  }
  const { face } = resolveFace(context.model, feature.face);
  const frame = planarFrame(face, "A sketch face");
  frames.set(feature.id, frame);
  // The face's edges, flattened into the sketch, to draw and snap to.
  const lines = b.meshEdges(face, { tolerance: 0.05, cache: false }).lines;
  const projection = new Float32Array((lines.length / 6) * 4);
  for (let i = 0, j = 0; i < lines.length; i += 6, j += 4) {
    const p = toLocal(frame, [lines[i]!, lines[i + 1]!, lines[i + 2]!]);
    const q = toLocal(frame, [lines[i + 3]!, lines[i + 4]!, lines[i + 5]!]);
    projection.set([p[0], p[1], q[0], q[1]], j);
  }
  return { model: { ...context.model, frames }, projection };
}

// ---------------------------------------------------------------- extrude

function loopWire(context: Context, loop: Loop, frame: Frame): b.Wire {
  const at = (p: { x: number; y: number }) => v3(toWorld(frame, p.x, p.y));
  const edges = loop.curves.map((curve) => {
    if (curve.kind === "line")
      return context.own(b.line(at(curve.from), at(curve.to)));
    const c = curve.center!;
    const r = Math.hypot(curve.from.x - c.x, curve.from.y - c.y);
    if (curve.kind === "circle")
      return context.own(b.circle(r, { at: at(c), axis: v3(frame.normal) }));
    const a0 = Math.atan2(curve.from.y - c.y, curve.from.x - c.x);
    const a1 = Math.atan2(curve.to.y - c.y, curve.to.x - c.x);
    const turn = (a: number) => (a + 4 * Math.PI) % (2 * Math.PI);
    const middle = curve.clockwise
      ? a0 - turn(a0 - a1) / 2
      : a0 + turn(a1 - a0) / 2;
    return context.own(
      b.threePointArc(
        at(curve.from),
        at({ x: c.x + r * Math.cos(middle), y: c.y + r * Math.sin(middle) }),
        at(curve.to),
      ),
    );
  });
  return context.own(b.unwrap(b.wire(edges)));
}

/** A region swept from `frame` along its normal by `depth`. */
function sweep(
  context: Context,
  region: Region,
  frame: Frame,
  depth: number,
): b.Shape3D {
  const outer = loopWire(context, region.outer, frame);
  const holes = region.holes.map((hole) => loopWire(context, hole, frame));
  const face = context.own(b.unwrap(b.face(outer as never, holes as never)));
  return context.own(
    b.unwrap(b.extrude(face as never, v3(scale(frame.normal, depth)))),
  );
}

/** Where along the sketch normal an extrude starts and ends. */
function extent(
  feature: ExtrudeFeature,
  frame: Frame,
  context: Context,
): [number, number] {
  const flip = feature.reverse ? -1 : 1;
  switch (feature.extent) {
    case "blind": {
      const d = context.value(feature.distance ?? "", "Distance");
      if (!(d > 0)) throw new FeatureError("Distance must be more than 0");
      return flip > 0 ? [0, d] : [-d, 0];
    }
    case "symmetric": {
      const d = context.value(feature.distance ?? "", "Distance");
      if (!(d > 0)) throw new FeatureError("Distance must be more than 0");
      return [-d / 2, d / 2];
    }
    case "throughAll": {
      const d = reach(context.model, frame);
      return flip > 0 ? [0, d] : [-d, 0];
    }
    case "upTo": {
      if (!feature.upTo) throw new FeatureError("Pick the face to extrude to");
      const { face } = resolveFace(context.model, feature.upTo);
      const target = planarFrame(face, "The face to extrude to");
      if (Math.abs(dot(target.normal, frame.normal)) < 1 - 1e-9)
        throw new FeatureError(
          "The face to extrude to must be parallel to the sketch",
        );
      const d = dot(sub(target.origin, frame.origin), frame.normal);
      if (Math.abs(d) < 1e-9)
        throw new FeatureError("The face to extrude to is on the sketch plane");
      return d > 0 ? [0, d] : [d, 0];
    }
  }
}

/** A recipe for a swept region, for manufacturing outputs: a cylinder for
 * a plain circle, otherwise the region's outline as a polygon. */
function sweepRecipe(region: Region, frame: Frame, depth: number): Recipe {
  const m = frameMatrix4(frame);
  const [only] = region.outer.curves;
  if (region.outer.curves.length === 1 && only?.kind === "circle") {
    const c = only.center!;
    const r = Math.hypot(only.from.x - c.x, only.from.y - c.y);
    return transformRecipe(
      { kind: "cylinder", diameter: 2 * r, length: depth },
      m.clone().multiply(new Matrix4().makeTranslation(c.x, c.y, depth / 2)),
    );
  }
  let recipe: Recipe = transformRecipe(
    { kind: "extrude", points: [...region.outer.polygon], height: depth },
    m,
  );
  for (const hole of region.holes)
    recipe = {
      kind: "cut",
      left: recipe,
      right: transformRecipe(
        { kind: "extrude", points: [...hole.polygon], height: depth },
        m,
      ),
    };
  return recipe;
}

function extrude(feature: ExtrudeFeature, context: Context): Result {
  const sketch = sketchOf(context, feature.sketch);
  const frame = frameOf(context, sketch);
  const profiles = detectProfiles(sketch);
  if (!profiles.regions.length)
    throw new FeatureError(`${sketch.name} has no closed region`);
  let regions: Region[];
  if (feature.regions?.length) {
    const matched = matchRegions(feature.regions, profiles.regions);
    const missing = matched.filter((r) => !r).length;
    if (missing)
      throw new FeatureError(
        `${missing} of the chosen regions no longer exist in ${sketch.name}; choose them again`,
        true,
      );
    regions = matched as Region[];
  } else regions = [...profiles.regions].sort((p, q) => (p.id < q.id ? -1 : 1));
  const [z0, z1] = extent(feature, frame, context);
  const start = offsetFrame(frame, z0);
  const depth = z1 - z0;
  const tools: Tool[] = regions.map((region, k) => {
    const shape = sweep(context, region, start, depth);
    const roles = sweptRoles(shape, start, [
      ...region.outer.curves,
      ...region.holes.flatMap((hole) => hole.curves),
    ]);
    const blank: Blank = {
      frame: start,
      depth,
      outline: region.outer.polygon,
      openings: region.holes.map((hole) => hole.polygon),
      curved: region.outer.curves.some((curve) => curve.kind !== "line"),
    };
    return feature.operation === "new"
      ? { shape, roles, blank, body: `${feature.id}:${k}` }
      : {
          shape,
          roles,
          machining: [
            { kind: "cut", recipe: sweepRecipe(region, start, depth) },
          ],
        };
  });
  const made: Made = {
    operation: feature.operation,
    tools,
    name: feature.name,
  };
  const model = apply(
    context,
    feature.id,
    made,
    feature.targets,
    context.model,
  );
  return { model: withMade(model, feature.id, made) };
}

/** Applies what a feature made to the model: new bodies, or booleans on
 * the bodies each tool reaches. `origin` names the faces it adds. */
function apply(
  context: Context,
  origin: string,
  made: Made,
  listed: readonly string[] | undefined,
  model: Model,
  rename: (id: string) => string = (id) => id,
): Model {
  if (made.operation === "new") {
    made.tools.forEach((tool, k) => {
      model = withBody(model, {
        id: rename(tool.body!),
        name: made.tools.length === 1 ? made.name : `${made.name} (${k + 1})`,
        feature: origin,
        shape: tool.shape,
        roles: withRoles(new Map(), origin, tool.roles),
        ...(tool.blank ? { blank: tool.blank } : {}),
        machining: [],
      });
    });
    return model;
  }
  const operation = made.operation;
  let changed = 0;
  for (const tool of made.tools) {
    const reached = targets(
      model,
      listed,
      tool.shape,
      made.operation,
      tool.probe,
    );
    if (!reached.length) continue;
    if (operation === "add") {
      // The tool joins the first body it reaches; the other bodies it
      // reaches become part of that one.
      let [into, ...rest] = reached;
      into = combine(context, into!, tool.shape, tool.roles, origin, "add");
      for (const other of rest) {
        into = {
          ...combine(context, into, other.shape, new Map(), origin, "add"),
          roles: mergeRoles(into.roles, other.roles),
        };
        model = withoutBody(model, other.id, into.id);
      }
      model = withBody(model, { ...into, irregular: "material was added" });
      changed++;
      continue;
    }
    for (const body of reached) {
      const next = combine(
        context,
        body,
        tool.shape,
        tool.roles,
        origin,
        operation,
      );
      if (!solidCount(next.shape)) {
        model = withoutBody(model, body.id);
        changed++;
        continue;
      }
      model = withBody(model, {
        ...next,
        ...(operation === "intersect"
          ? { irregular: "it was intersected" }
          : {}),
        machining: [
          ...body.machining,
          ...(tool.machining ?? []).map((cut) => ({ ...cut, feature: origin })),
        ],
      });
      changed++;
    }
  }
  if (!changed)
    throw new FeatureError(
      operation === "add"
        ? "There is no body to add to here"
        : `The ${operation} reaches no body`,
    );
  return model;
}

function mergeRoles(a: RoleTable, c: RoleTable): RoleTable {
  const next = new Map(a);
  for (const [origin, roles] of c) {
    const into = new Map(next.get(origin) ?? []);
    for (const [role, hashes] of roles)
      into.set(role, [...(into.get(role) ?? []), ...hashes]);
    next.set(origin, into);
  }
  return next;
}

// ---------------------------------------------------------------- fillet, chamfer, shell

function roundEdges(
  feature: Extract<Feature, { type: "fillet" | "chamfer" }>,
  context: Context,
  kind: "fillet" | "chamfer",
): Result {
  if (!feature.edges.length) throw new FeatureError("Pick the edges to round");
  const size = context.value(
    kind === "fillet"
      ? (feature as Extract<Feature, { type: "fillet" }>).radius
      : (feature as Extract<Feature, { type: "chamfer" }>).distance,
    kind === "fillet" ? "Radius" : "Distance",
  );
  if (!(size > 0))
    throw new FeatureError(
      `${kind === "fillet" ? "Radius" : "Distance"} must be more than 0`,
    );
  const byBody = new Map<string, { body: Body; edges: b.Edge[] }>();
  for (const ref of feature.edges) {
    const { body, edge } = resolveEdge(context.model, ref);
    const entry = byBody.get(body.id) ?? { body, edges: [] };
    entry.edges.push(edge);
    byBody.set(body.id, entry);
  }
  let model = context.model;
  for (const { body, edges } of byBody.values()) {
    const solid = single(body);
    const run =
      kind === "fillet" ? b.filletWithEvolution : b.chamferWithEvolution;
    const result = run(solid, edges, size);
    if (!result.ok)
      throw new FeatureError(
        `The ${kind === "fillet" ? "fillet" : "chamfer"} failed on ${body.name}; try a smaller size`,
      );
    const shape = context.own(result.value.shape);
    model = withBody(model, {
      ...body,
      shape,
      roles: remapRoles(body.roles, body.shape, shape),
      irregular:
        kind === "fillet" ? "edges were rounded" : "edges were chamfered",
    });
  }
  return { model };
}

function single(body: Body): b.ValidSolid {
  const solids = b.isSolid(body.shape) ? [body.shape] : b.getSolids(body.shape);
  if (solids.length !== 1)
    throw new FeatureError(
      `${body.name} is ${solids.length} separate solids; this needs one`,
    );
  return b.unwrap(b.validSolid(solids[0]!));
}

function shell(
  feature: Extract<Feature, { type: "shell" }>,
  context: Context,
): Result {
  const thickness = context.value(feature.thickness, "Thickness");
  if (!(thickness > 0)) throw new FeatureError("Thickness must be more than 0");
  if (!feature.faces.length) throw new FeatureError("Pick the faces to open");
  const resolved = feature.faces.map((ref) => resolveFace(context.model, ref));
  const body = resolved[0]!.body;
  if (resolved.some((r) => r.body.id !== body.id))
    throw new FeatureError("The open faces must be on one body");
  const result = b.shellWithEvolution(
    single(body),
    resolved.map((r) => r.face),
    thickness,
  );
  if (!result.ok)
    throw new FeatureError(
      `The shell failed on ${body.name}; try a thinner wall`,
    );
  const shape = context.own(result.value.shape);
  return {
    model: withBody(context.model, {
      ...body,
      shape,
      roles: remapRoles(body.roles, body.shape, shape),
      irregular: "it was shelled",
    }),
  };
}

// ---------------------------------------------------------------- hole

function hole(feature: HoleFeature, context: Context): Result {
  const sketch = sketchOf(context, feature.sketch);
  const frame = frameOf(context, sketch);
  const used = new Set(
    sketch.entities.flatMap((e) =>
      e.type === "line"
        ? [e.start, e.end]
        : e.type === "circle"
          ? [e.center]
          : e.type === "arc"
            ? [e.center, e.start, e.end]
            : [],
    ),
  );
  const points = sketch.entities.filter(
    (e): e is Extract<typeof e, { type: "point" }> =>
      e.type === "point" &&
      (feature.points ? feature.points.includes(e.id) : !used.has(e.id)),
  );
  if (feature.points && points.length < feature.points.length)
    throw new FeatureError(
      `Some hole points no longer exist in ${sketch.name}`,
      true,
    );
  if (!points.length)
    throw new FeatureError(
      `${sketch.name} has no points to drill at; add points that are not part of a line or curve`,
    );
  const diameter = context.value(feature.diameter, "Diameter");
  if (!(diameter > 0)) throw new FeatureError("Diameter must be more than 0");
  const depth =
    feature.depth === undefined
      ? reach(context.model, frame)
      : context.value(feature.depth, "Depth");
  if (!(depth > 0)) throw new FeatureError("Depth must be more than 0");
  const head =
    feature.kind === "simple"
      ? undefined
      : context.value(feature.headDiameter ?? "", "Head diameter");
  if (head !== undefined && !(head > diameter))
    throw new FeatureError("The head must be wider than the hole");
  const headDepth =
    feature.kind === "counterbore"
      ? context.value(feature.headDepth ?? "", "Head depth")
      : feature.kind === "countersink"
        ? head! /
          2 /
          Math.tan(
            (context.value(feature.angle ?? "90", "Angle") * Math.PI) / 360,
          )
        : 0;
  if (feature.kind !== "simple" && !(headDepth > 0 && headDepth < depth))
    throw new FeatureError("The head must be shallower than the hole");

  // Holes go into the material behind the sketch: against its normal.
  const into = frameMatrix4(frame).multiply(
    new Matrix4().makeRotationX(Math.PI),
  );
  const tools: Tool[] = points.map((point) => {
    const at = into
      .clone()
      .multiply(new Matrix4().makeTranslation(point.x, -point.y, 0));
    // Tools reach a little above the surface so the surface is cut cleanly.
    const above = 0.01;
    const drill = transformRecipe(
      { kind: "cylinder", diameter, length: depth + above },
      at
        .clone()
        .multiply(new Matrix4().makeTranslation(0, 0, (depth - above) / 2)),
    );
    // The head: a wider cylinder, or a cone whose base is on the surface
    // and whose tip points into the material (+z here).
    const headRecipe: Recipe | undefined =
      feature.kind === "counterbore"
        ? transformRecipe(
            { kind: "cylinder", diameter: head!, length: headDepth + above },
            at
              .clone()
              .multiply(
                new Matrix4().makeTranslation(0, 0, (headDepth - above) / 2),
              ),
          )
        : feature.kind === "countersink"
          ? transformRecipe(
              { kind: "cone", diameter: head!, length: headDepth },
              at,
            )
          : undefined;
    const recipe: Recipe = headRecipe
      ? { kind: "union", left: drill, right: headRecipe }
      : drill;
    const shape = build(context, recipe);
    // Only what lies below the surface decides which bodies it drills.
    const probe = build(
      context,
      transformRecipe(
        { kind: "cylinder", diameter, length: depth },
        at.clone().multiply(new Matrix4().makeTranslation(0, 0, depth / 2)),
      ),
    );
    return {
      shape,
      probe,
      roles: holeRoles(shape, frame, point.id),
      machining: [
        { kind: "drill", recipe: drill, diameter, depth },
        ...(headRecipe
          ? [
              {
                kind: feature.kind as "counterbore" | "countersink",
                recipe: headRecipe,
                diameter: head!,
                depth: headDepth,
              },
            ]
          : []),
      ],
    };
  });
  const made: Made = { operation: "cut", tools, name: feature.name };
  const model = apply(
    context,
    feature.id,
    made,
    feature.targets,
    context.model,
  );
  return { model: withMade(model, feature.id, made) };
}

/** A hole's faces: `wall:<point>` and `head:<point>` for the round sides,
 * `floor:<point>` and `step:<point>` for flat bottoms. */
function holeRoles(
  shape: b.Shape3D,
  frame: Frame,
  point: string,
): Map<string, number[]> {
  const roles = new Map<string, number[]>();
  const add = (role: string, face: b.Face) =>
    roles.set(role, [...(roles.get(role) ?? []), b.getHashCode(face)]);
  const faces = b.getFaces(shape);
  const height = (face: b.Face) =>
    dot(sub(b.faceCenter(face) as unknown as Vec3, frame.origin), frame.normal);
  const deepest = Math.min(...faces.map(height));
  for (const face of faces) {
    const type = b.faceGeomType(face);
    if (type === "PLANE") {
      const z = height(face);
      if (z > 0) continue;
      add(
        Math.abs(z - deepest) < 1e-6 ? `floor:${point}` : `step:${point}`,
        face,
      );
    } else {
      add(`${type === "CONE" ? "head" : "wall"}:${point}`, face);
    }
  }
  return roles;
}

// ---------------------------------------------------------------- joints

function joint(feature: JointFeature, context: Context): Result {
  const bodies = [feature.a, feature.b].map((id) => {
    const body = bodyOf(context.model, id);
    if (!body) throw new FeatureError(`The body ${id} no longer exists`, true);
    return body;
  });
  const panels = bodies.map((body) => {
    const panel = panelOf(body);
    if (typeof panel === "string") throw new FeatureError(panel);
    return panel;
  });
  const value = (expression: string | undefined, name: string) =>
    expression === undefined ? undefined : context.value(expression, name);
  const numbers = {
    fingerWidth: value(feature.fingerWidth, "Finger width"),
    clearance: value(feature.clearance, "Clearance"),
    count: value(feature.count, "Count"),
    edgeOffset: value(feature.edgeOffset, "Distance from the ends"),
    depth: value(feature.depth, "Depth"),
    diameter: value(feature.diameter, "Diameter"),
    length: value(feature.length, "Length"),
  };
  const parameters = Object.fromEntries(
    Object.entries({ ...numbers, domino: feature.domino }).filter(
      ([, v]) => v !== undefined,
    ),
  );
  let plan;
  try {
    plan = planJoint(feature.kind, contact(panels[0]!, panels[1]!), parameters);
  } catch (error) {
    if (error instanceof JointError) throw new FeatureError(error.message);
    throw error;
  }
  let model = context.model;
  // The part of a panel that reaches into the other comes first: the
  // panel's blank grows to include it.
  for (const growth of plan.grow) {
    const body = bodyOf(model, growth.body)!;
    const panel = panels[bodies.findIndex((b) => b.id === body.id)]!;
    const tool = build(context, {
      kind: "transform",
      matrix: new Matrix4()
        .makeTranslation(growth.box.min.x, growth.box.min.y, growth.box.min.z)
        .toArray(),
      source: {
        kind: "box",
        width: growth.box.max.x - growth.box.min.x,
        depth: growth.box.max.y - growth.box.min.y,
        height: growth.box.max.z - growth.box.min.z,
      },
    });
    const joined = combine(context, body, tool, new Map(), feature.id, "add");
    model = withBody(model, {
      ...joined,
      shape: single(joined) as unknown as b.Shape3D,
      blank: grown(panel, growth.box).blank,
    });
  }
  // Every cut into one body in one boolean.
  for (const id of new Set(plan.cuts.map((cut) => cut.body))) {
    const body = bodyOf(model, id)!;
    const cuts = plan.cuts.filter((cut) => cut.body === id);
    const shapes = cuts.map((cut) => build(context, cut.recipe));
    const tool =
      shapes.length === 1
        ? shapes[0]!
        : (context.own(b.compound(shapes)) as unknown as b.Shape3D);
    const next = combine(context, body, tool, new Map(), feature.id, "cut");
    model = withBody(model, {
      ...next,
      machining: [
        ...body.machining,
        ...cuts.map(({ body: _body, ...cut }) => ({
          ...cut,
          feature: feature.id,
        })),
      ],
    });
  }
  const hardware = new Map(model.hardware);
  hardware.set(feature.id, plan.hardware);
  return { model: { ...model, hardware } };
}

// ---------------------------------------------------------------- pattern, mirror

/** The transforms of a pattern's copies (not the original), or the one
 * reflection of a mirror. */
function copies(
  feature: PatternFeature | MirrorFeature,
  context: Context,
): Matrix4[] {
  if (feature.type === "mirror") {
    const frame = planeFrame(feature.plane);
    const offset =
      feature.offset === undefined
        ? 0
        : context.value(feature.offset, "Offset");
    const n = frame.normal;
    // Reflection through the plane n·p = offset.
    const m = new Matrix4().set(
      1 - 2 * n[0] * n[0],
      -2 * n[0] * n[1],
      -2 * n[0] * n[2],
      2 * offset * n[0],
      -2 * n[1] * n[0],
      1 - 2 * n[1] * n[1],
      -2 * n[1] * n[2],
      2 * offset * n[1],
      -2 * n[2] * n[0],
      -2 * n[2] * n[1],
      1 - 2 * n[2] * n[2],
      2 * offset * n[2],
      0,
      0,
      0,
      1,
    );
    return [m];
  }
  const count = Math.round(context.value(feature.count, "Count"));
  if (!(count >= 2))
    throw new FeatureError("A pattern needs at least 2 copies");
  if (count > 500) throw new FeatureError("A pattern makes at most 500 copies");
  const axis = axisVector(feature.axis);
  const out: Matrix4[] = [];
  if (feature.kind === "linear") {
    const spacing = context.value(feature.spacing ?? "", "Spacing");
    if (spacing === 0) throw new FeatureError("Spacing must not be 0");
    for (let i = 1; i < count; i++) {
      const d = scale(axis, spacing * i);
      out.push(new Matrix4().makeTranslation(d[0], d[1], d[2]));
    }
    return out;
  }
  const total =
    feature.angle === undefined ? 360 : context.value(feature.angle, "Angle");
  if (total === 0 || Math.abs(total) > 360)
    throw new FeatureError("The angle must be between 0 and 360°");
  // A full turn spaces the copies evenly around it; a part turn spreads
  // them from the first to the last.
  const step =
    Math.abs(Math.abs(total) - 360) < 1e-9
      ? total / count
      : total / (count - 1);
  const center = (feature.center ?? ["0", "0", "0"]).map((e, i) =>
    context.value(e, `Centre ${"xyz"[i]}`),
  ) as unknown as Vec3;
  for (let i = 1; i < count; i++) {
    out.push(
      new Matrix4()
        .makeTranslation(center[0], center[1], center[2])
        .multiply(rotationAbout(axis, (step * i * Math.PI) / 180))
        .multiply(
          new Matrix4().makeTranslation(-center[0], -center[1], -center[2]),
        ),
    );
  }
  return out;
}

function rotationAbout(axis: Vec3, angle: number): Matrix4 {
  const [x, y, z] = normalize(axis);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  return new Matrix4().set(
    t * x * x + c,
    t * x * y - s * z,
    t * x * z + s * y,
    0,
    t * x * y + s * z,
    t * y * y + c,
    t * y * z - s * x,
    0,
    t * x * z - s * y,
    t * y * z + s * x,
    t * z * z + c,
    0,
    0,
    0,
    0,
    1,
  );
}

/** A frame moved by a transform. A mirror turns it left-handed; its x
 * axis is then reversed, which the outline follows. */
function moveBlank(blank: Blank, m: Matrix4): Blank {
  const point = (p: Vec3): Vec3 => {
    const e = m.elements;
    return [
      e[0]! * p[0] + e[4]! * p[1] + e[8]! * p[2] + e[12]!,
      e[1]! * p[0] + e[5]! * p[1] + e[9]! * p[2] + e[13]!,
      e[2]! * p[0] + e[6]! * p[1] + e[10]! * p[2] + e[14]!,
    ];
  };
  const direction = (v: Vec3): Vec3 => sub(point(v), point([0, 0, 0]));
  const f = blank.frame;
  let x = direction(f.x);
  const y = direction(f.y);
  const normal = direction(f.normal);
  const flipped = m.determinant() < 0;
  if (flipped) x = scale(x, -1);
  const mirror = (loop: readonly { x: number; y: number }[]) =>
    flipped ? [...loop].reverse().map((p) => ({ x: -p.x, y: p.y })) : loop;
  return {
    frame: { origin: point(f.origin), x, y, normal },
    depth: blank.depth,
    outline: mirror(blank.outline),
    openings: blank.openings.map(mirror),
    curved: blank.curved,
  };
}

function repeat(
  feature: PatternFeature | MirrorFeature,
  context: Context,
): Result {
  const transforms = copies(feature, context);
  if (!feature.features?.length && !feature.bodies?.length)
    throw new FeatureError("Choose the features or bodies to repeat");
  let model = context.model;
  for (const [i, m] of transforms.entries()) {
    const tag = `${feature.id}#${i + 1}`;
    for (const id of feature.features ?? []) {
      const made = context.model.made.get(id);
      if (!made)
        throw new FeatureError(
          `The feature ${nameOf(context, id)} made nothing to repeat`,
          !context.document.features.some((f) => f.id === id),
        );
      const moved: Made = {
        operation: made.operation,
        name: `${made.name} (${feature.name} ${i + 1})`,
        tools: made.tools.map((tool) => {
          const shape = place(context, tool.shape, m);
          const roles = copyRoles(
            new Map([["tool", tool.roles]]),
            tool.shape,
            shape,
          ).get("tool")!;
          return {
            shape,
            roles,
            ...(tool.machining
              ? {
                  machining: tool.machining.map((cut) => ({
                    ...cut,
                    recipe: transformRecipe(cut.recipe, m),
                  })),
                }
              : {}),
            ...(tool.blank ? { blank: moveBlank(tool.blank, m) } : {}),
            ...(tool.body ? { body: tool.body } : {}),
            ...(tool.probe ? { probe: place(context, tool.probe, m) } : {}),
          };
        }),
      };
      model = apply(
        context,
        tag,
        moved,
        undefined,
        model,
        (body) => `${tag}:${body}`,
      );
    }
    for (const id of feature.bodies ?? []) {
      const body = bodyOf(context.model, id);
      if (!body)
        throw new FeatureError(`The body ${id} no longer exists`, true);
      model = withBody(model, {
        ...moved(context, body, m),
        id: `${tag}:${body.id}`,
        name: `${body.name} (${feature.name} ${i + 1})`,
        feature: feature.id,
      });
    }
  }
  return { model };
}

/** A body moved by a transform, with its names, blank and cuts. */
function moved(
  context: Context,
  body: Body,
  m: Matrix4,
  rename?: (origin: string) => string,
): Body {
  const shape = place(context, body.shape, m);
  return {
    ...body,
    shape,
    roles: copyRoles(body.roles, body.shape, shape, rename),
    ...(body.blank ? { blank: moveBlank(body.blank, m) } : {}),
    machining: body.machining.map((cut) => ({
      ...cut,
      recipe: transformRecipe(cut.recipe, m),
    })),
  };
}

// ---------------------------------------------------------------- move, mate

const vector = (v: Vec3) => new Vector3(v[0], v[1], v[2]);

function move(feature: MoveFeature, context: Context): Result {
  if (!feature.bodies.length)
    throw new FeatureError("Choose the bodies to move");
  const triple = (values: readonly string[], name: string) =>
    values.map((v, i) => context.value(v, `${name} ${"xyz"[i]}`)) as [
      number,
      number,
      number,
    ];
  const m = new Matrix4();
  if (feature.translate) {
    const [x, y, z] = triple(feature.translate, "Move");
    m.makeTranslation(x, y, z);
  }
  if (feature.rotate) {
    const [x, y, z] = feature.rotate.center
      ? triple(feature.rotate.center, "Centre")
      : [0, 0, 0];
    const angle = context.value(feature.rotate.angle, "Angle");
    m.multiply(new Matrix4().makeTranslation(x, y, z))
      .multiply(
        rotationAbout(axisVector(feature.rotate.axis), (angle * Math.PI) / 180),
      )
      .multiply(new Matrix4().makeTranslation(-x, -y, -z));
  }
  let model = context.model;
  for (const id of feature.bodies) {
    const body = bodyOf(model, id);
    if (!body) throw new FeatureError(`The body ${id} no longer exists`, true);
    const next = moved(context, body, m);
    model = feature.copy
      ? withBody(model, {
          ...next,
          id: `${feature.id}#1:${body.id}`,
          name: `${body.name} (${feature.name})`,
          feature: feature.id,
        })
      : withBody(model, next);
  }
  return { model };
}

/** The flat face a reference names: its plane and centre. */
function flatFace(model: Model, ref: FaceReference, what: string) {
  const { body, face } = resolveFace(model, ref);
  if (b.faceGeomType(face) !== "PLANE")
    throw new FeatureError(`${what} must be a flat face`);
  return {
    body,
    normal: vector(b.normalAt(face) as unknown as Vec3).normalize(),
    centre: vector(b.faceCenter(face) as unknown as Vec3),
  };
}

function mate(feature: MateFeature, context: Context): Result {
  const moving = flatFace(context.model, feature.moving, "The moving face");
  const target = flatFace(context.model, feature.target, "The target face");
  if (moving.body.id === target.body.id)
    throw new FeatureError("The two faces are on the same body");
  const offset =
    feature.offset === undefined ? 0 : context.value(feature.offset, "Offset");
  // Turn the moving face to lie against the target (or along it), about
  // its own centre.
  const wanted = target.normal.clone().multiplyScalar(feature.flip ? 1 : -1);
  const turn = new Matrix4().makeRotationFromQuaternion(
    new Quaternion().setFromUnitVectors(moving.normal, wanted),
  );
  const about = (m: Matrix4, point: Vector3) =>
    new Matrix4()
      .makeTranslation(point.x, point.y, point.z)
      .multiply(m)
      .multiply(new Matrix4().makeTranslation(-point.x, -point.y, -point.z));
  let m = about(turn, moving.centre);
  const centre = moving.centre.clone().applyMatrix4(m);
  // Onto the target's plane, `offset` out from it.
  const across = target.centre.clone().sub(centre).dot(target.normal) + offset;
  m = new Matrix4()
    .makeTranslation(
      target.normal.x * across,
      target.normal.y * across,
      target.normal.z * across,
    )
    .multiply(m);
  if (feature.kind === "fastened") {
    // And centred on it.
    const now = moving.centre.clone().applyMatrix4(m);
    const inPlane = target.centre.clone().sub(now);
    inPlane.addScaledVector(target.normal, -inPlane.dot(target.normal));
    m = new Matrix4()
      .makeTranslation(inPlane.x, inPlane.y, inPlane.z)
      .multiply(m);
  }
  if (feature.kind === "edge") {
    if (!feature.movingEdge || !feature.targetEdge)
      throw new FeatureError("Pick an edge of each face");
    const ends = (ref: EdgeReference) => {
      const { edge } = resolveEdge(context.model, ref);
      return [0, 1].map((t) =>
        vector(b.curvePointAt(edge, t) as unknown as Vec3),
      ) as [Vector3, Vector3];
    };
    const [t0, t1] = ends(feature.targetEdge);
    let [m0, m1] = ends(feature.movingEdge).map((p) => p.applyMatrix4(m)) as [
      Vector3,
      Vector3,
    ];
    const along = t1.clone().sub(t0).normalize();
    // Turn about the target's normal so the edges run the same way, by
    // the smaller of the two turns.
    let direction = m1.clone().sub(m0).normalize();
    if (direction.dot(along) < 0) {
      [m0, m1] = [m1, m0];
      direction.negate();
    }
    const angle = Math.atan2(
      direction.clone().cross(along).dot(target.normal),
      direction.dot(along),
    );
    const spin = about(
      new Matrix4().makeRotationAxis(target.normal, angle),
      m0,
    );
    m = spin.clone().multiply(m);
    m1.applyMatrix4(spin);
    // Then slide it onto the target edge, lined up at the chosen end.
    const align = feature.align ?? "start";
    const pick = (a: Vector3, c: Vector3) =>
      align === "start"
        ? a
        : align === "end"
          ? c
          : a.clone().add(c).multiplyScalar(0.5);
    const shift = pick(t0, t1).clone().sub(pick(m0, m1));
    shift.addScaledVector(target.normal, -shift.dot(target.normal));
    m = new Matrix4().makeTranslation(shift.x, shift.y, shift.z).multiply(m);
  }
  return { model: withBody(context.model, moved(context, moving.body, m)) };
}

// ---------------------------------------------------------------- library instances

function instance(feature: InstanceFeature, context: Context): Result {
  const pinned = context.document.library?.find(
    (p) => p.item === feature.item && p.version === feature.version,
  );
  if (!pinned)
    throw new FeatureError(
      `This project keeps no copy of version ${feature.version} of the library item`,
      true,
    );
  if (isCodePinned(pinned)) return codeInstance(feature, pinned, context);
  // Exposed variables take the values this project gives them, and the
  // item's sketches are solved again for them.
  const overrides = new Map<string, number>();
  for (const [name, expression] of Object.entries(feature.values ?? {})) {
    if (!pinned.exposed.includes(name))
      throw new FeatureError(`${pinned.name} does not let you set ${name}`);
    overrides.set(name, context.value(expression, name));
  }
  let inner = pinned.document!;
  if (overrides.size) {
    if (!context.solver)
      throw new FeatureError(
        "Setting a library item's variables needs the sketch solver",
      );
    inner = solveDocument(
      {
        ...inner,
        variables: inner.variables.map((v) =>
          overrides.has(v.name)
            ? { ...v, expression: String(overrides.get(v.name)) }
            : v,
        ),
      },
      context.solver,
    ).document;
  }
  const evaluation = context.nested(feature.id).evaluate(inner);
  context.ran(feature.id, evaluation);
  const failed = [...evaluation.status].find(([, s]) => s.state === "error");
  if (failed) {
    const [id, status] = failed;
    throw new FeatureError(
      `In ${pinned.name}, ${inner.features.find((f) => f.id === id)?.name ?? id}: ${status.state === "error" ? status.message : ""}`,
    );
  }
  const innerVariables = evaluateVariables(inner.variables);
  const mated = feature.mate
    ? inner.interfaces?.find((i) => i.id === feature.mate!.interface)
    : undefined;
  if (feature.mate && !mated)
    throw new FeatureError(
      `The item has no interface ${feature.mate.interface}`,
      true,
    );
  const own = mated ? evaluation.frames.get(mated.sketch) : undefined;
  if (mated && !own)
    throw new FeatureError(`The sketch of ${mated.name} could not be placed`);
  const m = own
    ? mateMatrix(feature, own, context)
    : placementMatrix(feature.placement, context);

  let model = context.model;
  for (const body of evaluation.bodies)
    model = withBody(model, {
      ...moved(context, body, m, (origin) => `${feature.id}#${origin}`),
      id: `${feature.id}:${body.id}`,
      name: `${feature.name} · ${body.name}`,
      feature: feature.id,
    });
  const items = [...evaluation.hardware.map(({ feature: _f, ...h }) => h)];

  // The interface's holes, drilled into the part it is mated to.
  if (mated && own && feature.mate!.holes !== false && mated.kind !== "point") {
    const sketch = inner.features.find(
      (f): f is SketchFeature => f.id === mated.sketch && f.type === "sketch",
    )!;
    const inItem = (expression: string | undefined, fallback: string) => {
      try {
        return evaluateWith(expression ?? fallback, innerVariables);
      } catch (error) {
        throw new FeatureError(
          `${mated.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
    const drilled = drillInterface(
      context,
      model,
      feature,
      {
        name: mated.name,
        kind: mated.kind,
        diameter: inItem(mated.diameter, mated.kind === "dowel" ? "8" : "3"),
        depth: inItem(mated.depth, mated.kind === "dowel" ? "15" : "12"),
      },
      own,
      freePoints(sketch),
      m,
    );
    model = drilled.model;
    if (drilled.hardware) items.push(drilled.hardware);
  }
  const hardware = new Map(model.hardware);
  hardware.set(feature.id, items);
  return { model: { ...model, hardware } };
}

/** A code part's instance: the stored result for its code and values,
 * placed like any library item. The code itself never runs here. */
function codeInstance(
  feature: InstanceFeature,
  pinned: CodePinned,
  context: Context,
): Result {
  const given: Record<string, number> = {};
  for (const [name, expression] of Object.entries(feature.values ?? {})) {
    if (!pinned.exposed.includes(name))
      throw new FeatureError(`${pinned.name} has no parameter ${name}`);
    given[name] = context.value(expression, name);
  }
  let values: Record<string, number>;
  try {
    values = parameterValues(pinned.code.parameters, given);
  } catch (error) {
    throw new FeatureError(
      error instanceof Error ? error.message : String(error),
    );
  }
  const key = codeResultKey(pinned.code.source, values, pinned.code.files);
  const result = context.codeResult(key);
  if (!result)
    throw new FeatureError(
      `${pinned.name} needs regeneration in the editor: its code has not been run for these values yet`,
      false,
      true,
    );
  const mated = feature.mate
    ? result.interfaces.find((i) => i.id === feature.mate!.interface)
    : undefined;
  if (feature.mate && !mated)
    throw new FeatureError(
      `${pinned.name} has no interface ${feature.mate.interface}`,
      true,
    );
  const m = mated
    ? mateMatrix(feature, mated.frame, context)
    : placementMatrix(feature.placement, context);
  let model = context.model;
  for (const body of result.bodies)
    model = withBody(
      model,
      moved(
        context,
        {
          id: `${feature.id}:${body.id}`,
          name: `${feature.name} · ${body.name}`,
          feature: feature.id,
          shape: body.shape,
          roles: body.roles,
          ...(body.blank ? { blank: body.blank } : {}),
          machining: body.machining.map((cut) => ({
            ...cut,
            feature: feature.id,
          })),
          ...(body.irregular ? { irregular: body.irregular } : {}),
        },
        m,
        (origin) => `${feature.id}#${origin}`,
      ),
    );
  const items: Hardware[] = [];
  if (mated && feature.mate!.holes !== false && mated.kind !== "point") {
    const drilled = drillInterface(
      context,
      model,
      feature,
      {
        name: mated.name,
        kind: mated.kind,
        diameter: mated.diameter ?? (mated.kind === "dowel" ? 8 : 3),
        depth: mated.depth ?? (mated.kind === "dowel" ? 15 : 12),
      },
      mated.frame,
      mated.points,
      m,
    );
    model = drilled.model;
    if (drilled.hardware) items.push(drilled.hardware);
  }
  const hardware = new Map(model.hardware);
  hardware.set(feature.id, items);
  return { model: { ...model, hardware } };
}

/** Drills an interface's points into the part its instance is mated to,
 * and says what hardware goes in. */
function drillInterface(
  context: Context,
  model: Model,
  feature: InstanceFeature,
  iface: {
    readonly name: string;
    readonly kind: "screw" | "dowel";
    diameter: number;
    depth: number;
  },
  frame: Frame,
  points: readonly { readonly x: number; readonly y: number }[],
  m: Matrix4,
): { model: Model; hardware?: Hardware } {
  const mate = feature.mate!;
  const diameter = mate.diameter
    ? context.value(mate.diameter, "Hole diameter")
    : iface.diameter;
  const depth = mate.depth
    ? context.value(mate.depth, "Hole depth")
    : iface.depth;
  if (!(diameter > 0 && depth > 0))
    throw new FeatureError("Interface holes need a diameter and depth");
  const { body: target, face } = resolveFace(model, mate.target);
  const into = vector(b.normalAt(face) as unknown as Vec3).negate();
  if (!points.length)
    throw new FeatureError(`${iface.name} has no points to drill at`);
  const at = points.map((p) =>
    vector(toWorld(frame, p.x, p.y)).applyMatrix4(m),
  );
  const tools = at.map((point) =>
    build(context, bore(point, into, diameter, depth)),
  );
  const tool =
    tools.length === 1
      ? tools[0]!
      : (context.own(b.compound(tools)) as unknown as b.Shape3D);
  const next = combine(context, target, tool, new Map(), feature.id, "cut");
  return {
    model: withBody(model, {
      ...next,
      machining: [
        ...target.machining,
        ...at.map((point) => ({
          feature: feature.id,
          kind: "drill" as const,
          recipe: bore(point, into, diameter, depth),
          diameter,
          depth,
        })),
      ],
    }),
    hardware: {
      kind: iface.kind,
      size: `Ø${Math.round(diameter * 10) / 10}`,
      count: points.length,
    },
  };
}

/** Points of a sketch that belong to no curve. */
function freePoints(sketch: SketchFeature) {
  const used = new Set(
    sketch.entities.flatMap((e) =>
      e.type === "line"
        ? [e.start, e.end]
        : e.type === "circle"
          ? [e.center]
          : e.type === "arc"
            ? [e.center, e.start, e.end]
            : [],
    ),
  );
  return sketch.entities.filter(
    (e): e is Extract<typeof e, { type: "point" }> =>
      e.type === "point" && !used.has(e.id),
  );
}

function placementMatrix(
  placement: InstanceFeature["placement"],
  context: Context,
): Matrix4 {
  const m = new Matrix4();
  if (placement?.translate) {
    const [x, y, z] = placement.translate.map((e, i) =>
      context.value(e, `Move ${"xyz"[i]}`),
    ) as [number, number, number];
    m.makeTranslation(x, y, z);
  }
  if (placement?.rotate)
    m.multiply(
      rotationAbout(
        axisVector(placement.rotate.axis),
        (context.value(placement.rotate.angle, "Angle") * Math.PI) / 180,
      ),
    );
  return m;
}

/** Where an item goes so its interface lies on the target face, facing
 * it: the interface's origin at `at` on the face, turned by `angle`. */
function mateMatrix(
  feature: InstanceFeature,
  own: Frame,
  context: Context,
): Matrix4 {
  const mate = feature.mate!;
  const { face } = resolveFace(context.model, mate.target);
  const target = planarFrame(face, "The face to mate to");
  const [x, y] = (mate.at ?? ["0", "0"]).map((e, i) =>
    context.value(e, `Position ${"xy"[i]}`),
  ) as [number, number];
  const offset = mate.offset ? context.value(mate.offset, "Gap") : 0;
  const angle = mate.angle ? context.value(mate.angle, "Angle") : 0;
  return (
    frameMatrix4({ ...target, origin: toWorld(target, x, y, offset) })
      .multiply(new Matrix4().makeRotationZ((angle * Math.PI) / 180))
      // Face to face: the interface's normal against the target's.
      .multiply(new Matrix4().makeRotationX(Math.PI))
      .multiply(frameMatrix4(own).invert())
  );
}

function nameOf(context: Context, id: string): string {
  return context.document.features.find((f) => f.id === id)?.name ?? id;
}

// ---------------------------------------------------------------- picking

/** A reference to a face of an evaluated body, by the name the evaluator
 * gave it; undefined when the face has no name (a fillet's round). */
export function referenceFace(
  body: Body,
  face: b.Face,
): FaceReference | undefined {
  const hash = b.getHashCode(face);
  for (const [origin, roles] of body.roles)
    for (const [role, hashes] of roles)
      if (hashes.includes(hash)) {
        const normal = b.normalAt(face) as unknown as Vec3;
        const centroid = b.faceCenter(face) as unknown as Vec3;
        return {
          body: body.id,
          origin,
          role,
          hint: {
            surfaceType: b.faceGeomType(face),
            normal: [...normal],
            centroid: [...centroid],
            area: b.measureArea(face) as unknown as number,
          },
        };
      }
  return undefined;
}

/** A reference to an edge of an evaluated body, by its two named faces. */
export function referenceEdge(
  body: Body,
  edge: b.Edge,
): EdgeReference | undefined {
  const faces = b.facesOfEdge(body.shape, edge);
  if (faces.length !== 2) return undefined;
  const a = referenceFace(body, faces[0]!);
  const c = referenceFace(body, faces[1]!);
  if (!a || !c) return undefined;
  return { a, b: c, near: [...(b.curvePointAt(edge, 0.5) as unknown as Vec3)] };
}
