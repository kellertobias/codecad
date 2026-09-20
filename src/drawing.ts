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
import type {
  TechnicalDrawing,
  DrawingSubject,
  DrawingViewKind,
  ResolvedDrawingView,
} from "./outputs.js";
import { standardScales, viewBasis } from "./view-basis.js";
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
  viewScales: readonly number[],
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
  const scales = [...new Set(viewScales.map(scaleLabel))];
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
  const s = viewScales[0] ?? 1,
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

type PaperPoint = { x: number; y: number };
/** Dimension line between two paper points; positive offsets go below/right. */
function paperDimension(
  page: ReportPage,
  A: PaperPoint,
  C: PaperPoint,
  offset: number,
  label: string,
) {
  const len = Math.hypot(C.x - A.x, C.y - A.y);
  if (len < 1e-6)
    throw new Error("Dimension projects to zero length in selected view");
  const ux = (C.x - A.x) / len,
    uy = (C.y - A.y) / len,
    ox = -uy * offset,
    oy = ux * offset,
    side = Math.sign(offset) || 1;
  for (const P of [A, C])
    line(
      page,
      P.x - uy * side,
      P.y + ux * side,
      P.x + ox - uy * 1.5 * side,
      P.y + oy + ux * 1.5 * side,
      "DIMENSIONS",
    );
  line(page, A.x + ox, A.y + oy, C.x + ox, C.y + oy, "DIMENSIONS");
  for (const [P, sign] of [
    [A, 1],
    [C, -1],
  ] as const)
    for (const wing of [-1, 1])
      line(
        page,
        P.x + ox,
        P.y + oy,
        P.x + ox + ux * 2.5 * sign - uy * 0.7 * wing,
        P.y + oy + uy * 2.5 * sign + ux * 0.7 * wing,
        "DIMENSIONS",
      );
  const rotation = (Math.atan2(uy, ux) * 180) / Math.PI,
    flipped = rotation > 90 || rotation < -90,
    // Keep the text on the far side of the dimension line from the geometry.
    lift = flipped ? -1.5 : 1.5;
  page.entities.push({
    kind: "text",
    layer: "DIMENSION_TEXT",
    text: label,
    height: 3,
    x: (A.x + C.x) / 2 + ox + uy * lift,
    y: (A.y + C.y) / 2 + oy - ux * lift,
    rotation: flipped ? rotation + 180 : rotation,
    align: "middle",
  });
}

export function viewCamera(kind: DrawingViewKind): b.Camera {
  const basis = viewBasis(
    kind === "exploded" ? "isometric" : kind === "flat" ? "top" : kind,
  );
  return b.unwrap(b.createCamera([0, 0, 0], [...basis.toward], [...basis.x]));
}

/** Geometry of one view in projected model millimetres (x right, y up). */
export interface PreparedView {
  view: ResolvedDrawingView;
  /** Projected 3D segment endpoints (x, y, depth); absent for flat patterns. */
  linework?: { visible: number[]; hidden: number[] };
  camera: b.Camera;
  flat: boolean;
  min: PaperPoint;
  max: PaperPoint;
  emit(page: ReportPage, x: number, y: number, scale: number): void;
}
const dimensionRoom = 16,
  viewGap = 14,
  labelRoom = 9;

