// Drawing sheets of a document: views of its evaluated bodies projected
// with hidden-line removal, sections cut by any plane with their cut faces
// hatched per material, enlarged details, exploded views and flat blanks.
// A sheet renders to a ReportPage, which the existing writers turn into
// SVG (preview), DXF and PDF.
import * as b from "brepjs/quick";
import { Matrix4, Vector3 } from "three";
import { projectedLines, scaleLabel, viewCamera } from "../drawing.js";
import { hatchTriangles } from "../drawing-style.js";
import { partEntities, type DxfEntity } from "../manufacturing.js";
import { line, rectangle, text, type ReportPage } from "../reports.js";
import { standardScales } from "../view-basis.js";
import type { OpenCascadeEngine } from "../engine.js";
import {
  cross,
  faceFrame,
  frameMatrix,
  normalize,
  type Vec3,
} from "../document/frames.js";
import type {
  CadDocument,
  DrawingSheet,
  DrawingView,
} from "../document/schema.js";
import { evaluateVariables, evaluateWith } from "../document/variables.js";
import type { Body } from "./evaluator.js";
import { sheetProject, type PartInfo } from "./parts.js";

export const paperSizes = {
  A4: { width: 297, height: 210 },
  A3: { width: 420, height: 297 },
  A2: { width: 594, height: 420 },
  A1: { width: 841, height: 594 },
} as const;

type Point = { x: number; y: number };

/** A view in model millimetres on its own paper axes (x right, y up),
 * ready to be scaled and placed. */
interface Prepared {
  readonly view: DrawingView;
  /** Segment endpoints as x, y, depth triples. */
  readonly visible: number[];
  readonly hidden: number[];
  /** Cut faces, as triangles, with how to hatch them. */
  readonly hatches: {
    triangles: Point[][];
    angle: number;
    cross: boolean;
    layer: string;
  }[];
  /** A flat blank's DXF entities (model millimetres). */
  readonly flat?: DxfEntity[];
  readonly min: Point;
  readonly max: Point;
}

const hatchAngles = [45, 135, 0, 90];

function camera(direction: Vec3): b.Camera {
  const toward = normalize(direction);
  // Paper-right runs level where it can.
  const x =
    Math.abs(toward[2]) > 0.999
      ? ([1, 0, 0] as Vec3)
      : normalize(cross([0, 0, 1], toward));
  return b.unwrap(b.createCamera([0, 0, 0], [...toward], [...x]));
}

const bounds = (lines: readonly number[][], extra: Point[] = []) => {
  const min = { x: Infinity, y: Infinity };
  const max = { x: -Infinity, y: -Infinity };
  for (const set of lines)
    for (let i = 0; i < set.length; i += 3) {
      min.x = Math.min(min.x, set[i]!);
      max.x = Math.max(max.x, set[i]!);
      min.y = Math.min(min.y, set[i + 1]!);
      max.y = Math.max(max.y, set[i + 1]!);
    }
  for (const p of extra) {
    min.x = Math.min(min.x, p.x);
    max.x = Math.max(max.x, p.x);
    min.y = Math.min(min.y, p.y);
    max.y = Math.max(max.y, p.y);
  }
  if (!Number.isFinite(min.x))
    return { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } };
  return { min, max };
};

interface Context {
  readonly engine: OpenCascadeEngine;
  readonly document: CadDocument;
  readonly bodies: readonly Body[];
  readonly info: readonly PartInfo[];
  value(expression: string): number;
}

function chosen(context: Context, view: DrawingView): Body[] {
  const bodies = view.bodies?.length
    ? context.bodies.filter((body) => view.bodies!.includes(body.id))
    : [...context.bodies];
  if (!bodies.length) throw new Error(`View ${view.id} has no bodies to draw`);
  return bodies;
}

function materialIndex(context: Context, body: Body): number {
  const material = context.info.find((p) => p.body === body.id)?.material;
  const all = context.document.materials ?? [];
  return material ? all.findIndex((m) => m.id === material.id) : -1;
}

function project(
  context: Context,
  shapes: b.Shape3D[],
  cam: b.Camera,
  hidden: boolean,
): Pick<Prepared, "visible" | "hidden"> {
  return projectedLines(
    context.engine,
    context.engine.own(b.compound(shapes)),
    cam,
    hidden,
    false,
  );
}

