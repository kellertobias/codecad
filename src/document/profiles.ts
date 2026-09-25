// Finds the closed regions of a sketch: the areas an extrude can use. A
// rectangle is one region; a rectangle with a line across it is two; a
// circle inside a rectangle makes the rectangle a region with a hole, and
// the circle a region of its own. Construction geometry is ignored.
//
// Lines and arcs form a planar graph: points are its vertices (points at
// the same position are merged) and each curve an edge. Walking every edge
// in both directions, always taking the next edge clockwise, traces each
// face once; bounded faces come out counter-clockwise, and a face that
// comes out clockwise is the outside of a connected group of curves. When
// such a group sits inside another group's face, it is that face's hole.
import type { SketchEntity, SketchFeature } from "./schema.js";

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** One curve of a loop, in the direction the loop runs. */
export interface ProfileCurve {
  readonly entity: string;
  readonly kind: "line" | "arc" | "circle";
  readonly from: Point;
  readonly to: Point;
  /** Arcs and circles. */
  readonly center?: Point;
  /** Arcs: whether this curve runs clockwise, against the arc's own
   * counter-clockwise direction. */
  readonly clockwise?: boolean;
}

export interface Loop {
  readonly curves: readonly ProfileCurve[];
  /** The loop sampled as a polygon (arcs as short chords). */
  readonly polygon: readonly Point[];
  /** Signed: positive when the loop runs counter-clockwise. */
  readonly area: number;
}

export interface Region {
  /** Built from the ids of the curves around it, so it stays the same when
   * the sketch's dimensions change. */
  readonly id: string;
  /** Counter-clockwise. */
  readonly outer: Loop;
  /** Clockwise. */
  readonly holes: readonly Loop[];
  /** Enclosed area, holes subtracted. */
  readonly area: number;
}

export interface Profiles {
  readonly regions: readonly Region[];
  /** Curves with an end that joins nothing, so they bound no region. */
  readonly open: readonly string[];
}

interface Edge {
  readonly entity: SketchEntity & { type: "line" | "arc" };
  readonly from: number;
  readonly to: number;
  /** Positions along the edge from `from` to `to`, at least two. */
  readonly samples: readonly Point[];
  readonly center?: Point;
}

interface HalfEdge {
  readonly edge: Edge;
  readonly forward: boolean;
  readonly origin: number;
  readonly target: number;
  /** Direction it leaves its origin in, as an angle. */
  readonly angle: number;
}

