import * as b from "brepjs/quick";
import { Matrix4, Vector3 } from "three";
import {
  Part,
  descendants,
  type Component,
  type Point2,
  type Recipe,
} from "./model.js";
import {
  SheetMaterial,
  SheetPart,
  SheetMetalPart,
  BlockPart,
  MetalStockPart,
} from "./stock.js";
import type { CutList, ManufacturingDxf } from "./outputs.js";
import type { View2D } from "./view2d.js";
import type { OpenCascadeEngine } from "./engine.js";
import { formatMm } from "./precision.js";

export interface CutRow {
  path: string;
  label: string;
  material: string;
  width: number;
  height: number;
  thickness?: number;
  /** Metal profile cut length along local Z. */
  length?: number;
  wallThickness?: number | null;
  cornerRadius?: number;
  quantity: number;
}
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
  offcuts: SheetOffcut[];
  usedArea: number;
  offcutArea: number;
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
  source: string;
  axis: "x" | "y";
  at: number;
  from: number;
  to: number;
  kerf: number;
}
export function sheetParts(root: Component): SheetPart[] {
  return [root, ...descendants(root)].filter(
    (p): p is SheetPart => p instanceof SheetPart,
  );
}
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
/** A blank radius only reaches the cut list when every rounded corner shares
 * it; mixed radii live in the contour the DXF carries. */
function sheetCornerRadius(part: SheetPart): { cornerRadius?: number } {
  const rounded = new Set(
    Object.values(part.cornerRadii).filter((radius) => radius > 0),
  );
  return rounded.size === 1 ? { cornerRadius: [...rounded][0]! } : {};
}
export function cutRows(root: Component, output?: CutList): CutRow[] {
  return [root, ...descendants(root)]
    .filter(
      (p): p is SheetPart | BlockPart | MetalStockPart =>
        p instanceof SheetPart ||
        p instanceof BlockPart ||
        p instanceof MetalStockPart,
    )
    .filter(
      (p) =>
        !output?.options.materials ||
        output.options.materials.includes(p.material),
    )
    .map((p) => ({
      path: p.path,
      label: p.label,
      material: p.material.name,
      ...(p instanceof SheetPart
        ? {
            ...outlineBounds(p),
            thickness: p.material.thickness,
            ...sheetCornerRadius(p),
          }
        : p instanceof MetalStockPart
          ? {
              width: p.material.width,
              height: p.material.height,
              length: p.length,
              wallThickness: p.material.wallThickness,
              cornerRadius: p.material.cornerRadius,
            }
          : {
              width: p.dimensions.width,
              height: p.dimensions.depth,
              thickness: p.dimensions.height,
            }),
      quantity: p.quantity,
    }));
}
export function csv(rows: CutRow[], mmPrecision?: number): string {
  const quote = (s: unknown) => '"' + String(s).replaceAll('"', '""') + '"';
  return (
    [
      [
        "part",
        "label",
        "material",
        "width_mm",
        "height_mm",
        "thickness_mm",
        "quantity",
        "length_mm",
        "wall_thickness_mm",
        "corner_radius_mm",
      ],
      ...rows.map((r) => [
        r.path,
        r.label,
        r.material,
        formatMm(r.width, mmPrecision),
        formatMm(r.height, mmPrecision),
        r.thickness === undefined ? "" : formatMm(r.thickness, mmPrecision),
        r.quantity,
        r.length === undefined ? "" : formatMm(r.length, mmPrecision),
        r.wallThickness == null ? "" : formatMm(r.wallThickness, mmPrecision),
        r.cornerRadius === undefined
          ? ""
          : formatMm(r.cornerRadius, mmPrecision),
      ]),
    ]
      .map((r) => r.map(quote).join(","))
      .join("\n") + "\n"
  );
}
/** Deterministic guillotine packing; additional stock sheets are allocated on demand. */
export function nest(parts: readonly SheetPart[]): SheetLayout[] {
  const results: SheetLayout[] = [];
  for (const material of new Set(parts.map((p) => p.material))) {
    if (material.width === undefined || material.height === undefined)
      throw new Error(`Stock size required to nest ${material.name}`);
    const margin = material.options.sheetMargin ?? 0,
      gap = Math.max(
        material.options.kerf ?? 0,
        material.options.partSpacing ?? 0,
      );
    const W = material.width - 2 * margin,
      H = material.height - 2 * margin;
    if (W <= 0 || H <= 0) throw new Error("Sheet margin consumes the sheet");
    type Free = { id: string; x: number; y: number; w: number; h: number };
    const sheets: { layout: SheetLayout; free: Free[] }[] = [];
    const entries = parts
      .filter((p) => p.material === material)
      .flatMap((part) =>
        Array.from({ length: part.quantity }, (_, copy) => ({ part, copy })),
      )
      .sort((a, c) => {
        const x = outlineBounds(a.part),
          y = outlineBounds(c.part);
        return (
          y.width * y.height - x.width * x.height ||
          a.part.path.localeCompare(c.part.path)
        );
      });
    const dimensions = (part: SheetPart, r: number) => {
      const size = outlineBounds(part);
      return r % 180 === 0
        ? { w: size.width, h: size.height }
        : { w: size.height, h: size.width };
    };
    const orientations = (part: SheetPart) => {
      const grain = material.options.grain ?? "none";
      const allowed = material.options.rotations ?? [0, 90];
      return [...new Set(allowed)].filter(
        (r) =>
          grain === "none" ||
          part.grain === "none" ||
          (grain === part.grain) === (r % 180 === 0),
      );
    };
    const fits = (f: Free, part: SheetPart, r: number) => {
      const { w, h } = dimensions(part, r);
      return w <= f.w + 1e-8 && h <= f.h + 1e-8;
    };
    const split = (
      f: Free,
      w: number,
      h: number,
      order: "vertical" | "horizontal",
    ) => {
      const right = f.w - w - gap;
      const below = f.h - h - gap;
      if (order === "vertical")
        return [
          ...(right > 1e-8
            ? [{ id: `${f.id}R`, x: f.x + w + gap, y: f.y, w: right, h: f.h }]
            : []),
          ...(below > 1e-8
            ? [{ id: `${f.id}B`, x: f.x, y: f.y + h + gap, w, h: below }]
            : []),
        ];
      return [
        ...(below > 1e-8
          ? [{ id: `${f.id}B`, x: f.x, y: f.y + h + gap, w: f.w, h: below }]
          : []),
        ...(right > 1e-8
          ? [{ id: `${f.id}R`, x: f.x + w + gap, y: f.y, w: right, h }]
          : []),
      ];
    };
    const scorePlacement = (
      free: Free,
      children: Free[],
      remaining: typeof entries,
    ) => {
      const futureArea = remaining.reduce((sum, next) => {
        const canFit = children.some((child) =>
          orientations(next.part).some((candidateRotation) =>
            fits(child, next.part, candidateRotation),
          ),
        );
        const size = outlineBounds(next.part);
        return sum + (canFit ? size.width * size.height : 0);
      }, 0);
      const largestOffcut = Math.max(0, ...children.map((c) => c.w * c.h));
      return futureArea * 2 + largestOffcut - free.w * free.h * 0.001;
    };
    for (const [entryIndex, { part, copy }] of entries.entries()) {
      const dim = outlineBounds(part);
      const rotations = orientations(part);
      if (
        !rotations.some((r) =>
          fits({ id: "stock", x: 0, y: 0, w: W, h: H }, part, r),
        )
      )
        throw new Error(
          `Part ${part.path} does not fit stock ${material.name} with its grain/rotation constraints`,
        );
      let chosen: (typeof sheets)[number] | undefined,
        index = -1,
        rotation: 0 | 90 | 180 | 270 = 0,
        order: "vertical" | "horizontal" = "vertical",
        bestScore = -Infinity;
      const remaining = entries.slice(entryIndex + 1);
      for (const s of sheets) {
        for (let i = 0; i < s.free.length; i++) {
          const free = s.free[i]!;
          for (const r of rotations) {
            if (!fits(free, part, r)) continue;
            const { w, h } = dimensions(part, r);
            for (const candidateOrder of ["vertical", "horizontal"] as const) {
              const children = split(free, w, h, candidateOrder);
              const score = scorePlacement(free, children, remaining);
              if (score > bestScore) {
                bestScore = score;
                chosen = s;
                index = i;
                rotation = r;
                order = candidateOrder;
              }
            }
          }
        }
        if (chosen) break; // Always consume an existing sheet before buying another.
      }
      if (!chosen) {
        chosen = {
          layout: {
            material,
            number: sheets.length + 1,
            parts: [],
            cuts: [],
            offcuts: [],
            usedArea: 0,
            offcutArea: 0,
            wasteArea: 0,
          },
          free: [{ id: "stock", x: margin, y: margin, w: W, h: H }],
        };
        sheets.push(chosen);
        index = 0;
        const free = chosen.free[0]!;
        bestScore = -Infinity;
        for (const candidateRotation of rotations) {
          if (!fits(free, part, candidateRotation)) continue;
          const { w, h } = dimensions(part, candidateRotation);
          for (const candidateOrder of ["vertical", "horizontal"] as const) {
            const score = scorePlacement(
              free,
              split(free, w, h, candidateOrder),
              remaining,
            );
            if (score > bestScore) {
              bestScore = score;
              rotation = candidateRotation;
              order = candidateOrder;
            }
          }
        }
      }
      const free = chosen.free.splice(index, 1)[0]!,
        w = rotation % 180 === 0 ? dim.width : dim.height,
        h = rotation % 180 === 0 ? dim.height : dim.width;
      chosen.layout.parts.push({
        part,
        copy,
        x: free.x,
        y: free.y,
        width: w,
        height: h,
        rotation,
      });
      const cut = (
        axis: "x" | "y",
        at: number,
        from: number,
        to: number,
        source: string,
      ) =>
        chosen!.layout.cuts.push({
          sequence: chosen!.layout.cuts.length + 1,
          source,
          axis,
          at,
          from,
          to,
          kerf: material.options.kerf ?? 0,
        });
      if (order === "vertical") {
        if (free.w > w + 1e-8)
          cut("x", free.x + w, free.y, free.y + free.h, free.id);
        if (free.h > h + 1e-8)
          cut("y", free.y + h, free.x, free.x + w, `${free.id}:kept`);
      } else {
        if (free.h > h + 1e-8)
          cut("y", free.y + h, free.x, free.x + free.w, free.id);
        if (free.w > w + 1e-8)
          cut("x", free.x + w, free.y, free.y + h, `${free.id}:kept`);
      }
      chosen.free.push(...split(free, w, h, order));
    }
    for (const sheet of sheets) {
      sheet.layout.offcuts = sheet.free.map((f) => ({
        id: f.id,
        x: f.x,
        y: f.y,
        width: f.w,
        height: f.h,
      }));
      sheet.layout.usedArea = sheet.layout.parts.reduce(
        (sum, p) => sum + p.width * p.height,
        0,
      );
      sheet.layout.offcutArea = sheet.free.reduce(
        (sum, f) => sum + f.w * f.h,
        0,
      );
      sheet.layout.wasteArea =
        material.width! * material.height! -
        sheet.layout.usedArea -
        sheet.layout.offcutArea;
    }
    results.push(...sheets.map((s) => s.layout));
  }
  return results;
}
/** A polyline vertex. `bulge` is `tan(sweep / 4)` for the arc running to the
 * next vertex, positive counter-clockwise, as LWPOLYLINE group code 42 wants.
 * Absent or zero means a straight segment. */
