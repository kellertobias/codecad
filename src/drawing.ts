import * as b from "brepjs/quick";
import { Matrix4, Vector3 } from "three";
import {
  Part,
  PartInterface,
  descendants,
  type Component,
  type Point3,
} from "./model.js";
import type { TechnicalDrawing, DrawingSubject } from "./outputs.js";
import type { OpenCascadeEngine } from "./engine.js";
import { escapeXml } from "./manufacturing.js";
import { line, text, rectangle, pagesDxf, type ReportPage } from "./reports.js";
export function subjects(subject: DrawingSubject): Part[] {
  const roots = Array.isArray(subject) ? subject : [subject as Component];
  return [
    ...new Set(
      roots
        .flatMap((root) => [root, ...descendants(root)])
        .filter((p): p is Part => p instanceof Part),
    ),
  ];
}
export async function renderDrawing(
  engine: OpenCascadeEngine,
  drawing: TechnicalDrawing,
): Promise<Uint8Array> {
  return (await renderDrawingFormats(engine, drawing)).svg;
}
export async function renderDrawingFormats(
  engine: OpenCascadeEngine,
  drawing: TechnicalDrawing,
): Promise<{ svg: Uint8Array; dxf: Uint8Array }> {
  const sizes = {
      A4: [210, 297],
      A3: [297, 420],
      A2: [420, 594],
      A1: [594, 841],
    },
    size = sizes[drawing.options.paper ?? "A3"]!;
  let [w, h] = size as [number, number];
  if (drawing.options.orientation !== "portrait") [w, h] = [h, w];
  const page: ReportPage = { width: w, height: h, entities: [] };
  rectangle(page, 5, 5, w - 10, h - 10, "BORDER");
  text(page, drawing.options.title, 12, 15, 5, "TITLE");
  const paths: string[] = [
    `<rect x="5" y="5" width="${w - 10}" height="${h - 10}" fill="white" stroke="#aaa"/><text x="12" y="15" font-size="5">${escapeXml(drawing.options.title)}</text>`,
  ];
  const viewInfo = new Map<
    string,
    { camera: b.Camera; x: number; y: number; scale: number }
  >();
  for (const view of drawing.views) {
    const camera =
      view.kind === "isometric" || view.kind === "exploded"
        ? b.unwrap(b.createCamera([0, 0, 0], [1, -1, 1], [1, 1, 0]))
        : b.unwrap(b.cameraFromPlane(view.kind));
    const parts = subjects(view.of);
    const shapes = parts.map((part, i) => {
      let shape = engine.subject(part);
      if (view.kind === "exploded") {
        const amount = view.explode ?? 50;
        shape = engine.transform(
          shape,
          new Matrix4().makeTranslation(((i % 3) - 1) * amount, 0, i * amount),
        );
      }
      return shape;
    });
    const combined = engine.own(b.compound(shapes)),
      projected = b.projectEdges(combined, camera, view.hiddenLines ?? false);
    const visible: number[] = [],
      hidden: number[] = [];
    for (const [edges, target] of [
      [projected.visible, visible],
      [projected.hidden, hidden],
    ] as const) {
      for (const edge of edges) {
        engine.own(edge);
        target.push(
          ...b.meshEdges(edge, { tolerance: 0.03, cache: false }).lines,
        );
      }
    }
    const all = [...visible, ...hidden],
      xs = all.filter((_, i) => i % 3 === 0),
      ys = all.filter((_, i) => i % 3 === 1);
    const minX = xs.length ? Math.min(...xs) : 0,
      maxY = ys.length ? Math.max(...ys) : 0;
    const x = view.at.x - minX * view.scale,
      y = view.at.y + maxY * view.scale;
    viewInfo.set(view.id, { camera, x, y, scale: view.scale });
    for (const [lines, isHidden] of [
      [visible, false],
      [hidden, true],
    ] as const) {
      let d = "";
      for (let i = 0; i < lines.length; i += 6) {
        d += `M${x + lines[i]! * view.scale},${y - lines[i + 1]! * view.scale}L${x + lines[i + 3]! * view.scale},${y - lines[i + 4]! * view.scale}`;
        line(
          page,
          x + lines[i]! * view.scale,
          y - lines[i + 1]! * view.scale,
          x + lines[i + 3]! * view.scale,
          y - lines[i + 4]! * view.scale,
          isHidden ? "HIDDEN" : "VISIBLE",
        );
      }
      paths.push(
        `<path d="${d}" fill="none" stroke="${isHidden ? "#aaa" : "#25353e"}" stroke-width="0.22" ${isHidden ? 'stroke-dasharray="1,1"' : ""}/>`,
      );
    }
  }
  const point = (p: Point3 | PartInterface) =>
    p instanceof PartInterface
      ? new Vector3().setFromMatrixPosition(p.worldMatrix())
      : new Vector3(p.x, p.y, p.z);
  for (const dim of drawing.dimensions) {
    const info = viewInfo.get(dim.view ?? drawing.views[0]?.id ?? "");
    if (!info) throw new Error("Dimension needs a valid drawing view");
    const a = point(dim.from),
      c = point(dim.to),
      distance = a.distanceTo(c),
      axisX = new Vector3(...info.camera.xAxis),
      axisY = new Vector3(...info.camera.yAxis);
    const A = {
        x: info.x + a.dot(axisX) * info.scale,
        y: info.y - a.dot(axisY) * info.scale,
      },
      C = {
        x: info.x + c.dot(axisX) * info.scale,
        y: info.y - c.dot(axisY) * info.scale,
      };
    const len = Math.hypot(C.x - A.x, C.y - A.y);
    if (len < 1e-6)
      throw new Error("Dimension projects to zero length in selected view");
    const ox = (-(C.y - A.y) / len) * dim.offset * info.scale,
      oy = ((C.x - A.x) / len) * dim.offset * info.scale;
    line(page, A.x, A.y, A.x + ox, A.y + oy, "DIMENSIONS");
    line(page, C.x, C.y, C.x + ox, C.y + oy, "DIMENSIONS");
    line(page, A.x + ox, A.y + oy, C.x + ox, C.y + oy, "DIMENSIONS");
    text(
      page,
      dim.label ?? distance.toFixed(1) + " mm",
      (A.x + C.x) / 2 + ox + 1,
      (A.y + C.y) / 2 + oy - 1,
      3,
      "DIMENSION_TEXT",
    );
    paths.push(
      `<path d="M${A.x},${A.y}l${ox},${oy}M${C.x},${C.y}l${ox},${oy}M${A.x + ox},${A.y + oy}L${C.x + ox},${C.y + oy}" fill="none" stroke="#b05035" stroke-width="0.2"/><text x="${(A.x + C.x) / 2 + ox + 1}" y="${(A.y + C.y) / 2 + oy - 1}" font-size="3">${escapeXml(dim.label ?? distance.toFixed(1) + " mm")}</text>`,
    );
  }
  for (const note of drawing.notes) {
    text(page, note.text, note.at.x, note.at.y, 3, "NOTES");
    paths.push(
      `<text x="${note.at.x}" y="${note.at.y}" font-size="3">${escapeXml(note.text)}</text>`,
    );
  }
  return {
    svg: new TextEncoder().encode(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}">${paths.join("")}</svg>`,
    ),
    dxf: pagesDxf([page]),
  };
}