export function detectProfiles(
  sketch: SketchFeature,
  tolerance = 1e-6,
): Profiles {
  const points = new Map<string, Point>();
  for (const entity of sketch.entities)
    if (entity.type === "point") points.set(entity.id, entity);
  const at = (id: string) => {
    const found = points.get(id);
    if (!found) throw new Error(`Point "${id}" is missing`);
    return found;
  };

  // Vertices: one per distinct position.
  const vertices: Point[] = [];
  const vertexOf = (p: Point) => {
    const found = vertices.findIndex(
      (v) =>
        Math.abs(v.x - p.x) <= tolerance && Math.abs(v.y - p.y) <= tolerance,
    );
    if (found >= 0) return found;
    vertices.push(p);
    return vertices.length - 1;
  };

  let edges: Edge[] = [];
  const loops: Loop[] = [];
  for (const entity of sketch.entities) {
    if (entity.construction) continue;
    if (entity.type === "line") {
      const from = at(entity.start);
      const to = at(entity.end);
      edges.push({
        entity,
        from: vertexOf(from),
        to: vertexOf(to),
        samples: [from, to],
      });
    } else if (entity.type === "arc") {
      const center = at(entity.center);
      const start = at(entity.start);
      const end = at(entity.end);
      edges.push({
        entity,
        from: vertexOf(start),
        to: vertexOf(end),
        samples: arcSamples(center, start, end),
        center,
      });
    } else if (entity.type === "circle") {
      // A circle closes on itself: a loop with no vertices to share.
      const center = at(entity.center);
      const start = { x: center.x + entity.radius, y: center.y };
      const polygon = Array.from({ length: 64 }, (_, i) => {
        const a = (i / 64) * 2 * Math.PI;
        return {
          x: center.x + entity.radius * Math.cos(a),
          y: center.y + entity.radius * Math.sin(a),
        };
      });
      loops.push({
        curves: [
          { entity: entity.id, kind: "circle", from: start, to: start, center },
        ],
        polygon,
        area: Math.PI * entity.radius ** 2,
      });
    }
  }

  // A curve ending on the middle of another (a divider drawn up to a wall)
  // splits it there, so both sides can close into regions.
  edges = edges.flatMap((edge) => splitAtVertices(edge, vertices, tolerance));

  // Edges with a free end cannot bound anything: remove them, and whatever
  // they leave dangling, until every remaining end is shared.
  const open: string[] = [];
  for (;;) {
    const degree = new Map<number, number>();
    for (const edge of edges) {
      degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
      degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
    }
    const dangling = edges.filter(
      (edge) =>
        edge.from !== edge.to &&
        (degree.get(edge.from) === 1 || degree.get(edge.to) === 1),
    );
    if (!dangling.length) break;
    open.push(...dangling.map((edge) => edge.entity.id));
    edges = edges.filter((edge) => !dangling.includes(edge));
  }

  // Half-edges, grouped by the vertex they leave, sorted counter-clockwise.
  const outgoing = new Map<number, HalfEdge[]>();
  const halves: HalfEdge[] = [];
  for (const edge of edges)
    for (const forward of [true, false]) {
      const samples = forward ? edge.samples : [...edge.samples].reverse();
      // Leave along the curve itself, not its tangent, so a line and an arc
      // leaving tangentially from one point still sort apart.
      const near = samples[Math.min(1, samples.length - 1)]!;
      const origin = samples[0]!;
      const half: HalfEdge = {
        edge,
        forward,
        origin: forward ? edge.from : edge.to,
        target: forward ? edge.to : edge.from,
        angle: Math.atan2(near.y - origin.y, near.x - origin.x),
      };
      halves.push(half);
      const list = outgoing.get(half.origin) ?? [];
      list.push(half);
      outgoing.set(half.origin, list);
    }
  for (const list of outgoing.values()) list.sort((a, b) => a.angle - b.angle);

  // At the far end of a half-edge, continue with the next edge clockwise
  // from the way back.
  const next = (half: HalfEdge): HalfEdge => {
    const list = outgoing.get(half.target)!;
    const back = list.findIndex(
      (candidate) =>
        candidate.edge === half.edge && candidate.forward !== half.forward,
    );
    return list[(back - 1 + list.length) % list.length]!;
  };
  const visited = new Set<HalfEdge>();
  for (const start of halves) {
    if (visited.has(start)) continue;
    const walk: HalfEdge[] = [];
    let half = start;
    do {
      visited.add(half);
      walk.push(half);
      half = next(half);
    } while (half !== start && walk.length <= halves.length);
    loops.push(loopOf(walk));
  }

  // Counter-clockwise loops are faces. A clockwise loop is the outline of a
  // separate group; inside another face it is a hole in the smallest face
  // around it.
  const faces = loops.filter((loop) => loop.area > 0);
  const outlines = loops.filter((loop) => loop.area < 0);
  const holes = new Map<Loop, Loop[]>(faces.map((face) => [face, []]));
  // Circles are faces and their own outlines.
  for (const loop of loops)
    if (loop.curves[0]?.kind === "circle") outlines.push(reversed(loop));
  for (const outline of outlines) {
    const probe = outline.polygon[0]!;
    const around = faces
      .filter(
        (face) =>
          !sharesCurve(face, outline) &&
          Math.abs(face.area) > Math.abs(outline.area) &&
          contains(face.polygon, probe),
      )
      .sort((a, b) => a.area - b.area)[0];
    if (around) holes.get(around)!.push(outline);
  }
  const regions = faces
    .map((outer): Region => {
      const inner = holes.get(outer)!;
      return {
        id: [...new Set(outer.curves.map((curve) => curve.entity))]
          .sort()
          .join("+"),
        outer,
        holes: inner,
        area: outer.area + inner.reduce((sum, hole) => sum + hole.area, 0),
      };
    })
    .sort((a, b) => b.area - a.area);
  return { regions, open };
}