export interface DxfVertex extends Point2 {
  readonly bulge?: number;
}
export type DxfEntity =
  | {
      kind: "polyline";
      layer: string;
      points: DxfVertex[];
      closed: boolean;
      style?: import("./drawing-style.js").DrawingLineStyle;
    }
  | {
      kind: "text";
      layer: string;
      x: number;
      y: number;
      height: number;
      text: string;
      rotation?: number;
      align?: "middle";
    }
  | { kind: "circle"; layer: string; x: number; y: number; radius: number };
function primitiveTransform(recipe: Recipe): {
  recipe: Recipe;
  matrix: Matrix4;
} {
  const matrix = new Matrix4();
  let r = recipe;
  while (r.kind === "transform") {
    matrix.multiply(new Matrix4().fromArray(r.matrix));
    r = r.source;
  }
  return { recipe: r, matrix };
}
/** A contour piece. A nonzero `bulge` makes it an arc from `a` to `b`;
 * reversing the piece negates it. */
export interface DxfSegment {
  readonly a: Point2;
  readonly b: Point2;
  readonly bulge?: number;
}
function contourChains(
  segments: DxfSegment[],
): { points: DxfVertex[]; closed: boolean }[] {
  const chains: { points: DxfVertex[]; closed: boolean }[] = [],
    near = (a: Point2, b: Point2) => Math.hypot(a.x - b.x, a.y - b.y) < 0.0001;
  while (segments.length) {
    const first = segments.pop()!;
    // A vertex carries the bulge of the segment leaving it.
    const points: DxfVertex[] = [
      {
        x: first.a.x,
        y: first.a.y,
        ...(first.bulge ? { bulge: first.bulge } : {}),
      },
      { x: first.b.x, y: first.b.y },
    ];
    let found = true;
    while (found) {
      found = false;
      const end = points.at(-1)!;
      for (let i = 0; i < segments.length; i++) {
        const s = segments[i]!;
        const forward = near(end, s.a);
        if (!forward && !near(end, s.b)) continue;
        const bulge = forward ? (s.bulge ?? 0) : -(s.bulge ?? 0);
        if (bulge) points[points.length - 1] = { ...end, bulge };
        const next = forward ? s.b : s.a;
        points.push({ x: next.x, y: next.y });
        segments.splice(i, 1);
        found = true;
        break;
      }
    }
    // On a closed loop the last vertex duplicates the first; the vertex before
    // it already carries the closing segment's bulge.
    const closed = near(points[0]!, points.at(-1)!);
    if (closed) points.pop();
    chains.push({ points: straightened(points, closed), closed });
  }
  return chains;
}
/** Two cuts meeting along one line leave a vertex where nothing turns; the
 * contour reads better, and measures the same, without it. */
