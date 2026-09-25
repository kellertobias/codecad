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
  readonly plane: Plane;
  readonly entities: readonly SketchEntity[];
  readonly constraints: readonly SketchConstraint[];
  readonly suppressed?: boolean;
}

export type Feature = SketchFeature;

export interface CadDocument {
  readonly schemaVersion: typeof currentSchemaVersion;
  readonly units: "mm";
  readonly variables: readonly Variable[];
  readonly features: readonly Feature[];
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
  list(document.features, "features").forEach((feature, i) => {
    const path = `features[${i}]`;
    if (!isObject(feature)) return fail(path, "must be an object");
    unique(featureIds, feature.id, `${path}.id`);
    oneOf(feature.type, `${path}.type`, ["sketch"]);
    string(feature.name, `${path}.name`);
    oneOf(feature.plane, `${path}.plane`, ["XY", "XZ", "YZ"]);
    optional(feature.suppressed, `${path}.suppressed`, boolean);
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
