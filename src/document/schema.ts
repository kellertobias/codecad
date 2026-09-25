// The document a browser-edited project is made of. It is plain JSON: the
// server stores it, the editor edits it, and the evaluator turns it into
// geometry. Nothing in it is executable; every number that can depend on
// something else is an expression string (see expressions.ts).
//
// Documents carry `schemaVersion`. When the format changes, bump
// `currentSchemaVersion` and add a step to `migrations`, so every stored
// document can still be opened.

export const currentSchemaVersion = 1;

/** A variable's value is an expression; `unit` says how to show it. */
export interface Variable {
  readonly id: string;
  /** Referenced by expressions; a JavaScript-style identifier. */
  readonly name: string;
  readonly expression: string;
  readonly unit: "mm" | "deg" | "none";
  /** "boolean" variables are 0 or 1; "select" ones pick one of `options`. */
  readonly kind?: "number" | "boolean" | "select";
  readonly options?: readonly {
    readonly label: string;
    readonly value: number;
  }[];
  readonly group?: string;
  readonly description?: string;
}

export type Plane = "XY" | "XZ" | "YZ";

/** Points hold the position from the last solve, which is where the next
 * solve starts from; everything else refers to points by id. */
export type SketchEntity =
  | {
      readonly id: string;
      readonly type: "point";
      readonly x: number;
      readonly y: number;
      readonly construction?: boolean;
    }
  | {
      readonly id: string;
      readonly type: "line";
      readonly start: string;
      readonly end: string;
      readonly construction?: boolean;
    }
  | {
      readonly id: string;
      readonly type: "circle";
      readonly center: string;
      readonly radius: number;
      readonly construction?: boolean;
    }
  | {
      /** Counter-clockwise from `start` to `end` around `center`. */
      readonly id: string;
      readonly type: "arc";
      readonly center: string;
      readonly start: string;
      readonly end: string;
      readonly construction?: boolean;
    };

/** Constraints. `value` fields are expressions in base units (mm, deg). */
export type SketchConstraint =
  | {
      readonly id: string;
      readonly type: "coincident";
      readonly a: string;
      readonly b: string;
    }
  | { readonly id: string; readonly type: "horizontal"; readonly line: string }
  | { readonly id: string; readonly type: "vertical"; readonly line: string }
  | {
      readonly id: string;
      readonly type: "parallel";
      readonly a: string;
      readonly b: string;
    }
  | {
      readonly id: string;
      readonly type: "perpendicular";
      readonly a: string;
      readonly b: string;
    }
  /** Equal length for two lines, equal radius for circles and arcs. */
  | {
      readonly id: string;
      readonly type: "equal";
      readonly a: string;
      readonly b: string;
    }
  /** A line or curve touching a circle or arc, or two curves touching. */
  | {
      readonly id: string;
      readonly type: "tangent";
      readonly a: string;
      readonly b: string;
    }
  /** Point on a line, circle or arc. */
  | {
      readonly id: string;
      readonly type: "onEntity";
      readonly point: string;
      readonly entity: string;
    }
  | {
      readonly id: string;
      readonly type: "midpoint";
      readonly point: string;
      readonly line: string;
    }
  | {
      readonly id: string;
      readonly type: "symmetric";
      readonly a: string;
      readonly b: string;
      readonly line: string;
    }
  | {
      readonly id: string;
      readonly type: "fix";
      readonly point: string;
      readonly x: string;
      readonly y: string;
    }
  /** Between two points, or a point and a line (perpendicular distance). */
  | {
      readonly id: string;
      readonly type: "distance";
      readonly a: string;
      readonly b: string;
      readonly value: string;
      /** Measured along one axis only. */
      readonly direction?: "horizontal" | "vertical";
    }
  | {
      readonly id: string;
      readonly type: "angle";
      readonly a: string;
      readonly b: string;
      readonly value: string;
    }
  | {
      readonly id: string;
      readonly type: "radius";
      readonly entity: string;
      readonly value: string;
    }
  | {
      readonly id: string;
      readonly type: "diameter";
      readonly entity: string;
      readonly value: string;
    };

export interface SketchFeature {
  readonly id: string;
  readonly type: "sketch";
  readonly name: string;
  /** The standard plane, or, with `face`, the plane the face lies in. */
  readonly plane: Plane;
  /** Sketch on a planar face of a body built by an earlier feature. */
  readonly face?: FaceReference;
  readonly entities: readonly SketchEntity[];
  readonly constraints: readonly SketchConstraint[];
  readonly suppressed?: boolean;
}

