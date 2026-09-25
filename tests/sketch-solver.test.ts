import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  make_gcs_wrapper,
  DebugMode,
  SolveStatus,
  type SketchPrimitive,
  type SketchParam,
  type GcsWrapper,
} from "@salusoft89/planegcs";

// The sketcher needs a 2D constraint solver that places geometry from
// dimensions driven by variables, says how many degrees of freedom are left,
// names conflicting or redundant constraints, and is fast enough to re-solve
// on every mouse move while a point is dragged. planegcs is FreeCAD's solver
// compiled to WASM; these tests check it does each of those.

const wrappers: GcsWrapper[] = [];
after(() => {
  for (const wrapper of wrappers) wrapper.destroy_gcs_module();
});
async function solver() {
  const wrapper = await make_gcs_wrapper();
  // The solver prints diagnostics to stdout unless told not to.
  wrapper.debug_mode = DebugMode.NoDebug;
  wrappers.push(wrapper);
  return wrapper;
}

/** A rectangle whose width and height come from sketch parameters (the
 * document's variables), anchored at the origin. `prefix` keeps ids unique
 * when several rectangles share one sketch. */
function rectangle(
  prefix: string,
  at: { x: number; y: number },
): SketchPrimitive[] {
  const p = (n: number) => `${prefix}p${n}`;
  const l = (n: number) => `${prefix}l${n}`;
  // Deliberately rough starting positions: the solver has to move them.
  const corners = [
    [at.x, at.y],
    [at.x + 90, at.y + 3],
    [at.x + 85, at.y + 45],
    [at.x - 4, at.y + 52],
  ] as const;
  return [
    ...corners.map(([x, y], i): SketchPrimitive => ({
      id: p(i),
      type: "point",
      x,
      y,
      fixed: false,
    })),
    ...[0, 1, 2, 3].map((i): SketchPrimitive => ({
      id: l(i),
      type: "line",
      p1_id: p(i),
      p2_id: p((i + 1) % 4),
    })),
    { id: `${prefix}h0`, type: "horizontal_l", l_id: l(0) },
    { id: `${prefix}h2`, type: "horizontal_l", l_id: l(2) },
    { id: `${prefix}v1`, type: "vertical_l", l_id: l(1) },
    { id: `${prefix}v3`, type: "vertical_l", l_id: l(3) },
    {
      id: `${prefix}w`,
      type: "p2p_distance",
      p1_id: p(0),
      p2_id: p(1),
      distance: "width",
    },
    {
      id: `${prefix}d`,
      type: "p2p_distance",
      p1_id: p(1),
      p2_id: p(2),
      distance: "depth",
    },
    {
      id: `${prefix}x`,
      type: "coordinate_x",
      p_id: p(0),
      x: at.x,
    },
    {
      id: `${prefix}y`,
      type: "coordinate_y",
      p_id: p(0),
      y: at.y,
    },
  ];
}

const params = (width: number, depth: number): SketchParam[] => [
  { type: "param", name: "width", value: width },
  { type: "param", name: "depth", value: depth },
];

function point(wrapper: GcsWrapper, id: string): { x: number; y: number } {
  const primitive = wrapper.sketch_index.get_primitive_or_fail(id);
  assert.equal(primitive.type, "point");
  return { x: primitive.x, y: primitive.y };
}
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

test("a dimensioned rectangle solves to its variables and has no freedom left", async () => {
  const wrapper = await solver();
  wrapper.push_primitives_and_params([
    ...params(120, 40),
    ...rectangle("", { x: 0, y: 0 }),
  ]);
  const status = wrapper.solve();
  assert.ok(status === SolveStatus.Success || status === SolveStatus.Converged);
  wrapper.apply_solution();
  const far = point(wrapper, "p2");
  assert.ok(near(far.x, 120) && near(far.y, 40), JSON.stringify(far));
  assert.equal(wrapper.gcs.dof(), 0);
});

test("changing a variable moves the geometry on the next solve", async () => {
  const wrapper = await solver();
  wrapper.push_primitives_and_params([
    ...params(120, 40),
    ...rectangle("", { x: 0, y: 0 }),
  ]);
  wrapper.solve();
  wrapper.apply_solution();
  wrapper.set_sketch_param("width", 300);
  wrapper.solve();
  wrapper.apply_solution();
  assert.ok(near(point(wrapper, "p1").x, 300));
});

test("an unconstrained point is reported as remaining freedom", async () => {
  const wrapper = await solver();
  wrapper.push_primitives_and_params([
    ...params(120, 40),
    ...rectangle("", { x: 0, y: 0 }).filter((p) => p.id !== "y"),
  ]);
  wrapper.solve();
  // Without its y anchor the rectangle can still slide up and down.
  assert.equal(wrapper.gcs.dof(), 1);
});

test("a contradicting dimension is named as a conflict", async () => {
  const wrapper = await solver();
  wrapper.push_primitives_and_params([
    ...params(120, 40),
    ...rectangle("", { x: 0, y: 0 }),
    // The top edge cannot be 80 long while the bottom edge is 120.
    { id: "bad", type: "p2p_distance", p1_id: "p2", p2_id: "p3", distance: 80 },
  ]);
  wrapper.solve();
  assert.ok(wrapper.has_gcs_conflicting_constraints());
  assert.ok(wrapper.get_gcs_conflicting_constraints().includes("bad"));
});

test("a sketch of 20 rectangles re-solves within a frame", async (t) => {
  const wrapper = await solver();
  const primitives: (SketchPrimitive | SketchParam)[] = [...params(120, 40)];
  for (let i = 0; i < 20; i++)
    primitives.push(
      ...rectangle(`r${i}-`, { x: (i % 5) * 200, y: Math.floor(i / 5) * 100 }),
    );
  wrapper.push_primitives_and_params(primitives);
  wrapper.solve();
  wrapper.apply_solution();
  // Dragging edits one variable and re-solves; measure the steady state.
  const times: number[] = [];
  for (let i = 0; i < 30; i++) {
    wrapper.set_sketch_param("width", 120 + i);
    const started = performance.now();
    wrapper.solve();
    wrapper.apply_solution();
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)]!;
  t.diagnostic(`median re-solve ${median.toFixed(2)} ms`);
  assert.ok(median < 16, `median re-solve ${median.toFixed(2)} ms`);
  assert.ok(near(point(wrapper, "r19-p1").x, 800 + 149));
});
