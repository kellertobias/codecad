// Screen-side geometry for the sketch canvas: the view transform, hit
// testing and snapping. World coordinates are sketch millimetres with y up;
// screen coordinates are canvas pixels with y down.
import type {
  SketchEntity,
  SketchFeature,
} from "../../../src/document/schema.ts";

export interface View {
  /** Pixels per millimetre. */
  readonly scale: number;
  /** World point at the centre of the canvas. */
  readonly cx: number;
  readonly cy: number;
  readonly width: number;
  readonly height: number;
}

export interface Vec {
  readonly x: number;
  readonly y: number;
}

export const toScreen = (view: View, p: Vec): Vec => ({
  x: view.width / 2 + (p.x - view.cx) * view.scale,
  y: view.height / 2 - (p.y - view.cy) * view.scale,
});
export const toWorld = (view: View, p: Vec): Vec => ({
  x: view.cx + (p.x - view.width / 2) / view.scale,
  y: view.cy - (p.y - view.height / 2) / view.scale,
});

/** A round grid step about `pixels` wide at this zoom: 1, 2, 5, 10, 20… */
export function gridStep(view: View, pixels: number): number {
  const raw = pixels / view.scale;
  const power = 10 ** Math.floor(Math.log10(raw));
  for (const factor of [1, 2, 5, 10])
    if (power * factor >= raw) return power * factor;
  return power * 10;
}

export function pointsOf(sketch: SketchFeature): Map<string, Vec> {
  const points = new Map<string, Vec>();
  for (const e of sketch.entities) if (e.type === "point") points.set(e.id, e);
  return points;
}

/** Distance in world units from `p` to a curve. */
export function distanceToCurve(
  entity: SketchEntity,
  points: ReadonlyMap<string, Vec>,
  p: Vec,
): number {
  if (entity.type === "line") {
    const a = points.get(entity.start)!;
    const b = points.get(entity.end)!;
    return distanceToSegment(p, a, b);
  }
  if (entity.type === "circle") {
    const c = points.get(entity.center)!;
    return Math.abs(Math.hypot(p.x - c.x, p.y - c.y) - entity.radius);
  }
  if (entity.type === "arc") {
    const c = points.get(entity.center)!;
    const s = points.get(entity.start)!;
    const e = points.get(entity.end)!;
    if (withinArc(c, s, e, p)) {
      const r = Math.hypot(s.x - c.x, s.y - c.y);
      return Math.abs(Math.hypot(p.x - c.x, p.y - c.y) - r);
    }
    return Math.min(
      Math.hypot(p.x - s.x, p.y - s.y),
      Math.hypot(p.x - e.x, p.y - e.y),
    );
  }
  return Infinity;
}

export function distanceToSegment(p: Vec, a: Vec, b: Vec): number {
  const q = projectOnSegment(p, a, b);
  return Math.hypot(p.x - q.x, p.y - q.y);
}

export function projectOnSegment(p: Vec, a: Vec, b: Vec): Vec {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy || 1;
  const t = Math.max(
    0,
    Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2),
  );
  return { x: a.x + t * dx, y: a.y + t * dy };
}

/** Whether `p`'s direction from the centre lies within the arc's sweep
 * (counter-clockwise from start to end). */
export function withinArc(c: Vec, s: Vec, e: Vec, p: Vec): boolean {
  const angle = (v: Vec) => Math.atan2(v.y - c.y, v.x - c.x);
  const from = angle(s);
  const span = (angle(e) - from + 4 * Math.PI) % (2 * Math.PI);
  const at = (angle(p) - from + 4 * Math.PI) % (2 * Math.PI);
  return at <= span;
}

/** The nearest point on a curve to `p`. */
export function projectOnCurve(
  entity: SketchEntity,
  points: ReadonlyMap<string, Vec>,
  p: Vec,
): Vec {
  if (entity.type === "line")
    return projectOnSegment(
      p,
      points.get(entity.start)!,
      points.get(entity.end)!,
    );
  const c = points.get(entity.type === "point" ? entity.id : entity.center)!;
  const r =
    entity.type === "circle"
      ? entity.radius
      : entity.type === "arc"
        ? Math.hypot(
            points.get(entity.start)!.x - c.x,
            points.get(entity.start)!.y - c.y,
          )
        : 0;
  const d = Math.hypot(p.x - c.x, p.y - c.y) || 1;
  return { x: c.x + ((p.x - c.x) * r) / d, y: c.y + ((p.y - c.y) * r) / d };
}

/** What the pointer is over: a point, then a curve, within a few pixels. */
export function hitTest(
  sketch: SketchFeature,
  view: View,
  world: Vec,
  radius = 7,
): SketchEntity | undefined {
  const points = pointsOf(sketch);
  const reach = radius / view.scale;
  let best: { entity: SketchEntity; distance: number } | undefined;
  for (const entity of sketch.entities) {
    if (entity.type !== "point") continue;
    const d = Math.hypot(world.x - entity.x, world.y - entity.y);
    if (d <= reach && (!best || d < best.distance))
      best = { entity, distance: d };
  }
  if (best) return best.entity;
  for (const entity of sketch.entities) {
    if (entity.type === "point") continue;
    const d = distanceToCurve(entity, points, world);
    if (d <= reach && (!best || d < best.distance))
      best = { entity, distance: d };
  }
  return best?.entity;
}

/** Where a click lands when placing geometry: on an existing point, on a
 * curve, or on the grid. */
