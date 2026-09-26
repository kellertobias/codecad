// Code parts: parts written in TypeScript against a small part API. Their
// code only ever runs in an editor's browser, in a sandbox, and describes
// solids as recipes (plain data). The editor's kernel turns the recipes into
// exact geometry and uploads that as a "result", keyed by the code and the
// parameter values it was made for. The server, drawings, exports and the
// phone viewer only read results; nothing on the server runs the code.
//
// Everything here is plain data and checks of it, so the browser, the
// kernel and the server all use the same rules.
import type { Recipe } from "../model.js";
import type { Frame, Vec3 } from "./frames.js";
import type { CadDocument, InstanceFeature, PinnedItem } from "./schema.js";
import { evaluateVariables, evaluateWith } from "./variables.js";

/** Changes when the part API changes what the same code makes. */
export const codeApiVersion = 1;

export interface CodeParameter {
  readonly name: string;
  readonly label?: string;
  readonly default: number;
  readonly min?: number;
  readonly max?: number;
  readonly unit?: "mm" | "deg" | "";
}

export interface CodeInterfaceInfo {
  readonly id: string;
  readonly name: string;
  readonly kind: "screw" | "dowel" | "point";
}

/** A code part as a library version keeps it. */
export interface CodePart {
  readonly source: string;
  readonly parameters: readonly CodeParameter[];
  /** The interfaces the code made with its defaults, for choosing one to
   * mate by before anything is generated. */
  readonly interfaces: readonly CodeInterfaceInfo[];
  /** STEP files the code imports (`new Shapes.ImportedStep({ path })`),
   * base64 by file name. */
  readonly files?: Readonly<Record<string, string>>;
}

/** A file name a code part's recipes may import. */
export const isCodeFileName = (name: string) =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.(step|stp)$/i.test(name);

/** The file names a recipe imports. */
export function recipeFileNames(recipe: Recipe, into = new Set<string>()) {
  if (recipe.kind === "step") into.add(recipe.path);
  else if ("source" in recipe) recipeFileNames(recipe.source, into);
  else if ("left" in recipe) {
    recipeFileNames(recipe.left, into);
    recipeFileNames(recipe.right, into);
  }
  return into;
}

/** Where a code part's recipes connect: points in a plane of the part. The plane's
 * normal points away from the part, as a face's does. */
export interface CodeInterface extends CodeInterfaceInfo {
  readonly frame: Frame;
  readonly points: readonly { readonly x: number; readonly y: number }[];
  readonly diameter?: number;
  readonly depth?: number;
}

/** What the code returns, from the sandbox. Untrusted. */
export interface CodeOutput {
  readonly parameters: readonly CodeParameter[];
  readonly bodies: readonly {
    readonly name: string;
    readonly recipe: Recipe;
  }[];
  readonly interfaces: readonly CodeInterface[];
}

/** A flat blank, as the evaluator's `Blank`. */
export interface CodeBlank {
  readonly frame: Frame;
  readonly depth: number;
  readonly outline: readonly { readonly x: number; readonly y: number }[];
  readonly openings: readonly (readonly { x: number; y: number }[])[];
  readonly curved: boolean;
}

export interface CodeResultBody {
  readonly id: string;
  readonly name: string;
  /** The exact solid, in OpenCascade's BREP text format. */
  readonly brep: string;
  readonly blank?: CodeBlank;
  readonly machining?: readonly {
    readonly kind: "drill";
    readonly recipe: Recipe;
    readonly diameter: number;
    readonly depth: number;
  }[];
  readonly irregular?: string;
}

/** What the editor uploads after running a code part. Untrusted too. */
export interface CodeResult {
  readonly format: typeof codeResultFormat;
  readonly formatVersion: 1;
  readonly key: string;
  readonly bodies: readonly CodeResultBody[];
  readonly interfaces: readonly CodeInterface[];
}

export const codeResultFormat = "codecad-code-result";