/** The edge in pieces, cut wherever a vertex lies on it between its ends. */
function splitAtVertices(
  edge: Edge,
  vertices: readonly Point[],
  tolerance: number,
): Edge[] {
  // Where along the sampled edge each vertex lies, as sample index plus
  // fraction of the following segment.
  const cuts: { vertex: number; position: number; point: Point }[] = [];
  vertices.forEach((vertex, index) => {
    if (index === edge.from || index === edge.to) return;
    for (let i = 0; i < edge.samples.length - 1; i++) {
      const a = edge.samples[i]!;
      const b = edge.samples[i + 1]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length2 = dx * dx + dy * dy;
      if (!length2) continue;
      const t = ((vertex.x - a.x) * dx + (vertex.y - a.y) * dy) / length2;
      if (t < 0 || t > 1) continue;
      const off = Math.hypot(a.x + t * dx - vertex.x, a.y + t * dy - vertex.y);
      // Arcs are sampled as chords; allow for the chord's sag.
      const allowed = edge.center
        ? tolerance + Math.sqrt(length2) * 0.02
        : tolerance;
      if (off > allowed) continue;
      cuts.push({ vertex: index, position: i + t, point: vertex });
      return;
    }
  });
  if (!cuts.length) return [edge];
  cuts.sort((a, b) => a.position - b.position);
  const pieces: Edge[] = [];
  let from = edge.from;
  let samples: Point[] = [edge.samples[0]!];
  let next = 1;
  for (const cut of cuts) {
    while (next <= Math.floor(cut.position) && next < edge.samples.length - 1)
      samples.push(edge.samples[next++]!);
    samples.push(cut.point);
    pieces.push({ ...edge, from, to: cut.vertex, samples });
    from = cut.vertex;
    samples = [cut.point];
  }
  samples.push(...edge.samples.slice(next));
  pieces.push({ ...edge, from, samples });
  return pieces;
}

function loopOf(walk: readonly HalfEdge[]): Loop {
  const curves: ProfileCurve[] = [];
  const polygon: Point[] = [];
  for (const half of walk) {
    const samples = half.forward
      ? half.edge.samples
      : [...half.edge.samples].reverse();
    polygon.push(...samples.slice(0, -1));
    const kind = half.edge.entity.type;
    curves.push({
      entity: half.edge.entity.id,
      kind,
      from: samples[0]!,
      to: samples[samples.length - 1]!,
      ...(half.edge.center
        ? { center: half.edge.center, clockwise: !half.forward }
        : {}),
    });
  }
  return { curves, polygon, area: signedArea(polygon) };
}

function reversed(loop: Loop): Loop {
  return {
    curves: [...loop.curves].reverse(),
    polygon: [...loop.polygon].reverse(),
    area: -loop.area,
  };
}

const sharesCurve = (a: Loop, b: Loop) =>
  a.curves.some((curve) =>
    b.curves.some((other) => other.entity === curve.entity),
  );

/** Points along a counter-clockwise arc, about every 3°. */
function arcSamples(center: Point, start: Point, end: Point): Point[] {
  const radius = Math.hypot(start.x - center.x, start.y - center.y);
  const from = Math.atan2(start.y - center.y, start.x - center.x);
  let to = Math.atan2(end.y - center.y, end.x - center.x);
  while (to <= from) to += 2 * Math.PI;
  const steps = Math.max(2, Math.ceil((to - from) / (Math.PI / 60)));
  const samples: Point[] = [start];
  for (let i = 1; i < steps; i++) {
    const a = from + ((to - from) * i) / steps;
    samples.push({
      x: center.x + radius * Math.cos(a),
      y: center.y + radius * Math.sin(a),
    });
  }
  samples.push(end);
  return samples;
}

function signedArea(polygon: readonly Point[]): number {
  let twice = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    twice += a.x * b.y - b.x * a.y;
  }
  return twice / 2;
}

/** Even-odd point in polygon test. */
function contains(polygon: readonly Point[], point: Point): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
}