function straightened(points: DxfVertex[], closed: boolean): DxfVertex[] {
  const kept: DxfVertex[] = [];
  for (const [index, point] of points.entries()) {
    const before = kept.at(-1) ?? (closed ? points.at(-1) : undefined),
      after = points[index + 1] ?? (closed ? points[0] : undefined);
    if (before && after && !before.bulge && !point.bulge) {
      const ax = point.x - before.x,
        ay = point.y - before.y,
        bx = after.x - point.x,
        by = after.y - point.y;
      const cross = ax * by - ay * bx,
        dot = ax * bx + ay * by;
      if (
        Math.abs(cross) < 1e-6 * Math.hypot(ax, ay) * Math.hypot(bx, by) &&
        dot > 0
      )
        continue;
    }
    kept.push(point);
  }
  return kept.length >= 2 ? kept : points;
}
/** `tan(sweep / 4)`, which is what LWPOLYLINE group code 42 wants, derived
 * from the chord and a point on the arc. Positive counter-clockwise, and
 * exact for reflex arcs too. */
export function bulgeThrough(a: Point2, on: Point2, b: Point2): number {
  const dx = b.x - a.x,
    dy = b.y - a.y,
    chord = Math.hypot(dx, dy);
  if (chord < 1e-9) return 0;
  const cross = dx * (on.y - a.y) - dy * (on.x - a.x);
  return (-2 * cross) / (chord * chord);
}
/** Linetypes the layers draw with. `ByBlock`, `ByLayer` and `Continuous`
 * must exist in every file; each pattern's dashes sum to its length. */
const DXF_LINETYPES: readonly {
  name: string;
  description: string;
  dashes: readonly number[];
}[] = [
  { name: "ByBlock", description: "", dashes: [] },
  { name: "ByLayer", description: "", dashes: [] },
  { name: "Continuous", description: "Solid", dashes: [] },
  {
    name: "CENTER",
    description: "Bend center / tangent",
    dashes: [3, -1, 0.5, -1],
  },
  { name: "HIDDEN", description: "Hidden edges", dashes: [1, -1] },
];
/** Lineweights, in 1/100 mm, that group code 370 accepts. */
const DXF_LINEWEIGHTS = [
  0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106,
  120, 140, 158, 200, 211,
];
/** Symbol-table names may not hold these characters; AutoCAD refuses the
 * whole file when a layer does. */
