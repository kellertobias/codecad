import { SheetMaterial, SheetPart } from "./stock.js";

/**
 * Rectangular sheet nesting for a panel saw.
 *
 * Every layout is a guillotine cut tree: each cut runs edge to edge across
 * the piece it divides, so the plan can be sawn straight off the sheet. The
 * tree is what the cut sequence, the placed blanks and the off-cuts are read
 * from, so the three always agree.
 *
 * Several packing strategies are run and the best complete result is kept:
 * the fewest sheets first, then the largest single off-cut on each sheet,
 * then the most reusable off-cut area, then the fewest pieces and cuts.
 * The strip packer lays parts of the same height side by side in a strip, so
 * the leftover above them stays one wide piece instead of a comb of slivers;
 * the best-fit packer places each blank into the free piece it fits most
 * snugly, splitting so the larger remnant stays whole. Ties between
 * strategies are broken by their fixed order, so the result is deterministic.
 */

export interface NestedPart {
  part: SheetPart;
  copy: number;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
}
export interface SheetLayout {
  material: SheetMaterial;
  number: number;
  parts: NestedPart[];
  cuts: SheetCut[];
  /** Free pieces worth keeping: at least `minimumOffcut` in both directions. */
  offcuts: SheetOffcut[];
  usedArea: number;
  offcutArea: number;
  /** Margins, kerf, spacing and pieces too small to keep. */
  wasteArea: number;
}
export interface SheetOffcut {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface SheetCut {
  sequence: number;
  /** The piece the cut divides: `stock` for the whole sheet, then the piece's
   * id, which names the side of every cut that produced it (L/R, T/B). */
  source: string;
  /** `x` cuts run at a constant X (a rip along Y); `y` cuts at a constant Y. */
  axis: "x" | "y";
  at: number;
  from: number;
  to: number;
  kerf: number;
}

const EPS = 1e-6;
/** Free pieces narrower than this in either direction count as waste, not
 * off-cuts, unless the material states its own `minimumOffcut`. */
export const DEFAULT_MINIMUM_OFFCUT = 30;

export function outlineBounds(part: SheetPart) {
  const p = part.manufacturingOutline.points;
  const x = Math.min(...p.map((v) => v.x)),
    y = Math.min(...p.map((v) => v.y));
  return {
    x,
    y,
    width: Math.max(...p.map((v) => v.x)) - x,
    height: Math.max(...p.map((v) => v.y)) - y,
  };
}

type Rotation = 0 | 90 | 180 | 270;
type Axis = "x" | "y";
interface Orient {
  rotation: Rotation;
  w: number;
  h: number;
}
interface Entry {
  part: SheetPart;
  copy: number;
  orients: Orient[];
  area: number;
  long: number;
  short: number;
}
/** A piece of stock: free, holding one blank, or divided by a cut. */
interface Node {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  placed?: { entry: Entry; rotation: Rotation };
  split?: { axis: Axis; at: number; first: Node; second?: Node };
}
interface Stock {
  material: SheetMaterial;
  margin: number;
  gap: number;
  w: number;
  h: number;
  minimumOffcut: number;
}

const other = (axis: Axis): Axis => (axis === "x" ? "y" : "x");
const extent = (node: { w: number; h: number }, axis: Axis) =>
  axis === "x" ? node.w : node.h;

/** Cut `size` off the start of `node` along `axis`. The piece keeps the exact
 * size; what remains beyond the kerf becomes the rest, or nothing when the
 * cut only trims a sliver. No cut is made when the node is already the size. */
function carve(
  node: Node,
  axis: Axis,
  size: number,
  gap: number,
): { piece: Node; rest?: Node } {
  const whole = extent(node, axis);
  if (whole - size <= EPS) return { piece: node };
  const piece: Node = {
    id: node.id + (axis === "x" ? "L" : "T"),
    x: node.x,
    y: node.y,
    w: axis === "x" ? size : node.w,
    h: axis === "y" ? size : node.h,
  };
  const remaining = whole - size - gap;
  const rest: Node | undefined =
    remaining > EPS
      ? {
          id: node.id + (axis === "x" ? "R" : "B"),
          x: axis === "x" ? node.x + size + gap : node.x,
          y: axis === "y" ? node.y + size + gap : node.y,
          w: axis === "x" ? remaining : node.w,
          h: axis === "y" ? remaining : node.h,
        }
      : undefined;
  node.split = {
    axis,
    at: (axis === "x" ? node.x : node.y) + size,
    first: piece,
    ...(rest ? { second: rest } : {}),
  };
  return { piece, ...(rest ? { rest } : {}) };
}
function leaves(node: Node, out: Node[] = []): Node[] {
  if (node.split) {
    leaves(node.split.first, out);
    if (node.split.second) leaves(node.split.second, out);
  } else out.push(node);
  return out;
}
function newSheet(stock: Stock): Node {
  return {
    id: "stock",
    x: stock.margin,
    y: stock.margin,
    w: stock.w,
    h: stock.h,
  };
}

/* ---------------------------------------------------------------- entries */

function entriesFor(
  material: SheetMaterial,
  parts: readonly SheetPart[],
  stock: Stock,
): Entry[] {
  const grain = material.options.grain ?? "none";
  const allowed = material.options.rotations ?? [0, 90];
  return parts
    .filter((p) => p.material === material)
    .flatMap((part) => {
      const size = outlineBounds(part);
      const orients: Orient[] = [];
      for (const rotation of new Set(allowed)) {
        const upright =
          grain === "none" ||
          part.grain === "none" ||
          (grain === part.grain) === (rotation % 180 === 0);
        if (!upright) continue;
        const w = rotation % 180 === 0 ? size.width : size.height,
          h = rotation % 180 === 0 ? size.height : size.width;
        if (w > stock.w + EPS || h > stock.h + EPS) continue;
        if (!orients.some((o) => o.w === w && o.h === h))
          orients.push({ rotation, w, h });
      }
      if (!orients.length)
        throw new Error(
          `Part ${part.path} does not fit stock ${material.name} with its grain/rotation constraints`,
        );
      const entry = {
        part,
        orients,
        area: size.width * size.height,
        long: Math.max(size.width, size.height),
        short: Math.min(size.width, size.height),
      };
      return Array.from({ length: part.quantity }, (_, copy) => ({
        ...entry,
        copy,
      }));
    });
}
type Sort = "across" | "area" | "long" | "short";
type Pref = "flat" | "tall" | "free";
/** The side the strip packer will run across the strips, under a preference:
 * flat strips take the shorter side, tall ones the longer. */
function acrossOf(entry: Entry, axis: Axis, pref: Pref) {
  const sides = entry.orients.map((o) => extent(o, other(axis)));
  return pref === "tall" ? Math.max(...sides) : Math.min(...sides);
}
function sorted(entries: Entry[], sort: Sort, axis: Axis, pref: Pref) {
  const key = (e: Entry): [number, number] => {
    switch (sort) {
      case "across": {
        const across = acrossOf(e, axis, pref);
        return [across, e.area / across];
      }
      case "area":
        return [e.area, e.long];
      case "long":
        return [e.long, e.short];
      case "short":
        return [e.short, e.long];
    }
  };
  return [...entries].sort((a, b) => {
    const ka = key(a),
      kb = key(b);
    return (
      kb[0] - ka[0] ||
      kb[1] - ka[1] ||
      a.part.path.localeCompare(b.part.path) ||
      a.copy - b.copy
    );
  });
}

/* ----------------------------------------------------------- strip packer */

/** A region is packed with strips stacked across it; each strip holds groups
 * of blanks with the same height, side by side. What a group leaves above
 * its blanks is a residual region, packed the same way. */
interface Region {
  along: Axis;
  across: number;
  strips: Strip[];
  /** Fixed for a sheet; a residual is as long as its group. */
  fixedAlong?: number;
  group?: Group;
}
interface Strip {
  region: Region;
  across: number;
  groups: Group[];
}
interface Group {
  strip: Strip;
  across: number;
  parts: { entry: Entry; orient: Orient; along: number }[];
  residual?: Region;
}
interface Candidate {
  cost: number;
  /** Joins a group of blanks with the same height: preferred at equal cost. */
  extend: boolean;
  order: number;
  place: () => void;
}
function preferable(c: Candidate, best: Candidate | undefined) {
  if (!best) return true;
  if (Math.abs(c.cost - best.cost) > EPS) return c.cost < best.cost;
  if (c.extend !== best.extend) return c.extend;
  return c.order < best.order;
}
const sizeKey = (entry: Entry) => `${entry.long}x${entry.short}`;
function groupAlong(group: Group, gap: number) {
  return (
    group.parts.reduce((sum, p) => sum + p.along, 0) +
    gap * (group.parts.length - 1)
  );
}
function regionAlong(region: Region, gap: number): number {
  return region.fixedAlong ?? groupAlong(region.group!, gap);
}
function stripFreeAlong(strip: Strip, gap: number) {
  const used = strip.groups.reduce(
    (sum, g) => sum + groupAlong(g, gap) + gap,
    0,
  );
  return regionAlong(strip.region, gap) - (used ? used : 0);
}
function regionFreeAcross(region: Region, gap: number) {
  const used = region.strips.reduce((sum, s) => sum + s.across + gap, 0);
  return region.across - (used ? used : 0);
}
function packStrips(
  entries: Entry[],
  stock: Stock,
  axis: Axis,
  pref: Pref,
): Node[] {
  const { gap } = stock;
  const sheets: Region[] = [];
  const remaining = new Map<string, number>();
  for (const entry of entries)
    remaining.set(sizeKey(entry), (remaining.get(sizeKey(entry)) ?? 0) + 1);
  const stripOrients = (entry: Entry, newStrip: boolean) => {
    if (!newStrip || pref === "free") return entry.orients;
    const wanted = entry.orients.filter((o) =>
      pref === "flat"
        ? extent(o, other(axis)) <= extent(o, axis) + EPS
        : extent(o, other(axis)) + EPS >= extent(o, axis),
    );
    return wanted.length ? wanted : entry.orients;
  };
  const candidates = (region: Region, entry: Entry, out: Candidate[]) => {
    for (const strip of region.strips) {
      const free = stripFreeAlong(strip, gap);
      const last = strip.groups.at(-1);
      for (const orient of entry.orients) {
        const across = extent(orient, other(axis)),
          along = extent(orient, axis);
        if (across > strip.across + EPS || along > free + EPS) continue;
        const extend =
          last !== undefined && Math.abs(last.across - across) < EPS;
        out.push({
          cost: (strip.across - across) * along,
          extend,
          order: out.length,
          place: () => {
            const group = extend
              ? last!
              : { strip, across, parts: [] as Group["parts"] };
            if (!extend) strip.groups.push(group);
            group.parts.push({ entry, orient, along });
          },
        });
      }
      for (const group of strip.groups) {
        const residualAcross = strip.across - group.across - gap;
        if (residualAcross <= EPS) continue;
        group.residual ??= {
          along: axis,
          across: residualAcross,
          strips: [],
          group,
        };
        candidates(group.residual, entry, out);
      }
    }
    const freeAcross = regionFreeAcross(region, gap),
      length = regionAlong(region, gap);
    for (const orient of stripOrients(entry, true)) {
      const across = extent(orient, other(axis)),
        along = extent(orient, axis);
      if (across > freeAcross + EPS || along > length + EPS) continue;
      // What the new strip leaves beside the blanks like this one that will
      // join it, per blank: a strip that takes all eight drawer sides beats
      // one that takes two, whichever way round they lie.
      const alike = Math.max(
        1,
        Math.min(
          remaining.get(sizeKey(entry)) ?? 1,
          Math.floor((length + gap + EPS) / (along + gap)),
        ),
      );
      out.push({
        cost: (across * (length - alike * along - (alike - 1) * gap)) / alike,
        extend: false,
        order: out.length,
        place: () => {
          const strip: Strip = { region, across, groups: [] };
          region.strips.push(strip);
          strip.groups.push({
            strip,
            across,
            parts: [{ entry, orient, along }],
          });
        },
      });
    }
  };
  for (const entry of entries) {
    let best: Candidate | undefined;
    for (const sheet of sheets) {
      const found: Candidate[] = [];
      candidates(sheet, entry, found);
      for (const c of found) if (preferable(c, best)) best = c;
      if (best) break; // Fill the sheets in hand before starting another.
    }
    if (!best) {
      const sheet: Region = {
        along: axis,
        across: extent({ w: stock.w, h: stock.h }, other(axis)),
        strips: [],
        fixedAlong: extent({ w: stock.w, h: stock.h }, axis),
      };
      sheets.push(sheet);
      const found: Candidate[] = [];
      candidates(sheet, entry, found);
      for (const c of found) if (preferable(c, best)) best = c;
    }
    best!.place();
    remaining.set(sizeKey(entry), remaining.get(sizeKey(entry))! - 1);
  }
  return sheets.map((sheet) => {
    const root = newSheet(stock);
    materializeRegion(root, sheet, gap);
    return root;
  });
}
function materializeRegion(node: Node, region: Region, gap: number) {
  const across = other(region.along);
  let cur: Node | undefined = node;
  for (const strip of region.strips) {
    if (!cur) break;
    const { piece, rest } = carve(cur, across, strip.across, gap);
    materializeStrip(piece, strip, gap);
    cur = rest;
  }
}
function materializeStrip(node: Node, strip: Strip, gap: number) {
  const along = strip.region.along;
  let cur: Node | undefined = node;
  for (const group of strip.groups) {
    if (!cur) break;
    const { piece, rest } = carve(cur, along, groupAlong(group, gap), gap);
    const row = carve(piece, other(along), group.across, gap);
    let slot: Node | undefined = row.piece;
    for (const part of group.parts) {
      if (!slot) break;
      const cut = carve(slot, along, part.along, gap);
      cut.piece.placed = { entry: part.entry, rotation: part.orient.rotation };
      slot = cut.rest;
    }
    if (row.rest && group.residual)
      materializeRegion(row.rest, group.residual, gap);
    cur = rest;
  }
}

/* -------------------------------------------------------- best-fit packer */

type Fit = "short-side" | "area";
/** Each blank goes into the free piece it fits most snugly; the piece is
 * split so that the larger remnant stays in one piece. */
function packLeaves(entries: Entry[], stock: Stock, fit: Fit): Node[] {
  const { gap } = stock;
  const sheets: Node[] = [];
  const score = (leaf: Node, o: Orient) =>
    fit === "area"
      ? leaf.w * leaf.h - o.w * o.h
      : Math.min(leaf.w - o.w, leaf.h - o.h);
  for (const entry of entries) {
    let best:
      { leaf: Node; orient: Orient; score: number; order: number } | undefined;
    const consider = (sheet: Node) => {
      for (const leaf of leaves(sheet)) {
        if (leaf.placed) continue;
        for (const orient of entry.orients) {
          if (orient.w > leaf.w + EPS || orient.h > leaf.h + EPS) continue;
          const s = score(leaf, orient);
          if (!best || s < best.score - EPS)
            best = { leaf, orient, score: s, order: 0 };
        }
      }
    };
    for (const sheet of sheets) {
      consider(sheet);
      if (best) break;
    }
    if (!best) {
      const sheet = newSheet(stock);
      sheets.push(sheet);
      consider(sheet);
    }
    const { leaf, orient } = best!;
    // Split first along the axis whose remnant is larger, keeping it whole.
    const right = (leaf.w - orient.w - gap) * leaf.h,
      below = (leaf.h - orient.h - gap) * leaf.w;
    const first: Axis = right >= below ? "x" : "y",
      second = other(first);
    const outer = carve(leaf, first, extent(orient, first), gap);
    const inner = carve(outer.piece, second, extent(orient, second), gap);
    inner.piece.placed = { entry, rotation: orient.rotation };
  }
  return sheets;
}

/* ------------------------------------------------------------- selection */

function readLayout(root: Node, stock: Stock, number: number): SheetLayout {
  const { material } = stock;
  const parts: NestedPart[] = [],
    offcuts: SheetOffcut[] = [];
  let offcutArea = 0;
  for (const leaf of leaves(root)) {
    if (leaf.placed) {
      parts.push({
        part: leaf.placed.entry.part,
        copy: leaf.placed.entry.copy,
        x: leaf.x,
        y: leaf.y,
        width: leaf.w,
        height: leaf.h,
        rotation: leaf.placed.rotation,
      });
    } else if (Math.min(leaf.w, leaf.h) + EPS >= stock.minimumOffcut) {
      offcuts.push({
        id: leaf.id,
        x: leaf.x,
        y: leaf.y,
        width: leaf.w,
        height: leaf.h,
      });
      offcutArea += leaf.w * leaf.h;
    }
  }
  // Legend order: reading order over the sheet, top left to bottom right.
  parts.sort((a, b) => a.y - b.y || a.x - b.x);
  offcuts.sort((a, b) => b.width * b.height - a.width * a.height);
  const cuts: SheetCut[] = [];
  const walk = (node: Node) => {
    if (!node.split) return;
    const { axis, at, first, second } = node.split;
    cuts.push({
      sequence: cuts.length + 1,
      source: node.id,
      axis,
      at,
      from: axis === "x" ? node.y : node.x,
      to: axis === "x" ? node.y + node.h : node.x + node.w,
      kerf: material.options.kerf ?? 0,
    });
    walk(first);
    if (second) walk(second);
  };
  walk(root);
  const usedArea = parts.reduce((sum, p) => sum + p.width * p.height, 0);
  return {
    material,
    number,
    parts,
    cuts,
    offcuts,
    usedArea,
    offcutArea,
    wasteArea: material.width! * material.height! - usedArea - offcutArea,
  };
}
/** Lower is better: fewer sheets, then the biggest single off-cut on every
 * sheet, then the most reusable off-cut, then the fewest pieces and cuts. */
function rank(layouts: SheetLayout[]): number[] {
  return [
    layouts.length,
    -layouts.reduce(
      (sum, l) =>
        sum + Math.max(0, ...l.offcuts.map((o) => o.width * o.height)),
      0,
    ),
    -layouts.reduce((sum, l) => sum + l.offcutArea, 0),
    layouts.reduce((sum, l) => sum + l.offcuts.length, 0),
    layouts.reduce((sum, l) => sum + l.cuts.length, 0),
  ];
}
function better(a: number[], b: number[]) {
  for (let i = 0; i < a.length; i++)
    if (Math.abs(a[i]! - b[i]!) > EPS) return a[i]! < b[i]!;
  return false;
}
/** Nests every part's blank on its material's stock, allocating sheets as
 * needed. Deterministic: the same parts always give the same layouts. */
export function nest(parts: readonly SheetPart[]): SheetLayout[] {
  const results: SheetLayout[] = [];
  for (const material of new Set(parts.map((p) => p.material))) {
    if (material.width === undefined || material.height === undefined)
      throw new Error(`Stock size required to nest ${material.name}`);
    const margin = material.options.sheetMargin ?? 0;
    const stock: Stock = {
      material,
      margin,
      gap: Math.max(
        material.options.kerf ?? 0,
        material.options.partSpacing ?? 0,
      ),
      w: material.width - 2 * margin,
      h: material.height - 2 * margin,
      minimumOffcut: material.options.minimumOffcut ?? DEFAULT_MINIMUM_OFFCUT,
    };
    if (stock.w <= 0 || stock.h <= 0)
      throw new Error("Sheet margin consumes the sheet");
    const entries = entriesFor(material, parts, stock);
    if (!entries.length) continue;
    let best: { layouts: SheetLayout[]; rank: number[] } | undefined;
    const consider = (sheets: Node[]) => {
      const layouts = sheets.map((root, i) => readLayout(root, stock, i + 1));
      const placed = layouts.reduce((sum, l) => sum + l.parts.length, 0);
      if (placed !== entries.length)
        throw new Error(`Nesting lost ${entries.length - placed} blank(s)`);
      const r = rank(layouts);
      if (!best || better(r, best.rank)) best = { layouts, rank: r };
    };
    const sorts: Sort[] = ["across", "area", "long", "short"];
    for (const axis of ["x", "y"] as const)
      for (const pref of ["flat", "tall", "free"] as const)
        for (const sort of sorts)
          consider(
            packStrips(sorted(entries, sort, axis, pref), stock, axis, pref),
          );
    for (const sort of sorts)
      for (const fit of ["short-side", "area"] as const)
        consider(packLeaves(sorted(entries, sort, "x", "flat"), stock, fit));
    results.push(...best!.layouts);
  }
  return results;
}
