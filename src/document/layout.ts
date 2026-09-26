// Parts placed on a piece of stock, and what is wrong with where they are:
// outside the piece or too close to its edge, overlapping or closer than
// the saw's kerf, leaving a strip too thin to be worth anything, or with
// the grain the wrong way. Pure geometry, so the editor checks live.
import type { Layout, Placement, Point2, StockPiece } from "./schema.js";

export interface LayoutPart {
  readonly id: string;
  readonly name: string;
  /** The blank's outline, in its own coordinates. */
  readonly outline: readonly Point2[];
  readonly quantity: number;
  /** Which blank axis must follow the grain. */
  readonly grain: "x" | "y" | "none";
}

/** The outline moved so its bounding box starts at (0, 0): placements are
 * measured from there. */
export function normalized(outline: readonly Point2[]): Point2[] {
  const x = Math.min(...outline.map((p) => p.x));
  const y = Math.min(...outline.map((p) => p.y));
  return outline.map((p) => ({ x: p.x - x, y: p.y - y }));
}

/** Where a point of a normalized outline lands on the stock. */
export function place(p: Point2, placement: Placement): Point2 {
  const x = placement.flip ? -p.x : p.x;
  const angle = (placement.rotation * Math.PI) / 180;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return {
    x: placement.x + x * c - p.y * s,
    y: placement.y + x * s + p.y * c,
  };
}

export function placedOutline(
  part: LayoutPart,
  placement: Placement,
): Point2[] {
  const points = normalized(part.outline).map((p) => place(p, placement));
  // A flip reverses the winding; keep outlines counter-clockwise.
  return placement.flip ? points.reverse() : points;
}

export type IssueKind =
  | "outside"
  | "margin"
  | "overlap"
  | "kerf"
  | "strip"
  | "grain"
  | "count"
  | "unknown";

export interface LayoutIssue {
  readonly kind: IssueKind;
  /** Indices into the layout's placements. */
  readonly placements: readonly number[];
  readonly message: string;
}

const eps = 1e-6;

export function area(polygon: readonly Point2[]): number {
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

export function inside(p: Point2, polygon: readonly Point2[]): boolean {
  let within = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    )
      within = !within;
  }
  return within;
}

function segmentDistance(p: Point2, a: Point2, b: Point2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  const t = length2
    ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2))
    : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

function crosses(a: Point2, b: Point2, c: Point2, d: Point2): boolean {
  const cross = (o: Point2, p: Point2, q: Point2) =>
    (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return (
    ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) &&
    ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))
  );
}

const edges = (polygon: readonly Point2[]) =>
  polygon.map((p, i) => [p, polygon[(i + 1) % polygon.length]!] as const);

/** Whether two outlines share any area. */
export function overlapping(
  a: readonly Point2[],
  b: readonly Point2[],
): boolean {
  for (const [p, q] of edges(a))
    for (const [r, s] of edges(b)) if (crosses(p, q, r, s)) return true;
  // One inside the other, or identical: test a point well inside each.
  const probe = (polygon: readonly Point2[]) => {
    const c = polygon.reduce(
      (sum, p) => ({
        x: sum.x + p.x / polygon.length,
        y: sum.y + p.y / polygon.length,
      }),
      { x: 0, y: 0 },
    );
    return inside(c, polygon) ? c : polygon[0]!;
  };
  const insideStrictly = (p: Point2, polygon: readonly Point2[]) =>
    inside(p, polygon) &&
    edges(polygon).every(([r, s]) => segmentDistance(p, r, s) > eps);
  return insideStrictly(probe(a), b) || insideStrictly(probe(b), a);
}

/** The shortest distance between two outlines that do not overlap. */
export function gap(a: readonly Point2[], b: readonly Point2[]): number {
  let best = Infinity;
  for (const p of a)
    for (const [r, s] of edges(b))
      best = Math.min(best, segmentDistance(p, r, s));
  for (const p of b)
    for (const [r, s] of edges(a))
      best = Math.min(best, segmentDistance(p, r, s));
  return best;
}

/** How far an outline stays inside a piece: negative when it leaves it. */
function clearance(
  outline: readonly Point2[],
  piece: readonly Point2[],
): number {
  for (const [p, q] of edges(outline))
    for (const [r, s] of edges(piece)) if (crosses(p, q, r, s)) return -1;
  if (outline.some((p) => !inside(p, piece) && gap([p], piece) > eps))
    return -1;
  let best = Infinity;
  for (const p of outline)
    for (const [r, s] of edges(piece))
      best = Math.min(best, segmentDistance(p, r, s));
  // A corner of the piece reaching into the part (a notch in an offcut).
  for (const p of piece)
    if (inside(p, outline) && gap([p], outline) > eps) return -1;
  return best;
}

/** Whether an outline lies on a piece (touching its edge is on it). */
export const within = (outline: readonly Point2[], piece: readonly Point2[]) =>
  clearance(outline, piece) >= 0;

export interface Rectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Up to `count` large rectangles inside a piece, not overlapping each
 * other, largest first: the piece itself when it is a rectangle, the arms
 * of an L-shaped offcut. Corners are taken from the piece's own corners. */
