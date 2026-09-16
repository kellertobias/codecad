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
} from "./stock.js";
import type { CutList, ManufacturingDxf } from "./outputs.js";
import type { OpenCascadeEngine } from "./engine.js";
import { formatMm } from "./precision.js";

export interface CutRow {
  path: string;
  label: string;
  material: string;
  width: number;
  height: number;
  thickness: number;
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
export function cutRows(root: Component, output?: CutList): CutRow[] {
  return [root, ...descendants(root)]
    .filter(
      (p): p is SheetPart | BlockPart =>
        p instanceof SheetPart || p instanceof BlockPart,
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
        ? { ...outlineBounds(p), thickness: p.material.thickness }
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
      ],
      ...rows.map((r) => [
        r.path,
        r.label,
        r.material,
        formatMm(r.width, mmPrecision),
        formatMm(r.height, mmPrecision),
        formatMm(r.thickness, mmPrecision),
        r.quantity,
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
    type Free = { x: number; y: number; w: number; h: number };
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
    for (const { part, copy } of entries) {
      const dim = outlineBounds(part);
      const grain = material.options.grain ?? "none",
        partGrain = part.grain;
      const allowed = material.options.rotations ?? [0, 90];
      const orientations = [...new Set(allowed)].filter((r) => {
        if (grain === "none" || partGrain === "none") return true;
        return (grain === partGrain) === (r % 180 === 0);
      });
      const fits = (f: Free, r: number) =>
        (r % 180 === 0 ? dim.width : dim.height) <= f.w + 1e-8 &&
        (r % 180 === 0 ? dim.height : dim.width) <= f.h + 1e-8;
      if (!orientations.some((r) => fits({ x: 0, y: 0, w: W, h: H }, r)))
        throw new Error(
          `Part ${part.path} does not fit stock ${material.name} with its grain/rotation constraints`,
        );
      let chosen: (typeof sheets)[number] | undefined,
        index = -1,
        rotation: 0 | 90 | 180 | 270 = 0;
      for (const s of sheets) {
        for (let i = 0; i < s.free.length; i++) {
          const r = orientations.find((r) => fits(s.free[i]!, r));
          if (r !== undefined) {
            chosen = s;
            index = i;
            rotation = r;
            break;
          }
        }
        if (chosen) break;
      }
      if (!chosen) {
        chosen = {
          layout: { material, number: sheets.length + 1, parts: [] },
          free: [{ x: margin, y: margin, w: W, h: H }],
        };
        sheets.push(chosen);
        index = 0;
        rotation = orientations.find((r) => fits(chosen!.free[0]!, r))!;
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
      if (free.w - w - gap > 0)
        chosen.free.push({
          x: free.x + w + gap,
          y: free.y,
          w: free.w - w - gap,
          h,
        });
      if (free.h - h - gap > 0)
        chosen.free.push({
          x: free.x,
          y: free.y + h + gap,
          w: free.w,
          h: free.h - h - gap,
        });
    }
    results.push(...sheets.map((s) => s.layout));
  }
  return results;
}
export type DxfEntity =
  | {
      kind: "polyline";
      layer: string;
      points: Point2[];
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
function contourChains(
  segments: { a: Point2; b: Point2 }[],
): { points: Point2[]; closed: boolean }[] {
  const chains: { points: Point2[]; closed: boolean }[] = [],
    near = (a: Point2, b: Point2) => Math.hypot(a.x - b.x, a.y - b.y) < 0.0001;
  while (segments.length) {
    const first = segments.pop()!,
      points = [first.a, first.b];
    let found = true;
    while (found) {
      found = false;
      const end = points.at(-1)!;
      for (let i = 0; i < segments.length; i++) {
        const s = segments[i]!;
        if (near(end, s.a) || near(end, s.b)) {
          points.push(near(end, s.a) ? s.b : s.a);
          segments.splice(i, 1);
          found = true;
          break;
        }
      }
    }
    const closed = near(points[0]!, points.at(-1)!);
    if (closed) points.pop();
    chains.push({ points, closed });
  }
  return chains;
}
export function encodeDxf(entities: DxfEntity[]): Uint8Array {
  const out: (string | number)[] = [
    0,
    "SECTION",
    2,
    "HEADER",
    9,
    "$ACADVER",
    1,
    "AC1018",
    9,
    "$INSUNITS",
    70,
    4,
    0,
    "ENDSEC",
    0,
    "SECTION",
    2,
    "TABLES",
    0,
    "TABLE",
    2,
    "LTYPE",
    70,
    3,
    0,
    "LTYPE",
    2,
    "CONTINUOUS",
    70,
    0,
    3,
    "Solid",
    72,
    65,
    73,
    0,
    40,
    0,
    0,
    "LTYPE",
    2,
    "CENTER",
    70,
    0,
    3,
    "Bend center / tangent",
    72,
    65,
    73,
    4,
    40,
    5.5,
    49,
    3,
    74,
    0,
    49,
    -1,
    74,
    0,
    49,
    0.5,
    74,
    0,
    49,
    -1,
    74,
    0,
    0,
    "LTYPE",
    2,
    "HIDDEN",
    70,
    0,
    3,
    "Hidden edges",
    72,
    65,
    73,
    2,
    40,
    2,
    49,
    1,
    74,
    0,
    49,
    -1,
    74,
    0,
    0,
    "ENDTAB",
    0,
    "TABLE",
    2,
    "LAYER",
    70,
    new Set(entities.map((e) => e.layer)).size,
  ];
  for (const layer of new Set(entities.map((e) => e.layer)))
    out.push(
      0,
      "LAYER",
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
          : "CONTINUOUS",
    );
  out.push(0, "ENDTAB", 0, "ENDSEC", 0, "SECTION", 2, "ENTITIES");
  for (const e of entities) {
    if (e.kind === "text")
      out.push(
        0,
        "TEXT",
        8,
        e.layer,
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
        72,
        e.align === "middle" ? 1 : 0,
        11,
        e.x,
        21,
        e.y,
        31,
        0,
      );
    else if (e.kind === "circle")
      out.push(0, "CIRCLE", 8, e.layer, 10, e.x, 20, e.y, 30, 0, 40, e.radius);
    else {
      out.push(
        0,
        "LWPOLYLINE",
        8,
        e.layer,
        90,
        e.points.length,
        70,
        e.closed ? 1 : 0,
      );
      if (e.style?.stroke)
        out.push(420, Number.parseInt(e.style.stroke.slice(1), 16));
      if (e.style?.lineWidth !== undefined) {
        const weights = [
          0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100,
          106, 120, 140, 158, 200, 211,
        ];
        const requested = e.style.lineWidth * 100;
        out.push(
          370,
          weights.reduce((best, weight) =>
            Math.abs(weight - requested) < Math.abs(best - requested)
              ? weight
              : best,
          ),
        );
      }
      for (const p of e.points) out.push(10, p.x, 20, p.y);
    }
  }
  out.push(0, "ENDSEC", 0, "EOF");
  return new TextEncoder().encode(out.join("\n") + "\n");
}
export async function partEntities(
  engine: OpenCascadeEngine,
  part: SheetPart,
): Promise<DxfEntity[]> {
  if (part instanceof SheetMetalPart) return sheetMetalEntities(engine, part);
  const entities: DxfEntity[] = [
    {
      kind: "polyline",
      layer: "BLANK_OUTLINE",
      points: part.manufacturingOutline.points,
      closed: true,
    },
  ];
  for (const [i, op] of part.operations.entries()) {
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
    const section = engine.own(
      b.unwrap(
        b.section(tool, {
          origin: [0, 0, (z0 + z1) / 2],
          xDir: [1, 0, 0],
          yDir: [0, 1, 0],
          zDir: [0, 0, 1],
        }),
      ),
    );
    const edges = b.meshEdges(section, { tolerance: 0.02, cache: false });
    const lines = edges.lines;
    // Segments remain exact to the explicitly stated 0.02 mm curve tessellation tolerance.
    const seen = new Set<string>();
    const segments: { a: Point2; b: Point2 }[] = [];
    for (let j = 0; j < lines.length; j += 6) {
      const p = { x: lines[j]!, y: lines[j + 1]! },
        q = { x: lines[j + 3]!, y: lines[j + 4]! };
      const key = [
        `${p.x.toFixed(5)},${p.y.toFixed(5)}`,
        `${q.x.toFixed(5)},${q.y.toFixed(5)}`,
      ]
        .sort()
        .join("|");
      if (!seen.has(key)) {
        seen.add(key);
        segments.push({ a: p, b: q });
      }
    }
    void i;
    for (const chain of contourChains(segments))
      entities.push({ kind: "polyline", layer, ...chain });
  }
  return entities;
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
export async function exportDxf(
  engine: OpenCascadeEngine,
  output: ManufacturingDxf,
): Promise<ReadonlyMap<string, Uint8Array>> {
  if (!engine.root) throw new Error("Evaluate a project first");
  const parts =
    output.options.parts === "all"
      ? sheetParts(engine.root)
      : output.options.parts;
  const files = new Map<string, Uint8Array>(),
    entities = new Map<SheetPart, DxfEntity[]>();
  for (const p of parts) entities.set(p, await partEntities(engine, p));
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
