// True-shape nesting: parts placed by their real outlines, not their
// bounding rectangles, so L-shaped and angled parts interlock and offcuts
// of any outline are filled. A bottom-left fill: each part (largest first)
// goes to the lowest, then leftmost, position where it touches the piece's
// edge or another part (at the margin or kerf) without breaking any rule
// the layout checks: on the piece, clear of the edge by the margin, apart
// from every other part by the kerf, grain the right way.
import type { Layout, Placement, Point2, StockPiece } from "./schema.js";
import {
  area,
  clearance,
  gap,
  overlapping,
  placedOutline,
  unplaced,
  type LayoutPart,
} from "./layout.js";

const eps = 1e-6;

interface Box {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}
const boxOf = (points: readonly Point2[]): Box => ({
  minX: Math.min(...points.map((p) => p.x)),
  minY: Math.min(...points.map((p) => p.y)),
  maxX: Math.max(...points.map((p) => p.x)),
  maxY: Math.max(...points.map((p) => p.y)),
});

/** At most `count` of a polygon's points, spread along it: candidate
 * positions come from them, so sampled curves do not explode the search. */
const sample = (points: readonly Point2[], count = 24) =>
  points.length <= count
    ? points
    : Array.from(
        { length: count },
        (_, i) => points[Math.floor((i * points.length) / count)]!,
      );

/** Turns that keep a part's grain along the piece's. */
function rotations(part: LayoutPart, piece: StockPiece): number[] {
  const grain = piece.grain ?? "none";
  if (grain === "none" || part.grain === "none") return [0, 90, 180, 270];
  return part.grain === grain ? [0, 180] : [90, 270];
}

export function shapeNest(
  layout: Layout,
  piece: StockPiece,
  parts: readonly LayoutPart[],
  others: readonly Layout[],
  options: { readonly deadline?: number } = {},
): { placements: Placement[]; left: string[] } {
  const kerf = layout.kerf ?? 0;
  const margin = layout.margin ?? 0;
  const stock = piece.outline;
  const stockBox = boxOf(stock);
  const deadline = options.deadline ?? Date.now() + 10_000;

  // Every copy still to place, largest first.
  const todo = unplaced(parts, others)
    .flatMap(({ part, copies }) => Array.from({ length: copies }, () => part))
    .sort((a, b) => Math.abs(area(b.outline)) - Math.abs(area(a.outline)));

  const placed: { outline: Point2[]; box: Box }[] = [];
  const placements: Placement[] = [];
  // Copies other layouts hold already keep their numbers.
  const copies = new Map<string, number>();
  for (const other of others)
    for (const p of other.placements)
      copies.set(p.part, (copies.get(p.part) ?? 0) + 1);
  const left = new Map<string, number>();

  const fits = (outline: Point2[], box: Box) => {
    if (
      box.minX < stockBox.minX + margin - eps ||
      box.minY < stockBox.minY + margin - eps ||
      box.maxX > stockBox.maxX - margin + eps ||
      box.maxY > stockBox.maxY - margin + eps
    )
      return false;
    if (clearance(outline, stock) < margin - eps) return false;
    for (const other of placed) {
      if (
        box.maxX + kerf < other.box.minX - eps ||
        other.box.maxX + kerf < box.minX - eps ||
        box.maxY + kerf < other.box.minY - eps ||
        other.box.maxY + kerf < box.minY - eps
      )
        continue;
      if (overlapping(outline, other.outline)) return false;
      if (gap(outline, other.outline) < kerf - eps) return false;
    }
    return true;
  };

  for (const part of todo) {
    let best:
      | { x: number; y: number; rotation: number; outline: Point2[]; box: Box }
      | undefined;
    for (const rotation of rotations(part, piece)) {
      if (Date.now() > deadline) break;
      const shape = placedOutline(part, {
        part: part.id,
        x: 0,
        y: 0,
        rotation,
      });
      const shapeBox = boxOf(shape);
      const own = sample(shape);
      // Positions where one of the part's corners meets a corner of the
      // piece or of a placed part, kept at the margin or kerf.
      const candidates = new Map<string, { x: number; y: number }>();
      const add = (x: number, y: number) => {
        const key = `${Math.round(x * 100)},${Math.round(y * 100)}`;
        if (!candidates.has(key)) candidates.set(key, { x, y });
      };
      const nudges = (d: number) => [
        [d, d],
        [d, -d],
        [-d, d],
        [-d, -d],
        [d, 0],
        [-d, 0],
        [0, d],
        [0, -d],
      ];
      for (const s of sample(stock, 64))
        for (const q of own)
          for (const [dx, dy] of nudges(margin))
            add(s.x - q.x + dx!, s.y - q.y + dy!);
      for (const other of placed)
        for (const v of sample(other.outline))
          for (const q of own)
            for (const [dx, dy] of nudges(kerf))
              add(v.x - q.x + dx!, v.y - q.y + dy!);
      // Skyline positions: beside and above what is placed already.
      const xs = [
        stockBox.minX + margin,
        ...placed.map((p) => p.box.maxX + kerf),
      ];
      const ys = [
        stockBox.minY + margin,
        ...placed.map((p) => p.box.maxY + kerf),
      ];
      for (const x of xs)
        for (const y of ys) add(x - shapeBox.minX, y - shapeBox.minY);

      const ordered = [...candidates.values()].sort(
        (a, b) => a.y + shapeBox.minY - (b.y + shapeBox.minY) || a.x - b.x,
      );
      for (const at of ordered) {
        const box = {
          minX: shapeBox.minX + at.x,
          minY: shapeBox.minY + at.y,
          maxX: shapeBox.maxX + at.x,
          maxY: shapeBox.maxY + at.y,
        };
        // Worse than the best already found: stop looking.
        if (
          best &&
          (box.minY > best.box.minY + eps ||
            (Math.abs(box.minY - best.box.minY) <= eps &&
              box.minX >= best.box.minX - eps))
        )
          break;
        const outline = shape.map((p) => ({ x: p.x + at.x, y: p.y + at.y }));
        if (!fits(outline, box)) continue;
        best = { x: at.x, y: at.y, rotation, outline, box };
        break;
      }
    }
    if (!best) {
      left.set(part.name, (left.get(part.name) ?? 0) + 1);
      continue;
    }
    placed.push({ outline: best.outline, box: best.box });
    const copy = copies.get(part.id) ?? 0;
    copies.set(part.id, copy + 1);
    placements.push({
      part: part.id,
      copy,
      x: Math.round(best.x * 1e6) / 1e6,
      y: Math.round(best.y * 1e6) / 1e6,
      rotation: best.rotation,
    });
  }
  return {
    placements,
    left: [...left].map(([name, n]) => `${name}${n > 1 ? ` ×${n}` : ""}`),
  };
}
