// Stable names for the faces a feature creates, so a later feature can refer
// to "the top of the extrude" or "the side made by sketch edge e3" and still
// find it after an upstream dimension changes and the model is rebuilt.
//
// brepjs tracks named faces through booleans (a RoleTable of face hashes per
// feature, carried forward by each operation's evolution record) and resolves
// saved references against it. What it cannot know is what a face *means*:
// its own names for an extrude are positional, so they shift as soon as a
// sketch gains or loses an edge. Here extrude faces are named after the
// sketch edge that sweeps them instead.
import * as b from "brepjs/quick";
import {
  dot,
  length,
  planeFrame,
  sub,
  toLocal,
  type Frame,
  type Vec3,
} from "../document/frames.js";
import type { ProfileCurve } from "../document/profiles.js";

export interface ProfileEdge {
  /** The sketch entity's id: it stays the same when the sketch is edited. */
  readonly id: string;
  readonly from: { readonly x: number; readonly y: number };
  readonly to: { readonly x: number; readonly y: number };
}

type Roles = Map<string, number[]>;
export type RoleTable = ReadonlyMap<
  string,
  ReadonlyMap<string, readonly number[]>
>;

/** Names the faces of a straight extrude along +Z from z = 0: `start` and
 * `end` for the caps, `side:<edge id>` for each wall. A wall matches the
 * profile edge its centre lies on; faces that match nothing are left out
 * rather than guessed. */
export function extrudeRoles(
  shape: b.Shape3D,
  profile: readonly ProfileEdge[],
  tolerance = 1e-6,
): Roles {
  return sweptRoles(
    shape,
    planeFrame("XY"),
    profile.map((edge) => ({
      entity: edge.id,
      kind: "line" as const,
      from: edge.from,
      to: edge.to,
    })),
    tolerance,
  );
}

/** Names the faces of an extrude of sketch curves along the normal of
 * `frame`: `start` for the cap facing against the normal, `end` for the one
 * facing along it, and `side:<entity id>` for the wall each sketch curve
 * sweeps. A wall is matched by a point in the middle of its surface, which
 * lies on the curve that made it; faces that match nothing are left out
 * rather than guessed. */
export function sweptRoles(
  shape: b.Shape3D,
  frame: Frame,
  curves: readonly ProfileCurve[],
  tolerance = 1e-6,
): Roles {
  const roles: Roles = new Map();
  const add = (role: string, face: b.Face) =>
    roles.set(role, [...(roles.get(role) ?? []), b.getHashCode(face)]);
  for (const face of b.getFaces(shape)) {
    const normal = b.normalAt(face) as unknown as Vec3;
    const along = dot(normal, frame.normal);
    if (Math.abs(along) > 1 - 1e-9 && b.faceGeomType(face) === "PLANE") {
      add(along < 0 ? "start" : "end", face);
      continue;
    }
    // Parameters are normalised: 0.5 is the middle of the face's range.
    const [x, y] = toLocal(
      frame,
      b.pointOnSurface(face, 0.5, 0.5) as unknown as Vec3,
    );
    const curve = curves.find((c) => onCurve(c, x, y, tolerance));
    if (curve) add(`side:${curve.entity}`, face);
  }
  return roles;
}

function onCurve(
  curve: ProfileCurve,
  x: number,
  y: number,
  tolerance: number,
): boolean {
  const { from, to } = curve;
  if (curve.kind === "line") {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    if (length === 0) return false;
    const along = ((x - from.x) * dx + (y - from.y) * dy) / length;
    const across = ((x - from.x) * dy - (y - from.y) * dx) / length;
    const slack = tolerance * Math.max(1, length);
    return (
      Math.abs(across) <= slack && along >= -slack && along <= length + slack
    );
  }
  const c = curve.center!;
  const r = Math.hypot(from.x - c.x, from.y - c.y);
  const slack = tolerance * Math.max(1, r);
  if (Math.abs(Math.hypot(x - c.x, y - c.y) - r) > slack) return false;
  if (curve.kind === "circle") return true;
  // Within the arc's sweep, whichever way the loop runs along it.
  const angle = (px: number, py: number) => Math.atan2(py - c.y, px - c.x);
  const turn = (a: number) => (a + 4 * Math.PI) % (2 * Math.PI);
  const [start, end] = curve.clockwise ? [to, from] : [from, to];
  const a0 = angle(start.x, start.y);
  return turn(angle(x, y) - a0) <= turn(angle(end.x, end.y) - a0) + 1e-9;
}

