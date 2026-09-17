import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Project,
  Shapes,
  Part,
  cad,
  CodeCadParameters,
  defineParameters,
  inputParameters,
  resolveParameters,
} from "../src/index.js";

const schema = defineParameters({
  width: {
    type: "number",
    label: "Width",
    unit: "mm",
    default: 600,
    min: 300,
    max: 1200,
    step: 10,
  },
  doors: { type: "boolean", label: "Include doors", default: true },
  finish: {
    type: "select",
    label: "Finish",
    default: "birch",
    options: [
      { value: "birch", label: "Birch" },
      { value: "oak", label: "Oak" },
    ],
  },
});

test("inferred parameter declarations allow either range end to be open", () => {
  const params = new CodeCadParameters({
    maximum: cad.parameter(50, {
      label: "Maximum",
      range: [null, 100],
      step: 10,
    }),
    minimum: cad.parameter(150, { label: "Minimum", range: [100, null] }),
    bounded: cad.parameter(50, { label: "Bounded", range: [10, 100] }),
    enabled: cad.parameter(true, { label: "Enabled" }),
  });
  assert.deepEqual(resolveParameters(params.with()), {
    maximum: 50,
    minimum: 150,
    bounded: 50,
    enabled: true,
  });
  assert.equal(params.definitions.maximum.min, undefined);
  assert.equal(params.definitions.maximum.max, 100);
  assert.equal(params.definitions.minimum.max, undefined);
  assert.deepEqual(
    resolveParameters(
      params.with({ maximum: -100, minimum: 200, enabled: false }),
    ),
    {
      maximum: -100,
      minimum: 200,
      bounded: 50,
      enabled: false,
    },
  );
  assert.equal(params.definitions.maximum.default, 50);
  assert.throws(() => params.with({ maximum: 101 }), /bounds/);
  assert.throws(() => params.with({ minimum: 99 }), /bounds/);
  assert.throws(() => params.with({ bounded: 9 }), /bounds/);
  assert.throws(
    () =>
      new CodeCadParameters({
        bad: cad.parameter(5, { label: "Bad", range: [10, null] }),
      }),
    /bounds/,
  );
  assert.throws(
    () =>
      new CodeCadParameters({
        bad: cad.parameter(5, { label: "Bad", range: [100, 10] }),
      }),
    /reversed bounds/,
  );
});

@cad.project({ id: "parameter-test", units: "mm" })
class ParameterProject extends Project {
  readonly active;
  constructor() {
    super({ id: "parameter-test" });
    this.active = this.configureParameters(schema);
    new Part({
      id: "panel",
      shape: new Shapes.Box({
        width: this.active.width,
        depth: 20,
        height: 18,
      }),
    });
  }
}

test("typed project parameters supply defaults and active values to geometry", () => {
  const previous = process.env.CODECAD_PARAMETER_VALUES;
  try {
    delete process.env.CODECAD_PARAMETER_VALUES;
    const defaultProject = new ParameterProject();
    assert.equal(defaultProject.active.width, 600);
    assert.equal(schema.width.unit, "mm");
    process.env.CODECAD_PARAMETER_VALUES = JSON.stringify({
      width: 750,
      doors: false,
      finish: "oak",
    });
    const editedProject = new ParameterProject();
    assert.equal(editedProject.active.width, 750);
    assert.equal(editedProject.active.doors, false);
    assert.equal(editedProject.active.finish, "oak");
    assert.notDeepEqual(
      defaultProject.parts.all[0]!.recipe,
      editedProject.parts.all[0]!.recipe,
    );
  } finally {
    if (previous === undefined) delete process.env.CODECAD_PARAMETER_VALUES;
    else process.env.CODECAD_PARAMETER_VALUES = previous;
  }
});

test("parameter values reject unknown, malformed, and out-of-range edits", () => {
  assert.throws(() => resolveParameters(schema, { width: 1201 }), /bounds/);
  assert.throws(
    () => resolveParameters(schema, { width: "700" }),
    /finite number/,
  );
  assert.throws(() => resolveParameters(schema, { doors: "yes" }), /boolean/);
  assert.throws(() => resolveParameters(schema, { finish: "pine" }), /options/);
  assert.throws(
    () => resolveParameters(schema, { missing: 1 }),
    /Unknown parameter/,
  );
  assert.throws(
    () =>
      defineParameters({
        gap: { type: "number", label: "Gap", default: 10, min: 20 },
      }),
    /bounds/,
  );
});

test("input parameters support validated, nonmutating default overrides", () => {
  const inputs = inputParameters({
    width: {
      type: "number",
      label: "Width",
      default: 1200,
      min: 500,
      max: 2000,
    },
    square: { type: "boolean", label: "Square", default: true },
  });
  const variant = inputs.with({ width: 1500, square: false });
  assert.deepEqual(resolveParameters(variant), { width: 1500, square: false });
  assert.deepEqual(resolveParameters(inputs.with()), {
    width: 1200,
    square: true,
  });
  assert.equal(inputs.definitions.width.default, 1200);
  assert.throws(() => inputs.with({ width: 2500 }), /bounds/);
  assert.throws(
    () => inputs.with({ missing: 1 } as never),
    /Unknown parameter/,
  );
});
