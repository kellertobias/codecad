// Layouts on stock: filling a piece automatically with the existing
// guillotine nesting, and writing a layout, or one part, as DXF exactly as
// the parts are placed.
import { Shapes, construction, Assembly } from "../model.js";
import { SheetMaterial, SheetPart } from "../stock.js";
import { nest } from "../nesting.js";
import { encodeDxf, partEntities, type DxfEntity } from "../manufacturing.js";
import type { OpenCascadeEngine } from "../engine.js";
import type {
  CadDocument,
  Layout,
  Placement,
  StockPiece,
} from "../document/schema.js";
import {
  checkLayout,
  normalized,
  place,
  rectanglesIn,
  unplaced,
  type LayoutPart,
  type Rectangle,
} from "../document/layout.js";
import type { BodyShape, PartInfo } from "./parts.js";
import { shapeNest } from "../document/shape-nesting.js";
import { sheetProject } from "./parts.js";

/** The sheet parts of one material, as layouts see them. */
export function layoutParts(
  parts: readonly PartInfo[],
  material: string,
): LayoutPart[] {
  return parts.flatMap((part) =>
    part.stock === "sheet" && part.material?.id === material && part.outline
      ? [
          {
            id: part.body,
            name: part.name,
            outline: part.outline,
            quantity: part.quantity,
            grain: part.grain,
          },
        ]
      : [],
  );
}

const bounds = (outline: readonly { x: number; y: number }[]) => {
  const xs = outline.map((p) => p.x);
  const ys = outline.map((p) => p.y);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
};

class NestParts extends Assembly {}

/** Fills a piece with the parts still to place (their copies not in any
 * other layout), as the layout asks: by rectangles (guillotine), by true
 * outlines, or (auto) whichever places more, rectangles when equal. */
export function autoNest(
  layout: Layout,
  piece: StockPiece,
  parts: readonly LayoutPart[],
  others: readonly Layout[],
): {
  placements: Placement[];
  left: string[];
  method: "guillotine" | "shape";
} {
  const method = layout.nesting ?? "auto";
  const guillotine =
    method === "shape"
      ? undefined
      : guillotineNest(layout, piece, parts, others);
  const shaped =
    method === "guillotine"
      ? undefined
      : shapeNest(layout, piece, parts, others);
  if (
    shaped &&
    (!guillotine || shaped.placements.length > guillotine.placements.length)
  )
    return { ...shaped, method: "shape" };
  return { ...guillotine!, method: "guillotine" };
}

/** The guillotine nesting: on a rectangular piece directly, on an offcut
 * in the largest rectangles that fit inside it. */
function guillotineNest(
  layout: Layout,
  piece: StockPiece,
  parts: readonly LayoutPart[],
  others: readonly Layout[],
): { placements: Placement[]; left: string[] } {
  let todo = unplaced(parts, others);
  const placements: Placement[] = [];
  for (const area of rectanglesIn(piece.outline)) {
    if (!todo.length) break;
    const added = nestInto(area, layout, piece, todo);
    placements.push(...added);
    todo = todo
      .map(({ part, copies }) => ({
        part,
        copies: copies - added.filter((p) => p.part === part.id).length,
      }))
      .filter((entry) => entry.copies > 0);
  }
  // Parts from neighbouring rectangles may sit closer than the kerf.
  const kept: Placement[] = [];
  for (const placement of placements) {
    const trial = [...kept, placement];
    const clash = checkLayout(
      { ...layout, placements: trial },
      piece,
      parts,
    ).some(
      (issue) =>
        issue.placements.includes(trial.length - 1) &&
        ["outside", "overlap", "kerf", "margin"].includes(issue.kind),
    );
    if (!clash) kept.push(placement);
  }
  const missing = unplaced(parts, [...others, { ...layout, placements: kept }]);
  return {
    placements: kept,
    left: missing.map(
      ({ part, copies }) => `${part.name}${copies > 1 ? ` ×${copies}` : ""}`,
    ),
  };
}

const grainName = (axis: "x" | "y" | "none") =>
  axis === "x" ? "width" : axis === "y" ? "height" : "none";

