// Evaluates a document's variables in dependency order. A variable that
// cannot be evaluated (bad syntax, an unknown name, a cycle) gets an error
// of its own; the others still get values, so one mistake does not blank
// out the whole model.
import {
  ExpressionError,
  evaluateExpression,
  renameInExpression,
  parseExpression,
  referencedNames,
  type Expression,
} from "./expressions.js";
import { mapExpressions, type CadDocument, type Variable } from "./schema.js";

export interface VariableValues {
  /** Values by variable name, in base units (mm, deg; booleans 0 or 1). */
  readonly values: ReadonlyMap<string, number>;
  /** Problems by variable id. */
  readonly errors: ReadonlyMap<string, string>;
  /** Variables in the order they were evaluated: each after those it uses. */
  readonly order: readonly string[];
}

export function evaluateVariables(
  variables: readonly Variable[],
): VariableValues {
  const byName = new Map(
    variables.map((variable) => [variable.name, variable]),
  );
  const values = new Map<string, number>();
  const errors = new Map<string, string>();
  const order: string[] = [];
  const parsed = new Map<string, Expression>();
  for (const variable of variables) {
    try {
      parsed.set(variable.id, parseExpression(variable.expression));
    } catch (error) {
      errors.set(
        variable.id,
        error instanceof ExpressionError
          ? `${error.message} at character ${error.at + 1}`
          : String(error),
      );
    }
  }

  // Depth-first, keeping the path, so a cycle can be reported in full.
  const state = new Map<string, "visiting" | "done">();
  const visit = (variable: Variable, path: readonly string[]): void => {
    if (state.get(variable.id) === "done") return;
    if (state.get(variable.id) === "visiting") {
      const cycle = [...path.slice(path.indexOf(variable.name)), variable.name];
      for (const name of new Set(cycle)) {
        const member = byName.get(name)!;
        errors.set(member.id, `Circular reference: ${cycle.join(" → ")}`);
      }
      return;
    }
    state.set(variable.id, "visiting");
    const expression = parsed.get(variable.id);
    if (expression)
      for (const name of referencedNames(expression)) {
        const dependency = byName.get(name);
        if (dependency) visit(dependency, [...path, variable.name]);
      }
    state.set(variable.id, "done");
    order.push(variable.name);
    if (!expression || errors.has(variable.id)) return;
    try {
      const value = evaluateExpression(expression, (name) => {
        const dependency = byName.get(name);
        if (dependency && errors.has(dependency.id))
          throw new ExpressionError(`"${name}" has an error`, 0);
        return values.get(name);
      });
      if (!Number.isFinite(value))
        throw new ExpressionError("The result is not a finite number", 0);
      values.set(variable.name, normalized(variable, value));
    } catch (error) {
      errors.set(
        variable.id,
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  for (const variable of variables) visit(variable, []);
  return { values, errors, order };
}

/** Booleans become 0 or 1; select values must be one of the options. */
function normalized(variable: Variable, value: number): number {
  if (variable.kind === "boolean") return value ? 1 : 0;
  if (
    variable.kind === "select" &&
    !variable.options?.some((option) => option.value === value)
  )
    throw new ExpressionError(`${value} is not one of the options`, 0);
  return value;
}

/** Evaluates an expression that may use the document's variables, such as a
 * dimension. Throws an ExpressionError when it cannot. */
export function evaluateWith(
  source: string,
  variables: VariableValues,
): number {
  const value = evaluateExpression(parseExpression(source), (name) =>
    variables.values.get(name),
  );
  if (!Number.isFinite(value))
    throw new ExpressionError("The result is not a finite number", 0);
  return value;
}

/** Renames a variable and every use of it, in other variables, in the
 * features and in the materials. */
export function renameVariable(
  document: CadDocument,
  id: string,
  name: string,
): CadDocument {
  const variable = document.variables.find((v) => v.id === id);
  if (!variable || variable.name === name) return document;
  const rename = (source: string) =>
    renameInExpression(source, variable.name, name);
  return {
    ...document,
    variables: document.variables.map((v) => ({
      ...v,
      ...(v.id === id ? { name } : {}),
      expression: rename(v.expression),
    })),
    features: document.features.map((feature) =>
      mapExpressions(feature, rename),
    ),
    ...(document.drawings
      ? {
          drawings: document.drawings.map((sheet) => ({
            ...sheet,
            views: sheet.views.map((view) =>
              view.kind === "section"
                ? {
                    ...view,
                    origin: view.origin.map(
                      rename,
                    ) as unknown as typeof view.origin,
                  }
                : view.kind === "exploded"
                  ? { ...view, distance: rename(view.distance) }
                  : view,
            ),
          })),
        }
      : {}),
    ...(document.materials
      ? {
          materials: document.materials.map((material) => {
            const renamed: Record<string, unknown> = { ...material };
            for (const key of ["thickness", "width", "height"])
              if (typeof renamed[key] === "string")
                renamed[key] = rename(renamed[key] as string);
            return renamed as unknown as typeof material;
          }),
        }
      : {}),
  };
}