function prepare(
  context: Context,
  view: DrawingView,
  prepared: ReadonlyMap<string, Prepared>,
): Prepared {
  const { engine } = context;
  switch (view.kind) {
    case "view": {
      const cam =
        view.angle === "auxiliary"
          ? camera(view.direction as unknown as Vec3)
          : viewCamera(view.angle);
      const shapes = chosen(context, view).map((body) => body.shape);
      const lines = project(context, shapes, cam, !!view.hidden);
      return {
        view,
        ...lines,
        hatches: [],
        ...bounds([lines.visible, lines.hidden]),
      };
    }
    case "exploded": {
      const distance = context.value(view.distance);
      const bodies = chosen(context, view);
      const centre = (shape: b.Shape3D) => {
        const bb = b.getBounds(shape);
        return new Vector3(
          (bb.xMin + bb.xMax) / 2,
          (bb.yMin + bb.yMax) / 2,
          (bb.zMin + bb.zMax) / 2,
        );
      };
      const middle = bodies
        .map((body) => centre(body.shape))
        .reduce((sum, c) => sum.add(c), new Vector3())
        .divideScalar(bodies.length);
      const shapes = bodies.map((body) => {
        const away = centre(body.shape).sub(middle);
        if (away.lengthSq() < 1e-9) away.set(0, 0, 1);
        away.normalize().multiplyScalar(distance);
        return engine.transform(
          body.shape,
          new Matrix4().makeTranslation(away.x, away.y, away.z),
        );
      });
      const lines = project(context, shapes, viewCamera("isometric"), false);
      return {
        view,
        ...lines,
        hatches: [],
        ...bounds([lines.visible, lines.hidden]),
      };
    }
    case "section": {
      const origin = view.origin.map((e) =>
        context.value(e),
      ) as unknown as Vec3;
      const normal = normalize(view.normal as unknown as Vec3);
      if (!Number.isFinite(normal[0]) || Math.hypot(...normal) < 0.5)
        throw new Error(`Section ${view.id} needs a direction`);
      const cam = camera(normal);
      // Keep what lies behind the plane, seen from the side the normal
      // points to: a box reaching far behind it.
      const frame = faceFrame(normal, origin);
      const reach = 1e5;
      const keep = engine.transform(
        engine.own(b.box(2 * reach, 2 * reach, reach)),
        new Matrix4()
          .fromArray(frameMatrix(frame))
          .multiply(new Matrix4().makeTranslation(-reach, -reach, -reach)),
      );
      const cut: b.Shape3D[] = [];
      const hatches: Prepared["hatches"] = [];
      const xAxis = new Vector3(...cam.xAxis);
      const yAxis = new Vector3(...cam.yAxis);
      for (const body of chosen(context, view)) {
        const half = b.intersect(body.shape, keep);
        if (!half.ok) continue;
        const shape = engine.own(half.value);
        if (!b.getFaces(shape).length) continue;
        cut.push(shape);
        const triangles: Point[][] = [];
        for (const face of b.getFaces(shape)) {
          const c = b.faceCenter(face) as unknown as Vec3;
          const n = b.normalAt(face) as unknown as Vec3;
          const off =
            (c[0] - origin[0]) * normal[0] +
            (c[1] - origin[1]) * normal[1] +
            (c[2] - origin[2]) * normal[2];
          const along = n[0] * normal[0] + n[1] * normal[1] + n[2] * normal[2];
          if (Math.abs(off) > 1e-4 || along < 1 - 1e-6) continue;
          const mesh = b.mesh(face, { tolerance: 0.05, cache: false });
          const at = (i: number) => {
            const p = new Vector3(
              mesh.vertices[i * 3]!,
              mesh.vertices[i * 3 + 1]!,
              mesh.vertices[i * 3 + 2]!,
            );
            return { x: p.dot(xAxis), y: p.dot(yAxis) };
          };
          for (let i = 0; i < mesh.triangles.length; i += 3)
            triangles.push([
              at(mesh.triangles[i]!),
              at(mesh.triangles[i + 1]!),
              at(mesh.triangles[i + 2]!),
            ]);
        }
        if (!triangles.length) continue;
        const index = materialIndex(context, body);
        const material = context.document.materials?.[index];
        hatches.push({
          triangles,
          angle: hatchAngles[Math.max(0, index) % hatchAngles.length]!,
          // Solid material is cross-hatched, sheet stock hatched once.
          cross: material?.kind === "solid",
          layer: `SECTION_HATCH_${(material?.id ?? "material").replace(/[^a-zA-Z0-9_-]/g, "_")}`,
        });
      }
      if (!cut.length)
        throw new Error(`Section ${view.id} does not cut through anything`);
      const lines = project(context, cut, cam, false);
      return {
        view,
        ...lines,
        hatches,
        ...bounds([lines.visible, lines.hidden]),
      };
    }
    case "detail": {
      const parent = prepared.get(view.of);
      if (!parent)
        throw new Error(
          `Detail ${view.id} needs the view ${view.of} before it`,
        );
      const { center, radius } = view;
      const clip = (lines: readonly number[]) => {
        const out: number[] = [];
        for (let i = 0; i < lines.length; i += 6) {
          const a = { x: lines[i]! - center.x, y: lines[i + 1]! - center.y };
          const c = {
            x: lines[i + 3]! - center.x,
            y: lines[i + 4]! - center.y,
          };
          // Where the segment a + t (c - a) lies inside the circle.
          const d = { x: c.x - a.x, y: c.y - a.y };
          const qa = d.x * d.x + d.y * d.y;
          const qb = 2 * (a.x * d.x + a.y * d.y);
          const qc = a.x * a.x + a.y * a.y - radius * radius;
          const disc = qb * qb - 4 * qa * qc;
          if (qa < 1e-12 || disc <= 0) continue;
          const t0 = Math.max(0, (-qb - Math.sqrt(disc)) / (2 * qa));
          const t1 = Math.min(1, (-qb + Math.sqrt(disc)) / (2 * qa));
          if (t1 <= t0) continue;
          out.push(
            center.x + a.x + d.x * t0,
            center.y + a.y + d.y * t0,
            0,
            center.x + a.x + d.x * t1,
            center.y + a.y + d.y * t1,
            0,
          );
        }
        return out;
      };
      return {
        view,
        visible: clip(parent.visible),
        hidden: clip(parent.hidden),
        hatches: [],
        min: { x: center.x - radius, y: center.y - radius },
        max: { x: center.x + radius, y: center.y + radius },
      };
    }
    case "flat":
      throw new Error("Flat views are prepared separately");
  }
}

