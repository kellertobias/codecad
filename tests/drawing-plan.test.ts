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
  // A plan saved before sheets existed reads as the first sheet.
  assert.deepEqual(validateDrawingPlan(JSON.parse(JSON.stringify(plan))), {
    version: 2,
    sheets: [{ id: "sheet_1", title: plan.title, items: plan.items }],
  });
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
  assert.deepEqual(
    validateDrawingPlan(JSON.parse(JSON.stringify(plan))).sheets[0]!.items,
    plan.items,
  );
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
  assert.deepEqual(
    validateDrawingPlan(JSON.parse(JSON.stringify(plan))).sheets[0]!.items,
    plan.items,
  );
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

test("a plan keeps several sheets, each with its own views and dimensions", () => {
  const view = (id: string) => ({
    id,
    kind: "view" as const,
    subject: "*",
    angle: "front" as const,
    x: 20,
    y: 20,
    width: 160,
    height: 100,
    scale: 10,
    label: "",
  });
  const dimension = (id: string, of: string) => ({
    id,
    kind: "dimension" as const,
    view: of,
    u1: 0,
    v1: 0,
    u2: 100,
    v2: 0,
    offset: 8,
    label: "",
  });
  const plan = {
    version: 2 as const,
    sheets: [
      { id: "s1", title: "Assembly", items: [view("a"), dimension("d1", "a")] },
      { id: "s2", title: "Parts", items: [view("b")] },
    ],
  };
  assert.deepEqual(validateDrawingPlan(JSON.parse(JSON.stringify(plan))), plan);
  // A dimension is drawn on its view's page, so it cannot point across.
  assert.throws(
    () =>
      validateDrawingPlan({
        ...plan,
        sheets: [
          plan.sheets[0],
          { ...plan.sheets[1]!, items: [view("b"), dimension("d2", "a")] },
        ],
      }),
    /missing view/,
  );
  // Built views are looked up by ID, so IDs stay unique across sheets.
  assert.throws(
    () =>
      validateDrawingPlan({
        ...plan,
        sheets: [plan.sheets[0], { ...plan.sheets[1]!, items: [view("a")] }],
      }),
    /duplicate/,
  );
  assert.throws(
    () => validateDrawingPlan({ ...plan, sheets: [] }),
    /Unsupported/,
  );
  assert.throws(
    () =>
      validateDrawingPlan({
        ...plan,
        sheets: [plan.sheets[0], { ...plan.sheets[1]!, id: "s1" }],
      }),
    /Invalid drawing sheet/,
  );
  // A flat view draws one part as cut, never the whole model.
  const flat = { ...view("f"), angle: "flat" as const, subject: "shelf" };
  const withFlat = {
    version: 2 as const,
    sheets: [{ id: "s", title: "", items: [flat] }],
  };
  assert.deepEqual(validateDrawingPlan(withFlat), withFlat);
  assert.throws(
    () =>
      validateDrawingPlan({
        ...withFlat,
        sheets: [{ id: "s", title: "", items: [{ ...flat, subject: "*" }] }],
      }),
    /Invalid model view/,
  );
});
