/** A 2D point in a view's projected model millimetres. */
export type PlanPoint = { u: number; v: number };
/** What the dimension tool picked: a corner or free point, or a whole edge. */
export type PlanPick =
  | { kind: "point"; at: PlanPoint; free?: boolean }
  | { kind: "line"; a: PlanPoint; b: PlanPoint; at: PlanPoint };

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Segments `[x1, y1, x2, y2, …]` without the zero-length pieces and repeats a
 * projection produces: an edge seen end-on collapses to a point, and edges of
 * parts behind each other land on the same line. Drawing them again adds
 * nothing but work for every repaint.
 */
export function uniqueSegments(lines: readonly number[], skip?: Set<string>) {
  const seen = new Set<string>(),
    kept: number[] = [];
  for (let i = 0; i + 3 < lines.length; i += 4) {
    const ax = round(lines[i]!),
      ay = round(lines[i + 1]!),
      bx = round(lines[i + 2]!),
      by = round(lines[i + 3]!);
    if (ax === bx && ay === by) continue;
    const forward = ax < bx || (ax === bx && ay < by);
    const key = forward ? `${ax},${ay},${bx},${by}` : `${bx},${by},${ax},${ay}`;
    if (seen.has(key) || skip?.has(key)) continue;
    seen.add(key);
    kept.push(ax, ay, bx, by);
  }
  return { lines: kept, keys: seen };
}

/**
 * Path data for the segments, split into square tiles of about `tile`
 * millimetres. The browser skips a path whose bounds are off screen, so when
 * the sheet is zoomed in only the few tiles in view are stroked again instead
 * of one path spanning the whole drawing. Joined segments continue the same
 * subpath rather than starting a new one.
 */
export function tiledPaths(lines: readonly number[], tile: number) {
  const tiles = new Map<string, { d: string; x: number; y: number }>();
  const size = tile > 0 ? tile : Infinity;
  for (let i = 0; i + 3 < lines.length; i += 4) {
    let ax = lines[i]!,
      ay = lines[i + 1]!,
      bx = lines[i + 2]!,
      by = lines[i + 3]!;
    const key = `${Math.floor((ax + bx) / 2 / size)}|${Math.floor((ay + by) / 2 / size)}`;
    let entry = tiles.get(key);
    if (!entry) tiles.set(key, (entry = { d: "", x: NaN, y: NaN }));
    if (bx === entry.x && by === entry.y) {
      [ax, bx] = [bx, ax];
      [ay, by] = [by, ay];
    }
    entry.d +=
      ax === entry.x && ay === entry.y
        ? `L${bx},${by}`
        : `M${ax},${ay}L${bx},${by}`;
    entry.x = bx;
    entry.y = by;
  }
  return [...tiles.values()].map((entry) => entry.d);
}

/** The point on the infinite line through `a` and `b` nearest to `p`. */
export function footOnLine(p: PlanPoint, a: PlanPoint, b: PlanPoint) {
  const du = b.u - a.u,
    dv = b.v - a.v,
    length2 = du * du + dv * dv;
  if (length2 < 1e-12) return { ...a };
  const t = ((p.u - a.u) * du + (p.v - a.v) * dv) / length2;
  return { u: a.u + du * t, v: a.v + dv * t };
}

/**
 * The two points a dimension between two picks runs between, or why the
 * picks cannot be measured together. Two points give their distance; a line
 * and a point the perpendicular from the line to the point; two parallel
 * lines the gap between them; the same edge twice its length.
 */
export function pickPair(
  first: PlanPick,
  second: PlanPick,
): { a: PlanPoint; b: PlanPoint } | string {
  let pair: { a: PlanPoint; b: PlanPoint };
  if (first.kind === "point" && second.kind === "point")
    pair = { a: first.at, b: second.at };
  else if (first.kind === "line" && second.kind === "point")
    pair = { a: footOnLine(second.at, first.a, first.b), b: second.at };
  else if (first.kind === "point" && second.kind === "line")
    pair = { a: first.at, b: footOnLine(first.at, second.a, second.b) };
  else if (first.kind === "line" && second.kind === "line") {
    const same = (p: PlanPoint, q: PlanPoint) =>
      Math.hypot(p.u - q.u, p.v - q.v) < 1e-6;
    if (
      (same(first.a, second.a) && same(first.b, second.b)) ||
      (same(first.a, second.b) && same(first.b, second.a))
    )
      pair = { a: first.a, b: first.b };
    else {
      const cross =
        (first.b.u - first.a.u) * (second.b.v - second.a.v) -
        (first.b.v - first.a.v) * (second.b.u - second.a.u);
      const lengths =
        Math.hypot(first.b.u - first.a.u, first.b.v - first.a.v) *
        Math.hypot(second.b.u - second.a.u, second.b.v - second.a.v);
      // About a hundredth of a degree still counts as parallel.
      if (Math.abs(cross) > lengths * 2e-4)
        return "Those edges are not parallel. Pick a point or a parallel edge.";
      pair = { a: footOnLine(second.at, first.a, first.b), b: second.at };
    }
  } else throw new Error("Unknown pick");
  if (Math.hypot(pair.b.u - pair.a.u, pair.b.v - pair.a.v) < 1e-6)
    return "Those targets touch, so there is no distance to dimension.";
  return pair;
}