/** A face of a body, named the way the evaluator names faces: by the
 * feature that made it (`origin`) and what it is to that feature (`role`,
 * e.g. `end` or `side:<sketch entity id>`). `hint` is a snapshot of the
 * face when it was picked; it only explains a broken reference, it never
 * silently resolves one. */
export interface FaceReference {
  readonly body: string;
  readonly origin: string;
  readonly role: string;
  readonly hint?: {
    readonly normal?: readonly number[];
    readonly centroid?: readonly number[];
    readonly area?: number;
    readonly surfaceType?: string;
  };
}

/** An edge, as the edge the two named faces share. */
export interface EdgeReference {
  readonly a: FaceReference;
  readonly b: FaceReference;
  /** Where it was picked, to choose between several shared edges. */
  readonly near?: readonly number[];
}

interface FeatureBase {
  readonly id: string;
  readonly name: string;
  readonly suppressed?: boolean;
}

/** Sweeps regions of a sketch along the sketch's normal. */
export interface ExtrudeFeature extends FeatureBase {
  readonly type: "extrude";
  readonly sketch: string;
  /** Region ids from profile detection; all regions when left out. */
  readonly regions?: readonly string[];
  /** `new` makes one body per region; the others change existing bodies. */
  readonly operation: "new" | "add" | "cut" | "intersect";
  readonly extent: "blind" | "symmetric" | "throughAll" | "upTo";
  /** Blind and symmetric: an expression in mm (the full width when
   * symmetric). */
  readonly distance?: string;
  /** Up to: the face the extrude ends at. */
  readonly upTo?: FaceReference;
  /** Against the sketch normal. */
  readonly reverse?: boolean;
  /** Bodies an add, cut or intersect changes; every body it meets when
   * left out. */
  readonly targets?: readonly string[];
}

export interface FilletFeature extends FeatureBase {
  readonly type: "fillet";
  readonly edges: readonly EdgeReference[];
  readonly radius: string;
}

export interface ChamferFeature extends FeatureBase {
  readonly type: "chamfer";
  readonly edges: readonly EdgeReference[];
  readonly distance: string;
}

/** Hollows a body, opening the chosen faces. */
export interface ShellFeature extends FeatureBase {
  readonly type: "shell";
  readonly faces: readonly FaceReference[];
  readonly thickness: string;
}

/** Drills at the points of a sketch, into the material behind it. */
export interface HoleFeature extends FeatureBase {
  readonly type: "hole";
  readonly sketch: string;
  /** Point ids; every point that is not part of a curve when left out. */
  readonly points?: readonly string[];
  readonly kind: "simple" | "countersink" | "counterbore";
  readonly diameter: string;
  /** An expression, or through every body it meets when left out. */
  readonly depth?: string;
  /** Countersink and counterbore: the diameter at the surface. */
  readonly headDiameter?: string;
  /** Counterbore depth. */
  readonly headDepth?: string;
  /** Countersink included angle, 90° when left out. */
  readonly angle?: string;
  readonly targets?: readonly string[];
}

export type Axis = "X" | "Y" | "Z";

/** Repeats features (the cuts and bodies they make) and bodies. */
export interface PatternFeature extends FeatureBase {
  readonly type: "pattern";
  readonly kind: "linear" | "circular";
  readonly features?: readonly string[];
  readonly bodies?: readonly string[];
  readonly axis: Axis;
  /** Circular: the axis runs through this point, [x, y, z] expressions. */
  readonly center?: readonly [string, string, string];
  /** Copies including the original. */
  readonly count: string;
  /** Linear: distance between copies. */
  readonly spacing?: string;
  /** Circular: the angle the copies spread over, 360° when left out. */
  readonly angle?: string;
}

export interface MirrorFeature extends FeatureBase {
  readonly type: "mirror";
  readonly features?: readonly string[];
  readonly bodies?: readonly string[];
  /** Mirror plane: a standard plane moved `offset` along its normal. */
  readonly plane: Plane;
  readonly offset?: string;
}

export type Feature =
  | SketchFeature
  | ExtrudeFeature
  | FilletFeature
  | ChamferFeature
  | ShellFeature
  | HoleFeature
  | PatternFeature
  | MirrorFeature;

export type FeatureType = Feature["type"];

