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
  const roles: Roles = new Map();
  const add = (role: string, face: b.Face) =>
    roles.set(role, [...(roles.get(role) ?? []), b.getHashCode(face)]);
  for (const face of b.getFaces(shape)) {
    const normal = b.normalAt(face);
    const [x, y] = b.faceCenter(face);
    if (Math.abs(normal[2]) > 1 - 1e-9) {
      add(normal[2] < 0 ? "start" : "end", face);
      continue;
    }
    const edge = profile.find((candidate) => {
      const dx = candidate.to.x - candidate.from.x;
      const dy = candidate.to.y - candidate.from.y;
      const length = Math.hypot(dx, dy);
      if (length === 0) return false;
      const along =
        ((x - candidate.from.x) * dx + (y - candidate.from.y) * dy) / length;
      const across =
        ((x - candidate.from.x) * dy - (y - candidate.from.y) * dx) / length;
      return (
        Math.abs(across) <= tolerance * Math.max(1, length) &&
        along >= -tolerance &&
        along <= length + tolerance
      );
    });
    if (edge) add(`side:${edge.id}`, face);
  }
  return roles;
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
