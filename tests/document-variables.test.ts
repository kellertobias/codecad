import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ExpressionError,
  evaluate,
  parseExpression,
  referencedNames,
  renameInExpression,
} from "../src/document/expressions.js";
import {
  evaluateVariables,
  renameVariable,
} from "../src/document/variables.js";
import {
  DocumentError,
  emptyDocument,
  readDocument,
  type Variable,
} from "../src/document/schema.js";

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

test("expressions follow arithmetic precedence and convert units", () => {
  assert.equal(evaluate("2 + 3 * 4"), 14);
  assert.equal(evaluate("(2 + 3) * 4"), 20);
  assert.equal(evaluate("2 ^ 3 ^ 2"), 512);
  assert.equal(evaluate("-2 ^ 2"), -4);
  assert.equal(evaluate("18mm"), 18);
  assert.equal(evaluate("2 cm + 5"), 25);
  assert.equal(evaluate("1in"), 25.4);
  assert.ok(near(evaluate("1rad"), 180 / Math.PI));
  assert.equal(evaluate("90deg"), 90);
  assert.equal(evaluate("1.5e2"), 150);
});

test("expressions call functions, compare and choose", () => {
  assert.equal(evaluate("max(300, 450 / 2)"), 300);
  assert.equal(evaluate("round(2.6)"), 3);
  assert.ok(near(evaluate("sin(30)"), 0.5));
  assert.ok(near(evaluate("atan2(1, 1)"), 45));
  assert.equal(evaluate("3 > 2 ? 10 : 20"), 10);
  assert.equal(evaluate("1 && 0 || 1"), 1);
  assert.ok(near(evaluate("2 * pi"), 2 * Math.PI));
});

test("names are read from the lookup and reported when unknown", () => {
  const values: Record<string, number> = { width: 600, t: 18 };
  assert.equal(
    evaluate("width - 2 * t", (name) => values[name]),
    564,
  );
  assert.deepEqual(referencedNames(parseExpression("a + b * a - pi")), [
    "a",
    "b",
  ]);
  assert.throws(
    () => evaluate("width + depth", (name) => values[name]),
    (error) =>
      error instanceof ExpressionError &&
      /Unknown name "depth"/.test(error.message) &&
      error.at === 8,
  );
});

test("syntax errors say where they are", () => {
  assert.throws(
    () => parseExpression("2 * (3 + "),
    (error) => error instanceof ExpressionError && error.at === 9,
  );
  assert.throws(() => parseExpression("2 $ 3"), ExpressionError);
  assert.throws(() => evaluate("unknownFn(2)"), /Unknown function "unknownFn"/);
});

const variable = (
  name: string,
  expression: string,
  extra: Partial<Variable> = {},
): Variable => ({ id: `v-${name}`, name, expression, unit: "mm", ...extra });

test("variables are evaluated after the variables they use", () => {
  const result = evaluateVariables([
    variable("inner", "width - 2 * thickness"),
    variable("width", "600"),
    variable("thickness", "18mm"),
  ]);
  assert.equal(result.values.get("inner"), 564);
  assert.deepEqual(result.order, ["width", "thickness", "inner"]);
  assert.equal(result.errors.size, 0);
});

test("a circular reference is named in full and does not stop the rest", () => {
  const result = evaluateVariables([
    variable("a", "b + 1"),
    variable("b", "c * 2"),
    variable("c", "a"),
    variable("d", "40"),
  ]);
  assert.equal(result.errors.get("v-a"), "Circular reference: a → b → c → a");
  assert.equal(result.errors.get("v-c"), "Circular reference: a → b → c → a");
  assert.equal(result.values.get("d"), 40);
  assert.equal(result.values.has("a"), false);
});

test("a variable using a broken one reports that instead of a value", () => {
  const result = evaluateVariables([
    variable("broken", "2 *"),
    variable("uses", "broken + 1"),
    variable("self", "self + 1"),
  ]);
  assert.match(result.errors.get("v-broken")!, /ends too early/);
  assert.match(result.errors.get("v-uses")!, /"broken" has an error/);
  assert.equal(result.errors.get("v-self"), "Circular reference: self → self");
});

test("boolean and select variables are normalized and checked", () => {
  const result = evaluateVariables([
    variable("doors", "2 > 1", { kind: "boolean", unit: "none" }),
    variable("drawers", "3", {
      kind: "select",
      unit: "none",
      options: [
        { label: "Two", value: 2 },
        { label: "Three", value: 3 },
      ],
    }),
    variable("wrong", "5", {
      kind: "select",
      unit: "none",
      options: [{ label: "Two", value: 2 }],
    }),
  ]);
  assert.equal(result.values.get("doors"), 1);
  assert.equal(result.values.get("drawers"), 3);
  assert.match(result.errors.get("v-wrong")!, /not one of the options/);
});

test("documents are validated and name the first problem", () => {
  assert.deepEqual(readDocument(emptyDocument()), emptyDocument());
  const sketch = {
    id: "s1",
    type: "sketch",
    name: "Sketch 1",
    plane: "XY",
    entities: [
      { id: "p1", type: "point", x: 0, y: 0 },
      { id: "p2", type: "point", x: 10, y: 0 },
      { id: "l1", type: "line", start: "p1", end: "p2" },
    ],
    constraints: [{ id: "c1", type: "horizontal", line: "l1" }],
  };
  const document = { ...emptyDocument(), features: [sketch] };
  assert.equal(readDocument(document).features.length, 1);
  assert.throws(
    () =>
      readDocument({
        ...document,
        features: [
          {
            ...sketch,
            constraints: [{ id: "c1", type: "horizontal", line: "l9" }],
          },
        ],
      }),
    (error) =>
      error instanceof DocumentError &&
      error.path === "features[0].constraints[0].line",
  );
  assert.throws(
    () =>
      readDocument({
        ...emptyDocument(),
        variables: [variable("2wide", "1")],
      }),
    (error) =>
      error instanceof DocumentError && error.path === "variables[0].name",
  );
  assert.throws(
    () => readDocument({ ...emptyDocument(), schemaVersion: 99 }),
    /newer CodeCAD/,
  );
});

test("renaming a variable changes whole names only, everywhere", () => {
  assert.equal(
    renameInExpression("w + width * 2mm - max(w, 3)", "w", "wall"),
    "wall + width * 2mm - max(wall, 3)",
  );
  assert.equal(renameInExpression("broken +", "w", "wall"), "broken +");
  const document = {
    ...emptyDocument(),
    variables: [variable("w", "600"), variable("inner", "w - 36")],
    features: [
      {
        id: "s",
        type: "sketch" as const,
        name: "Sketch",
        plane: "XY" as const,
        entities: [
          { id: "p1", type: "point" as const, x: 0, y: 0 },
          { id: "p2", type: "point" as const, x: 1, y: 0 },
        ],
        constraints: [
          {
            id: "d",
            type: "distance" as const,
            a: "p1",
            b: "p2",
            value: "w / 2",
          },
        ],
      },
    ],
  };
  const renamed = renameVariable(document, "v-w", "width");
  assert.deepEqual(
    renamed.variables.map((v) => [v.name, v.expression]),
    [
      ["width", "600"],
      ["inner", "width - 36"],
    ],
  );
  const dimension = renamed.features[0]!.constraints[0]!;
  assert.equal("value" in dimension && dimension.value, "width / 2");
});
