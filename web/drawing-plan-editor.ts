import * as THREE from "three";
import {
  planSheet,
  planViewLabel,
  validateDrawingPlan,
  type DrawingPlan,
  type PlanItem,
} from "../src/drawing-plan.js";
import {
  standardScales,
  viewAngles,
  viewBasis,
  type ViewAngle,
} from "../src/view-basis.js";

type Mesh = { componentPath: string; edges: number[]; matrix: number[] };
type Component = { path: string; label: string; parent?: string };
type View = Extract<PlanItem, { kind: "view" }>;
type Dimension = Extract<PlanItem, { kind: "dimension" }>;
type BuiltView = { key: string; visible: number[]; hidden: number[] };
type Point = { x: number; y: number };
/** Projected model millimetres: `[x1, y1, x2, y2, …]` plus their centre. */
type Linework = {
  visible: number[];
  hidden: number[];
  cx: number;
  cy: number;
  width: number;
  height: number;
  exact: boolean;
};
const ns = "http://www.w3.org/2000/svg";
const svgNode = (
  tag: string,
  attributes: Record<string, string | number> = {},
  content?: string,
) => {
  const node = document.createElementNS(ns, tag);
  for (const [key, value] of Object.entries(attributes))
    node.setAttribute(key, String(value));
  if (content !== undefined) node.textContent = content;
  return node;
};
const byId = <T extends HTMLElement | SVGSVGElement = HTMLElement>(
  id: string,
) => document.getElementById(id) as T;
const uid = () => "item_" + crypto.randomUUID().replaceAll("-", "");
const fmt = (n: number) => Number(n.toFixed(3));
const viewKey = (view: View) =>
  `${view.subject}|${view.angle}|${view.hiddenLines ? "hidden" : "visible"}`;
const scaleChoices = standardScales.map((scale) => fmt(1 / scale));
const scaleName = (denominator: number) =>
  denominator >= 1 ? `1:${fmt(denominator)}` : `${fmt(1 / denominator)}:1`;
const titleBlock = { width: 170, height: 40, margin: 10 };