/** Keys of a feature that hold expressions (besides sketch constraints and
 * a pattern's centre). */
const expressionKeys = [
  "distance",
  "radius",
  "thickness",
  "diameter",
  "depth",
  "headDiameter",
  "headDepth",
  "angle",
  "count",
  "spacing",
  "offset",
] as const;

/** The feature with every expression passed through `map`: dimensions of a
 * sketch, and the numeric fields of every other feature. */
export function mapExpressions<F extends Feature>(
  feature: F,
  map: (expression: string) => string,
): F {
  if (feature.type === "sketch")
    return {
      ...feature,
      constraints: feature.constraints.map((constraint) => {
        const mapped: Record<string, unknown> = { ...constraint };
        for (const key of ["value", "x", "y"])
          if (typeof mapped[key] === "string")
            mapped[key] = map(mapped[key] as string);
        return mapped as unknown as SketchConstraint;
      }),
    };
  const mapped: Record<string, unknown> = { ...feature };
  for (const key of expressionKeys)
    if (typeof mapped[key] === "string") mapped[key] = map(mapped[key]);
  if (feature.type === "pattern" && feature.center)
    mapped.center = feature.center.map(map);
  return mapped as unknown as F;
}

/** Stock a part can be made of. */
export interface MaterialDefinition {
  readonly id: string;
  readonly name: string;
  /** Sheets and boards have a thickness; anything else is a solid block. */
  readonly kind: "sheet" | "board" | "solid";
  readonly thickness?: string;
  /** Sheet size, for nesting. */
  readonly width?: string;
  readonly height?: string;
  readonly grain?: "width" | "height" | "none";
  readonly color?: string;
  readonly density?: number;
}

/** What a body is as a part: evaluated bodies are matched by id. */
export interface PartProperties {
  readonly body: string;
  readonly name?: string;
  readonly material?: string;
  /** `auto` (the default) treats a body as sheet stock when it was
   * extruded exactly as deep as its sheet material is thick. */
  readonly stock?: "auto" | "sheet" | "solid";
  readonly quantity?: number;
}

export interface CadDocument {
  readonly schemaVersion: typeof currentSchemaVersion;
  readonly units: "mm";
  readonly variables: readonly Variable[];
  readonly features: readonly Feature[];
  readonly materials?: readonly MaterialDefinition[];
  readonly parts?: readonly PartProperties[];
}

export function emptyDocument(): CadDocument {
  return {
    schemaVersion: currentSchemaVersion,
    units: "mm",
    variables: [],
    features: [],
  };
}

/** Upgrades older documents one version at a time. Index n turns version
 * n + 1 into n + 2 (none yet: version 1 is the first). */
const migrations: readonly ((
  document: Record<string, unknown>,
) => Record<string, unknown>)[] = [];

export class DocumentError extends Error {
  constructor(
    message: string,
    /** Where in the document, as a path like `features[0].entities[3]`. */
    readonly path: string,
  ) {
    super(path ? `${path}: ${message}` : message);
  }
}

/** Checks a document read from storage or the network and upgrades it to
 * the current version. Throws a DocumentError naming the first problem. */
