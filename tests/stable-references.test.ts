import { test } from "node:test";
import assert from "node:assert/strict";
import * as b from "brepjs/quick";
import {
  afterOperation,
  extrudeRoles,
  withRoles,
  type ProfileEdge,
  type RoleTable,
} from "../src/kernel/roles.js";

// A feature history is replayed from scratch whenever an upstream value
// changes. These tests build a small part — an extruded plate, a pocket cut
// into its top, a rounded corner — capture references to faces of the first
// build, change the dimensions, rebuild, and check that every reference still
// lands on the face it meant, or reports itself broken.

interface Parameters {
  readonly width: number;
  readonly depth: number;
  readonly height: number;
  /** A notch in the back edge adds three sketch edges and removes one. */
  readonly notch: boolean;
  readonly pocketX: number;
}

function profile(p: Parameters): ProfileEdge[] {
  const { width: w, depth: d } = p;
  const corner = (x: number, y: number) => ({ x, y });
  const edges: ProfileEdge[] = [
    { id: "front", from: corner(0, 0), to: corner(w, 0) },
    { id: "right", from: corner(w, 0), to: corner(w, d) },
  ];
  if (p.notch)
    edges.push(
      { id: "back-a", from: corner(w, d), to: corner(w * 0.6, d) },
      {
        id: "notch-right",
        from: corner(w * 0.6, d),
        to: corner(w * 0.6, d - 10),
      },
      {
        id: "notch-floor",
        from: corner(w * 0.6, d - 10),
        to: corner(w * 0.4, d - 10),
      },
      {
        id: "notch-left",
        from: corner(w * 0.4, d - 10),
        to: corner(w * 0.4, d),
      },
      { id: "back-b", from: corner(w * 0.4, d), to: corner(0, d) },
    );
  else edges.push({ id: "back", from: corner(w, d), to: corner(0, d) });
  edges.push({ id: "left", from: corner(0, d), to: corner(0, 0) });
  return edges;
}

function rebuild(p: Parameters): { shape: b.Shape3D; roles: RoleTable } {
  const edges = profile(p);
  const face = b.unwrap(
    b.polygon(edges.map((edge) => [edge.from.x, edge.from.y, 0] as const)),
  );
  let shape: b.Shape3D = b.unwrap(b.extrude(face, p.height));
  let roles: RoleTable = withRoles(
    new Map(),
    "plate",
    extrudeRoles(shape, edges),
  );
  // A pocket 5 mm deep into the top, named by its own box roles so its floor
  // can be referenced.
  const tool = b.translate(b.box(20, 15, 10), [p.pocketX, 10, p.height - 5]);
  roles = withRoles(roles, "pocket", b.assignRoles(tool, "box"));
  const cut = b.unwrap(b.cutWithEvolution(shape, tool));
  roles = afterOperation(roles, cut.evolution);
  shape = cut.shape;
  return { shape, roles };
}

const first: Parameters = {
  width: 100,
  depth: 60,
  height: 18,
  notch: false,
  pocketX: 20,
};
const edited: Parameters = {
  width: 140,
  depth: 80,
  height: 25,
  notch: true,
  pocketX: 50,
};

const close = (a: readonly number[], expected: readonly number[]) =>
  a.every((value, i) => Math.abs(value - expected[i]!) < 1e-6);

function reference(origin: string, role: string, p: Parameters) {
  const { shape, roles } = rebuild(p);
  const hashes = roles.get(origin)?.get(role);
  assert.ok(hashes?.length, `${origin}/${role} is named in the first build`);
  const face = b.getFaces(shape).find((f) => b.getHashCode(f) === hashes[0]);
  assert.ok(face);
  return b.createRef(origin, role, face);
}

test("an extrude's walls are named after the sketch edges that make them", () => {
  const { roles } = rebuild(first);
  const plate = roles.get("plate")!;
  assert.deepEqual([...plate.keys()].sort(), [
    "end",
    "side:back",
    "side:front",
    "side:left",
    "side:right",
    "start",
  ]);
});

test("a wall reference survives new dimensions and new sketch edges", () => {
  const ref = reference("plate", "side:left", first);
  const { shape, roles } = rebuild(edited);
  const resolved = b.resolveRef(ref, roles, shape);
  assert.ok("face" in resolved, "resolved");
  assert.equal(resolved.confidence, "exact");
  assert.ok(close(b.normalAt(resolved.face), [-1, 0, 0]));
  assert.ok(Math.abs(b.faceCenter(resolved.face)[0]) < 1e-6);
});

test("the top face stays the top after a pocket is cut into it", () => {
  const ref = reference("plate", "end", first);
  const { shape, roles } = rebuild(edited);
  const resolved = b.resolveRef(ref, roles, shape);
  assert.ok("face" in resolved, "resolved");
  assert.ok(close(b.normalAt(resolved.face), [0, 0, 1]));
  assert.ok(Math.abs(b.faceCenter(resolved.face)[2] - edited.height) < 1e-6);
});

test("the pocket floor is found at its new depth and position", () => {
  // The tool box's "bottom" face becomes the pocket's floor: facing up, at
  // height - 5, and inside the pocket's footprint.
  const ref = reference("pocket", "box:bottom", first);
  const { shape, roles } = rebuild(edited);
  const resolved = b.resolveRef(ref, roles, shape);
  assert.ok("face" in resolved, "resolved");
  const [x, , z] = b.faceCenter(resolved.face);
  assert.ok(Math.abs(z - (edited.height - 5)) < 1e-6);
  assert.ok(x > edited.pocketX && x < edited.pocketX + 20);
});

test("a wall whose sketch edge was deleted reports itself broken", () => {
  // "back" no longer exists once the notch replaces it with back-a / back-b.
  const ref = reference("plate", "side:back", first);
  const { shape, roles } = rebuild(edited);
  const resolved = b.resolveRef(ref, roles, shape);
  // A broken reference must not silently land on some other wall. The
  // geometric fallback may still offer a candidate facing the same way; the
  // evaluator treats anything but an exact match as needing a re-pick.
  if ("face" in resolved)
    assert.equal(resolved.confidence, "geometric-fallback");
  else
    assert.ok(["deleted", "not-found", "ambiguous"].includes(resolved.reason));
});

test("a rounded edge's face is found again after the part is rebuilt", () => {
  const round = (p: Parameters) => {
    const { shape, roles } = rebuild(p);
    const faces = b.getFaces(shape);
    const byRole = (role: string) => {
      const hash = roles.get("plate")!.get(role)![0];
      return faces.find((f) => b.getHashCode(f) === hash)!;
    };
    const [edge] = b.sharedEdges(byRole("side:front"), byRole("side:right"));
    assert.ok(edge, "front and right walls meet at an edge");
    // The origin is the feature that named the two walls the round bridges,
    // not a name for the round itself.
    const ref = b.createDerivedFaceRef("plate", "fillet", edge, shape, roles);
    assert.ok(ref);
    const filleted = b.unwrap(
      b.filletWithEvolution(shape as b.ValidSolid, [edge], 5),
    );
    return {
      ref,
      shape: filleted.shape,
      roles: afterOperation(roles, filleted.evolution),
    };
  };
  const { ref } = round(first);
  const again = round(edited);
  const resolved = b.resolveDerivedFaceRef(ref, again.roles, again.shape);
  assert.ok("face" in resolved, "resolved");
  // The round sits on the front-right vertical edge of the edited plate.
  const [x, y] = b.faceCenter(resolved.face);
  assert.ok(x > edited.width - 5 && y < 5);
});