async function prepareView(
  engine: OpenCascadeEngine,
  view: ResolvedDrawingView,
): Promise<PreparedView> {
  const camera = viewCamera(view.kind);
  const parts = subjects(view.of);
  if (view.kind === "flat") {
    if (parts.length !== 1 || !(parts[0] instanceof SheetMetalPart))
      throw new Error("A flat view needs exactly one sheet-metal part");
    const part = parts[0];
    const entities = await partEntities(engine, part);
    const bounds = part.manufacturingOutline.points;
    const regular = part.material.options.drawingStyle?.regular;
    return {
      view,
      camera,
      flat: true,
      min: {
        x: Math.min(...bounds.map((p) => p.x)),
        y: Math.min(...bounds.map((p) => p.y)),
      },
      max: {
        x: Math.max(...bounds.map((p) => p.x)),
        y: Math.max(...bounds.map((p) => p.y)),
      },
      emit(page, x, y, scale) {
        for (const e of entities) {
          if (e.kind === "polyline")
            page.entities.push({
              ...e,
              ...(regular ? { style: regular } : {}),
              points: e.points.map((p) => ({
                x: x + p.x * scale,
                y: y - p.y * scale,
              })),
            });
          else
            page.entities.push({
              ...e,
              x: x + e.x * scale,
              y: y - e.y * scale,
              ...(e.kind === "circle"
                ? { radius: e.radius * scale }
                : { height: 2.5 }),
            });
        }
      },
    };
  }
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
  if (!shapes.length)
    throw new Error(`View ${view.id} has no solid geometry to draw`);
  const { visible, hidden } = projectedLines(
    engine,
    engine.own(b.compound(shapes)),
    camera,
    view.hiddenLines,
    view.tangentEdges,
  );
  const min = { x: Infinity, y: Infinity },
    max = { x: -Infinity, y: -Infinity };
  for (const lines of [visible, hidden])
    for (let i = 0; i < lines.length; i += 3) {
      min.x = Math.min(min.x, lines[i]!);
      max.x = Math.max(max.x, lines[i]!);
      min.y = Math.min(min.y, lines[i + 1]!);
      max.y = Math.max(max.y, lines[i + 1]!);
    }
  if (!Number.isFinite(min.x)) min.x = min.y = max.x = max.y = 0;
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
          Math.abs((mx - lines[j]!) * dy - (my - lines[j + 1]!) * dx) / length <
            1e-4 &&
          Math.abs((bx - ax) * dy - (by - ay) * dx) / length < 1e-4
        )
          return true;
      }
      return false;
    });
  const capMeshes = caps
    .filter((cap) => cap.style.hatch)
    .map((cap) => ({
      cap,
      mesh: b.mesh(cap.face, {
        tolerance: 0.025,
        angularTolerance: 0.08,
        cache: false,
      }),
    }));
  const xAxis = new Vector3(...camera.xAxis),
    yAxis = new Vector3(...camera.yAxis);
  return {
    view,
    camera,
    flat: false,
    linework: { visible, hidden },
    min,
    max,
    emit(page, x, y, scale) {
      for (const { cap, mesh } of capMeshes) {
        const hatch = cap.style.hatch;
        if (!hatch) continue;
        const project = (index: number) => {
          const p = new Vector3(
            mesh.vertices[index * 3]!,
            mesh.vertices[index * 3 + 1]!,
            mesh.vertices[index * 3 + 2]!,
          );
          return {
            x: x + p.dot(xAxis) * scale,
            y: y - p.dot(yAxis) * scale,
          };
        };
        const triangles: PaperPoint[][] = [];
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
      // Hidden edges first so visible linework is painted over them.
      for (const [lines, layer] of [
        [hidden, "HIDDEN"],
        [visible, "VISIBLE"],
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
            x + lines[i]! * scale,
            y - lines[i + 1]! * scale,
            x + lines[i + 3]! * scale,
            y - lines[i + 4]! * scale,
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
    },
  };
}

interface PlacedView {
  /** Paper position of the geometry's top-left corner. */
  left: number;
  top: number;
  scale: number;
}
/** Third-angle arrangement: top above front, side views beside it, pictorial
 * and flat views in their own column. Every automatic view shares one scale. */
export function arrangeViews(
  views: readonly {
    kind: DrawingViewKind;
    width: number;
    height: number;
    scale?: number | undefined;
    overallDimensions?: boolean | undefined;
  }[],
  region: { x: number; y: number; width: number; height: number },
): PlacedView[] {
  const cells: Partial<Record<DrawingViewKind, [number, number]>> = {
    left: [0, 1],
    front: [1, 1],
    right: [2, 1],
    back: [3, 1],
    top: [1, 0],
    bottom: [1, 2],
  };
  const taken = new Set<string>();
  const slots = views.map((view) => {
    const cell = cells[view.kind];
    if (!cell || taken.has(cell.join())) return undefined;
    taken.add(cell.join());
    return cell;
  });
  const attempt = (common: number) => {
    const sizes = views.map((view) => {
      const scale = view.scale ?? common,
        room = view.overallDimensions ? dimensionRoom : 0;
      return {
        scale,
        width: view.width * scale + room,
        height: view.height * scale + room + labelRoom,
      };
    });
    const columns = [0, 0, 0, 0],
      rows = [0, 0, 0];
    let extraWidth = 0,
      extraHeight = 0;
    sizes.forEach((size, i) => {
      const slot = slots[i];
      if (slot) {
        columns[slot[0]] = Math.max(columns[slot[0]]!, size.width);
        rows[slot[1]] = Math.max(rows[slot[1]]!, size.height);
      } else {
        extraWidth = Math.max(extraWidth, size.width);
        extraHeight += size.height + (extraHeight ? viewGap : 0);
      }
    });
    const span = (values: number[]) => {
      const used = values.filter((value) => value > 0);
      return (
        used.reduce((sum, value) => sum + value, 0) +
        Math.max(0, used.length - 1) * viewGap
      );
    };
    const gridWidth = span(columns),
      gridHeight = span(rows);
    const width =
        gridWidth + (extraWidth ? extraWidth + (gridWidth ? viewGap : 0) : 0),
      height = Math.max(gridHeight, extraHeight);
    return {
      sizes,
      columns,
      rows,
      gridWidth,
      gridHeight,
      extraHeight,
      width,
      height,
      fits: width <= region.width + 1e-6 && height <= region.height + 1e-6,
    };
  };
  let layout = attempt(standardScales.at(-1)!);
  for (const scale of standardScales) {
    const candidate = attempt(scale);
    if (candidate.fits) {
      layout = candidate;
      break;
    }
  }
  const x0 = region.x + Math.max(0, (region.width - layout.width) / 2),
    y0 = region.y + Math.max(0, (region.height - layout.height) / 2);
  const offsets = (values: number[], origin: number) => {
    let at = origin;
    return values.map((value) => {
      const start = at;
      if (value > 0) at += value + viewGap;
      return start;
    });
  };
  const columnAt = offsets(layout.columns, x0),
    rowAt = offsets(
      layout.rows,
      y0 + Math.max(0, (layout.height - layout.gridHeight) / 2),
    );
  let extraAt = y0 + Math.max(0, (layout.height - layout.extraHeight) / 2);
  const extraX = x0 + layout.gridWidth + (layout.gridWidth ? viewGap : 0);
  return views.map((view, i) => {
    const size = layout.sizes[i]!,
      slot = slots[i];
    if (slot) {
      const cellWidth = layout.columns[slot[0]]!,
        cellHeight = layout.rows[slot[1]]!;
      return {
        scale: size.scale,
        left: columnAt[slot[0]]! + (cellWidth - size.width) / 2,
        // Align toward the front view so projections line up across views.
        top:
          rowAt[slot[1]]! +
          labelRoom +
          (slot[1] === 0
            ? cellHeight - size.height
            : slot[1] === 1
              ? (cellHeight - size.height) / 2
              : 0),
      };
    }
    const top = extraAt + labelRoom;
    extraAt += size.height + viewGap;
    return { scale: size.scale, left: extraX, top };
  });
}

export type ViewObserver = (view: PreparedView) => void;
async function drawingPage(
  engine: OpenCascadeEngine,
  drawing: TechnicalDrawing,
  number: number,
  total: number,
  onView?: ViewObserver,
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
  const prepared: PreparedView[] = [];
  for (const view of drawing.views) {
    const entry = await prepareView(engine, view);
    onView?.(entry);
    prepared.push(entry);
  }
  const automatic = prepared.filter((entry) => !entry.view.at);
  const placements = new Map<PreparedView, PlacedView>(
    arrangeViews(
      automatic.map((entry) => ({
        kind: entry.view.kind,
        width: entry.max.x - entry.min.x,
        height: entry.max.y - entry.min.y,
        scale: entry.view.scale,
        overallDimensions: entry.view.overallDimensions,
      })),
      // Above the title block and its graphic scale bar.
      { x: 20, y: 16, width: w - 40, height: h - 16 - 78 },
    ).map((placed, i) => [automatic[i]!, placed]),
  );
  const viewInfo = new Map<
    string,
    { camera: b.Camera; x: number; y: number; scale: number; flat: boolean }
  >();
  const scales: number[] = [];
  for (const entry of prepared) {
    const { view } = entry,
      width = entry.max.x - entry.min.x,
      height = entry.max.y - entry.min.y;
    let placed = placements.get(entry);
    if (!placed) {
      let scale = view.scale;
      if (scale === undefined) {
        if (!view.box)
          throw new Error(
            `View ${view.id} needs a scale, a box, or automatic placement`,
          );
        scale =
          standardScales.find(
            (s) =>
              width * s <= view.box!.width && height * s <= view.box!.height,
          ) ?? standardScales.at(-1)!;
      }
      placed = {
        scale,
        left:
          view.at!.x + (view.box ? (view.box.width - width * scale) / 2 : 0),
        top:
          view.at!.y + (view.box ? (view.box.height - height * scale) / 2 : 0),
      };
    }
    const { scale, left, top } = placed;
    scales.push(scale);
    const x = left - entry.min.x * scale,
      y = top + entry.max.y * scale;
    viewInfo.set(view.id, {
      camera: entry.camera,
      x,
      y,
      scale,
      flat: entry.flat,
    });
    entry.emit(page, x, y, scale);
    if (view.overallDimensions) {
      const right = left + width * scale,
        bottom = top + height * scale,
        format = (value: number) =>
          formatMm(value, drawing.options.mmPrecision, 2);
      if (width > 1e-6)
        paperDimension(
          page,
          { x: left, y: bottom },
          { x: right, y: bottom },
          9,
          format(width),
        );
      if (height > 1e-6)
        paperDimension(
          page,
          { x: right, y: bottom },
          { x: right, y: top },
          9,
          format(height),
        );
    }
    text(
      page,
      `${view.label ?? view.id.toUpperCase()}   ${scaleLabel(scale)}`,
      view.labelAt?.x ?? (view.box ? view.at!.x : left),
      view.labelAt?.y ??
        (view.box ? view.at!.y + view.box.height + 5 : top - 7),
      3,
      "VIEW_LABEL",
    );
  }
  titleBlock(page, drawing, number, total, scales);
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
    paperDimension(
      page,
      project(a),
      project(c),
      dim.paperOffset ?? dim.offset * info.scale,
      dim.label ?? formatMm(distance, drawing.options.mmPrecision, 2),
    );
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
    text(page, note.text, note.at.x, note.at.y, note.height ?? 3, "NOTES");
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
  onView?: ViewObserver,
): Promise<ReportPage[]> {
  const drawings = [drawing, ...drawing.additionalPages],
    reports: ReportPage[] = [];
  for (const [i, page] of drawings.entries())
    reports.push(
      await drawingPage(engine, page, i + 1, drawings.length, onView),
    );
  return reports;
}
export async function renderDrawingPreviews(
  engine: OpenCascadeEngine,
  drawing: TechnicalDrawing,
  onView?: ViewObserver,
): Promise<Uint8Array[]> {
  return (await drawingReports(engine, drawing, onView)).map(pageSvg);
}
export async function renderDrawingFormats(
  engine: OpenCascadeEngine,
  drawing: TechnicalDrawing,
  onView?: ViewObserver,
): Promise<{ svg: Uint8Array; pages: Uint8Array[]; dxf: Uint8Array }> {
  const reports = await drawingReports(engine, drawing, onView);
  const pages = reports.map(pageSvg);
  return { svg: pages[0]!, pages, dxf: pagesDxf(reports) };
}