/** Carries names through an operation that reports no evolution (fillet,
 * chamfer and shell on the OCCT kernel): a face that kept its hash keeps
 * its names, and each new face takes the names of the vanished face it
 * replaces, the one of the same kind on the same surface nearest to it.
 * Faces on no earlier surface (the rounds themselves) stay unnamed. */
export function remapRoles(
  table: RoleTable,
  before: b.Shape3D,
  after: b.Shape3D,
): RoleTable {
  const signature = (face: b.Face) => {
    const type = b.faceGeomType(face);
    const normal = b.normalAt(face) as unknown as Vec3;
    const center = b.faceCenter(face) as unknown as Vec3;
    return { type, normal, center, offset: dot(normal, center) };
  };
  const afterFaces = b.getFaces(after);
  const live = new Set(afterFaces.map((face) => b.getHashCode(face)));
  const beforeHashes = new Set(
    b.getFaces(before).map((face) => b.getHashCode(face)),
  );
  const vanished = b
    .getFaces(before)
    .filter((face) => !live.has(b.getHashCode(face)))
    .map((face) => ({ hash: b.getHashCode(face), ...signature(face) }));
  /** Old hash → the new faces that replace it. */
  const successors = new Map<number, number[]>();
  for (const face of afterFaces) {
    const hash = b.getHashCode(face);
    if (beforeHashes.has(hash)) continue;
    const s = signature(face);
    let best: { hash: number; distance: number } | undefined;
    for (const old of vanished) {
      if (old.type !== s.type) continue;
      if (s.type === "PLANE") {
        if (dot(old.normal, s.normal) < 1 - 1e-9) continue;
        if (Math.abs(old.offset - s.offset) > 1e-6) continue;
      }
      const distance = length(sub(old.center, s.center));
      if (!best || distance < best.distance)
        best = { hash: old.hash, distance };
    }
    if (best)
      successors.set(best.hash, [...(successors.get(best.hash) ?? []), hash]);
  }
  const next = new Map<string, ReadonlyMap<string, readonly number[]>>();
  for (const [origin, roles] of table) {
    const mapped = new Map<string, readonly number[]>();
    for (const [role, hashes] of roles) {
      const now = hashes.flatMap((hash) =>
        live.has(hash) ? [hash] : (successors.get(hash) ?? []),
      );
      if (now.length) mapped.set(role, now);
    }
    next.set(origin, mapped);
  }
  return next;
}

/** Copies names onto a transformed copy of a shape (a pattern instance or
 * a mirror image), whose faces come in the same order as the original's.
 * `rename` gives each origin its name in the copy. */
export function copyRoles(
  table: RoleTable,
  original: b.Shape3D,
  copy: b.Shape3D,
  rename: (origin: string) => string = (origin) => origin,
): RoleTable {
  const from = b.getFaces(original);
  const to = b.getFaces(copy);
  if (from.length !== to.length)
    throw new Error("A copied shape has different faces than its original");
  const map = new Map(
    from.map((face, i) => [b.getHashCode(face), b.getHashCode(to[i]!)]),
  );
  const next = new Map<string, ReadonlyMap<string, readonly number[]>>();
  for (const [origin, roles] of table) {
    const mapped = new Map<string, readonly number[]>();
    for (const [role, hashes] of roles) {
      const now = hashes.flatMap((hash) => {
        const moved = map.get(hash);
        return moved === undefined ? [] : [moved];
      });
      if (now.length) mapped.set(role, now);
    }
    next.set(rename(origin), mapped);
  }
  return next;
}

/** The table with one feature's names added. */
export function withRoles(
  table: RoleTable,
  origin: string,
  roles: ReadonlyMap<string, readonly number[]>,
): RoleTable {
  const next = new Map(table);
  next.set(origin, roles);
  return next;
}

/** Carries every feature's names through one operation, so faces an earlier
 * feature named keep their names in the result. */
export function afterOperation(
  table: RoleTable,
  evolution: Parameters<typeof b.updateRoles>[2],
): RoleTable {
  let next = table;
  for (const origin of table.keys())
    next = b.updateRoles(next, origin, evolution);
  return next;
}