export const codeLimits = {
  source: 256 * 1024,
  /** A code part's STEP files, decoded, all together. */
  files: 4 * 1024 * 1024,
  parameters: 40,
  bodies: 50,
  interfaces: 20,
  points: 500,
  recipeNodes: 5000,
  recipeDepth: 200,
  profilePoints: 20_000,
  /** The size of everything, in model millimetres from the origin. */
  extent: 20_000,
  brep: 12 * 1024 * 1024,
  /** A whole uploaded result, as JSON. */
  result: 16 * 1024 * 1024,
} as const;

export class CodePartError extends Error {}

const fail = (path: string, message: string): never => {
  throw new CodePartError(`${path} ${message}`);
};
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, path: string, max = 200): string => {
  if (typeof v !== "string" || !v.length || v.length > max)
    fail(path, `must be text of 1 to ${max} characters`);
  return v as string;
};
const number = (v: unknown, path: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v))
    fail(path, "must be a finite number");
  if (Math.abs(v as number) > codeLimits.extent * 10)
    fail(path, "is out of range");
  return v as number;
};
const positive = (v: unknown, path: string): number => {
  const n = number(v, path);
  if (n <= 0) fail(path, "must be more than 0");
  return n;
};
const list = (v: unknown, path: string, max: number): unknown[] => {
  if (!Array.isArray(v)) fail(path, "must be a list");
  if ((v as unknown[]).length > max) fail(path, `has more than ${max} entries`);
  return v as unknown[];
};
const id = (v: unknown, path: string): string => {
  const s = text(v, path, 64);
  if (!/^[A-Za-z0-9_-]+$/.test(s))
    fail(path, "may only hold letters, digits, - and _");
  return s;
};
const kinds = ["screw", "dowel", "point"] as const;

export function checkParameters(value: unknown, path = "parameters") {
  const names = new Set<string>();
  return list(value, path, codeLimits.parameters).map((p, i): CodeParameter => {
    const at = `${path}[${i}]`;
    if (!isObject(p)) return fail(at, "must be an object");
    const name = text(p.name, `${at}.name`, 64);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      fail(`${at}.name`, "must be a name like width or leg_height");
    if (names.has(name)) fail(`${at}.name`, "is used twice");
    names.add(name);
    const parameter: CodeParameter = {
      name,
      default: number(p.default, `${at}.default`),
      ...(p.label === undefined ? {} : { label: text(p.label, `${at}.label`) }),
      ...(p.min === undefined ? {} : { min: number(p.min, `${at}.min`) }),
      ...(p.max === undefined ? {} : { max: number(p.max, `${at}.max`) }),
      ...(p.unit === undefined
        ? {}
        : {
            unit: ["mm", "deg", ""].includes(p.unit as string)
              ? (p.unit as "mm")
              : fail(`${at}.unit`, "must be mm, deg or empty"),
          }),
    };
    if (
      (parameter.min !== undefined && parameter.default < parameter.min) ||
      (parameter.max !== undefined && parameter.default > parameter.max)
    )
      fail(`${at}.default`, "is outside min and max");
    return parameter;
  });
}

