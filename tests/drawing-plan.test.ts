import assert from "node:assert/strict";
import test from "node:test";
import { planViewKey, validateDrawingPlan } from "../src/drawing-plan.js";
import { rotatePaper, viewBasis, type Triple } from "../src/view-basis.js";

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

test("a turned view keeps its dimensions on the geometry they measure", () => {
  const view = {
    id: "view_1",
    kind: "view" as const,
    subject: "*",
    angle: "front" as const,
    x: 20,
    y: 20,
    width: 160,
    height: 100,
    scale: 10,
    rotate: 90,
    label: "",
  };
  const plan = { version: 1 as const, title: "Turned", items: [view] };
  assert.deepEqual(validateDrawingPlan(JSON.parse(JSON.stringify(plan))), plan);
  for (const rotate of [400, Number.NaN, "90"])
    assert.throws(
      () => validateDrawingPlan({ ...plan, items: [{ ...view, rotate }] }),
      /Invalid model view/,
      `rotate ${String(rotate)} should be rejected`,
    );

  // The built projection depends on the turn, but an upright view keeps the
  // key it had before rotation existed, so saved builds stay usable.
  const { rotate, ...upright } = view;
  assert.notEqual(planViewKey(view), planViewKey(upright));
  assert.equal(planViewKey(upright), planViewKey({ ...view, rotate: 0 }));

  // A front view turned a quarter turn still looks along the same axis, but
  // the model's up (world +Z) now points left on the paper.
  const turned = viewBasis("front", 90);
  const close = (a: Triple, b: Triple) =>
    a.forEach((n, i) => assert(Math.abs(n - b[i]!) < 1e-12, `${a} vs ${b}`));
  close(turned.x, [0, 0, -1]);
  close(turned.y, [1, 0, 0]);
  close(turned.toward, viewBasis("front").toward);
  // Four quarter turns come back to where they started.
  close(viewBasis("front", 360).x, viewBasis("front").x);

  // A point turns with the frame: 90° puts paper-right onto paper-up.
  const p = rotatePaper({ x: 3, y: 0 }, 90);
  assert(Math.abs(p.x) < 1e-12 && Math.abs(p.y - 3) < 1e-12);
  assert.deepEqual(rotatePaper({ x: 3, y: -2 }, 0), { x: 3, y: -2 });
});