export function readDocument(value: unknown): CadDocument {
  if (!isObject(value))
    throw new DocumentError("A document must be an object", "");
  let document = value;
  const version = document.schemaVersion;
  if (!Number.isInteger(version) || (version as number) < 1)
    throw new DocumentError(
      "schemaVersion must be a positive integer",
      "schemaVersion",
    );
  if ((version as number) > currentSchemaVersion)
    throw new DocumentError(
      `This document was saved by a newer CodeCAD (schema ${version as number}); update to open it`,
      "schemaVersion",
    );
  for (let v = version as number; v < currentSchemaVersion; v++)
    document = { ...migrations[v - 1]!(document), schemaVersion: v + 1 };
  validate(document);
  return document as unknown as CadDocument;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function validate(document: Record<string, unknown>): void {
  const fail = (path: string, message: string): never => {
    throw new DocumentError(message, path);
  };
  const string = (value: unknown, path: string) => {
    if (typeof value !== "string") fail(path, "must be a string");
  };
  const optional = (
    value: unknown,
    path: string,
    check: (v: unknown, p: string) => void,
  ) => {
    if (value !== undefined) check(value, path);
  };
  const boolean = (value: unknown, path: string) => {
    if (typeof value !== "boolean") fail(path, "must be true or false");
  };
  const finite = (value: unknown, path: string) => {
    if (typeof value !== "number" || !Number.isFinite(value))
      fail(path, "must be a finite number");
  };
  const oneOf = (value: unknown, path: string, allowed: readonly string[]) => {
    if (!allowed.includes(value as string))
      fail(path, `must be one of ${allowed.join(", ")}`);
  };
  const list = (value: unknown, path: string): unknown[] => {
    if (!Array.isArray(value)) fail(path, "must be a list");
    return value as unknown[];
  };
  const unique = (ids: Set<string>, id: unknown, path: string) => {
    string(id, path);
    if (ids.has(id as string)) fail(path, `duplicate id "${id as string}"`);
    ids.add(id as string);
  };

  oneOf(document.units, "units", ["mm"]);
  const variableIds = new Set<string>();
  const variableNames = new Set<string>();
  list(document.variables, "variables").forEach((variable, i) => {
    const path = `variables[${i}]`;
    if (!isObject(variable)) return fail(path, "must be an object");
    unique(variableIds, variable.id, `${path}.id`);
    string(variable.name, `${path}.name`);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable.name as string))
      fail(
        `${path}.name`,
        "must start with a letter and contain only letters, digits and _",
      );
    if (variableNames.has(variable.name as string))
      fail(
        `${path}.name`,
        `another variable is already called "${variable.name as string}"`,
      );
    variableNames.add(variable.name as string);
    string(variable.expression, `${path}.expression`);
    oneOf(variable.unit, `${path}.unit`, ["mm", "deg", "none"]);
    optional(variable.kind, `${path}.kind`, (v, p) =>
      oneOf(v, p, ["number", "boolean", "select"]),
    );
    optional(variable.group, `${path}.group`, string);
    optional(variable.description, `${path}.description`, string);
    optional(variable.options, `${path}.options`, (options, p) =>
      list(options, p).forEach((option, j) => {
        if (!isObject(option)) return fail(`${p}[${j}]`, "must be an object");
        string(option.label, `${p}[${j}].label`);
        finite(option.value, `${p}[${j}].value`);
      }),
    );
    if (variable.kind === "select" && !Array.isArray(variable.options))
      fail(`${path}.options`, "a select variable needs options");
  });

  const featureIds = new Set<string>();
  /** Feature id → type, for the features listed so far. */
  const featureTypes = new Map<string, string>();
  const expression = string;
  const face = (value: unknown, p: string) => {
    if (!isObject(value)) return fail(p, "must be a face reference");
    for (const key of ["body", "origin", "role"])
      string(value[key], `${p}.${key}`);
    optional(value.hint, `${p}.hint`, (v, q) => {
      if (!isObject(v)) fail(q, "must be an object");
    });
  };
  const checks: Checks = {
    fail,
    string,
    expression,
    boolean,
    oneOf,
    list,
    optional,
    face,
    edge: (value, p) => {
      if (!isObject(value)) return fail(p, "must be an edge reference");
      face(value.a, `${p}.a`);
      face(value.b, `${p}.b`);
      optional(value.near, `${p}.near`, (v, q) =>
        list(v, q).forEach((n, k) => finite(n, `${q}[${k}]`)),
      );
    },
  };
  optional(document.materials, "materials", (value, p) => {
    const ids = new Set<string>();
    list(value, p).forEach((material, i) => {
      const at = `${p}[${i}]`;
      if (!isObject(material)) return fail(at, "must be an object");
      unique(ids, material.id, `${at}.id`);
      string(material.name, `${at}.name`);
      oneOf(material.kind, `${at}.kind`, ["sheet", "board", "solid"]);
      for (const key of ["thickness", "width", "height", "color"])
        optional(material[key], `${at}.${key}`, string);
      optional(material.grain, `${at}.grain`, (v, q) =>
        oneOf(v, q, ["width", "height", "none"]),
      );
      optional(material.density, `${at}.density`, finite);
      if (material.kind !== "solid" && material.thickness === undefined)
        fail(`${at}.thickness`, "sheet and board stock needs a thickness");
    });
  });
  optional(document.parts, "parts", (value, p) => {
    const bodies = new Set<string>();
    list(value, p).forEach((part, i) => {
      const at = `${p}[${i}]`;
      if (!isObject(part)) return fail(at, "must be an object");
      unique(bodies, part.body, `${at}.body`);
      optional(part.name, `${at}.name`, string);
      optional(part.material, `${at}.material`, string);
      optional(part.stock, `${at}.stock`, (v, q) =>
        oneOf(v, q, ["auto", "sheet", "solid"]),
      );
      optional(part.quantity, `${at}.quantity`, (v, q) => {
        if (!Number.isInteger(v) || (v as number) < 1)
          fail(q, "must be a whole number of at least 1");
      });
    });
  });
  list(document.features, "features").forEach((feature, i) => {
    const path = `features[${i}]`;
    if (!isObject(feature)) return fail(path, "must be an object");
    const earlier = new Map(featureTypes);
    unique(featureIds, feature.id, `${path}.id`);
    oneOf(feature.type, `${path}.type`, [
      "sketch",
      "extrude",
      "fillet",
      "chamfer",
      "shell",
      "hole",
      "pattern",
      "mirror",
    ]);
    featureTypes.set(feature.id as string, feature.type as string);
    string(feature.name, `${path}.name`);
    optional(feature.suppressed, `${path}.suppressed`, boolean);
    if (feature.type !== "sketch") {
      validateFeature(feature, path, earlier, checks);
      return;
    }
    oneOf(feature.plane, `${path}.plane`, ["XY", "XZ", "YZ"]);
    optional(feature.face, `${path}.face`, checks.face);
    const entities = new Map<string, string>();
    list(feature.entities, `${path}.entities`).forEach((entity, j) => {
      const at = `${path}.entities[${j}]`;
      if (!isObject(entity)) return fail(at, "must be an object");
      string(entity.id, `${at}.id`);
      if (entities.has(entity.id as string))
        fail(`${at}.id`, `duplicate id "${entity.id as string}"`);
      oneOf(entity.type, `${at}.type`, ["point", "line", "circle", "arc"]);
      optional(entity.construction, `${at}.construction`, boolean);
      const point = (key: string) => {
        string(entity[key], `${at}.${key}`);
        if (entities.get(entity[key] as string) !== "point")
          fail(`${at}.${key}`, `must name a point listed before it`);
      };
      if (entity.type === "point") {
        finite(entity.x, `${at}.x`);
        finite(entity.y, `${at}.y`);
      } else if (entity.type === "line") {
        point("start");
        point("end");
      } else if (entity.type === "circle") {
        point("center");
        finite(entity.radius, `${at}.radius`);
      } else {
        point("center");
        point("start");
        point("end");
      }
      entities.set(entity.id as string, entity.type as string);
    });
    const constraintIds = new Set<string>();
    list(feature.constraints, `${path}.constraints`).forEach(
      (constraint, j) => {
        const at = `${path}.constraints[${j}]`;
        if (!isObject(constraint)) return fail(at, "must be an object");
        if (entities.has(constraint.id as string))
          fail(`${at}.id`, "must differ from every entity id");
        unique(constraintIds, constraint.id, `${at}.id`);
        const kinds: Record<string, readonly string[]> = {
          coincident: ["a", "b"],
          horizontal: ["line"],
          vertical: ["line"],
          parallel: ["a", "b"],
          perpendicular: ["a", "b"],
          equal: ["a", "b"],
          tangent: ["a", "b"],
          onEntity: ["point", "entity"],
          midpoint: ["point", "line"],
          symmetric: ["a", "b", "line"],
          fix: ["point"],
          distance: ["a", "b"],
          angle: ["a", "b"],
          radius: ["entity"],
          diameter: ["entity"],
        };
        oneOf(constraint.type, `${at}.type`, Object.keys(kinds));
        for (const key of kinds[constraint.type as string]!) {
          string(constraint[key], `${at}.${key}`);
          if (!entities.has(constraint[key] as string))
            fail(
              `${at}.${key}`,
              `names no entity of this sketch ("${constraint[key] as string}")`,
            );
        }
        for (const key of ["value", "x", "y"])
          if (key in constraint) string(constraint[key], `${at}.${key}`);
        if (
          ["distance", "angle", "radius", "diameter"].includes(
            constraint.type as string,
          )
        )
          string(constraint.value, `${at}.value`);
        if (constraint.type === "fix") {
          string(constraint.x, `${at}.x`);
          string(constraint.y, `${at}.y`);
        }
        optional(constraint.direction, `${at}.direction`, (v, p) =>
          oneOf(v, p, ["horizontal", "vertical"]),
        );
      },
    );
  });
}