/** Nests parts into one rectangle of a piece. */
function nestInto(
  area: Rectangle,
  layout: Layout,
  piece: StockPiece,
  todo: readonly { part: LayoutPart; copies: number }[],
): Placement[] {
  const margin = layout.margin ?? 0;
  const room = {
    width: area.width - 2 * margin,
    height: area.height - 2 * margin,
  };
  // Parts too big for this rectangle either way round would stop the
  // nesting.
  const fitting = todo.filter(({ part }) => {
    const { width, height } = bounds(part.outline);
    return (
      (width <= room.width && height <= room.height) ||
      (height <= room.width && width <= room.height)
    );
  });
  if (!fitting.length || room.width <= 0 || room.height <= 0) return [];
  const nested = construction(() => {
    new NestParts({ id: "nest" });
    const material = new SheetMaterial({
      id: "piece",
      thickness: 1,
      width: area.width,
      height: area.height,
      grain: grainName(piece.grain ?? "none"),
      kerf: layout.kerf ?? 0,
      sheetMargin: margin,
    });
    const sheets = fitting.map(({ part, copies }) => {
      const sheet = new SheetPart(material, {
        id: part.id.replace(/[/\\]/g, "_"),
        label: part.name,
        outline: new Shapes.Polygon({ points: normalized(part.outline) }),
        quantity: copies,
      });
      // Profiled parts have no grain of their own; the layout's part does.
      Object.defineProperty(sheet, "grain", { value: grainName(part.grain) });
      return [sheet, part] as const;
    });
    const byPart = new Map(sheets);
    try {
      return { layouts: nest(sheets.map(([sheet]) => sheet)), byPart };
    } catch {
      // Grain rules no part can meet here.
      return { layouts: [], byPart };
    }
  });
  return (nested.layouts[0]?.parts ?? []).map((n) => {
    const part = nested.byPart.get(n.part)!;
    const { width: w, height: h } = bounds(part.outline);
    // The nesting turns a blank about its corner and then moves it; the
    // same placement as a turn about the origin and a move.
    const shift = {
      0: { x: n.x, y: n.y },
      90: { x: n.x + h, y: n.y },
      180: { x: n.x + w, y: n.y + h },
      270: { x: n.x, y: n.y + w },
    }[n.rotation];
    return {
      part: part.id,
      copy: n.copy,
      x: area.x + shift.x,
      y: area.y + shift.y,
      rotation: n.rotation,
    };
  });
}

/** A part's DXF entities placed as a layout places them. */
function placed(
  entities: readonly DxfEntity[],
  outline: readonly { x: number; y: number }[],
  placement: Placement,
): DxfEntity[] {
  const origin = bounds(outline);
  const at = (p: { x: number; y: number }) =>
    place({ x: p.x - origin.x, y: p.y - origin.y }, placement);
  return entities.map((entity) => {
    if (entity.kind === "polyline")
      return {
        ...entity,
        points: entity.points.map((p) => ({
          ...p,
          ...at(p),
          // Mirroring runs every arc the other way round.
          ...(p.bulge !== undefined && placement.flip
            ? { bulge: -p.bulge }
            : {}),
        })),
      };
    if (entity.kind === "text")
      return {
        ...entity,
        ...at(entity),
        rotation: (entity.rotation ?? 0) + placement.rotation,
      };
    return { ...entity, ...at(entity) };
  });
}

/** The whole layout as one DXF: the piece's outline and every part where
 * it is placed, with its cut contours and machining. */
export async function layoutDxf(
  engine: OpenCascadeEngine,
  document: CadDocument,
  bodies: readonly BodyShape[],
  info: readonly PartInfo[],
  layout: Layout,
): Promise<Uint8Array> {
  return encodeDxf(
    await layoutEntities(engine, document, bodies, info, layout),
  );
}

export async function layoutEntities(
  engine: OpenCascadeEngine,
  document: CadDocument,
  bodies: readonly BodyShape[],
  info: readonly PartInfo[],
  layout: Layout,
): Promise<DxfEntity[]> {
  const piece = document.stock?.find((p) => p.id === layout.stock);
  if (!piece) throw new Error(`The stock piece ${layout.stock} does not exist`);
  const { parts } = sheetProject(document, bodies, info);
  const entities: DxfEntity[] = [
    {
      kind: "polyline",
      layer: "STOCK_BOUNDARY",
      closed: true,
      points: piece.outline.map((p) => ({ x: p.x, y: p.y })),
    },
  ];
  const cache = new Map<string, DxfEntity[]>();
  for (const placement of layout.placements) {
    const part = parts.get(placement.part);
    const partInfo = info.find((p) => p.body === placement.part);
    if (!part || !partInfo?.outline)
      throw new Error(`${placement.part} is not a sheet part`);
    let own = cache.get(placement.part);
    if (!own) {
      own = await partEntities(engine, part);
      cache.set(placement.part, own);
    }
    entities.push(...placed(own, partInfo.outline, placement));
  }
  return entities;
}

/** One part's DXF, in its blank's own coordinates. */
export async function partDxf(
  engine: OpenCascadeEngine,
  document: CadDocument,
  bodies: readonly BodyShape[],
  info: readonly PartInfo[],
  body: string,
): Promise<Uint8Array> {
  const part = sheetProject(document, bodies, info).parts.get(body);
  if (!part) throw new Error(`${body} is not a sheet part`);
  return encodeDxf(await partEntities(engine, part));
}