export function checkCodePart(value: unknown, path = "code"): CodePart {
  if (!isObject(value)) return fail(path, "must be an object");
  const source = value.source;
  if (typeof source !== "string" || source.length > codeLimits.source)
    fail(
      `${path}.source`,
      `must be code of at most ${codeLimits.source} bytes`,
    );
  let files: Record<string, string> | undefined;
  if (value.files !== undefined) {
    if (!isObject(value.files))
      fail(`${path}.files`, "must map names to files");
    let total = 0;
    files = {};
    for (const [name, data] of Object.entries(value.files as object)) {
      if (!isCodeFileName(name))
        fail(
          `${path}.files`,
          `${JSON.stringify(name)} is not a .step file name`,
        );
      if (typeof data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
        fail(`${path}.files.${name}`, "must be base64");
      total += Math.floor(((data as string).length * 3) / 4);
      if (total > codeLimits.files)
        fail(
          `${path}.files`,
          `may hold at most ${codeLimits.files / 1024 / 1024} MB`,
        );
      files[name] = data as string;
    }
  }
  return {
    ...(files ? { files } : {}),
    source: source as string,
    parameters: checkParameters(value.parameters, `${path}.parameters`),
    interfaces: list(
      value.interfaces ?? [],
      `${path}.interfaces`,
      codeLimits.interfaces,
    ).map((v, i) => {
      const at = `${path}.interfaces[${i}]`;
      if (!isObject(v)) return fail(at, "must be an object");
      return {
        id: id(v.id, `${at}.id`),
        name: text(v.name, `${at}.name`),
        kind: kinds.includes(v.kind as never)
          ? (v.kind as CodeInterfaceInfo["kind"])
          : fail(`${at}.kind`, "must be screw, dowel or point"),
      };
    }),
  };
}

const vec = (v: unknown, path: string): Vec3 => {
  const values = list(v, path, 3);
  if (values.length !== 3) fail(path, "must be three numbers");
  return values.map((n, i) => number(n, `${path}[${i}]`)) as unknown as Vec3;
};
const point2 = (v: unknown, path: string) => {
  if (!isObject(v)) return fail(path, "must be a point");
  return { x: number(v.x, `${path}.x`), y: number(v.y, `${path}.y`) };
};

function checkFrame(v: unknown, path: string): Frame {
  if (!isObject(v)) return fail(path, "must be a frame");
  const frame = {
    origin: vec(v.origin, `${path}.origin`),
    x: vec(v.x, `${path}.x`),
    y: vec(v.y, `${path}.y`),
    normal: vec(v.normal, `${path}.normal`),
  };
  for (const axis of ["x", "y", "normal"] as const) {
    const [a, b, c] = frame[axis];
    if (Math.abs(Math.hypot(a, b, c) - 1) > 1e-6)
      fail(`${path}.${axis}`, "must have length 1");
  }
  return frame;
}

/** Checks a recipe tree: only solids built from boxes, cylinders, cones
 * and extruded profiles, moved and combined; never files. */
export function checkRecipe(
  value: unknown,
  path = "recipe",
  options: { readonly files?: boolean } = {},
): Recipe {
  let nodes = 0;
  const visit = (v: unknown, at: string, depth: number): Recipe => {
    if (++nodes > codeLimits.recipeNodes)
      fail(path, `has more than ${codeLimits.recipeNodes} steps`);
    if (depth > codeLimits.recipeDepth) fail(path, "is nested too deeply");
    if (!isObject(v)) return fail(at, "must be a recipe");
    switch (v.kind) {
      case "box":
        return {
          kind: "box",
          width: positive(v.width, `${at}.width`),
          depth: positive(v.depth, `${at}.depth`),
          height: positive(v.height, `${at}.height`),
        };
      case "cylinder":
      case "cone":
        return {
          kind: v.kind,
          diameter: positive(v.diameter, `${at}.diameter`),
          length: positive(v.length, `${at}.length`),
        };
      case "extrude": {
        const points = list(v.points, `${at}.points`, codeLimits.profilePoints);
        if (points.length < 3) fail(`${at}.points`, "needs three points");
        return {
          kind: "extrude",
          points: points.map((p, i) => point2(p, `${at}.points[${i}]`)),
          height: positive(v.height, `${at}.height`),
          ...(v.arcTolerance === undefined
            ? {}
            : { arcTolerance: positive(v.arcTolerance, `${at}.arcTolerance`) }),
        };
      }
      case "transform": {
        const matrix = list(v.matrix, `${at}.matrix`, 16);
        if (matrix.length !== 16) fail(`${at}.matrix`, "must have 16 numbers");
        return {
          kind: "transform",
          source: visit(v.source, `${at}.source`, depth + 1),
          matrix: matrix.map((n, i) => number(n, `${at}.matrix[${i}]`)),
        };
      }
      case "cut":
      case "union":
      case "intersect":
        return {
          kind: v.kind,
          left: visit(v.left, `${at}.left`, depth + 1),
          right: visit(v.right, `${at}.right`, depth + 1),
        };
      case "offset":
        return {
          kind: "offset",
          source: visit(v.source, `${at}.source`, depth + 1),
          distance: number(v.distance, `${at}.distance`),
        };
      case "fillet":
      case "chamfer": {
        const edges = v.edges;
        if (!isObject(edges))
          return fail(`${at}.edges`, "must say which edges");
        const directions = list(edges.directions, `${at}.edges.directions`, 3);
        if (!directions.length)
          fail(`${at}.edges.directions`, "must name at least one face");
        const labels = list(edges.labels, `${at}.edges.labels`, 3);
        const tolerance = positive(edges.tolerance, `${at}.edges.tolerance`);
        if (tolerance >= 90) fail(`${at}.edges.tolerance`, "must be under 90°");
        const checked = {
          directions: directions.map((d, i) => {
            const q = `${at}.edges.directions[${i}]`;
            if (!isObject(d)) return fail(q, "must be a direction");
            const x = number(d.x, `${q}.x`);
            const y = number(d.y, `${q}.y`);
            const z = number(d.z, `${q}.z`);
            if (Math.abs(Math.hypot(x, y, z) - 1) > 1e-6)
              fail(q, "must have length 1");
            return { x, y, z };
          }),
          labels: labels.map((l, i) => text(l, `${at}.edges.labels[${i}]`, 40)),
          tolerance,
        };
        const source = visit(v.source, `${at}.source`, depth + 1);
        return v.kind === "fillet"
          ? {
              kind: "fillet",
              source,
              edges: checked,
              radius: positive(v.radius, `${at}.radius`),
              ...(v.endRadius === undefined
                ? {}
                : { endRadius: positive(v.endRadius, `${at}.endRadius`) }),
            }
          : {
              kind: "chamfer",
              source,
              edges: checked,
              distance: positive(v.distance, `${at}.distance`),
              ...(v.secondDistance === undefined
                ? {}
                : {
                    secondDistance: positive(
                      v.secondDistance,
                      `${at}.secondDistance`,
                    ),
                  }),
            };
      }
      case "step":
        // Only the part's own files, by name: never a path; and only where
        // the editor's kernel builds them, never in stored results.
        if (options.files === false)
          return fail(`${at}.kind`, "may not import files here");
        if (typeof v.path !== "string" || !isCodeFileName(v.path))
          return fail(`${at}.path`, "must name one of the part's .step files");
        return { kind: "step", path: v.path };
      default:
        return fail(
          `${at}.kind`,
          `${JSON.stringify(v.kind)} is not a shape a code part can make`,
        );
    }
  };
  return visit(value, path, 0);
}

function checkInterface(v: unknown, at: string): CodeInterface {
  if (!isObject(v)) return fail(at, "must be an object");
  return {
    id: id(v.id, `${at}.id`),
    name: text(v.name, `${at}.name`),
    kind: kinds.includes(v.kind as never)
      ? (v.kind as CodeInterface["kind"])
      : fail(`${at}.kind`, "must be screw, dowel or point"),
    frame: checkFrame(v.frame, `${at}.frame`),
    points: list(v.points, `${at}.points`, codeLimits.points).map((p, i) =>
      point2(p, `${at}.points[${i}]`),
    ),
    ...(v.diameter === undefined
      ? {}
      : { diameter: positive(v.diameter, `${at}.diameter`) }),
    ...(v.depth === undefined
      ? {}
      : { depth: positive(v.depth, `${at}.depth`) }),
  };
}

const interfacesOf = (value: unknown, path: string) => {
  const ids = new Set<string>();
  return list(value, path, codeLimits.interfaces).map((v, i) => {
    const iface = checkInterface(v, `${path}[${i}]`);
    if (ids.has(iface.id)) fail(`${path}[${i}].id`, "is used twice");
    ids.add(iface.id);
    return iface;
  });
};

/** Checks what came back from the sandbox. */
export function checkCodeOutput(value: unknown): CodeOutput {
  if (!isObject(value)) return fail("The part", "returned nothing usable");
  const bodies = list(value.bodies, "bodies", codeLimits.bodies);
  if (!bodies.length) fail("The part", "made no bodies");
  return {
    parameters: checkParameters(value.parameters ?? []),
    bodies: bodies.map((body, i) => {
      const at = `bodies[${i}]`;
      if (!isObject(body)) return fail(at, "must be an object");
      return {
        name: text(body.name, `${at}.name`),
        recipe: checkRecipe(body.recipe, `${at}.recipe`),
      };
    }),
    interfaces: interfacesOf(value.interfaces ?? [], "interfaces"),
  };
}

export const isResultKey = (key: string) => /^[0-9a-f]{28}$/.test(key);

/** Checks an uploaded result's structure. Its BREP text is only parsed
 * where a broken one cannot hurt (see src/code-results.ts). */
export function readCodeResult(value: unknown): CodeResult {
  if (!isObject(value) || value.format !== codeResultFormat)
    return fail("The upload", "is not a CodeCAD code-part result");
  if (value.formatVersion !== 1) fail("formatVersion", "is not supported");
  const key = typeof value.key === "string" ? value.key : "";
  if (!isResultKey(key)) fail("key", "is not a result key");
  const ids = new Set<string>();
  const bodies = list(value.bodies, "bodies", codeLimits.bodies);
  if (!bodies.length) fail("bodies", "must not be empty");
  return {
    format: codeResultFormat,
    formatVersion: 1,
    key,
    bodies: bodies.map((body, i): CodeResultBody => {
      const at = `bodies[${i}]`;
      if (!isObject(body)) return fail(at, "must be an object");
      const bodyId = id(body.id, `${at}.id`);
      if (ids.has(bodyId)) fail(`${at}.id`, "is used twice");
      ids.add(bodyId);
      if (
        typeof body.brep !== "string" ||
        !body.brep.trimStart().startsWith("CASCADE Topology")
      )
        fail(`${at}.brep`, "is not BREP text");
      if ((body.brep as string).length > codeLimits.brep)
        fail(`${at}.brep`, "is too large");
      return {
        id: bodyId,
        name: text(body.name, `${at}.name`),
        brep: body.brep as string,
        ...(body.blank === undefined
          ? {}
          : { blank: checkBlank(body.blank, `${at}.blank`) }),
        ...(body.machining === undefined
          ? {}
          : {
              machining: list(body.machining, `${at}.machining`, 1000).map(
                (m, j) => {
                  const q = `${at}.machining[${j}]`;
                  if (!isObject(m) || m.kind !== "drill")
                    return fail(q, "must be a drilling");
                  return {
                    kind: "drill" as const,
                    recipe: checkRecipe(m.recipe, `${q}.recipe`, {
                      files: false,
                    }),
                    diameter: positive(m.diameter, `${q}.diameter`),
                    depth: positive(m.depth, `${q}.depth`),
                  };
                },
              ),
            }),
        ...(body.irregular === undefined
          ? {}
          : { irregular: text(body.irregular, `${at}.irregular`, 500) }),
      };
    }),
    interfaces: interfacesOf(value.interfaces ?? [], "interfaces"),
  };
}

function checkBlank(v: unknown, at: string): CodeBlank {
  if (!isObject(v)) return fail(at, "must be an object");
  const outline = list(v.outline, `${at}.outline`, codeLimits.profilePoints);
  if (outline.length < 3) fail(`${at}.outline`, "needs three points");
  return {
    frame: checkFrame(v.frame, `${at}.frame`),
    depth: positive(v.depth, `${at}.depth`),
    outline: outline.map((p, i) => point2(p, `${at}.outline[${i}]`)),
    openings: list(v.openings ?? [], `${at}.openings`, 1000).map((o, i) =>
      list(o, `${at}.openings[${i}]`, codeLimits.profilePoints).map((p, j) =>
        point2(p, `${at}.openings[${i}][${j}]`),
      ),
    ),
    curved: v.curved === true,
  };
}

// ---------------------------------------------------------------- keys

/** cyrb53: a quick 53-bit string hash. */
function cyrb53(text: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** 106 bits of hash as 28 hex digits: enough to tell code and values
 * apart, and the same in every JavaScript engine. */
export const contentKey = (text: string) =>
  [1, 2]
    .map((seed) => cyrb53(text, seed).toString(16).padStart(14, "0"))
    .join("");

/** The key a result is stored under: the code, its files, the values it
 * ran with, and the version of the part API. */
export const codeResultKey = (
  source: string,
  values: Readonly<Record<string, number>>,
  files: Readonly<Record<string, string>> = {},
) =>
  contentKey(
    JSON.stringify([
      codeApiVersion,
      source,
      Object.entries(values).sort(([a], [b]) => (a < b ? -1 : 1)),
      ...(Object.keys(files).length
        ? [
            Object.entries(files)
              .map(([name, data]) => [name, contentKey(data)])
              .sort(([a], [b]) => (a! < b! ? -1 : 1)),
          ]
        : []),
    ]),
  );

/** Every parameter's value: the ones given, the defaults otherwise. */
export function parameterValues(
  parameters: readonly CodeParameter[],
  given: Readonly<Record<string, number>>,
): Record<string, number> {
  for (const name of Object.keys(given))
    if (!parameters.some((p) => p.name === name))
      throw new CodePartError(`The part has no parameter ${name}`);
  return Object.fromEntries(
    parameters.map((p) => {
      const value = given[p.name] ?? p.default;
      if (!Number.isFinite(value))
        throw new CodePartError(`${p.name} must be a number`);
      if (p.min !== undefined && value < p.min)
        throw new CodePartError(`${p.name} must be at least ${p.min}`);
      if (p.max !== undefined && value > p.max)
        throw new CodePartError(`${p.name} must be at most ${p.max}`);
      return [p.name, value];
    }),
  );
}

export type CodePinned = PinnedItem & { readonly code: CodePart };
export const isCodePinned = (pinned: PinnedItem): pinned is CodePinned =>
  "code" in pinned && pinned.code !== undefined;

export interface CodeInstance {
  readonly feature: InstanceFeature;
  readonly pinned: CodePinned;
  readonly values?: Record<string, number>;
  readonly key?: string;
  /** Why no key could be worked out: a value that does not evaluate. */
  readonly problem?: string;
}

/** The code-part instances of a document, with the values and result key
 * each needs; also those inside library items it places, however deep. */
export function codeInstances(
  document: CadDocument,
  depth = 0,
): CodeInstance[] {
  let variables: ReturnType<typeof evaluateVariables> | undefined;
  const found: CodeInstance[] = [];
  for (const feature of document.features) {
    if (feature.type !== "instance" || feature.suppressed) continue;
    const pinned = document.library?.find(
      (p) => p.item === feature.item && p.version === feature.version,
    );
    if (!pinned) continue;
    variables ??= evaluateVariables(document.variables);
    let given: Record<string, number>;
    try {
      given = Object.fromEntries(
        Object.entries(feature.values ?? {}).map(([name, expression]) => [
          name,
          evaluateWith(expression, variables!),
        ]),
      );
    } catch (error) {
      if (isCodePinned(pinned))
        found.push({
          feature,
          pinned,
          problem: error instanceof Error ? error.message : String(error),
        });
      continue;
    }
    if (!isCodePinned(pinned)) {
      // A document item: its own code parts, with the values it is given.
      if (pinned.document && depth < maxNesting)
        found.push(
          ...codeInstances(
            {
              ...pinned.document,
              variables: pinned.document.variables.map((v) =>
                v.name in given
                  ? { ...v, expression: String(given[v.name]) }
                  : v,
              ),
            },
            depth + 1,
          ),
        );
      continue;
    }
    try {
      const values = parameterValues(pinned.code.parameters, given);
      found.push({
        feature,
        pinned,
        values,
        key: codeResultKey(pinned.code.source, values, pinned.code.files),
      });
    } catch (error) {
      found.push({
        feature,
        pinned,
        problem: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return found;
}

/** How deep library items may hold library items. */
export const maxNesting = 5;
