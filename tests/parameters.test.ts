import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Project,
  Shapes,
  Part,
  cad,
  defineParameters,
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
