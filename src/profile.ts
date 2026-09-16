import * as b from "brepjs/quick";
import type { Point2 } from "./model.js";

/** @internal Reconstruct runs of >=5 co-circular samples. Straight segments remain exact.
 * This is opt-in and bounded by the caller's radial fitting tolerance. */
export function profileFace(
  points: Point2[],
  tolerance: number,
) {
  const ps = [...points, points[0]!],
    edges: b.Edge[] = [];
  const vec = (p: Point2): [number, number, number] => [p.x, p.y, 0];
  try {
    for (let i = 0; i < points.length;) {
      let end = i + 1;
      if (i + 4 < ps.length) {
        const a = ps[i]!,
          c = ps[i + 1]!,
          d = ps[i + 2]!;
        const ux = c.x - a.x,
          uy = c.y - a.y,
          vx = d.x - a.x,
          vy = d.y - a.y;
        const det = 2 * (ux * vy - uy * vx);
        if (Math.abs(det) > 1e-9) {
          const u2 = ux * ux + uy * uy,
            v2 = vx * vx + vy * vy;
          const cx = a.x + (u2 * vy - v2 * uy) / det,
            cy = a.y + (ux * v2 - vx * u2) / det;
          const radius = Math.hypot(a.x - cx, a.y - cy);
          let j = i + 3;
          for (; j < ps.length; j++) {
            const p = ps[j]!;
            if (
              Math.abs(Math.hypot(p.x - cx, p.y - cy) - radius) > tolerance ||
              Math.hypot(p.x - a.x, p.y - a.y) < tolerance
            )
              break;
          }
          if (j - i >= 5) end = j - 1;
        }
      }
      edges.push(
        end > i + 1
          ? b.threePointArc(
              vec(ps[i]!),
              vec(ps[Math.floor((i + end) / 2)]!),
              vec(ps[end]!),
            )
          : b.line(vec(ps[i]!), vec(ps[end]!)),
      );
      i = end;
    }
    const wire = b.unwrap(b.wireLoop(edges));
    try {
      const planar = b.unwrap(b.planarWire(wire));
      return b.unwrap(b.face(planar as typeof planar & typeof wire));
    } finally {
      wire[Symbol.dispose]();
    }
  } finally {
    for (const edge of edges) edge[Symbol.dispose]();
  }
}
