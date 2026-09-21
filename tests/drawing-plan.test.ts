import assert from "node:assert/strict";
import test from "node:test";
import { planViewKey, validateDrawingPlan } from "../src/drawing-plan.js";

test("drawing instructions preserve views, part references, measurements and notes", () => {
  const plan = {
    version: 1,
    title: "Assembly plan",
    items: [
      {
        id: "view_1",
        kind: "view",
        subject: "cabinet/door",
        angle: "front",
        x: 20,
        y: 20,
        width: 160,
        height: 100,
        scale: 10,
        label: "Door",
      },
      {
        id: "dim_1",
        kind: "dimension",
        view: "view_1",
        u1: 0,
        v1: 0,
        u2: 600,
        v2: 0,
        offset: 8,
        label: "",
      },
      {
        id: "note_1",
        kind: "text",
        x: 20,
        y: 150,
        text: "Check hinge clearance",
        size: 4,
      },
    ],
  };
  assert.deepEqual(validateDrawingPlan(JSON.parse(JSON.stringify(plan))), plan);
  assert.throws(
    () => validateDrawingPlan({ ...plan, items: plan.items.slice(1) }),
    /missing view/,
  );
  assert.throws(
    () =>
      validateDrawingPlan({ ...plan, items: [plan.items[0], plan.items[0]] }),
    /duplicate/,
  );
});

test("a view remembers which parts it leaves out", () => {
  const view = {
    id: "view_1",
    kind: "view" as const,
    subject: "cabinet",
    angle: "front" as const,
    x: 20,
    y: 20,
    width: 160,
    height: 100,
    scale: 10,
    label: "",
    hiddenParts: ["cabinet/door", "cabinet/shelf"],
  };
  const plan = { version: 1 as const, title: "Carcass", items: [view] };
  assert.deepEqual(validateDrawingPlan(JSON.parse(JSON.stringify(plan))), plan);
  assert.throws(
    () =>
      validateDrawingPlan({
        ...plan,
        items: [{ ...view, hiddenParts: "cabinet/door" }],
      }),
    /Invalid model view/,
  );
  // Built geometry is reused by key, so switching a part off must change it
  // while merely reordering the list must not.
  const { hiddenParts, ...whole } = view;
  assert.notEqual(planViewKey(view), planViewKey(whole));
  assert.equal(planViewKey(whole), planViewKey({ ...view, hiddenParts: [] }));
  assert.equal(
    planViewKey(view),
    planViewKey({ ...view, hiddenParts: [...hiddenParts].reverse() }),
  );
});
