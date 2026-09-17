import * as b from "brepjs/quick";
import { Matrix4, Vector3 } from "three";
import {
  Part,
  PartInterface,
  descendants,
  type Component,
  type Point3,
} from "./model.js";
import {
  SheetMetalPart,
  SheetPart,
  BlockPart,
  MetalStockPart,
} from "./stock.js";
import {
  hatchTriangles,
  type DrawingLineStyle,
  type MaterialDrawingStyle,
} from "./drawing-style.js";
import type { TechnicalDrawing, DrawingSubject } from "./outputs.js";
import type { OpenCascadeEngine } from "./engine.js";
import { partEntities } from "./manufacturing.js";
import { formatMm } from "./precision.js";
import {
  line,
  text,
  rectangle,
  pageSvg,
  pagesDxf,
  type ReportPage,
} from "./reports.js";

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
export const scaleLabel = (scale: number) =>
  scale >= 1
    ? `${Number(scale.toFixed(3))}:1`
    : `1:${Number((1 / scale).toFixed(3))}`;

/** Sample the trimmed HLR curves, never a cached polygon from the source edge. */
export function drawingCurveLines(shape: b.AnyShape): number[] {
  const result: number[] = [];
  for (const edge of b.getEdges(shape)) {
    const at = (t: number) => new Vector3(...b.curvePointAt(edge, t));
    const sample = (
      t0: number,
      a: Vector3,
      t1: number,
      c: Vector3,
      depth: number,
    ) => {
      const middle = (t0 + t1) / 2,
        p = at(middle);
      const chord = c.clone().sub(a),
        length2 = chord.lengthSq();
      const deviation = (q: Vector3) =>
        q.distanceTo(
          a
            .clone()
            .addScaledVector(
              chord,
              length2
                ? Math.max(
                    0,
                    Math.min(1, q.clone().sub(a).dot(chord) / length2),
                  )
                : 0,
            ),
        );
      if (
        depth < 18 &&
        Math.max(
          deviation(p),
          deviation(at((3 * t0 + t1) / 4)),
          deviation(at((t0 + 3 * t1) / 4)),
        ) > 0.01
      ) {
        sample(t0, a, middle, p, depth + 1);
        sample(middle, p, t1, c, depth + 1);
      } else if (a.distanceToSquared(c) > 1e-16)
        result.push(...a.toArray(), ...c.toArray());
    };
    sample(0, at(0), 1, at(1), 0);
  }
  return result;
}