async function prepareFlat(
  context: Context,
  view: Extract<DrawingView, { kind: "flat" }>,
): Promise<Prepared> {
  const part = sheetProject(
    context.document,
    context.bodies,
    context.info,
  ).parts.get(view.part);
  if (!part) throw new Error(`${view.part} is not a sheet part`);
  const flat = await partEntities(context.engine, part);
  const points = flat.flatMap((e) =>
    e.kind === "polyline"
      ? e.points
      : e.kind === "circle"
        ? [
            { x: e.x - e.radius, y: e.y - e.radius },
            { x: e.x + e.radius, y: e.y + e.radius },
          ]
        : [],
  );
  return {
    view,
    visible: [],
    hidden: [],
    hatches: [],
    flat,
    ...bounds([], points),
  };
}

/** Renders a drawing sheet: views placed and scaled, labelled, framed. */
export async function renderSheet(
  engine: OpenCascadeEngine,
  document: CadDocument,
  bodies: readonly Body[],
  info: readonly PartInfo[],
  sheet: DrawingSheet,
): Promise<ReportPage> {
  const variables = evaluateVariables(document.variables);
  const context: Context = {
    engine,
    document,
    bodies,
    info,
    value: (expression) => evaluateWith(expression, variables),
  };
  const paper = paperSizes[sheet.size];
  const page: ReportPage = { ...paper, entities: [] };
  const margin = 10;
  const titleHeight = 18;
  rectangle(
    page,
    margin / 2,
    margin / 2,
    paper.width - margin,
    paper.height - margin,
    "BORDER",
  );

  const prepared = new Map<string, Prepared>();
  for (const view of sheet.views)
    prepared.set(
      view.id,
      view.kind === "flat"
        ? await prepareFlat(context, view)
        : prepare(context, view, prepared),
    );

  // Views without a place share a grid; views without a scale share the
  // largest standard scale at which every one fits its cell.
  const views = sheet.views;
  const columns = Math.ceil(Math.sqrt(views.length));
  const rows = Math.ceil(views.length / columns);
  const region = {
    x: margin,
    y: margin,
    width: paper.width - 2 * margin,
    height: paper.height - 2 * margin - titleHeight,
  };
  const cell = { width: region.width / columns, height: region.height / rows };
  const size = (p: Prepared) => ({
    width: Math.max(p.max.x - p.min.x, 1),
    height: Math.max(p.max.y - p.min.y, 1),
  });
  const fitting = views
    .filter((view) => view.scale === undefined && view.kind !== "detail")
    .map((view) => {
      const s = size(prepared.get(view.id)!);
      return Math.min(
        (cell.width - 12) / s.width,
        (cell.height - 16) / s.height,
      );
    });
  const common =
    standardScales.find((scale) => fitting.every((fit) => scale <= fit)) ??
    standardScales.at(-1)!;
  const scales = new Map<string, number>();
  for (const view of views)
    scales.set(
      view.id,
      view.scale ??
        (view.kind === "detail" ? (scales.get(view.of) ?? common) * 2 : common),
    );

  views.forEach((view, i) => {
    const p = prepared.get(view.id)!;
    const scale = scales.get(view.id)!;
    const centre = view.at ?? {
      x: region.x + cell.width * ((i % columns) + 0.5),
      y: region.y + cell.height * (Math.floor(i / columns) + 0.5) - 4,
    };
    // Model point to paper point: centred, y down on paper.
    const mid = { x: (p.min.x + p.max.x) / 2, y: (p.min.y + p.max.y) / 2 };
    const paperAt = (x: number, y: number) => ({
      x: centre.x + (x - mid.x) * scale,
      y: centre.y - (y - mid.y) * scale,
    });
    for (const hatch of p.hatches) {
      const triangles = hatch.triangles.map((t) =>
        t.map((q) => paperAt(q.x, q.y)),
      );
      for (const angle of hatch.cross
        ? [hatch.angle, hatch.angle + 90]
        : [hatch.angle])
        for (const points of hatchTriangles(triangles, 2, angle))
          page.entities.push({
            kind: "polyline",
            layer: hatch.layer,
            points,
            closed: false,
            style: { stroke: "#606060", lineWidth: 0.13 },
          });
    }
    for (const [lines, layer] of [
      [p.hidden, "HIDDEN"],
      [p.visible, "VISIBLE"],
    ] as const)
      for (let j = 0; j < lines.length; j += 6) {
        const a = paperAt(lines[j]!, lines[j + 1]!);
        const c = paperAt(lines[j + 3]!, lines[j + 4]!);
        line(page, a.x, a.y, c.x, c.y, layer);
      }
    for (const entity of p.flat ?? []) {
      if (entity.kind === "polyline")
        page.entities.push({
          ...entity,
          points: entity.points.map((q) => ({
            ...q,
            ...paperAt(q.x, q.y),
            // Paper y runs down: arcs turn the other way.
            ...(q.bulge !== undefined ? { bulge: -q.bulge } : {}),
          })),
        });
      else if (entity.kind === "circle")
        page.entities.push({
          ...entity,
          ...paperAt(entity.x, entity.y),
          radius: entity.radius * scale,
        });
      else
        page.entities.push({
          ...entity,
          ...paperAt(entity.x, entity.y),
          height: 2.5,
        });
    }
    if (view.kind === "detail") {
      // The circle on the view it enlarges, and on the detail itself.
      const parent = prepared.get(view.of)!;
      const parentScale = scales.get(view.of)!;
      const parentView = views.indexOf(parent.view);
      const parentCentre = parent.view.at ?? {
        x: region.x + cell.width * ((parentView % columns) + 0.5),
        y:
          region.y + cell.height * (Math.floor(parentView / columns) + 0.5) - 4,
      };
      const pm = {
        x: (parent.min.x + parent.max.x) / 2,
        y: (parent.min.y + parent.max.y) / 2,
      };
      page.entities.push({
        kind: "circle",
        layer: "DETAIL",
        x: parentCentre.x + (view.center.x - pm.x) * parentScale,
        y: parentCentre.y - (view.center.y - pm.y) * parentScale,
        radius: view.radius * parentScale,
      });
      page.entities.push({
        kind: "circle",
        layer: "DETAIL",
        ...paperAt(view.center.x, view.center.y),
        radius: view.radius * scale,
      });
    }
    const labelY = centre.y + ((p.max.y - p.min.y) / 2) * scale + 6;
    text(
      page,
      `${view.label ?? defaultLabel(view)}  ${scaleLabel(scale)}`,
      centre.x,
      labelY,
      3,
      "LABEL",
    );
    const label = page.entities.at(-1);
    if (label?.kind === "text") Object.assign(label, { align: "middle" });
  });

  // Title block.
  const tx = paper.width - margin / 2 - 130;
  const ty = paper.height - margin / 2 - titleHeight;
  rectangle(page, tx, ty, 130, titleHeight, "BORDER");
  text(page, sheet.name, tx + 4, ty + 8, 5, "TITLE");
  text(
    page,
    `CodeCAD · ${sheet.size} · ${new Date().toISOString().slice(0, 10)}`,
    tx + 4,
    ty + 14,
    2.8,
    "TITLE",
  );
  return page;
}

function defaultLabel(view: DrawingView): string {
  switch (view.kind) {
    case "view":
      return view.angle === "auxiliary"
        ? "Auxiliary view"
        : `${view.angle[0]!.toUpperCase()}${view.angle.slice(1)} view`;
    case "section":
      return "Section";
    case "detail":
      return "Detail";
    case "exploded":
      return "Exploded view";
    case "flat":
      return "Blank";
  }
}

export { partSheets } from "../document/sheets.js";