export class DrawingPlanEditor {
  private plan: DrawingPlan = { version: 1, title: "", items: [] };
  private version = "";
  private meshes: Mesh[] = [];
  private components: Component[] = [];
  private built: Record<string, BuiltView> = {};
  private linework = new Map<string, Linework>();
  private selected = "";
  private tool: "select" | "measure" | "text" = "select";
  private firstPoint: { u: number; v: number; view: string } | undefined;
  private snap: (Point & { snapped: boolean }) | undefined;
  private drag:
    | { x: number; y: number; item: PlanItem; resize: boolean; moved: boolean }
    | undefined;
  private dirty = false;
  private loaded = false;
  private readonly sheet = byId<SVGSVGElement>("plan-sheet");
  private readonly overlay = svgNode("g", { "pointer-events": "none" });
  constructor(
    private token: () => string,
    private artifactUrl: (name: string) => string,
  ) {
    byId("plan-view").onclick = () => this.addView();
    byId("plan-measure").onclick = () =>
      this.setTool(this.tool === "measure" ? "select" : "measure");
    byId("plan-text").onclick = () =>
      this.setTool(this.tool === "text" ? "select" : "text");
    byId("plan-save").onclick = () => void this.save();
    byId("plan-export").onclick = () => void this.download();
    this.sheet.addEventListener("pointerdown", (event) =>
      this.pointerDown(event),
    );
    this.sheet.addEventListener("pointermove", (event) =>
      this.pointerMove(event),
    );
    this.sheet.addEventListener("pointerleave", () => {
      this.snap = undefined;
      this.renderOverlay();
    });
    for (const type of ["pointerup", "pointercancel"] as const)
      this.sheet.addEventListener(type, () => {
        if (this.drag?.moved) this.fields();
        this.drag = undefined;
      });
    window.addEventListener("keydown", (event) => this.keyDown(event));
    window.addEventListener("beforeunload", (event) => {
      if (this.dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    });
  }
  async load() {
    if (this.loaded) return;
    const response = await fetch("/api/drawing-plan");
    if (!response.ok) throw new Error("Could not load drawing plan");
    const data = await response.json();
    this.plan = validateDrawingPlan(data.plan);
    this.version = data.version;
    this.dirty = false;
    this.loaded = true;
    this.status(
      this.plan.items.length
        ? "Loaded " + String(data.file).split(/[\\/]/).at(-1)
        : "Add a view to start a drawing sheet.",
    );
    this.render();
  }
  setModel(model: {
    meshes: Mesh[];
    components: Component[];
    title: string;
    planViews?: Record<string, BuiltView>;
  }) {
    this.meshes = model.meshes;
    this.components = model.components;
    this.built = model.planViews ?? {};
    this.linework.clear();
    if (!this.plan.title) this.plan.title = model.title;
    if (this.loaded && !this.dirty && Object.keys(this.built).length)
      this.status("Sheet is up to date · PDF and DXF are under Sheets.");
    this.render();
  }
  private get active() {
    return (
      byId("drawing").classList.contains("active") &&
      !byId("plan-editor").hidden
    );
  }
  private status(message: string) {
    byId("plan-status").textContent = message;
  }
  private change() {
    this.dirty = true;
    this.status("Unsaved changes · Save plan to update the PDF and DXF");
    this.render();
  }
  private setTool(tool: "select" | "measure" | "text") {
    this.tool = tool;
    this.firstPoint = undefined;
    this.snap = undefined;
    byId("plan-measure").setAttribute(
      "aria-pressed",
      String(tool === "measure"),
    );
    byId("plan-text").setAttribute("aria-pressed", String(tool === "text"));
    this.sheet.style.cursor = tool === "select" ? "" : "crosshair";
    this.status(
      tool === "measure"
        ? "Click two points in a view. Corners and edges snap; Esc cancels."
        : tool === "text"
          ? "Click the sheet to place a note. Esc cancels."
          : "Drag items to move them. Delete removes the selection.",
    );
    this.renderOverlay();
  }
  private views() {
    return this.plan.items.filter((item): item is View => item.kind === "view");
  }
  /** Hidden-line geometry from the last build, else a live wireframe. */
  private lines(view: View): Linework {
    const key = view.id + "|" + viewKey(view);
    const cached = this.linework.get(key);
    if (cached) return cached;
    const built = this.built[view.id];
    let visible: number[] = [],
      hidden: number[] = [];
    const exact = built?.key === viewKey(view);
    if (exact) ({ visible, hidden } = built!);
    else {
      const basis = viewBasis(view.angle),
        horizontal = new THREE.Vector3(...basis.x),
        vertical = new THREE.Vector3(...basis.y),
        point = new THREE.Vector3();
      for (const mesh of this.meshes) {
        if (
          view.subject !== "*" &&
          mesh.componentPath !== view.subject &&
          !mesh.componentPath.startsWith(view.subject + "/")
        )
          continue;
        const matrix = new THREE.Matrix4().fromArray(mesh.matrix);
        for (let i = 0; i + 2 < mesh.edges.length; i += 3) {
          point
            .set(mesh.edges[i]!, mesh.edges[i + 1]!, mesh.edges[i + 2]!)
            .applyMatrix4(matrix);
          visible.push(point.dot(horizontal), point.dot(vertical));
        }
      }
    }
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    for (const lines of [visible, hidden])
      for (let i = 0; i < lines.length; i += 2) {
        minX = Math.min(minX, lines[i]!);
        maxX = Math.max(maxX, lines[i]!);
        minY = Math.min(minY, lines[i + 1]!);
        maxY = Math.max(maxY, lines[i + 1]!);
      }
    if (!Number.isFinite(minX)) minX = maxX = minY = maxY = 0;
    const result = {
      visible,
      hidden,
      cx: (minX + maxX) / 2,
      cy: (minY + maxY) / 2,
      width: maxX - minX,
      height: maxY - minY,
      exact,
    };
    this.linework.set(key, result);
    return result;
  }
  private toSheet(view: View, u: number, v: number): Point {
    const { cx, cy } = this.lines(view);
    return {
      x: view.x + view.width / 2 + (u - cx) / view.scale,
      y: view.y + view.height / 2 - (v - cy) / view.scale,
    };
  }
  private toModel(view: View, p: Point) {
    const { cx, cy } = this.lines(view);
    return {
      u: fmt(cx + (p.x - view.x - view.width / 2) * view.scale),
      v: fmt(cy - (p.y - view.y - view.height / 2) * view.scale),
    };
  }
  private fitScale(view: View) {
    const { width, height } = this.lines(view);
    return (
      scaleChoices.find(
        (scale) =>
          width / scale <= view.width - 8 && height / scale <= view.height - 8,
      ) ?? scaleChoices.at(-1)!
    );
  }
  private addView() {
    if (!this.meshes.length) {
      this.status("Build a model before adding a view.");
      return;
    }
    const existing = this.views(),
      index = existing.length,
      angle = (["front", "top", "right", "isometric"] as const)[index % 4]!;
    const view: View = {
      id: uid(),
      kind: "view",
      subject: existing.at(-1)?.subject ?? "*",
      angle,
      x: 18 + (index % 2) * 198,
      y: 20 + (Math.floor(index / 2) % 2) * 112,
      width: 180,
      height: 100,
      scale: 10,
      label: "",
    };
    // Related views read best at one scale; otherwise use the largest that fits.
    view.scale = Math.max(existing.at(-1)?.scale ?? 0, this.fitScale(view));
    this.plan.items.push(view);
    this.selected = view.id;
    this.setTool("select");
    this.change();
  }
  private point(event: PointerEvent): Point {
    const svg = this.sheet.createSVGPoint();
    svg.x = event.clientX;
    svg.y = event.clientY;
    const p = svg.matrixTransform(this.sheet.getScreenCTM()!.inverse());
    return { x: fmt(p.x), y: fmt(p.y) };
  }
  private viewAt(p: Point) {
    return this.views()
      .reverse()
      .find(
        (item) =>
          p.x >= item.x &&
          p.x <= item.x + item.width &&
          p.y >= item.y &&
          p.y <= item.y + item.height,
      );
  }
  /** Prefer corners, then the nearest point on an edge, then the free point. */
  private snapPoint(view: View, p: Point): Point & { snapped: boolean } {
    const lines = this.lines(view),
      target = this.toModel(view, p),
      cornerReach = 2.5 * view.scale,
      edgeReach = 1.5 * view.scale;
    let corner: { u: number; v: number; d: number } | undefined,
      edge: { u: number; v: number; d: number } | undefined;
    for (const set of [lines.visible, lines.hidden])
      for (let i = 0; i + 3 < set.length; i += 4) {
        const ax = set[i]!,
          ay = set[i + 1]!,
          bx = set[i + 2]!,
          by = set[i + 3]!;
        for (const [u, v] of [
          [ax, ay],
          [bx, by],
        ] as const) {
          const d = Math.hypot(u - target.u, v - target.v);
          if (d <= cornerReach && (!corner || d < corner.d))
            corner = { u, v, d };
        }
        const dx = bx - ax,
          dy = by - ay,
          length2 = dx * dx + dy * dy;
        if (length2 < 1e-12) continue;
        const t = Math.max(
          0,
          Math.min(1, ((target.u - ax) * dx + (target.v - ay) * dy) / length2),
        );
        const u = ax + dx * t,
          v = ay + dy * t,
          d = Math.hypot(u - target.u, v - target.v);
        if (d <= edgeReach && (!edge || d < edge.d)) edge = { u, v, d };
      }
    const hit = corner ?? edge;
    return hit
      ? { ...this.toSheet(view, hit.u, hit.v), snapped: true }
      : { ...p, snapped: false };
  }
  private itemAt(event: PointerEvent) {
    const element = event.target as Element;
    const id = element.closest("[data-plan-id]")?.getAttribute("data-plan-id");
    return this.plan.items.find((item) => item.id === id);
  }
  private pointerDown(event: PointerEvent) {
    if (event.button !== 0) return;
    const p = this.point(event);
    if (this.tool === "text") {
      const item: PlanItem = {
        id: uid(),
        kind: "text",
        x: p.x,
        y: p.y,
        text: "New note",
        size: 4,
      };
      this.plan.items.push(item);
      this.selected = item.id;
      this.setTool("select");
      this.change();
      const input = byId("plan-fields").querySelector("input");
      input?.focus();
      input?.select();
      return;
    }
    if (this.tool === "measure") {
      const view = this.firstPoint
        ? this.views().find((item) => item.id === this.firstPoint!.view)
        : this.viewAt(p);
      if (!view) {
        this.status("Click inside a model view.");
        return;
      }
      const point = this.toModel(view, this.snapPoint(view, p));
      if (!this.firstPoint) {
        this.firstPoint = { ...point, view: view.id };
        this.status("Click the second point in the same view.");
        this.renderOverlay();
        return;
      }
      const a = this.firstPoint;
      if (Math.hypot(point.u - a.u, point.v - a.v) < 1e-6) return;
      const item: Dimension = {
        id: uid(),
        kind: "dimension",
        view: view.id,
        u1: a.u,
        v1: a.v,
        u2: point.u,
        v2: point.v,
        offset: 8,
        label: "",
      };
      this.plan.items.push(item);
      this.selected = item.id;
      this.setTool("select");
      this.change();
      return;
    }
    const item = this.itemAt(event);
    this.selected = item?.id ?? "";
    if (item) {
      this.drag = {
        ...p,
        item,
        moved: false,
        resize: (event.target as Element).hasAttribute("data-plan-resize"),
      };
      this.sheet.setPointerCapture(event.pointerId);
    }
    this.render();
  }
  private pointerMove(event: PointerEvent) {
    const p = this.point(event);
    if (this.tool === "measure") {
      const view = this.firstPoint
        ? this.views().find((item) => item.id === this.firstPoint!.view)
        : this.viewAt(p);
      this.snap = view ? this.snapPoint(view, p) : undefined;
      this.renderOverlay();
      return;
    }
    if (!this.drag) return;
    const dx = p.x - this.drag.x,
      dy = p.y - this.drag.y,
      item = this.drag.item;
    if (!dx && !dy) return;
    if (item.kind === "dimension") {
      const view = this.views().find((entry) => entry.id === item.view);
      if (!view) return;
      const a = this.toSheet(view, item.u1, item.v1),
        b = this.toSheet(view, item.u2, item.v2),
        length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      // Dragging a dimension slides its line toward or away from the geometry.
      item.offset = fmt(
        ((p.x - a.x) * -(b.y - a.y) + (p.y - a.y) * (b.x - a.x)) / length,
      );
    } else if (item.kind === "view" && this.drag.resize) {
      item.width = fmt(Math.max(20, item.width + dx));
      item.height = fmt(Math.max(20, item.height + dy));
    } else {
      item.x = fmt(item.x + dx);
      item.y = fmt(item.y + dy);
    }
    this.drag.x = p.x;
    this.drag.y = p.y;
    this.drag.moved = true;
    this.dirty = true;
    this.status("Unsaved changes · Save plan to update the PDF and DXF");
    this.renderSheet();
  }
  private keyDown(event: KeyboardEvent) {
    if (!this.active) return;
    const target = event.target as HTMLElement | null;
    if (
      target?.closest(
        "input, select, textarea, [contenteditable], .monaco-editor",
      )
    )
      return;
    if (event.key === "Escape") {
      if (this.tool !== "select") this.setTool("select");
      else if (this.selected) {
        this.selected = "";
        this.render();
      }
      return;
    }
    const item = this.plan.items.find((entry) => entry.id === this.selected);
    if (!item) return;
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      this.remove(item);
      return;
    }
    const step = event.shiftKey ? 10 : 1,
      move: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
    const delta = move[event.key];
    if (!delta || item.kind === "dimension") return;
    event.preventDefault();
    item.x = fmt(item.x + delta[0]);
    item.y = fmt(item.y + delta[1]);
    this.change();
  }
  private remove(item: PlanItem) {
    this.plan.items = this.plan.items.filter(
      (entry) =>
        entry.id !== item.id &&
        !(entry.kind === "dimension" && entry.view === item.id),
    );
    this.selected = "";
    this.change();
  }
  private render() {
    this.renderSheet();
    this.fields();
  }
  private renderOverlay() {
    this.overlay.replaceChildren();
    const marker = (p: Point, snapped: boolean) =>
      this.overlay.append(
        svgNode("circle", {
          cx: p.x,
          cy: p.y,
          r: snapped ? 1.6 : 1,
          fill: snapped ? "#09a68d55" : "none",
          stroke: "#09a68d",
          "stroke-width": 0.4,
        }),
      );
    const view = this.views().find((item) => item.id === this.firstPoint?.view);
    const first =
      view && this.firstPoint
        ? this.toSheet(view, this.firstPoint.u, this.firstPoint.v)
        : undefined;
    if (first) marker(first, true);
    if (this.tool !== "measure" || !this.snap) return;
    marker(this.snap, this.snap.snapped);
    if (first && view) {
      this.overlay.append(
        svgNode("line", {
          x1: first.x,
          y1: first.y,
          x2: this.snap.x,
          y2: this.snap.y,
          stroke: "#09a68d",
          "stroke-width": 0.35,
          "stroke-dasharray": "1.5 1",
        }),
        svgNode(
          "text",
          {
            x: this.snap.x + 3,
            y: this.snap.y - 3,
            "font-size": 3.5,
            fill: "#067a68",
          },
          `${fmt(Math.hypot(this.snap.x - first.x, this.snap.y - first.y) * view.scale)} mm`,
        ),
      );
    }
  }
  private renderSheet() {
    const { width, height } = planSheet;
    this.sheet.replaceChildren(
      svgNode("rect", { x: 0, y: 0, width, height, fill: "white" }),
      svgNode("rect", {
        x: 10,
        y: 10,
        width: width - 20,
        height: height - 20,
        fill: "none",
        stroke: "#24343b",
        "stroke-width": 0.35,
      }),
    );
    // Keep-clear area: the build adds the full title block to the PDF and DXF.
    const block = svgNode("g", { "pointer-events": "none" });
    const bx = width - titleBlock.margin - titleBlock.width,
      by = height - titleBlock.margin - titleBlock.height;
    block.append(
      svgNode("rect", {
        x: bx,
        y: by,
        width: titleBlock.width,
        height: titleBlock.height,
        fill: "#f4f7f7",
        stroke: "#24343b",
        "stroke-width": 0.35,
      }),
      svgNode(
        "text",
        { x: bx + 3, y: by + 5, "font-size": 2.4, fill: "#6b7d84" },
        "TITLE BLOCK · filled in on export",
      ),
      svgNode(
        "text",
        { x: bx + 3, y: by + 13, "font-size": 4.5, fill: "#24343b" },
        this.plan.title || "Drawing plan",
      ),
    );
    this.sheet.append(block);
    const selectedColor = "#09a68d";
    for (const item of this.plan.items) {
      const chosen = this.selected === item.id;
      const g = svgNode("g", {
        "data-plan-id": item.id,
        class: "plan-item" + (chosen ? " plan-selected" : ""),
      });
      if (item.kind === "view") {
        const clipId = "clip_" + item.id;
        const clip = svgNode("clipPath", { id: clipId });
        clip.append(
          svgNode("rect", {
            x: item.x,
            y: item.y,
            width: item.width,
            height: item.height,
          }),
        );
        this.sheet.append(clip);
        g.append(
          svgNode("rect", {
            x: item.x,
            y: item.y,
            width: item.width,
            height: item.height,
            fill: chosen ? "#f2fbf9" : "#ffffff00",
            stroke: chosen ? selectedColor : "#b9c6cb",
            "stroke-width": chosen ? 0.4 : 0.25,
            "stroke-dasharray": chosen ? "" : "2 1.5",
            "data-plan-frame": "",
          }),
        );
        const lines = this.lines(item);
        for (const [set, dashed] of [
          [lines.hidden, true],
          [lines.visible, false],
        ] as const) {
          if (!set.length) continue;
          let d = "";
          for (let i = 0; i + 3 < set.length; i += 4) {
            const a = this.toSheet(item, set[i]!, set[i + 1]!),
              b = this.toSheet(item, set[i + 2]!, set[i + 3]!);
            d += `M${fmt(a.x)},${fmt(a.y)}L${fmt(b.x)},${fmt(b.y)}`;
          }
          g.append(
            svgNode("path", {
              d,
              "clip-path": `url(#${clipId})`,
              stroke: dashed ? "#6b7d84" : "#24343b",
              "stroke-width": dashed ? 0.18 : lines.exact ? 0.35 : 0.2,
              "stroke-dasharray": dashed ? "2 1" : "",
              "stroke-linecap": "round",
              fill: "none",
            }),
          );
        }
        g.append(
          svgNode(
            "text",
            {
              x: item.x,
              y: item.y + item.height + 5,
              "font-size": 3.5,
              fill: "#24343b",
            },
            (item.label || planViewLabel(item)) +
              (lines.exact ? "" : "  (wireframe preview · save to refine)"),
          ),
        );
        if (chosen)
          g.append(
            svgNode("rect", {
              x: item.x + item.width - 2.5,
              y: item.y + item.height - 2.5,
              width: 5,
              height: 5,
              fill: selectedColor,
              "data-plan-resize": "",
              style: "cursor: nwse-resize",
            }),
          );
      } else if (item.kind === "dimension") {
        const view = this.views().find((v) => v.id === item.view);
        if (!view) continue;
        const p1 = this.toSheet(view, item.u1, item.v1),
          p2 = this.toSheet(view, item.u2, item.v2);
        const dx = p2.x - p1.x,
          dy = p2.y - p1.y,
          length = Math.hypot(dx, dy) || 1;
        const nx = -dy / length,
          ny = dx / length,
          ox = nx * item.offset,
          oy = ny * item.offset;
        const a = { x: p1.x + ox, y: p1.y + oy },
          b = { x: p2.x + ox, y: p2.y + oy };
        const stroke = chosen ? selectedColor : "#235767";
        // A wide invisible stroke makes the thin dimension easy to grab.
        g.append(
          svgNode("line", {
            x1: a.x,
            y1: a.y,
            x2: b.x,
            y2: b.y,
            stroke: "#ffffff00",
            "stroke-width": 4,
            style: "cursor: move",
          }),
        );
        for (const [x1, y1, x2, y2] of [
          [
            p1.x,
            p1.y,
            a.x + nx * Math.sign(item.offset || 1) * 1.5,
            a.y + ny * Math.sign(item.offset || 1) * 1.5,
          ],
          [
            p2.x,
            p2.y,
            b.x + nx * Math.sign(item.offset || 1) * 1.5,
            b.y + ny * Math.sign(item.offset || 1) * 1.5,
          ],
          [a.x, a.y, b.x, b.y],
        ] as [number, number, number, number][])
          g.append(
            svgNode("line", { x1, y1, x2, y2, stroke, "stroke-width": 0.25 }),
          );
        const ux = dx / length,
          uy = dy / length;
        for (const [p, sign] of [
          [a, 1],
          [b, -1],
        ] as const)
          g.append(
            svgNode("path", {
              d: `M${p.x + ux * 2.5 * sign - uy * 0.7},${p.y + uy * 2.5 * sign + ux * 0.7}L${p.x},${p.y}L${p.x + ux * 2.5 * sign + uy * 0.7},${p.y + uy * 2.5 * sign - ux * 0.7}`,
              stroke,
              "stroke-width": 0.25,
              fill: "none",
            }),
          );
        let rotation = (Math.atan2(uy, ux) * 180) / Math.PI;
        const flipped = rotation > 90 || rotation < -90;
        if (flipped) rotation += 180;
        const lift = flipped ? -1.5 : 1.5,
          tx = (a.x + b.x) / 2 + uy * lift,
          ty = (a.y + b.y) / 2 - ux * lift;
        g.append(
          svgNode(
            "text",
            {
              x: tx,
              y: ty,
              "font-size": 3.2,
              "text-anchor": "middle",
              transform: `rotate(${fmt(rotation)},${fmt(tx)},${fmt(ty)})`,
              fill: stroke,
            },
            item.label ||
              String(
                Number(
                  Math.hypot(item.u2 - item.u1, item.v2 - item.v1).toFixed(2),
                ),
              ),
          ),
        );
      } else
        g.append(
          svgNode(
            "text",
            {
              x: item.x,
              y: item.y,
              "font-size": item.size,
              fill: chosen ? selectedColor : "#24343b",
              style: "cursor: move",
            },
            item.text,
          ),
        );
      this.sheet.append(g);
    }
    this.sheet.append(this.overlay);
    this.renderOverlay();
  }
  private fields() {
    const panel = byId("plan-fields");
    panel.replaceChildren();
    const item = this.plan.items.find((entry) => entry.id === this.selected);
    const heading = byId("plan-heading");
    heading.textContent = !item
      ? "Drawing sheet"
      : item.kind === "view"
        ? "Model view"
        : item.kind === "dimension"
          ? "Dimension"
          : "Note";
    const row = (label: string, control: HTMLElement, wide = true) => {
      const wrap = document.createElement("label");
      if (!wide) wrap.className = "plan-half";
      const caption = document.createElement("span");
      caption.textContent = label;
      wrap.append(caption, control);
      panel.append(wrap);
      return control;
    };
    const textField = (
      label: string,
      value: string,
      update: (value: string) => void,
      placeholder = "",
    ) => {
      const input = document.createElement("input");
      input.value = value;
      input.placeholder = placeholder;
      input.onchange = () => {
        update(input.value);
        this.change();
      };
      return row(label, input);
    };
    const numberField = (
      label: string,
      value: number,
      update: (value: number) => void,
      options: { min?: number; wide?: boolean } = {},
    ) => {
      const input = document.createElement("input");
      input.type = "number";
      input.step = "any";
      input.value = String(value);
      if (options.min !== undefined) input.min = String(options.min);
      input.onchange = () => {
        const next = Number(input.value);
        if (
          input.value === "" ||
          !Number.isFinite(next) ||
          (options.min !== undefined && next < options.min)
        ) {
          input.value = String(value);
          return;
        }
        update(next);
        this.change();
      };
      return row(label, input, options.wide ?? false);
    };
    const selectField = (
      label: string,
      value: string,
      choices: readonly (readonly [string, string])[],
      update: (value: string) => void,
      wide = true,
    ) => {
      const select = document.createElement("select");
      for (const [choice, caption] of choices) {
        const option = document.createElement("option");
        option.value = choice;
        option.textContent = caption;
        select.append(option);
      }
      select.value = value;
      select.onchange = () => {
        update(select.value);
        this.change();
      };
      return row(label, select, wide);
    };
    const hint = (message: string) => {
      const note = document.createElement("p");
      note.textContent = message;
      panel.append(note);
    };
    if (!item) {
      textField("Title", this.plan.title, (value) => (this.plan.title = value));
      hint(
        this.plan.items.length
          ? "Select an item to edit it. Save plan writes the recipe beside the project and adds the sheet to the build as PDF and DXF."
          : "Use ▣ to add a view of the model or of one part, ⌁ to dimension it and T for notes.",
      );
      return;
    }
    if (item.kind === "view") {
      const depth = (path: string) => path.split("/").length - 1;
      selectField(
        "Shows",
        item.subject,
        [
          ["*", "Whole model"],
          ...this.components
            .filter((c) => c.parent !== undefined)
            .map(
              (c) =>
                [
                  c.path,
                  "  ".repeat(Math.max(0, depth(c.path) - 1)) + c.label,
                ] as const,
            ),
          ...(item.subject !== "*" &&
          !this.components.some((c) => c.path === item.subject)
            ? [[item.subject, `${item.subject} (missing)`] as const]
            : []),
        ],
        (value) => (item.subject = value),
      );
      selectField(
        "View from",
        item.angle,
        viewAngles.map(
          (angle) => [angle, angle[0]!.toUpperCase() + angle.slice(1)] as const,
        ),
        (value) => (item.angle = value as ViewAngle),
        false,
      );
      const known = scaleChoices.includes(item.scale);
      selectField(
        "Scale",
        String(item.scale),
        [
          ...scaleChoices.map(
            (scale) => [String(scale), scaleName(scale)] as const,
          ),
          ...(known
            ? []
            : [[String(item.scale), scaleName(item.scale)] as const]),
        ],
        (value) => (item.scale = Number(value)),
        false,
      );
      const hidden = document.createElement("input");
      hidden.type = "checkbox";
      hidden.checked = Boolean(item.hiddenLines);
      hidden.onchange = () => {
        if (hidden.checked) item.hiddenLines = true;
        else delete item.hiddenLines;
        this.change();
      };
      row("Show hidden edges (dashed)", hidden).parentElement!.className =
        "plan-check";
      textField(
        "Caption",
        item.label,
        (value) => (item.label = value),
        planViewLabel(item),
      );
      numberField("X (mm)", item.x, (value) => (item.x = value));
      numberField("Y (mm)", item.y, (value) => (item.y = value));
      numberField("Width", item.width, (value) => (item.width = value), {
        min: 20,
      });
      numberField("Height", item.height, (value) => (item.height = value), {
        min: 20,
      });
      const fit = document.createElement("button");
      fit.textContent = "Fit scale to frame";
      fit.onclick = () => {
        item.scale = this.fitScale(item);
        this.change();
      };
      panel.append(fit);
    } else if (item.kind === "dimension") {
      textField(
        "Text",
        item.label,
        (value) => (item.label = value),
        String(
          Number(Math.hypot(item.u2 - item.u1, item.v2 - item.v1).toFixed(2)),
        ),
      );
      numberField(
        "Offset (mm)",
        item.offset,
        (value) => (item.offset = value),
        {
          wide: true,
        },
      );
      hint(
        "Measured on the model in this view, so it updates when the design changes. Drag it to move the dimension line; leave the text empty for the measured value.",
      );
    } else {
      textField("Text", item.text, (value) => (item.text = value));
      numberField("Size (mm)", item.size, (value) => (item.size = value), {
        min: 1,
        wide: true,
      });
      numberField("X (mm)", item.x, (value) => (item.x = value));
      numberField("Y (mm)", item.y, (value) => (item.y = value));
    }
    const remove = document.createElement("button");
    remove.className = "plan-delete";
    remove.textContent = "Delete";
    remove.title = "Delete (Del)";
    remove.onclick = () => this.remove(item);
    panel.append(remove);
  }
  async save() {
    try {
      validateDrawingPlan(this.plan);
      const response = await fetch("/api/drawing-plan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CodeCAD-Token": this.token(),
        },
        body: JSON.stringify({ version: this.version, plan: this.plan }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      this.version = result.version;
      this.dirty = false;
      this.status(
        `Saved ${String(result.file).split(/[\\/]/).at(-1)} · rebuilding the sheet`,
      );
      return true;
    } catch (error) {
      this.status(error instanceof Error ? error.message : String(error));
      return false;
    }
  }
  /** The PDF comes from the build, so it always has true hidden-line views. */
  private async download() {
    if (!this.views().length) {
      this.status("Add a view before downloading the sheet.");
      return;
    }
    if (this.dirty) {
      if (!(await this.save())) return;
      this.status("Saved · the PDF is available once the rebuild finishes.");
      return;
    }
    const link = document.createElement("a");
    link.href = this.artifactUrl("drawing-plan.pdf") + "&download";
    link.download = "drawing-plan.pdf";
    link.click();
  }
}