export function rectanglesIn(piece: readonly Point2[], count = 4): Rectangle[] {
  const xs = [...new Set(piece.map((p) => p.x))].sort((a, c) => a - c);
  const ys = [...new Set(piece.map((p) => p.y))].sort((a, c) => a - c);
  const found: Rectangle[] = [];
  const outline = (r: Rectangle) => [
    { x: r.x, y: r.y },
    { x: r.x + r.width, y: r.y },
    { x: r.x + r.width, y: r.y + r.height },
    { x: r.x, y: r.y + r.height },
  ];
  const clear = (a: Rectangle, c: Rectangle) =>
    a.x + a.width <= c.x + eps ||
    c.x + c.width <= a.x + eps ||
    a.y + a.height <= c.y + eps ||
    c.y + c.height <= a.y + eps;
  for (let n = 0; n < count; n++) {
    let best: Rectangle | undefined;
    for (let i = 0; i < xs.length; i++)
      for (let j = i + 1; j < xs.length; j++)
        for (let k = 0; k < ys.length; k++)
          for (let l = k + 1; l < ys.length; l++) {
            const r = {
              x: xs[i]!,
              y: ys[k]!,
              width: xs[j]! - xs[i]!,
              height: ys[l]! - ys[k]!,
            };
            if (best && r.width * r.height <= best.width * best.height)
              continue;
            if (!found.every((f) => clear(f, r))) continue;
            if (within(outline(r), piece)) best = r;
          }
    if (!best) break;
    found.push(best);
  }
  return found;
}

const round = (value: number) => Math.round(value * 100) / 100;

/** Everything wrong with a layout. */
export function checkLayout(
  layout: Layout,
  piece: StockPiece,
  parts: readonly LayoutPart[],
): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  const byId = new Map(parts.map((part) => [part.id, part]));
  const kerf = layout.kerf ?? 0;
  const margin = layout.margin ?? 0;
  const strip = layout.minimumStrip ?? 0;
  const placed: { index: number; part: LayoutPart; outline: Point2[] }[] = [];
  const counts = new Map<string, number>();
  layout.placements.forEach((placement, index) => {
    const part = byId.get(placement.part);
    if (!part) {
      issues.push({
        kind: "unknown",
        placements: [index],
        message: `There is no sheet part ${placement.part} of this material any more`,
      });
      return;
    }
    counts.set(part.id, (counts.get(part.id) ?? 0) + 1);
    placed.push({ index, part, outline: placedOutline(part, placement) });
  });
  for (const [id, count] of counts) {
    const part = byId.get(id)!;
    if (count > part.quantity)
      issues.push({
        kind: "count",
        placements: layout.placements.flatMap((p, i) =>
          p.part === id ? [i] : [],
        ),
        message: `${part.name} is placed ${count} times, but ${part.quantity} are needed`,
      });
  }
  for (const { index, part, outline } of placed) {
    const room = clearance(outline, piece.outline);
    if (room < 0)
      issues.push({
        kind: "outside",
        placements: [index],
        message: `${part.name} is not on the piece`,
      });
    else if (room < margin - eps)
      issues.push({
        kind: "margin",
        placements: [index],
        message: `${part.name} is ${round(room)} mm from the edge; keep ${margin} mm`,
      });
    const grain = piece.grain ?? "none";
    if (grain !== "none" && part.grain !== "none") {
      const placement = layout.placements[index]!;
      const origin = place({ x: 0, y: 0 }, placement);
      const tip = place(
        part.grain === "x" ? { x: 1, y: 0 } : { x: 0, y: 1 },
        placement,
      );
      const along = grain === "x" ? tip.x - origin.x : tip.y - origin.y;
      if (Math.abs(Math.abs(along) - 1) > 1e-6)
        issues.push({
          kind: "grain",
          placements: [index],
          message: `${part.name}'s grain runs across the piece's grain`,
        });
    }
  }
  for (let i = 0; i < placed.length; i++)
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i]!;
      const b = placed[j]!;
      const pair = [a.index, b.index];
      if (overlapping(a.outline, b.outline)) {
        issues.push({
          kind: "overlap",
          placements: pair,
          message: `${a.part.name} and ${b.part.name} overlap`,
        });
        continue;
      }
      const distance = gap(a.outline, b.outline);
      if (distance < kerf - eps)
        issues.push({
          kind: "kerf",
          placements: pair,
          message: `${a.part.name} and ${b.part.name} are ${round(distance)} mm apart; the kerf is ${kerf} mm`,
        });
      else if (distance < strip - eps && distance > kerf + eps)
        issues.push({
          kind: "strip",
          placements: pair,
          message: `Between ${a.part.name} and ${b.part.name} a ${round(distance - kerf)} mm strip is left`,
        });
    }
  return issues;
}

/** Parts of the layout's material still to be placed: their copies not in
 * this or another layout. */
export function unplaced(
  parts: readonly LayoutPart[],
  layouts: readonly Layout[],
): { part: LayoutPart; copies: number }[] {
  const used = new Map<string, number>();
  for (const layout of layouts)
    for (const placement of layout.placements)
      used.set(placement.part, (used.get(placement.part) ?? 0) + 1);
  return parts
    .map((part) => ({ part, copies: part.quantity - (used.get(part.id) ?? 0) }))
    .filter((entry) => entry.copies > 0);
}

/** A rectangle outline, counter-clockwise from (0, 0). */
export const rectangleOutline = (width: number, height: number): Point2[] => [
  { x: 0, y: 0 },
  { x: width, y: 0 },
  { x: width, y: height },
  { x: 0, y: height },
];

/** Reads corners written as x,y pairs ("0,0 800,0 800,400 0,600", one per
 * line, or however separated) into an outline, counter-clockwise. */
export function parseOutline(text: string): Point2[] | string {
  const numbers = (text.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  if (numbers.length % 2)
    return "Write the corners as x,y pairs, e.g. 0,0 800,0 800,400 0,600";
  const outline: Point2[] = [];
  for (let i = 0; i < numbers.length; i += 2)
    outline.push({ x: numbers[i]!, y: numbers[i + 1]! });
  if (outline.length < 3) return "An outline needs at least three corners";
  if (Math.abs(area(outline)) < eps) return "The outline has no area";
  return area(outline) < 0 ? outline.reverse() : outline;
}