function dxfName(name: string): string {
  return name.replace(/[<>/\\":;?*|=`,\r\n]/g, "_") || "0";
}
/** An AutoCAD 2004 (AC1018) DXF. Since R2000, AutoCAD and every strict reader
 * reject a file unless each object carries a handle, its owner and its
 * subclass markers, and unless all nine symbol tables, the model and paper
 * space blocks and the root dictionary exist. */
export function encodeDxf(entities: DxfEntity[]): Uint8Array {
  let seed = 1;
  const handle = () => (seed++).toString(16).toUpperCase();
  const out: (string | number)[] = [];
  const table = (
    name: string,
    recordClass: string,
    records: (string | number)[][],
    handleCode = 5,
  ): string[] => {
    const own = handle(),
      handles = records.map(() => handle());
    out.push(0, "TABLE", 2, name, 5, own, 330, 0, 100, "AcDbSymbolTable");
    out.push(70, records.length);
    if (name === "DIMSTYLE") out.push(100, "AcDbDimStyleTable", 71, 0);
    for (const [i, codes] of records.entries()) {
      out.push(0, name, handleCode, handles[i]!, 330, own);
      out.push(100, "AcDbSymbolTableRecord", 100, recordClass, ...codes);
    }
    out.push(0, "ENDTAB");
    return handles;
  };
  out.push(0, "SECTION", 2, "TABLES");
  table("VPORT", "AcDbViewportTableRecord", []);
  table(
    "LTYPE",
    "AcDbLinetypeTableRecord",
    DXF_LINETYPES.map((t) => [
      2,
      t.name,
      70,
      0,
      3,
      t.description,
      72,
      65,
      73,
      t.dashes.length,
      40,
      t.dashes.reduce((sum, dash) => sum + Math.abs(dash), 0),
      ...t.dashes.flatMap((dash) => [49, dash, 74, 0]),
    ]),
  );
  table(
    "LAYER",
    "AcDbLayerTableRecord",
    [...new Set(["0", ...entities.map((e) => dxfName(e.layer))])].map(
      (layer) => [
        2,
        layer,
        70,
        0,
        62,
        7,
        6,
        /HIDDEN/.test(layer)
          ? "HIDDEN"
          : /BEND|TANGENT/.test(layer)
            ? "CENTER"
            : "Continuous",
        370,
        -3,
      ],
    ),
  );
  table("STYLE", "AcDbTextStyleTableRecord", [
    [
      2,
      "Standard",
      70,
      0,
      40,
      0,
      41,
      1,
      50,
      0,
      71,
      0,
      42,
      2.5,
      3,
      "txt",
      4,
      "",
    ],
  ]);
  table("VIEW", "AcDbViewTableRecord", []);
  table("UCS", "AcDbUCSTableRecord", []);
  table("APPID", "AcDbRegAppTableRecord", [[2, "ACAD", 70, 0]]);
  table("DIMSTYLE", "AcDbDimStyleTableRecord", [[2, "Standard", 70, 0]], 105);
  const [modelSpace, paperSpace] = table(
    "BLOCK_RECORD",
    "AcDbBlockTableRecord",
    [
      [2, "*Model_Space", 340, 0],
      [2, "*Paper_Space", 340, 0],
    ],
  ) as [string, string];
  out.push(0, "ENDSEC", 0, "SECTION", 2, "BLOCKS");
  for (const [name, owner] of [
    ["*Model_Space", modelSpace],
    ["*Paper_Space", paperSpace],
  ] as const) {
    out.push(0, "BLOCK", 5, handle(), 330, owner, 100, "AcDbEntity");
    if (owner === paperSpace) out.push(67, 1);
    out.push(8, "0", 100, "AcDbBlockBegin", 2, name, 70, 0);
    out.push(10, 0, 20, 0, 30, 0, 3, name, 1, "");
    out.push(0, "ENDBLK", 5, handle(), 330, owner, 100, "AcDbEntity");
    if (owner === paperSpace) out.push(67, 1);
    out.push(8, "0", 100, "AcDbBlockEnd");
  }
  out.push(0, "ENDSEC", 0, "SECTION", 2, "ENTITIES");
  for (const e of entities) {
    const type =
      e.kind === "text"
        ? "TEXT"
        : e.kind === "circle"
          ? "CIRCLE"
          : "LWPOLYLINE";
    out.push(0, type, 5, handle(), 330, modelSpace, 100, "AcDbEntity");
    out.push(8, dxfName(e.layer));
    if (e.kind === "text")
      out.push(
        100,
        "AcDbText",
        10,
        e.x,
        20,
        e.y,
        30,
        0,
        40,
        e.height,
        1,
        e.text
          .replace(/[\r\n]/g, " ")
          .replace(
            /[^\x20-\x7e]/g,
            (c) =>
              "\\U+" +
              c.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase(),
          ),
        50,
        -(e.rotation ?? 0),
        7,
        "Standard",
        72,
        e.align === "middle" ? 1 : 0,
        11,
        e.x,
        21,
        e.y,
        31,
        0,
        100,
        "AcDbText",
        73,
        0,
      );
    else if (e.kind === "circle")
      out.push(100, "AcDbCircle", 10, e.x, 20, e.y, 30, 0, 40, e.radius);
    else {
      // Colour and lineweight belong to the common entity data, before the
      // polyline's own subclass.
      if (e.style?.stroke)
        out.push(420, Number.parseInt(e.style.stroke.slice(1), 16));
      if (e.style?.lineWidth !== undefined) {
        const requested = e.style.lineWidth * 100;
        out.push(
          370,
          DXF_LINEWEIGHTS.reduce((best, weight) =>
            Math.abs(weight - requested) < Math.abs(best - requested)
              ? weight
              : best,
          ),
        );
      }
      out.push(100, "AcDbPolyline", 90, e.points.length, 70, e.closed ? 1 : 0);
      for (const p of e.points) {
        out.push(10, p.x, 20, p.y);
        if (p.bulge) out.push(42, p.bulge);
      }
    }
  }
  const root = handle(),
    groups = handle();
  out.push(0, "ENDSEC", 0, "SECTION", 2, "OBJECTS");
  out.push(0, "DICTIONARY", 5, root, 330, 0, 100, "AcDbDictionary");
  out.push(281, 1, 3, "ACAD_GROUP", 350, groups);
  out.push(0, "DICTIONARY", 5, groups, 330, root, 100, "AcDbDictionary");
  out.push(281, 1, 0, "ENDSEC", 0, "EOF");
  const header = [
    0,
    "SECTION",
    2,
    "HEADER",
    9,
    "$ACADVER",
    1,
    "AC1018",
    9,
    "$DWGCODEPAGE",
    3,
    "ANSI_1252",
    9,
    "$HANDSEED",
    5,
    handle(),
    9,
    "$INSUNITS",
    70,
    4,
    0,
    "ENDSEC",
    0,
    "SECTION",
    2,
    "CLASSES",
    0,
    "ENDSEC",
  ];
  return new TextEncoder().encode([...header, ...out].join("\n") + "\n");
}
/** The blank as the saw or router sees it. A profile that opted into arc
 * fitting is read back through the kernel so its curves stay exact; a plain
 * polygon outline is emitted as written. */
async function blankContours(
  engine: OpenCascadeEngine,
  part: SheetPart,
): Promise<{ points: DxfVertex[]; closed: boolean }[]> {
  const outline = part.manufacturingOutline;
  if (outline.fittedArcTolerance === undefined)
    return [{ points: outline.points.map((p) => ({ ...p })), closed: true }];
  const prism = await engine.recipe(
    outline.extrude(part.material.thickness).recipe,
  );
  const contours = contourChains(
    sectionSegments(engine, prism, part.material.thickness / 2),
  );
  if (!contours.length || contours.some((contour) => !contour.closed))
    throw new Error(`Blank outline of ${part.path} is not closed`);
  return contours;
}
export async function partEntities(
  engine: OpenCascadeEngine,
  part: SheetPart,
): Promise<DxfEntity[]> {
  if (part instanceof SheetMetalPart) return sheetMetalEntities(engine, part);
  const entities: DxfEntity[] = (await blankContours(engine, part)).map(
    (contour) => ({ kind: "polyline", layer: "BLANK_OUTLINE", ...contour }),
  );
  // Through cuts that break the blank's edge (finger joints, notches) are not
  // separate pockets: they change the contour the router has to follow.
  const edgeCuts: Recipe[] = [];
  for (const op of part.operations) {
    if (op.kind === "union")
      throw new Error(
        `DXF cannot describe additive solid ${part.path}; make its final blank explicit`,
      );
    const tool = await engine.recipe(op.recipe),
      bb = engine.bounds(tool),
      t = part.material.thickness;
    const z0 = Math.max(0, bb.min.z),
      z1 = Math.min(t, bb.max.z);
    if (z1 - z0 < 1e-6) continue;
    const side =
      z0 < 1e-5 && z1 >= t - 1e-5
        ? "THROUGH"
        : z1 >= t - 1e-5
          ? "TOP"
          : z0 <= 1e-5
            ? "BOTTOM"
            : "INTERNAL";
    if (side === "INTERNAL" && op.kind === "domino") {
      const setup = edgeSetup(part, bb);
      entities.push({
        kind: "text",
        layer: "REFERENCE_EDGE_SETUP",
        x: bb.min.x,
        y: bb.min.y,
        height: 3,
        text: `Domino: separate ${setup} edge setup, depth ${op.depth} mm`,
      });
      continue;
    }
    if (side === "INTERNAL")
      throw new Error(
        `Enclosed cut on ${part.path} is not routable from either sheet face`,
      );
    const depth = (z1 - z0).toFixed(3),
      layer =
        op.kind === "miter"
          ? `REFERENCE_BEVEL_${op.angle}_DEGREES`
          : `${op.kind.toUpperCase()}_${side}_D${depth}`;
    const primitive = primitiveTransform(op.recipe),
      axis = new Vector3(0, 0, 1).transformDirection(primitive.matrix);
    if (
      (primitive.recipe.kind === "cylinder" ||
        primitive.recipe.kind === "cone") &&
      Math.abs(axis.z) <= 0.999999
    )
      throw new Error(
        `Side drilling on ${part.path} needs a separate machining setup; it cannot be flattened to an XY pocket`,
      );
    if (
      (primitive.recipe.kind === "cylinder" ||
        primitive.recipe.kind === "cone") &&
      Math.abs(axis.z) > 0.999999
    ) {
      const center = new Vector3().applyMatrix4(primitive.matrix);
      entities.push({
        kind: "circle",
        layer,
        x: center.x,
        y: center.y,
        radius: primitive.recipe.diameter / 2,
      });
      continue;
    }
    // Keep depth/side in layer names; CNC toolpaths are generated by the downstream CAM application.
    // Segments remain exact to the explicitly stated 0.02 mm curve tessellation tolerance.
    const segments = sectionSegments(engine, tool, (z0 + z1) / 2);
    const chains = contourChains(segments);
    if (
      side === "THROUGH" &&
      op.kind !== "miter" &&
      chains.some((chain) =>
        chain.points.some(
          (point) => !strictlyInside(point, part.manufacturingOutline.points),
        ),
      )
    ) {
      edgeCuts.push(op.recipe);
      continue;
    }
    for (const chain of chains)
      entities.push({ kind: "polyline", layer, ...chain });
  }
  if (edgeCuts.length) {
    const finished = await engine.recipe(
      edgeCuts.reduce<Recipe>(
        (left, right) => ({ kind: "cut", left, right }),
        part.manufacturingOutline.extrude(part.material.thickness).recipe,
      ),
    );
    const contours = contourChains(
      sectionSegments(engine, finished, part.material.thickness / 2),
    );
    if (contours.some((contour) => !contour.closed))
      throw new Error(`Finished contour of ${part.path} is not closed`);
    // The stock blank stays as BLANK_OUTLINE for sawing and nesting.
    entities.splice(
      1,
      0,
      ...contours.map((contour): DxfEntity => ({
        kind: "polyline",
        layer: "PART_OUTLINE",
        ...contour,
      })),
    );
  } else {
    // Nothing breaks the edge, so the finished contour is the blank itself.
    // It is still stated, so every part carries the contour the router
    // follows and reads the same way wherever the layers are drawn.
    const blank = entities.filter((entity) => entity.layer === "BLANK_OUTLINE");
    entities.splice(
      blank.length,
      0,
      ...blank.map((entity) => ({ ...entity, layer: "PART_OUTLINE" })),
    );
  }
  return entities;
}
function sectionSegments(
  engine: OpenCascadeEngine,
  shape: b.Shape3D,
  z: number,
): DxfSegment[] {
  const section = engine.own(
    b.unwrap(
      b.section(shape, {
        origin: [0, 0, z],
        xDir: [1, 0, 0],
        yDir: [0, 1, 0],
        zDir: [0, 0, 1],
      }),
    ),
  );
  const segments: DxfSegment[] = [],
    seen = new Set<string>();
  const add = (a: Point2, c: Point2, bulge = 0) => {
    const key =
      [
        `${a.x.toFixed(5)},${a.y.toFixed(5)}`,
        `${c.x.toFixed(5)},${c.y.toFixed(5)}`,
      ]
        .sort()
        .join("|") + `|${Math.abs(bulge).toFixed(5)}`;
    if (seen.has(key)) return;
    seen.add(key);
    segments.push(bulge ? { a, b: c, bulge } : { a, b: c });
  };
  const at = (edge: b.Edge<b.Dimension>, position: number): Point2 => {
    const p = b.curvePointAt(edge, position);
    return { x: p[0]!, y: p[1]! };
  };
  for (const edge of b.getEdges(section)) {
    // Circles keep their exact sweep; anything else is tessellated as before.
    if (b.getCurveType(edge) === "CIRCLE") {
      const start = at(edge, 0),
        end = at(edge, 1);
      if (Math.hypot(end.x - start.x, end.y - start.y) < 1e-9) {
        // A full circle has no chord, so split it into two exact half arcs.
        const half = at(edge, 0.5);
        add(start, half, bulgeThrough(start, at(edge, 0.25), half));
        add(half, start, bulgeThrough(half, at(edge, 0.75), start));
      } else add(start, end, bulgeThrough(start, at(edge, 0.5), end));
      continue;
    }
    const lines = b.meshEdges(edge, { tolerance: 0.02, cache: false }).lines;
    for (let j = 0; j < lines.length; j += 6)
      add(
        { x: lines[j]!, y: lines[j + 1]! },
        { x: lines[j + 3]!, y: lines[j + 4]! },
      );
  }
  return segments;
}
/** Inside the polygon and further than the tolerance from every edge. */
function strictlyInside(
  point: Point2,
  polygon: readonly Point2[],
  tolerance = 1e-4,
): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!,
      c = polygon[j]!;
    const dx = c.x - a.x,
      dy = c.y - a.y,
      length2 = dx * dx + dy * dy;
    const t = length2
      ? Math.max(
          0,
          Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length2),
        )
      : 0;
    if (Math.hypot(point.x - a.x - dx * t, point.y - a.y - dy * t) <= tolerance)
      return false;
    if (
      a.y > point.y !== c.y > point.y &&
      point.x < ((c.x - a.x) * (point.y - a.y)) / (c.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
}

/** Section the finished developed solid, not the untrimmed cutter shapes.
 * Edge-open reliefs become part of the outer contour; holes remain closed loops. */
async function sheetMetalEntities(
  engine: OpenCascadeEngine,
  part: SheetMetalPart,
): Promise<DxfEntity[]> {
  if (part.operations.some((op) => op.kind === "union"))
    throw new Error(
      `Sheet-metal DXF cannot infer stock for additive geometry on ${part.path}; define the final blank explicitly`,
    );
  const flat = await engine.recipe(part.unfold().shape.recipe);
  if (b.getSolids(flat).length !== 1)
    throw new Error(
      `Sheet-metal blank ${part.path} must be one connected solid`,
    );
  const section = engine.own(
    b.unwrap(
      b.section(flat, {
        origin: [0, 0, part.material.thickness / 2],
        xDir: [1, 0, 0],
        yDir: [0, 1, 0],
        zDir: [0, 0, 1],
      }),
    ),
  );
  const lines = b.meshEdges(section, { tolerance: 0.02, cache: false }).lines;
  const segments: { a: Point2; b: Point2 }[] = [],
    seen = new Set<string>();
  for (let i = 0; i < lines.length; i += 6) {
    const a = { x: lines[i]!, y: lines[i + 1]! },
      c = { x: lines[i + 3]!, y: lines[i + 4]! };
    const key = [JSON.stringify(a), JSON.stringify(c)].sort().join("|");
    if (!seen.has(key)) {
      seen.add(key);
      segments.push({ a, b: c });
    }
  }
  const contours = contourChains(segments);
  if (contours.some((c) => !c.closed))
    throw new Error(`Developed contour of ${part.path} is not closed`);
  const area = (points: Point2[]) =>
    Math.abs(
      points.reduce((a, p, i) => {
        const q = points[(i + 1) % points.length]!;
        return a + p.x * q.y - q.x * p.y;
      }, 0),
    );
  contours.sort((a, c) => area(c.points) - area(a.points));
  const entities: DxfEntity[] = contours.map((c, i) => ({
    kind: "polyline",
    layer: i
      ? `CUT_THROUGH_D${part.material.thickness.toFixed(3)}`
      : "BLANK_OUTLINE",
    ...c,
  }));
  // A sheet-metal blank cannot encode blind milling as a through-cut.
  for (const op of part.operations) {
    const box = engine.bounds(await engine.recipe(op.recipe));
    if (box.min.z > 1e-5 || box.max.z < part.material.thickness - 1e-5)
      throw new Error(
        `Sheet-metal flat DXF requires through cuts on ${part.path}; use a separate milling setup for blind features`,
      );
  }
  for (const bend of part.unfold().bends) {
    entities.push({
      kind: "polyline",
      layer: `BEND_${bend.direction.toUpperCase()}_${bend.angle}_R${bend.insideRadius}`,
      points: [bend.start, bend.end],
      closed: false,
    });
    for (const points of [bend.tangentStart, bend.tangentEnd])
      entities.push({
        kind: "polyline",
        layer: "TANGENT_BEND_LIMIT",
        points,
        closed: false,
      });
  }
  return entities;
}
function edgeSetup(
  part: SheetPart,
  bb: { min: Vector3; max: Vector3 },
): string {
  const outline = outlineBounds(part),
    eps = 1e-4;
  if (Math.abs(bb.min.x - outline.x) < eps) return "X_MIN";
  if (Math.abs(bb.max.x - outline.x - outline.width) < eps) return "X_MAX";
  if (Math.abs(bb.min.y - outline.y) < eps) return "Y_MIN";
  if (Math.abs(bb.max.y - outline.y - outline.height) < eps) return "Y_MAX";
  throw new Error(
    `Domino on ${part.path} does not open onto a supported stock edge`,
  );
}
/** Edge-facing domino sections are separate machining setups, never XY pockets. */
async function dominoEdgeFiles(
  engine: OpenCascadeEngine,
  part: SheetPart,
): Promise<Map<string, DxfEntity[]>> {
  const result = new Map<string, DxfEntity[]>(),
    outline = outlineBounds(part),
    t = part.material.thickness;
  for (const op of part.operations) {
    if (op.kind !== "domino") continue;
    const tool = await engine.recipe(op.recipe),
      bb = engine.bounds(tool);
    if (bb.min.z < 1e-5 || bb.max.z > t - 1e-5) continue;
    const setup = edgeSetup(part, bb),
      xEdge = setup.startsWith("X"),
      axis = xEdge ? "x" : "y";
    if (!result.has(setup))
      result.set(setup, [
        {
          kind: "polyline",
          layer: "EDGE_BLANK",
          closed: true,
          points: [
            { x: 0, y: 0 },
            { x: xEdge ? outline.height : outline.width, y: 0 },
            { x: xEdge ? outline.height : outline.width, y: t },
            { x: 0, y: t },
          ],
        },
      ]);
    const origin: [number, number, number] = xEdge
      ? [(bb.min.x + bb.max.x) / 2, 0, 0]
      : [0, (bb.min.y + bb.max.y) / 2, 0];
    const section = engine.own(
      b.unwrap(
        b.section(tool, {
          origin,
          xDir: xEdge ? [0, 1, 0] : [1, 0, 0],
          yDir: [0, 0, 1],
          zDir: xEdge ? [1, 0, 0] : [0, -1, 0],
        }),
      ),
    );
    const lines = b.meshEdges(section, { tolerance: 0.02, cache: false }).lines,
      segments: { a: Point2; b: Point2 }[] = [];
    const projected = (i: number) => ({
      x: lines[i + (xEdge ? 1 : 0)]! - (xEdge ? outline.y : outline.x),
      y: lines[i + 2]!,
    });
    for (let i = 0; i < lines.length; i += 6)
      segments.push({ a: projected(i), b: projected(i + 3) });
    for (const chain of contourChains(segments))
      result.get(setup)!.push({
        kind: "polyline",
        layer: `DOMINO_EDGE_${setup}_D${(bb.max[axis] - bb.min[axis]).toFixed(3)}`,
        ...chain,
      });
  }
  return result;
}
export interface ThinMaterial {
  /** The narrowest material found, in millimetres. */
  readonly mm: number;
  /** The two contours it lies between, by layer. */
  readonly between: readonly [string, string];
  /** Where on the blank, in its own coordinates. */
  readonly at: Point2;
}
/** Points along a contour, about one per millimetre. */
function contourPoints(entity: DxfEntity): Point2[] {
  if (entity.kind === "circle")
    return Array.from({ length: 48 }, (_, step) => {
      const angle = (step / 48) * 2 * Math.PI;
      return {
        x: entity.x + entity.radius * Math.cos(angle),
        y: entity.y + entity.radius * Math.sin(angle),
      };
    });
  if (entity.kind !== "polyline") return [];
  const points = flattened(entity.points, entity.closed);
  const out: Point2[] = [];
  for (const [index, from] of points.entries()) {
    const to = points[(index + 1) % points.length];
    if (!to || (!entity.closed && index === points.length - 1)) {
      out.push(from);
      continue;
    }
    const steps = Math.max(
      1,
      Math.ceil(Math.hypot(to.x - from.x, to.y - from.y)),
    );
    for (let step = 0; step < steps; step++)
      out.push({
        x: from.x + ((to.x - from.x) * step) / steps,
        y: from.y + ((to.y - from.y) * step) / steps,
      });
  }
  return out;
}
function bounds(points: readonly Point2[]) {
  return {
    minX: Math.min(...points.map((p) => p.x)),
    maxX: Math.max(...points.map((p) => p.x)),
    minY: Math.min(...points.map((p) => p.y)),
    maxY: Math.max(...points.map((p) => p.y)),
  };
}
/** The narrowest stretch of material a part is left with: between two cuts, or
 * between a cut and the blank's edge. Sampled about every millimetre, so it is
 * a check rather than a proof, and it ignores where a cut meets the edge on
 * purpose — a finger notch opens onto it. */
export function thinMaterial(
  entities: readonly DxfEntity[],
  minimum: number,
): ThinMaterial | undefined {
  const edge = entities.filter((e) => e.layer.endsWith("OUTLINE"));
  const cuts = entities.filter(
    (e) => e.layer.startsWith("CUT") || e.layer.startsWith("DRILL"),
  );
  // The finished contour can be its own worst enemy: a finger left hanging on
  // a sliver, or a corner both joints cut, shows up as a neck in it.
  let worst: ThinMaterial | undefined;
  for (const entity of entities)
    if (
      entity.kind === "polyline" &&
      entity.layer === "PART_OUTLINE" &&
      entity.closed
    ) {
      const neck = narrowestNeck(
        flattened(entity.points, true),
        worst?.mm ?? minimum,
        entity.layer,
      );
      if (neck) worst = neck;
    }
  if (!cuts.length) return worst;
  const sampled = new Map<DxfEntity, Point2[]>();
  for (const entity of [...edge, ...cuts])
    sampled.set(entity, contourPoints(entity));
  const edgePoints = edge.flatMap((entity) => sampled.get(entity)!);
  // A pocket that runs out through the edge opens onto it on purpose, as a
  // finger pull does: there is no wall between the two to be thin. Only
  // pockets that stay inside are measured against the edge.
  const outline = entities
    .flatMap((entity) =>
      entity.kind === "polyline" && entity.layer === "PART_OUTLINE"
        ? [flattened(entity.points, true)]
        : [],
    )
    .sort((a, c) => Math.abs(polygonArea(c)) - Math.abs(polygonArea(a)))[0];
  const open = (points: readonly Point2[]) =>
    outline !== undefined &&
    points.some((point) => !strictlyInside(point, outline, 1e-6));
  const measure = (
    a: readonly Point2[],
    b: readonly Point2[],
    layers: readonly [string, string],
  ) => {
    if (!a.length || !b.length) return;
    const limit = worst?.mm ?? minimum;
    const boxA = bounds(a),
      boxB = bounds(b);
    // Nothing to find where the two are already further apart than the limit.
    const apart =
      Math.max(boxA.minX - boxB.maxX, boxB.minX - boxA.maxX, 0) ** 2 +
      Math.max(boxA.minY - boxB.maxY, boxB.minY - boxA.maxY, 0) ** 2;
    if (apart > limit * limit) return;
    for (const p of a)
      for (const q of b) {
        const distance = Math.hypot(p.x - q.x, p.y - q.y);
        if (distance < (worst?.mm ?? minimum) && distance > 1e-6)
          worst = { mm: distance, between: layers, at: p };
      }
  };
  for (const [index, cut] of cuts.entries()) {
    const points = sampled.get(cut)!;
    if (!open(points)) measure(points, edgePoints, [cut.layer, "blank edge"]);
    for (const other of cuts.slice(index + 1))
      measure(points, sampled.get(other)!, [cut.layer, other.layer]);
  }
  return worst;
}
function polygonArea(points: readonly Point2[]): number {
  return points.reduce((sum, p, i) => {
    const q = points[(i + 1) % points.length]!;
    return sum + p.x * q.y - q.x * p.y;
  }, 0);
}
/** The narrowest neck of material inside one closed contour: a concave corner
 * facing another edge across material, closer than `minimum`. A concave corner
 * is where two cuts meet, so that is where a finger or a corner can be left
 * hanging on next to nothing — or on nothing at all, where the contour touches
 * itself. */
export function narrowestNeck(
  points: readonly Point2[],
  minimum: number,
  layer = "PART_OUTLINE",
): ThinMaterial | undefined {
  const count = points.length;
  if (count < 4) return undefined;
  const area = points.reduce((sum, p, i) => {
    const q = points[(i + 1) % count]!;
    return sum + p.x * q.y - q.x * p.y;
  }, 0);
  const counterClockwise = area > 0;
  let worst: ThinMaterial | undefined;
  for (let i = 0; i < count; i++) {
    const before = points[(i + count - 1) % count]!,
      v = points[i]!,
      after = points[(i + 1) % count]!;
    const cross =
      (v.x - before.x) * (after.y - v.y) - (v.y - before.y) * (after.x - v.x);
    const concave = counterClockwise ? cross < -1e-9 : cross > 1e-9;
    if (!concave) continue;
    for (let j = 0; j < count; j++) {
      // Not the two edges that make this corner.
      if (j === i || (j + 1) % count === i) continue;
      const a = points[j]!,
        c = points[(j + 1) % count]!;
      const dx = c.x - a.x,
        dy = c.y - a.y,
        length2 = dx * dx + dy * dy;
      const t = length2
        ? Math.max(
            0,
            Math.min(1, ((v.x - a.x) * dx + (v.y - a.y) * dy) / length2),
          )
        : 0;
      const q = { x: a.x + dx * t, y: a.y + dy * t };
      const distance = Math.hypot(v.x - q.x, v.y - q.y);
      if (distance >= (worst?.mm ?? minimum)) continue;
      // The contour touching itself is a neck of nothing at all.
      if (distance < 1e-6) {
        worst = { mm: 0, between: [layer, layer], at: v };
        continue;
      }
      // Only a gap that crosses material counts: either side of its middle
      // has to be inside the contour, not across a notch.
      const middle = { x: (v.x + q.x) / 2, y: (v.y + q.y) / 2 },
        step = Math.min(0.01, distance / 4),
        nx = (-(q.y - v.y) / distance) * step,
        ny = ((q.x - v.x) / distance) * step;
      if (
        strictlyInside({ x: middle.x + nx, y: middle.y + ny }, points, 1e-6) &&
        strictlyInside({ x: middle.x - nx, y: middle.y - ny }, points, 1e-6)
      )
        worst = { mm: distance, between: [layer, layer], at: v };
    }
  }
  return worst;
}
/** How the CAM layers read on the Drawings plane. */
const view2DColors: readonly (readonly [string, `#${string}`])[] = [
  ["BLANK_OUTLINE", "#5c6773"],
  ["STOCK_BOUNDARY", "#414a55"],
  ["PART_OUTLINE", "#69d2ba"],
  ["DRILL", "#7aa2f7"],
  ["CUT", "#e0902f"],
  ["REFERENCE", "#b48ead"],
];
function view2DColor(layer: string): `#${string}` {
  return (
    view2DColors.find(([prefix]) => layer.startsWith(prefix))?.[1] ?? "#69d2ba"
  );
}
/** A DXF polyline's arcs are stored as bulges; the Drawings plane takes plain
 * points, so each arc is sampled into one. */
function flattened(
  points: readonly DxfVertex[],
  closed: boolean,
): readonly Point2[] {
  const out: Point2[] = [];
  for (const [index, from] of points.entries()) {
    const to = points[(index + 1) % points.length];
    out.push({ x: from.x, y: from.y });
    if (!to || (!closed && index === points.length - 1)) continue;
    const bulge = from.bulge ?? 0;
    if (Math.abs(bulge) < 1e-9) continue;
    const angle = 4 * Math.atan(bulge),
      chord = Math.hypot(to.x - from.x, to.y - from.y);
    if (chord < 1e-9) continue;
    const radius = chord / (2 * Math.sin(Math.abs(angle) / 2));
    const middle = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    const offset = Math.sqrt(Math.max(0, radius * radius - (chord / 2) ** 2));
    const sign = Math.sign(angle) * (Math.abs(angle) > Math.PI ? -1 : 1);
    const centre = {
      x: middle.x - (sign * offset * (to.y - from.y)) / chord,
      y: middle.y + (sign * offset * (to.x - from.x)) / chord,
    };
    const start = Math.atan2(from.y - centre.y, from.x - centre.x);
    const steps = Math.max(2, Math.ceil((Math.abs(angle) / Math.PI) * 24));
    for (let step = 1; step < steps; step++) {
      const at = start + (angle * step) / steps;
      out.push({
        x: centre.x + radius * Math.cos(at),
        y: centre.y + radius * Math.sin(at),
      });
    }
  }
  return out;
}
/** Draw DXF entities onto the Drawings plane, shifted to where they belong. */
function drawEntities(
  view: View2D,
  entities: readonly DxfEntity[],
  offset: Point2,
  label: string,
): void {
  let named = false;
  for (const entity of entities) {
    const color = view2DColor(entity.layer);
    // One label per piece, on its outline, so the plane stays readable.
    const style = {
      color,
      ...(named || entity.kind === "text" ? {} : { label }),
    };
    if (entity.kind === "polyline") {
      view.path(
        flattened(entity.points, entity.closed).map((point) => ({
          x: point.x + offset.x,
          y: point.y + offset.y,
        })),
        { closed: entity.closed, ...style },
      );
      named = true;
    } else if (entity.kind === "circle") {
      view.circle(
        { x: entity.x + offset.x, y: entity.y + offset.y },
        entity.radius,
        { color },
      );
    }
  }
}
/** The geometry the CAM files carry, placed on the Drawings plane: nested
 * sheets where the output nests, otherwise the parts in a row. */
export async function drawManufacturing(
  engine: OpenCascadeEngine,
  output: ManufacturingDxf,
  view: View2D,
): Promise<void> {
  if (!engine.root) throw new Error("Evaluate a project first");
  const parts =
    output.options.parts === "all"
      ? sheetParts(engine.root)
      : output.options.parts;
  const entities = new Map<SheetPart, DxfEntity[]>();
  for (const part of parts)
    entities.set(part, await partEntities(engine, part));
  const gap = 20;
  let x = 0;
  if (output.options.layout === "one-file-per-part") {
    for (const part of parts) {
      const box = outlineBounds(part);
      drawEntities(
        view,
        entities.get(part)!,
        { x: x - box.x, y: -box.y },
        part.path,
      );
      x += box.width + gap;
    }
    return;
  }
  for (const layout of nest(parts)) {
    drawEntities(
      view,
      layoutEntities(layout, entities),
      { x, y: 0 },
      `${layout.material.name} · sheet ${layout.number}`,
    );
    x += layout.material.width! + gap;
  }
}
export async function exportDxf(
  engine: OpenCascadeEngine,
  output: ManufacturingDxf,
  /** Called for every part left thinner than `minimumMaterial` anywhere. */
  onThinMaterial?: (part: SheetPart, finding: ThinMaterial) => void,
): Promise<ReadonlyMap<string, Uint8Array>> {
  if (!engine.root) throw new Error("Evaluate a project first");
  const parts =
    output.options.parts === "all"
      ? sheetParts(engine.root)
      : output.options.parts;
  const files = new Map<string, Uint8Array>(),
    entities = new Map<SheetPart, DxfEntity[]>();
  for (const p of parts) entities.set(p, await partEntities(engine, p));
  const minimum = output.options.minimumMaterial;
  if (minimum !== undefined && onThinMaterial)
    for (const part of parts) {
      const finding = thinMaterial(entities.get(part)!, minimum);
      if (finding) onThinMaterial(part, finding);
    }
  const name = (s: string) => s.replace(/[^a-zA-Z0-9_.-]+/g, "_");
  for (const part of parts)
    for (const [setup, edges] of await dominoEdgeFiles(engine, part))
      files.set(name(part.path) + "-edge-" + setup + ".dxf", encodeDxf(edges));
  if (output.options.layout === "one-file-per-part") {
    for (const p of parts)
      files.set(name(p.path) + ".dxf", encodeDxf(entities.get(p)!));
  } else {
    for (const layout of nest(parts)) {
      files.set(
        name(layout.material.id) + "-" + layout.number + ".dxf",
        encodeDxf(layoutEntities(layout, entities)),
      );
    }
  }
  return files;
}
function layoutEntities(
  layout: SheetLayout,
  entities: Map<SheetPart, DxfEntity[]>,
): DxfEntity[] {
  const all: DxfEntity[] = [
    {
      kind: "polyline",
      layer: "STOCK_BOUNDARY",
      closed: true,
      points: [
        { x: 0, y: 0 },
        { x: layout.material.width!, y: 0 },
        { x: layout.material.width!, y: layout.material.height! },
        { x: 0, y: layout.material.height! },
      ],
    },
  ];
  for (const n of layout.parts) {
    const bb = outlineBounds(n.part);
    const point = (p: Point2): Point2 => {
      const x = p.x - bb.x,
        y = p.y - bb.y;
      switch (n.rotation) {
        case 0:
          return { x: n.x + x, y: n.y + y };
        case 90:
          return { x: n.x + bb.height - y, y: n.y + x };
        case 180:
          return { x: n.x + bb.width - x, y: n.y + bb.height - y };
        case 270:
          return { x: n.x + y, y: n.y + bb.width - x };
      }
    };
    for (const e of entities.get(n.part)!) {
      if (e.kind === "polyline")
        all.push({ ...e, points: e.points.map(point) });
      else all.push({ ...e, ...point(e) });
    }
  }
  return all;
}
export async function layoutDxf(
  engine: OpenCascadeEngine,
  layout: SheetLayout,
): Promise<Uint8Array> {
  const entities = new Map<SheetPart, DxfEntity[]>();
  for (const { part } of layout.parts)
    if (!entities.has(part))
      entities.set(part, await partEntities(engine, part));
  return encodeDxf(layoutEntities(layout, entities));
}
export function layoutSvg(layout: SheetLayout): string {
  const w = layout.material.width!,
    h = layout.material.height!;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#faf7ef" stroke="#222"/>${layout.parts.map((n) => `<g><rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" fill="#d9c399" stroke="#333"/><text x="${n.x + 10}" y="${n.y + 25}" font-size="18">${escapeXml(n.part.label)}</text></g>`).join("")}</svg>`;
}
export function escapeXml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