interface Checks {
  fail(path: string, message: string): never;
  string(value: unknown, path: string): void;
  expression(value: unknown, path: string): void;
  boolean(value: unknown, path: string): void;
  oneOf(value: unknown, path: string, allowed: readonly string[]): void;
  list(value: unknown, path: string): unknown[];
  optional(
    value: unknown,
    path: string,
    check: (v: unknown, p: string) => void,
  ): void;
  face(value: unknown, path: string): void;
  edge(value: unknown, path: string): void;
}

/** Everything but sketches. `earlier` holds the features listed before this
 * one: a feature may only use what comes before it. */
function validateFeature(
  feature: Record<string, unknown>,
  path: string,
  earlier: ReadonlyMap<string, string>,
  c: Checks,
): void {
  const at = (key: string) => `${path}.${key}`;
  const sketch = (key: string) => {
    c.string(feature[key], at(key));
    if (earlier.get(feature[key] as string) !== "sketch")
      c.fail(at(key), "must name a sketch listed before this feature");
  };
  const strings = (key: string) =>
    c.optional(feature[key], at(key), (v, p) =>
      c.list(v, p).forEach((item, i) => c.string(item, `${p}[${i}]`)),
    );
  const features = (key: string) =>
    c.optional(feature[key], at(key), (v, p) =>
      c.list(v, p).forEach((item, i) => {
        c.string(item, `${p}[${i}]`);
        if (!earlier.has(item as string))
          c.fail(`${p}[${i}]`, "must name a feature listed before this one");
      }),
    );
  const expressions = (...keys: string[]) =>
    keys.forEach((key) => c.optional(feature[key], at(key), c.expression));
  switch (feature.type) {
    case "extrude":
      sketch("sketch");
      strings("regions");
      strings("targets");
      c.oneOf(feature.operation, at("operation"), [
        "new",
        "add",
        "cut",
        "intersect",
      ]);
      c.oneOf(feature.extent, at("extent"), [
        "blind",
        "symmetric",
        "throughAll",
        "upTo",
      ]);
      expressions("distance");
      if (
        (feature.extent === "blind" || feature.extent === "symmetric") &&
        feature.distance === undefined
      )
        c.fail(at("distance"), "a blind or symmetric extrude needs a distance");
      if (feature.extent === "upTo") c.face(feature.upTo, at("upTo"));
      c.optional(feature.reverse, at("reverse"), c.boolean);
      break;
    case "fillet":
    case "chamfer":
      c.list(feature.edges, at("edges")).forEach((edge, i) =>
        c.edge(edge, `${at("edges")}[${i}]`),
      );
      c.expression(
        feature[feature.type === "fillet" ? "radius" : "distance"],
        at(feature.type === "fillet" ? "radius" : "distance"),
      );
      break;
    case "shell":
      c.list(feature.faces, at("faces")).forEach((face, i) =>
        c.face(face, `${at("faces")}[${i}]`),
      );
      c.expression(feature.thickness, at("thickness"));
      break;
    case "hole":
      sketch("sketch");
      strings("points");
      strings("targets");
      c.oneOf(feature.kind, at("kind"), [
        "simple",
        "countersink",
        "counterbore",
      ]);
      c.expression(feature.diameter, at("diameter"));
      expressions("depth", "headDiameter", "headDepth", "angle");
      if (feature.kind !== "simple" && feature.headDiameter === undefined)
        c.fail(at("headDiameter"), `a ${feature.kind} needs a head diameter`);
      if (feature.kind === "counterbore" && feature.headDepth === undefined)
        c.fail(at("headDepth"), "a counterbore needs a depth");
      break;
    case "pattern":
    case "mirror":
      features("features");
      strings("bodies");
      if (feature.type === "pattern") {
        c.oneOf(feature.kind, at("kind"), ["linear", "circular"]);
        c.oneOf(feature.axis, at("axis"), ["X", "Y", "Z"]);
        c.expression(feature.count, at("count"));
        expressions("spacing", "angle");
        if (feature.kind === "linear" && feature.spacing === undefined)
          c.fail(at("spacing"), "a linear pattern needs a spacing");
        c.optional(feature.center, at("center"), (v, p) => {
          const center = c.list(v, p);
          if (center.length !== 3) c.fail(p, "must list x, y and z");
          center.forEach((value, i) => c.expression(value, `${p}[${i}]`));
        });
      } else {
        c.oneOf(feature.plane, at("plane"), ["XY", "XZ", "YZ"]);
        expressions("offset");
      }
      break;
  }
}