export type Snap =
  | { readonly kind: "point"; readonly id: string; readonly at: Vec }
  | { readonly kind: "curve"; readonly id: string; readonly at: Vec }
  | { readonly kind: "free"; readonly at: Vec };

export function snap(
  sketch: SketchFeature,
  view: View,
  world: Vec,
  /** Edges of the face the sketch is on, as x1, y1, x2, y2 runs: their
   * ends and lines are snapped to, as positions. */
  reference?: Float32Array,
): Snap {
  const target = hitTest(sketch, view, world, 9);
  if (target?.type === "point")
    return { kind: "point", id: target.id, at: target };
  if (target)
    return {
      kind: "curve",
      id: target.id,
      at: projectOnCurve(target, pointsOf(sketch), world),
    };
  if (reference?.length) {
    const reach = 9 / view.scale;
    let best: { at: Vec; distance: number; end: boolean } | undefined;
    for (let i = 0; i < reference.length; i += 4) {
      const a = { x: reference[i]!, y: reference[i + 1]! };
      const b = { x: reference[i + 2]!, y: reference[i + 3]! };
      for (const end of [a, b]) {
        const d = Math.hypot(world.x - end.x, world.y - end.y);
        if (d <= reach && (!best?.end || d < best.distance))
          best = { at: end, distance: d, end: true };
      }
      if (best?.end) continue;
      const on = projectOnSegment(world, a, b);
      const d = Math.hypot(world.x - on.x, world.y - on.y);
      if (d <= reach && (!best || d < best.distance))
        best = { at: on, distance: d, end: false };
    }
    if (best) return { kind: "free", at: best.at };
  }
  const step = gridStep(view, 8);
  return {
    kind: "free",
    at: {
      x: Math.round(world.x / step) * step,
      y: Math.round(world.y / step) * step,
    },
  };
}

/** SVG path data for a counter-clockwise arc, drawn on screen. */
export function arcPath(view: View, c: Vec, s: Vec, e: Vec): string {
  const r = Math.hypot(s.x - c.x, s.y - c.y) * view.scale;
  const from = toScreen(view, s);
  const to = toScreen(view, e);
  const span =
    (Math.atan2(e.y - c.y, e.x - c.x) -
      Math.atan2(s.y - c.y, s.x - c.x) +
      4 * Math.PI) %
    (2 * Math.PI);
  // World counter-clockwise is screen clockwise (y flips): sweep flag 0.
  return `M ${from.x} ${from.y} A ${r} ${r} 0 ${span > Math.PI ? 1 : 0} 0 ${to.x} ${to.y}`;
}

/** A view that shows every point of the sketch, with a margin. */
export function fit(
  sketch: SketchFeature,
  width: number,
  height: number,
  reference?: Float32Array,
): View {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < (reference?.length ?? 0); i += 2) {
    xs.push(reference![i]!);
    ys.push(reference![i + 1]!);
  }
  for (const e of sketch.entities) {
    if (e.type === "point") {
      xs.push(e.x);
      ys.push(e.y);
    }
  }
  const points = pointsOf(sketch);
  for (const e of sketch.entities)
    if (e.type === "circle") {
      const c = points.get(e.center)!;
      xs.push(c.x - e.radius, c.x + e.radius);
      ys.push(c.y - e.radius, c.y + e.radius);
    }
  if (!xs.length) return { scale: 1, cx: 0, cy: 0, width, height };
  const [minX, maxX, minY, maxY] = [
    Math.min(...xs),
    Math.max(...xs),
    Math.min(...ys),
    Math.max(...ys),
  ];
  const scale = Math.max(
    0.001,
    Math.min(
      (width * 0.8) / Math.max(maxX - minX, 1),
      (height * 0.8) / Math.max(maxY - minY, 1),
      20,
    ),
  );
  return { scale, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, width, height };
}

/** A sketch's curves (not its construction geometry) as short straight
 * segments, x1, y1, x2, y2 runs, for drawing it in 3D. */
export function sketchSegments(sketch: SketchFeature): Float32Array {
  const points = pointsOf(sketch);
  const out: number[] = [];
  const arc = (c: Vec, r: number, from: number, sweep: number) => {
    const steps = Math.max(8, Math.ceil((Math.abs(sweep) / Math.PI) * 24));
    for (let i = 0; i < steps; i++) {
      const a = from + (sweep * i) / steps;
      const b = from + (sweep * (i + 1)) / steps;
      out.push(
        c.x + r * Math.cos(a),
        c.y + r * Math.sin(a),
        c.x + r * Math.cos(b),
        c.y + r * Math.sin(b),
      );
    }
  };
  for (const e of sketch.entities) {
    if (e.type === "point" || e.construction) continue;
    if (e.type === "line") {
      const a = points.get(e.start)!;
      const b = points.get(e.end)!;
      out.push(a.x, a.y, b.x, b.y);
    } else if (e.type === "circle")
      arc(points.get(e.center)!, e.radius, 0, 2 * Math.PI);
    else {
      const c = points.get(e.center)!;
      const s = points.get(e.start)!;
      const t = points.get(e.end)!;
      const from = Math.atan2(s.y - c.y, s.x - c.x);
      const sweep =
        (Math.atan2(t.y - c.y, t.x - c.x) - from + 4 * Math.PI) % (2 * Math.PI);
      arc(c, Math.hypot(s.x - c.x, s.y - c.y), from, sweep);
    }
  }
  return new Float32Array(out);
}