/** Tangent seams are not manufactured edges. Retain true outlines and sharp edges. */
export function projectedLines(
  engine: OpenCascadeEngine,
  shape: b.AnyShape,
  camera: b.Camera,
  hidden = false,
  tangent = false,
) {
  const kernel = b.getKernel();
  const projection = kernel.projectEdges(
    shape.wrapped,
    [...camera.position],
    [...camera.direction],
    [...camera.xAxis],
  );
  // OCCT sometimes puts Boolean-generated tangent seams in its sharp bucket.
  // Suppress those only when no real 3D sharp edge shares the projection.
  // Comparing tangent projections alone incorrectly erases unrelated edges.
  type Segment = [number, number, number, number];
  const smoothSegments: Segment[] = [],
    sharpSegments: Segment[] = [];
  if (!tangent)
    for (const edge of b.getEdges(shape)) {
      const faces = b.facesOfEdge(shape, edge);
      let smooth = false;
      if (faces.length === 2) {
        const p = b.curvePointAt(edge, 0.5);
        const n1 = new Vector3(...b.normalAt(faces[0]!, p)),
          n2 = new Vector3(...b.normalAt(faces[1]!, p));
        smooth =
          Math.abs(n1.dot(n2)) > Math.cos((3 * Math.PI) / 180) &&
          Math.abs(n1.dot(new Vector3(...camera.direction))) >= 0.01;
      }
      const edges = b.meshEdges(edge, { tolerance: 0.015, cache: false }).lines;
      for (let i = 0; i < edges.length; i += 6) {
        const a = new Vector3(edges[i]!, edges[i + 1]!, edges[i + 2]!);
        const c = new Vector3(edges[i + 3]!, edges[i + 4]!, edges[i + 5]!);
        (smooth ? smoothSegments : sharpSegments).push([
          a.dot(new Vector3(...camera.xAxis)),
          a.dot(new Vector3(...camera.yAxis)),
          c.dot(new Vector3(...camera.xAxis)),
          c.dot(new Vector3(...camera.yAxis)),
        ]);
      }
    }
  const matches = (
    segments: Segment[],
    ax: number,
    ay: number,
    bx: number,
    by: number,
  ) =>
    segments.some(([x1, y1, x2, y2]) => {
      const dx = x2 - x1,
        dy = y2 - y1,
        length = Math.hypot(dx, dy);
      if (length < 1e-8) return false;
      return [
        [ax, ay],
        [bx, by],
      ].every(([x, y]) => {
        const t = ((x! - x1) * dx + (y! - y1) * dy) / (length * length);
        return (
          t >= -1e-5 &&
          t <= 1.00001 &&
          Math.abs((x! - x1) * dy - (y! - y1) * dx) / length < 0.02
        );
      });
    });
  const result = { visible: [] as number[], hidden: [] as number[] };
  for (const side of ["visible", "hidden"] as const) {
    for (const kind of ["outline", "sharp", "smooth"] as const) {
      const raw = projection[side][kind];
      try {
        if ((side === "visible" || hidden) && (kind !== "smooth" || tangent)) {
          const lines = drawingCurveLines(engine.own(b.castShape(raw)));
          for (let i = 0; i < lines.length; i += 6) {
            const segment: Segment = [
              lines[i]!,
              lines[i + 1]!,
              lines[i + 3]!,
              lines[i + 4]!,
            ];
            if (
              kind === "sharp" &&
              matches(smoothSegments, ...segment) &&
              !matches(sharpSegments, ...segment)
            )
              continue;
            result[side].push(...lines.slice(i, i + 6));
          }
        }
      } finally {
        kernel.dispose(raw);
      }
    }
  }
  return result;
}

function titleBlock(
  page: ReportPage,
  drawing: TechnicalDrawing,
  number: number,
  total: number,
) {
  const o = drawing.options,
    x = page.width - 180,
    y = page.height - 50;
  rectangle(page, 10, 10, page.width - 20, page.height - 20, "BORDER");
  rectangle(page, x, y, 170, 40, "BORDER");
  for (const dy of [14, 27]) line(page, x, y + dy, x + 170, y + dy, "BORDER");
  const cell = (
    label: string,
    value: string,
    cx: number,
    cy: number,
    size = 3.2,
  ) => {
    text(page, label, cx + 2, cy + 3.5, 1.9, "TITLE_LABEL");
    text(page, value, cx + 2, cy + 9, size, "TITLE_TEXT");
  };
  cell(
    "PROJECT / DRAWING TITLE",
    o.title,
    x,
    y,
    Math.min(3.5, 300 / Math.max(1, o.title.length)),
  );
  line(page, x + 95, y + 14, x + 95, y + 27, "BORDER");
  cell("PROJECT", o.project ?? o.title, x, y + 14, 2.8);
  cell("MATERIAL", o.material ?? "See part specification", x + 95, y + 14, 2.8);
  const scales = [...new Set(drawing.views.map((v) => scaleLabel(v.scale)))];
  const fields = [
    ["DRAWING NO.", o.drawingNumber ?? o.id ?? "-", 0],
    ["REV", o.revision ?? "A", 50],
    [
      "SCALE / UNITS",
      `${scales.length === 1 ? scales[0] : "AS SHOWN"} / mm`,
      70,
    ],
    ["DRAWN BY", o.author ?? "CodeCAD", 111],
    ["SHEET", `${number} / ${total}`, 149],
  ] as const;
  for (const [label, value, dx] of fields) {
    if (dx) line(page, x + dx, y + 27, x + dx, y + 40, "BORDER");
    cell(label, value, x + dx, y + 27, 2.6);
  }
  const s = drawing.views[0]?.scale ?? 1,
    bx = x,
    by = y - 15;
  text(page, `GRAPHIC SCALE ${scaleLabel(s)} · PRINT AT 100%`, bx, by - 2, 2.4);
  for (let i = 0; i < 5; i++)
    rectangle(
      page,
      bx + i * 10,
      by,
      10,
      3.5,
      i % 2 ? "SCALE_LIGHT" : "SCALE_DARK",
    );
  text(page, "0", bx, by + 7, 2.2);
  text(page, "50 mm PRINTED", bx + 50, by + 7, 2.2);
  text(
    page,
    `${formatMm(50 / s, o.mmPrecision, 2)} mm REAL`,
    bx + 95,
    by + 7,
    2.2,
  );
}

async function drawingPage(
  engine: OpenCascadeEngine,
  drawing: TechnicalDrawing,
  number: number,
  total: number,
): Promise<ReportPage> {
  const sizes = {
    A4: [210, 297],
    A3: [297, 420],
    A2: [420, 594],
    A1: [594, 841],
  };
  let [w, h] = sizes[drawing.options.paper ?? "A3"] as [number, number];
  if (drawing.options.orientation !== "portrait") [w, h] = [h, w];
  const page: ReportPage = { width: w, height: h, entities: [] };
  titleBlock(page, drawing, number, total);
  const viewInfo = new Map<
    string,
    { camera: b.Camera; x: number; y: number; scale: number; flat: boolean }
  >();
  for (const view of drawing.views) {
    const camera =
      view.kind === "isometric" || view.kind === "exploded"
        ? b.unwrap(b.createCamera([0, 0, 0], [1, -1, 1], [1, 1, 0]))
        : view.kind === "top" || view.kind === "flat" || view.kind === "bottom"
          ? b.unwrap(
              b.createCamera(
                [0, 0, 0],
                [0, 0, view.kind === "bottom" ? -1 : 1],
                [1, 0, 0],
              ),
            )
          : b.unwrap(b.cameraFromPlane(view.kind));
    const parts = subjects(view.of);
    if (view.kind === "flat") {
      if (parts.length !== 1 || !(parts[0] instanceof SheetMetalPart))
        throw new Error("A flat view needs exactly one sheet-metal part");
      const entities = await partEntities(engine, parts[0]);
      const bounds = parts[0].manufacturingOutline.points;
      const minX = Math.min(...bounds.map((p) => p.x)),
        maxY = Math.max(...bounds.map((p) => p.y));
      const x = view.at.x - minX * view.scale,
        y = view.at.y + maxY * view.scale;
      viewInfo.set(view.id, { camera, x, y, scale: view.scale, flat: true });
      for (const e of entities) {
        if (e.kind === "polyline")
          page.entities.push({
            ...e,
            ...(parts[0].material.options.drawingStyle?.regular
              ? { style: parts[0].material.options.drawingStyle.regular }
              : {}),
            points: e.points.map((p) => ({
              x: x + p.x * view.scale,
              y: y - p.y * view.scale,
            })),
          });
        else
          page.entities.push({
            ...e,
            x: x + e.x * view.scale,
            y: y - e.y * view.scale,
            ...(e.kind === "circle"
              ? { radius: e.radius * view.scale }
              : { height: 2.5 }),
          });
      }
    } else {
      const styled: {
        shape: b.AnyShape;
        style: DrawingLineStyle;
        cut: boolean;
        layer: string;
      }[] = [];
      const caps: {
        face: b.AnyShape;
        style: NonNullable<MaterialDrawingStyle["cutaway"]>;
        layer: string;
      }[] = [];
      const shapes = parts.flatMap((part, i) => {
        let shape = engine.subject(part);
        const material =
          part.drawingMaterial ??
          (part instanceof SheetPart ||
          part instanceof BlockPart ||
          part instanceof MetalStockPart
            ? part.material
            : undefined);
        const style = material?.options.drawingStyle;
        const materialLayer = (material?.id ?? "material").replace(
          /[^a-zA-Z0-9_-]/g,
          "_",
        );
        let cut = false;
        if (view.cutHeight !== undefined) {
          const bb = engine.bounds(shape);
          if (bb.min.z >= view.cutHeight) return [];
          if (bb.max.z > view.cutHeight) {
            cut = true;
            const box = engine.own(
              b.box(
                bb.max.x - bb.min.x + 2,
                bb.max.y - bb.min.y + 2,
                view.cutHeight - bb.min.z + 1,
              ),
            );
            const clip = engine.transform(
              box,
              new Matrix4().makeTranslation(
                bb.min.x - 1,
                bb.min.y - 1,
                bb.min.z - 1,
              ),
            );
            shape = engine.own(b.unwrap(b.intersect(shape, clip)));
          }
        }
        if (view.kind === "exploded")
          shape = engine.transform(
            shape,
            new Matrix4().makeTranslation(
              ((i % 3) - 1) * (view.explode ?? 50),
              0,
              i * (view.explode ?? 50),
            ),
          );
        if (style?.regular)
          styled.push({
            shape,
            style: style.regular,
            cut: false,
            layer: `VISIBLE_${materialLayer}`,
          });
        if (cut && style?.cutaway) {
          const height =
            view.cutHeight! +
            (view.kind === "exploded" ? i * (view.explode ?? 50) : 0);
          for (const face of b.getFaces(shape)) {
            const bounds = engine.bounds(face);
            if (
              Math.abs(bounds.min.z - height) > 1e-4 ||
              Math.abs(bounds.max.z - height) > 1e-4
            )
              continue;
            caps.push({
              face,
              style: style.cutaway,
              layer: `SECTION_HATCH_${materialLayer}`,
            });
            styled.push({
              shape: face,
              style: { ...style.regular, ...style.cutaway },
              cut: true,
              layer: `SECTION_${materialLayer}`,
            });
          }
        }
        return [shape];
      });
      const { visible, hidden } = projectedLines(
        engine,
        engine.own(b.compound(shapes)),
        camera,
        view.hiddenLines,
        view.tangentEdges,
      );
      const all = [...visible, ...hidden],
        xs = all.filter((_, i) => i % 3 === 0),
        ys = all.filter((_, i) => i % 3 === 1);
      const x = view.at.x - (xs.length ? Math.min(...xs) : 0) * view.scale,
        y = view.at.y + (ys.length ? Math.max(...ys) : 0) * view.scale;
      viewInfo.set(view.id, { camera, x, y, scale: view.scale, flat: false });
      for (const cap of caps) {
        const hatch = cap.style.hatch;
        if (!hatch) continue;
        const mesh = b.mesh(cap.face, {
          tolerance: 0.025,
          angularTolerance: 0.08,
          cache: false,
        });
        const project = (index: number) => {
          const p = new Vector3(
            mesh.vertices[index * 3]!,
            mesh.vertices[index * 3 + 1]!,
            mesh.vertices[index * 3 + 2]!,
          );
          return {
            x: x + p.dot(new Vector3(...camera.xAxis)) * view.scale,
            y: y - p.dot(new Vector3(...camera.yAxis)) * view.scale,
          };
        };
        const triangles: { x: number; y: number }[][] = [];
        for (let i = 0; i < mesh.triangles.length; i += 3)
          triangles.push([
            project(mesh.triangles[i]!),
            project(mesh.triangles[i + 1]!),
            project(mesh.triangles[i + 2]!),
          ]);
        for (const angle of hatch.cross
          ? [hatch.angle ?? 45, (hatch.angle ?? 45) + 90]
          : [hatch.angle ?? 45])
          for (const points of hatchTriangles(
            triangles,
            hatch.spacing ?? 2,
            angle,
          ))
            page.entities.push({
              kind: "polyline",
              layer: cap.layer,
              points,
              closed: false,
              style: {
                stroke: hatch.stroke ?? cap.style.stroke ?? "#606060",
                lineWidth: hatch.lineWidth ?? 0.13,
              },
            });
      }
      // Retain the compound HLR result (including occlusion); only attribute its
      // surviving edges to material styles. Cut edges take precedence at seams.
      const candidates = styled
        .map((entry) => {
          const projected = projectedLines(
            engine,
            entry.shape,
            camera,
            true,
            view.tangentEdges,
          );
          return {
            ...entry,
            lines: [...projected.visible, ...projected.hidden],
          };
        })
        .sort((a, c) => Number(c.cut) - Number(a.cut));
      const styleAt = (ax: number, ay: number, bx: number, by: number) =>
        candidates.find(({ lines }) => {
          const mx = (ax + bx) / 2,
            my = (ay + by) / 2;
          for (let j = 0; j < lines.length; j += 6) {
            const dx = lines[j + 3]! - lines[j]!,
              dy = lines[j + 4]! - lines[j + 1]!;
            const length = Math.hypot(dx, dy);
            if (length < 1e-8) continue;
            const t =
              ((mx - lines[j]!) * dx + (my - lines[j + 1]!) * dy) /
              (length * length);
            if (
              t >= -1e-6 &&
              t <= 1 + 1e-6 &&
              Math.abs((mx - lines[j]!) * dy - (my - lines[j + 1]!) * dx) /
                length <
                1e-4 &&
              Math.abs((bx - ax) * dy - (by - ay) * dx) / length < 1e-4
            )
              return true;
          }
          return false;
        });
      for (const [lines, layer] of [
        [visible, "VISIBLE"],
        [hidden, "HIDDEN"],
      ] as const)
        for (let i = 0; i < lines.length; i += 6) {
          const materialStyle = styleAt(
            lines[i]!,
            lines[i + 1]!,
            lines[i + 3]!,
            lines[i + 4]!,
          );
          line(
            page,
            x + lines[i]! * view.scale,
            y - lines[i + 1]! * view.scale,
            x + lines[i + 3]! * view.scale,
            y - lines[i + 4]! * view.scale,
            materialStyle
              ? layer === "HIDDEN"
                ? `HIDDEN_${materialStyle.layer}`
                : materialStyle.layer
              : layer,
          );
          const entity = page.entities.at(-1)!;
          if (materialStyle && entity.kind === "polyline")
            entity.style = materialStyle.style;
        }
    }
    text(
      page,
      `${view.label ?? view.id.toUpperCase()}   ${scaleLabel(view.scale)}`,
      view.labelAt?.x ?? view.at.x,
      view.labelAt?.y ?? view.at.y - 7,
      3,
      "VIEW_LABEL",
    );
  }
  for (const dim of drawing.dimensions) {
    const info = viewInfo.get(dim.view ?? drawing.views[0]?.id ?? "");
    if (!info) throw new Error("Dimension needs a valid drawing view");
    if (
      info.flat &&
      (dim.relativeTo ||
        dim.from instanceof PartInterface ||
        dim.to instanceof PartInterface)
    )
      throw new Error(
        "Flat dimensions use developed local XY coordinates, not world interfaces",
      );
    const point = (p: Point3 | PartInterface) =>
      p instanceof PartInterface
        ? new Vector3().setFromMatrixPosition(p.worldMatrix())
        : new Vector3(p.x, p.y, p.z).applyMatrix4(
            dim.relativeTo?.worldMatrix() ?? new Matrix4(),
          );
    const a = point(dim.from),
      c = point(dim.to),
      distance = a.distanceTo(c);
    const project = (p: Vector3) => ({
      x:
        info.x +
        (info.flat ? p.x : p.dot(new Vector3(...info.camera.xAxis))) *
          info.scale,
      y:
        info.y -
        (info.flat ? p.y : p.dot(new Vector3(...info.camera.yAxis))) *
          info.scale,
    });
    const A = project(a),
      C = project(c),
      len = Math.hypot(C.x - A.x, C.y - A.y);
    if (len < 1e-6)
      throw new Error("Dimension projects to zero length in selected view");
    const ux = (C.x - A.x) / len,
      uy = (C.y - A.y) / len,
      offset = dim.paperOffset ?? dim.offset * info.scale;
    const ox = -uy * offset,
      oy = ux * offset;
    for (const P of [A, C])
      line(
        page,
        P.x - uy,
        P.y + ux,
        P.x + ox - uy * 1.5,
        P.y + oy + ux * 1.5,
        "DIMENSIONS",
      );
    line(page, A.x + ox, A.y + oy, C.x + ox, C.y + oy, "DIMENSIONS");
    for (const [P, sign] of [
      [A, 1],
      [C, -1],
    ] as const)
      for (const side of [-1, 1])
        line(
          page,
          P.x + ox,
          P.y + oy,
          P.x + ox + ux * 2.5 * sign - uy * 0.7 * side,
          P.y + oy + uy * 2.5 * sign + ux * 0.7 * side,
          "DIMENSIONS",
        );
    const label =
      dim.label ?? formatMm(distance, drawing.options.mmPrecision, 2);
    const rotation = (Math.atan2(uy, ux) * 180) / Math.PI;
    page.entities.push({
      kind: "text",
      layer: "DIMENSION_TEXT",
      text: label,
      height: 3,
      x: (A.x + C.x) / 2 + ox,
      y: (A.y + C.y) / 2 + oy - 1.5,
      rotation: rotation > 90 || rotation < -90 ? rotation + 180 : rotation,
      align: "middle",
    });
  }
  const inView = (id: string, relativeTo?: Component) => {
    const info = viewInfo.get(id);
    if (!info) throw new Error("Annotation needs a valid drawing view");
    if (info.flat && relativeTo)
      throw new Error("Flat annotations use developed local coordinates");
    return {
      info,
      world: (p: Point3) =>
        new Vector3(p.x, p.y, p.z).applyMatrix4(
          relativeTo?.worldMatrix() ?? new Matrix4(),
        ),
      project: (p: Vector3) => ({
        x:
          info.x +
          (info.flat ? p.x : p.dot(new Vector3(...info.camera.xAxis))) *
            info.scale,
        y:
          info.y -
          (info.flat ? p.y : p.dot(new Vector3(...info.camera.yAxis))) *
            info.scale,
      }),
    };
  };
  const arrow = (a: { x: number; y: number }, c: { x: number; y: number }) => {
    const len = Math.hypot(c.x - a.x, c.y - a.y);
    if (len < 1e-6) return;
    const dx = (c.x - a.x) / len,
      dy = (c.y - a.y) / len;
    for (const sign of [-1, 1])
      line(
        page,
        a.x,
        a.y,
        a.x + dx * 2.5 - dy * 0.7 * sign,
        a.y + dy * 2.5 + dx * 0.7 * sign,
        "DIMENSIONS",
      );
  };
  for (const angle of drawing.angles) {
    const { info, world, project } = inView(angle.view, angle.relativeTo);
    const vertex = world(angle.vertex),
      u = world(angle.from).sub(vertex),
      v = world(angle.to).sub(vertex);
    if (u.length() < 1e-8 || v.length() < 1e-8)
      throw new Error("Angular dimension needs two nonzero rays");
    u.normalize();
    v.normalize();
    const theta = Math.acos(Math.max(-1, Math.min(1, u.dot(v))));
    const normal = new Vector3().crossVectors(u, v);
    if (normal.length() < 1e-8)
      throw new Error("Angular dimension rays must not be collinear");
    const q = new Vector3().crossVectors(normal.normalize(), u).normalize();
    const at = (t: number, radius: number) =>
      project(
        vertex
          .clone()
          .addScaledVector(u, (Math.cos(t) * radius) / info.scale)
          .addScaledVector(q, (Math.sin(t) * radius) / info.scale),
      );
    const points = Array.from({ length: 33 }, (_, i) =>
      at((theta * i) / 32, angle.radius),
    );
    page.entities.push({
      kind: "polyline",
      layer: "DIMENSIONS",
      points,
      closed: false,
    });
    for (const t of [0, theta]) {
      const a = project(vertex),
        c = at(t, angle.radius + 2);
      line(page, a.x, a.y, c.x, c.y, "DIMENSIONS");
    }
    arrow(points[0]!, points[1]!);
    arrow(points[32]!, points[31]!);
    const label = at(theta / 2, angle.radius + 5);
    text(
      page,
      angle.label ?? `${Number(((theta * 180) / Math.PI).toFixed(2))}°`,
      label.x,
      label.y,
      3,
      "DIMENSION_TEXT",
    );
  }
  for (const leader of drawing.leaders) {
    const { project, world, info } = inView(leader.view, leader.relativeTo);
    if (info.flat && leader.from instanceof PartInterface)
      throw new Error("Flat leaders require local points");
    const from = project(
      leader.from instanceof PartInterface
        ? new Vector3().setFromMatrixPosition(leader.from.worldMatrix())
        : world(leader.from),
    );
    const end = { x: leader.at.x - 2, y: leader.at.y - 1 };
    line(page, from.x, from.y, end.x, end.y, "DIMENSIONS");
    arrow(from, end);
    text(page, leader.text, leader.at.x, leader.at.y, 3, "DIMENSION_TEXT");
  }
  for (const path of drawing.paths) {
    const { project, world } = inView(path.view);
    page.entities.push({
      kind: "polyline",
      layer: path.layer ?? "ANNOTATION",
      points: path.points.map((p) => project(world(p))),
      closed: path.closed ?? false,
    });
  }
  for (const label of drawing.labels) {
    const { project, world } = inView(label.view),
      at = project(world(label.at));
    text(page, label.text, at.x, at.y, label.height ?? 3, "ROOM_LABEL");
  }
  for (const note of drawing.notes)
    text(page, note.text, note.at.x, note.at.y, 3, "NOTES");
  return page;
}
export async function renderDrawing(
  engine: OpenCascadeEngine,
  drawing: TechnicalDrawing,
): Promise<Uint8Array> {
  return (await renderDrawingFormats(engine, drawing)).svg;
}
async function drawingReports(
  engine: OpenCascadeEngine,
  drawing: TechnicalDrawing,
): Promise<ReportPage[]> {
  const drawings = [drawing, ...drawing.additionalPages],
    reports: ReportPage[] = [];
  for (const [i, page] of drawings.entries())
    reports.push(await drawingPage(engine, page, i + 1, drawings.length));
  return reports;
}
export async function renderDrawingPreviews(
  engine: OpenCascadeEngine,
  drawing: TechnicalDrawing,
): Promise<Uint8Array[]> {
  return (await drawingReports(engine, drawing)).map(pageSvg);
}
export async function renderDrawingFormats(
  engine: OpenCascadeEngine,
  drawing: TechnicalDrawing,
): Promise<{ svg: Uint8Array; pages: Uint8Array[]; dxf: Uint8Array }> {
  const reports = await drawingReports(engine, drawing);
  const pages = reports.map(pageSvg);
  return { svg: pages[0]!, pages, dxf: pagesDxf(reports) };
}
