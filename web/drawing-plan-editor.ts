import * as THREE from "three";
import {
  emptyDrawingPlan,
  planSheet,
  planViewKey,
  planViewLabel,
  validateDrawingPlan,
  type DrawingPlan,
  type PlanItem,
  type PlanSheet,
} from "../src/drawing-plan.js";
import { PanZoom, typedZoom, viewBoxFor } from "./pan-zoom.js";
import { downloadWithProgress } from "./progress.js";
import {
  pickPair,
  tiledPaths,
  uniqueSegments,
  type PlanPick,
} from "./plan-linework.js";
import {
  rotatePaper,
  standardScales,
  viewAngles,
  viewBasis,
  type ViewAngle,
} from "../src/view-basis.js";

type Mesh = { componentPath: string; edges: number[]; matrix: number[] };
type Component = { path: string; label: string; parent?: string };
/** A part the 2D geometry tab shows, as segments in its own flat XY. */
type FlatPart = { path: string; label: string; lines: number[] };
type View = Extract<PlanItem, { kind: "view" }>;
type Dimension = Extract<PlanItem, { kind: "dimension" }>;
type BuiltView = { key: string; visible: number[]; hidden: number[] };
type Point = { x: number; y: number };
type ModelPoint = { u: number; v: number };
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
const viewKey = planViewKey;
/** A path is in the view when neither it nor an ancestor was switched off. */
const underPath = (path: string, root: string) =>
  path === root || path.startsWith(root + "/");
const hiddenBy = (view: View, path: string) =>
  view.hiddenParts?.find((root) => underPath(path, root));
const scaleChoices = standardScales.map((scale) => fmt(1 / scale));
const scaleName = (denominator: number) =>
  denominator >= 1 ? `1:${fmt(denominator)}` : `${fmt(1 / denominator)}:1`;
const titleBlock = { width: 170, height: 40, margin: 10 };
const measureHints = {
  first:
    "Click a corner or an edge in a view. Hold Shift for a point along an edge; Esc cancels.",
  afterPoint:
    "Click a second corner, or an edge for the perpendicular distance to it.",
  afterLine:
    "Click a corner for its distance from this edge, a parallel edge, or the same edge for its length.",
  place: "Click where the dimension line goes.",
};
/** How close, in screen pixels, the pointer must come to snap. */
const reach = { corner: 10, edge: 7 };

export class DrawingPlanEditor {
  private plan: DrawingPlan = emptyDrawingPlan();
  private sheetId = this.plan.sheets[0]!.id;
  private version = "";
  private modelTitle = "";
  private meshes: Mesh[] = [];
  private components: Component[] = [];
  private flatParts = new Map<string, FlatPart>();
  private built: Record<string, BuiltView> = {};
  private linework = new Map<string, Linework>();
  private drawn = new WeakMap<Linework, SVGElement>();
  /** The element drawn for each item on the sheet, by id. */
  private readonly nodes = new Map<string, SVGElement>();
  private zoomFrame = 0;
  private selected = "";
  private tool: "select" | "measure" | "text" = "select";
  /**
   * Dimension in progress: the first pick, then the two points it runs
   * between once the second is picked, then where its line goes.
   */
  private measure:
    | { view: string; first: PlanPick; a?: ModelPoint; b?: ModelPoint }
    | undefined;
  /** What the pointer is over while measuring, in sheet millimetres. */
  private hover: { view: string; p: Point; pick?: PlanPick } | undefined;
  private drag:
    | { x: number; y: number; item: PlanItem; resize: boolean; moved: boolean }
    | undefined;
  private dirty = false;
  private loaded = false;
  private readonly sheet = byId<SVGSVGElement>("plan-sheet");
  private readonly wrap = byId("plan-sheet-wrap");
  private readonly viewport = new PanZoom();
  private pan: { x: number; y: number; pointer: number } | undefined;
  private readonly overlay = svgNode("g", { "pointer-events": "none" });
  constructor(
    private token: () => string,
    private artifactUrl: (name: string) => string,
  ) {
    byId("plan-view").onclick = () => this.addView();
    const partButton = byId("plan-part"),
      partMenu = byId("plan-part-menu");
    partButton.onclick = (event) => {
      event.stopPropagation();
      if (partMenu.hidden) this.openPartMenu();
      else partMenu.hidden = true;
    };
    document.addEventListener("pointerdown", (event) => {
      if (
        !partMenu.hidden &&
        !partMenu.contains(event.target as Node) &&
        event.target !== partButton
      )
        partMenu.hidden = true;
    });
    byId("plan-measure").onclick = () =>
      this.setTool(this.tool === "measure" ? "select" : "measure");
    byId("plan-text").onclick = () =>
      this.setTool(this.tool === "text" ? "select" : "text");
    for (const [id, action] of [
      ["plan-zoom-out", () => this.viewport.zoom(1 / 1.25)],
      ["plan-zoom-in", () => this.viewport.zoom(1.25)],
      ["plan-zoom-fit", () => this.viewport.reset()],
    ] as const)
      byId(id).onclick = () => {
        action();
        this.applyZoom();
      };
    const level = byId<HTMLInputElement>("plan-zoom-level");
    // Both Enter and leaving the field commit; anything unreadable snaps back.
    const commit = () => {
      const scale = typedZoom(level.value);
      if (scale !== undefined) this.viewport.zoomTo(scale);
      this.applyZoom();
    };
    level.onfocus = () => level.select();
    level.onchange = commit;
    level.onkeydown = (event) => {
      if (event.key === "Enter") commit();
      else if (event.key === "Escape") {
        this.applyZoom();
        level.blur();
      } else return;
      event.preventDefault();
    };
    this.wrap.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const bounds = this.wrap.getBoundingClientRect();
        const delta =
          event.deltaY *
          (event.deltaMode === 1
            ? 16
            : event.deltaMode === 2
              ? bounds.height
              : 1);
        this.viewport.zoom(
          Math.exp(-Math.max(-200, Math.min(200, delta)) * 0.002),
          event.clientX - bounds.left - bounds.width / 2,
          event.clientY - bounds.top - bounds.height / 2,
        );
        this.applyZoom();
      },
      { passive: false },
    );
    this.wrap.addEventListener("pointerdown", (event) => this.panDown(event));
    this.wrap.addEventListener("pointermove", (event) => this.panMove(event));
    for (const type of ["pointerup", "pointercancel"] as const)
      this.wrap.addEventListener(type, () => this.panUp());
    new ResizeObserver(() => this.applyZoom()).observe(this.wrap);
    this.applyZoom();
    byId("plan-save").onclick = () => void this.save();
    byId("plan-export").onclick = () => void this.download();
    this.sheet.addEventListener("pointerdown", (event) =>
      this.pointerDown(event),
    );
    this.sheet.addEventListener("pointermove", (event) =>
      this.pointerMove(event),
    );
    this.sheet.addEventListener("pointerleave", () => {
      this.hover = undefined;
      this.renderOverlay();
    });
    for (const type of ["pointerup", "pointercancel"] as const)
      this.sheet.addEventListener(type, () => {
        if (this.drag?.moved) this.fields();
        this.drag = undefined;
      });
    window.addEventListener("keydown", (event) => this.keyDown(event));
    // Shift switches an edge between the whole line and a point along it.
    window.addEventListener("keyup", (event) => {
      if (event.key === "Shift" && this.active) this.refreshHover(false);
    });
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
    this.sheetId = this.plan.sheets[0]!.id;
    if (!this.page.title) this.page.title = this.modelTitle;
    this.version = data.version;
    this.dirty = false;
    this.loaded = true;
    this.status(
      this.plan.sheets.some((sheet) => sheet.items.length)
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
    flatParts?: FlatPart[];
  }) {
    this.meshes = model.meshes;
    this.components = model.components;
    this.built = model.planViews ?? {};
    this.flatParts = new Map(
      (model.flatParts ?? []).map((part) => [part.path, part]),
    );
    this.linework.clear();
    this.modelTitle = model.title;
    if (!this.plan.sheets[0]!.title) this.plan.sheets[0]!.title = model.title;
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
  private get page(): PlanSheet {
    return (
      this.plan.sheets.find((sheet) => sheet.id === this.sheetId) ??
      this.plan.sheets[0]!
    );
  }
  /** Items on the sheet being edited. */
  private get items() {
    return this.page.items;
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
    this.measure = undefined;
    this.hover = undefined;
    byId("plan-measure").setAttribute(
      "aria-pressed",
      String(tool === "measure"),
    );
    byId("plan-text").setAttribute("aria-pressed", String(tool === "text"));
    this.sheet.style.cursor = tool === "select" ? "" : "crosshair";
    this.status(
      tool === "measure"
        ? measureHints.first
        : tool === "text"
          ? "Click the sheet to place a note. Esc cancels."
          : "Drag items to move them. Delete removes the selection.",
    );
    this.renderOverlay();
  }
  private views() {
    return this.items.filter((item): item is View => item.kind === "view");
  }
  /** Hidden-line geometry from the last build, else a live wireframe. A flat
   * part is already 2D, so its outline from the build is exact as it is. */
  private lines(view: View): Linework {
    const key = view.id + "|" + viewKey(view);
    const cached = this.linework.get(key);
    if (cached) return cached;
    const built = this.built[view.id];
    let visible: number[] = [],
      hidden: number[] = [],
      exact = false;
    if (view.angle === "flat") {
      const part = this.flatParts.get(view.subject);
      exact = Boolean(part);
      for (let i = 0; i + 1 < (part?.lines.length ?? 0); i += 2) {
        const p = rotatePaper(
          { x: part!.lines[i]!, y: part!.lines[i + 1]! },
          view.rotate ?? 0,
        );
        visible.push(p.x, p.y);
      }
    } else if (built?.key === viewKey(view)) {
      exact = true;
      ({ visible, hidden } = built);
    } else {
      const basis = viewBasis(view.angle, view.rotate ?? 0),
        horizontal = new THREE.Vector3(...basis.x),
        vertical = new THREE.Vector3(...basis.y),
        point = new THREE.Vector3();
      for (const mesh of this.meshes) {
        if (
          view.subject !== "*" &&
          !underPath(mesh.componentPath, view.subject)
        )
          continue;
        if (hiddenBy(view, mesh.componentPath)) continue;
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
    // A hidden edge under a visible one would only be drawn over again.
    const shown = uniqueSegments(visible);
    visible = shown.lines;
    hidden = uniqueSegments(hidden, shown.keys).lines;
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
  /** The automatic caption; a flat part is named after the part. */
  private caption(view: View) {
    if (view.angle !== "flat") return planViewLabel(view);
    const label =
      this.flatParts.get(view.subject)?.label ??
      view.subject.split("/").at(-1)!;
    return `${label} · ${scaleName(view.scale)}`;
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
    const existing = this.views().filter((view) => view.angle !== "flat"),
      angle = (["front", "top", "right", "isometric"] as const)[
        existing.length % 4
      ]!;
    this.place(
      { subject: existing.at(-1)?.subject ?? "*", angle },
      existing.at(-1)?.scale,
    );
  }
  /** Adds a view in the next free slot of a two-by-two grid on the sheet. */
  private place(view: Pick<View, "subject" | "angle">, scale = 0) {
    const index = this.views().length;
    const item: View = {
      id: uid(),
      kind: "view",
      ...view,
      x: 18 + (index % 2) * 198,
      y: 20 + (Math.floor(index / 2) % 2) * 112,
      width: 180,
      height: 100,
      scale: 10,
      label: "",
    };
    // Related views read best at one scale; otherwise use the largest that fits.
    item.scale = Math.max(scale, this.fitScale(item));
    this.items.push(item);
    this.selected = item.id;
    this.setTool("select");
    this.change();
  }
  /** Lists the parts the 2D geometry tab shows, to place one as cut. */
  private openPartMenu() {
    const menu = byId("plan-part-menu");
    menu.replaceChildren();
    const placed = new Set(
      this.views()
        .filter((view) => view.angle === "flat")
        .map((view) => view.subject),
    );
    if (!this.flatParts.size) {
      const note = document.createElement("p");
      note.textContent =
        "No parts in 2D geometry yet. A manufacturing output with showInDrawings puts its sheet parts there.";
      menu.append(note);
    }
    for (const part of this.flatParts.values()) {
      const button = document.createElement("button");
      button.setAttribute("role", "menuitem");
      const name = document.createElement("span");
      name.textContent = part.label;
      const path = document.createElement("small");
      path.textContent = placed.has(part.path)
        ? `${part.path} · on this sheet`
        : part.path;
      button.append(name, path);
      button.onclick = () => {
        menu.hidden = true;
        this.place({ subject: part.path, angle: "flat" });
      };
      menu.append(button);
    }
    menu.hidden = false;
    menu.querySelector("button")?.focus();
  }
  private addSheet() {
    const sheet: PlanSheet = {
      id: "sheet_" + crypto.randomUUID().replaceAll("-", ""),
      title: `${this.modelTitle || "Sheet"} · ${this.plan.sheets.length + 1}`,
      items: [],
    };
    this.plan.sheets.push(sheet);
    this.showSheet(sheet.id);
    this.change();
  }
  private showSheet(id: string) {
    this.sheetId = id;
    this.selected = "";
    this.setTool("select");
    this.render();
  }
  private removeSheet() {
    if (this.plan.sheets.length < 2) return;
    const index = this.plan.sheets.indexOf(this.page);
    if (
      this.page.items.length &&
      !confirm(
        `Delete sheet "${this.page.title || index + 1}" and everything on it?`,
      )
    )
      return;
    this.plan.sheets.splice(index, 1);
    this.showSheet(this.plan.sheets[Math.max(0, index - 1)]!.id);
    this.change();
  }
  private renderTabs() {
    const bar = byId("plan-sheet-tabs");
    bar.replaceChildren();
    for (const [index, sheet] of this.plan.sheets.entries()) {
      const tab = document.createElement("button");
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(sheet.id === this.page.id));
      tab.textContent = sheet.title || `Sheet ${index + 1}`;
      tab.title = `Sheet ${index + 1} of ${this.plan.sheets.length}`;
      tab.onclick = () => {
        if (sheet.id !== this.page.id) this.showSheet(sheet.id);
      };
      bar.append(tab);
    }
    const add = document.createElement("button");
    add.className = "plan-sheet-add";
    add.textContent = "+";
    add.title = "Add a sheet (a new page of the PDF and DXF)";
    add.setAttribute("aria-label", "Add sheet");
    add.onclick = () => this.addSheet();
    bar.append(add);
  }
  /** Middle button anywhere, or dragging the sheet's empty background. */
  private panDown(event: PointerEvent) {
    const onItem =
      event.button === 0 &&
      (this.tool !== "select" || Boolean(this.itemAt(event)));
    if ((event.button !== 0 && event.button !== 1) || onItem) return;
    this.pan = { x: event.clientX, y: event.clientY, pointer: event.pointerId };
    this.wrap.setPointerCapture(event.pointerId);
    this.wrap.classList.add("panning");
  }
  private panMove(event: PointerEvent) {
    if (this.pan?.pointer !== event.pointerId) return;
    this.viewport.pan(event.clientX - this.pan.x, event.clientY - this.pan.y);
    this.pan = { ...this.pan, x: event.clientX, y: event.clientY };
    this.applyZoom();
  }
  private panUp() {
    this.pan = undefined;
    this.wrap.classList.remove("panning");
  }
  /**
   * Zooming moves the viewBox rather than scaling the element, so the sheet is
   * re-rasterised at the display's resolution instead of being stretched.
   */
  private applyZoom() {
    // Wheel and drag events can outpace the display; one update per frame.
    if (this.zoomFrame) return;
    this.zoomFrame = requestAnimationFrame(() => {
      this.zoomFrame = 0;
      this.updateViewBox();
    });
  }
  private updateViewBox() {
    const { x, y, scale } = this.viewport;
    const width = this.wrap.clientWidth,
      height = this.wrap.clientHeight;
    if (width > 0 && height > 0) {
      const box = viewBoxFor({ scale, x, y }, planSheet, width, height);
      this.sheet.setAttribute(
        "viewBox",
        `${fmt(box.minX)} ${fmt(box.minY)} ${fmt(box.width)} ${fmt(box.height)}`,
      );
    }
    byId<HTMLInputElement>("plan-zoom-level").value =
      `${Math.round(scale * 100)}%`;
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
  /** Paper millimetres per screen pixel at the current zoom. */
  private get pixel() {
    return 1 / (this.sheet.getScreenCTM()?.a || 1);
  }
  /**
   * A corner when one is close, else the edge under the pointer as a whole
   * line, or with `alongEdge` the point on it; otherwise the free point.
   * Reach is in screen pixels, so it feels the same at every zoom level.
   */
  private pickAt(view: View, p: Point, alongEdge: boolean): PlanPick {
    const lines = this.lines(view),
      target = this.toModel(view, p),
      cornerReach = reach.corner * this.pixel * view.scale,
      edgeReach = reach.edge * this.pixel * view.scale;
    let corner: { u: number; v: number; d: number } | undefined,
      edge:
        { a: ModelPoint; b: ModelPoint; at: ModelPoint; d: number } | undefined;
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
        if (d <= edgeReach && (!edge || d < edge.d))
          edge = {
            a: { u: ax, v: ay },
            b: { u: bx, v: by },
            at: { u: fmt(u), v: fmt(v) },
            d,
          };
      }
    if (corner) return { kind: "point", at: { u: corner.u, v: corner.v } };
    if (edge)
      return alongEdge
        ? { kind: "point", at: edge.at }
        : { kind: "line", a: edge.a, b: edge.b, at: edge.at };
    return { kind: "point", at: target, free: true };
  }
  private refreshHover(alongEdge: boolean) {
    if (this.tool !== "measure" || !this.hover || this.measure?.b) return;
    const view = this.views().find((item) => item.id === this.hover!.view);
    if (!view) return;
    this.hover.pick = this.pickAt(view, this.hover.p, alongEdge);
    this.renderOverlay();
  }
  private itemAt(event: PointerEvent) {
    const element = event.target as Element;
    const id = element.closest("[data-plan-id]")?.getAttribute("data-plan-id");
    return this.items.find((item) => item.id === id);
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
      this.items.push(item);
      this.selected = item.id;
      this.setTool("select");
      this.change();
      const input = byId("plan-fields").querySelector("input");
      input?.focus();
      input?.select();
      return;
    }
    if (this.tool === "measure") {
      const view = this.measureView(p);
      if (!view) {
        this.status("Click inside a model view.");
        return;
      }
      const measure = this.measure;
      // Third click: the points are fixed, this one only places the line.
      if (measure?.a && measure.b) {
        const item: Dimension = {
          id: uid(),
          kind: "dimension",
          view: view.id,
          u1: measure.a.u,
          v1: measure.a.v,
          u2: measure.b.u,
          v2: measure.b.v,
          offset: this.offsetAt(view, measure.a, measure.b, p),
          label: "",
        };
        this.items.push(item);
        this.selected = item.id;
        this.setTool("select");
        this.change();
        return;
      }
      const pick = this.pickAt(view, p, event.shiftKey);
      if (!measure) {
        this.measure = { view: view.id, first: pick };
        this.status(
          pick.kind === "line"
            ? measureHints.afterLine
            : measureHints.afterPoint,
        );
      } else {
        const pair = pickPair(measure.first, pick);
        if (typeof pair === "string") {
          this.status(pair);
          return;
        }
        measure.a = { u: fmt(pair.a.u), v: fmt(pair.a.v) };
        measure.b = { u: fmt(pair.b.u), v: fmt(pair.b.v) };
        this.status(measureHints.place);
      }
      this.hover = { view: view.id, p };
      this.renderOverlay();
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
      const view = this.measureView(p);
      // Placing the line follows the cursor freely; only the targets snap.
      this.hover = view && {
        view: view.id,
        p,
        ...(!this.measure?.b && {
          pick: this.pickAt(view, p, event.shiftKey),
        }),
      };
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
      // Dragging a dimension slides its line toward or away from the geometry.
      item.offset = this.offsetAt(
        view,
        { u: item.u1, v: item.v1 },
        { u: item.u2, v: item.v2 },
        p,
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
    this.redraw(item);
  }
  /** Once a dimension is started, it stays in the view it started in. */
  private measureView(p: Point) {
    const id = this.measure?.view;
    return id ? this.views().find((item) => item.id === id) : this.viewAt(p);
  }
  /** Paper millimetres from the measured line to `p`, signed by side. */
  private offsetAt(view: View, from: ModelPoint, to: ModelPoint, p: Point) {
    const a = this.toSheet(view, from.u, from.v),
      b = this.toSheet(view, to.u, to.v),
      length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return fmt(
      ((p.x - a.x) * -(b.y - a.y) + (p.y - a.y) * (b.x - a.x)) / length,
    );
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
    if (event.key === "Shift") {
      this.refreshHover(true);
      return;
    }
    if (event.key === "Escape") {
      if (this.tool !== "select") this.setTool("select");
      else if (this.selected) {
        this.selected = "";
        this.render();
      }
      return;
    }
    if (["+", "=", "-", "0"].includes(event.key)) {
      event.preventDefault();
      if (event.key === "0") this.viewport.reset();
      else this.viewport.zoom(event.key === "-" ? 1 / 1.25 : 1.25);
      this.applyZoom();
      return;
    }
    const item = this.items.find((entry) => entry.id === this.selected);
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
    this.page.items = this.items.filter(
      (entry) =>
        entry.id !== item.id &&
        !(entry.kind === "dimension" && entry.view === item.id),
    );
    this.selected = "";
    this.change();
  }
  private render() {
    this.renderTabs();
    this.renderSheet();
    this.fields();
  }
  private renderOverlay() {
    this.overlay.replaceChildren();
    if (this.tool !== "measure") return;
    const color = "#09a68d",
      px = this.pixel,
      measure = this.measure,
      hover = this.hover,
      view = this.views().find(
        (item) => item.id === (measure?.view ?? hover?.view),
      );
    if (!view) return;
    const at = (point: ModelPoint) => this.toSheet(view, point.u, point.v);
    // Markers are sized in screen pixels, so they stay put while zooming.
    const show = (pick: PlanPick) => {
      if (pick.kind === "line") {
        const a = at(pick.a),
          b = at(pick.b);
        this.overlay.append(
          svgNode("line", {
            x1: a.x,
            y1: a.y,
            x2: b.x,
            y2: b.y,
            stroke: color,
            "stroke-opacity": 0.75,
            "stroke-width": 3 * px,
            "stroke-linecap": "round",
          }),
        );
        return;
      }
      const p = at(pick.at);
      this.overlay.append(
        svgNode("circle", {
          cx: p.x,
          cy: p.y,
          r: (pick.free ? 3.5 : 5) * px,
          fill: pick.free ? "none" : "#09a68d55",
          stroke: color,
          "stroke-width": 1.5 * px,
        }),
      );
    };
    if (measure?.a && measure.b) {
      show(measure.first);
      show({ kind: "point", at: measure.a });
      show({ kind: "point", at: measure.b });
      // The finished dimension, its line under the cursor until placed.
      this.drawDimension(
        this.overlay,
        view,
        {
          u1: measure.a.u,
          v1: measure.a.v,
          u2: measure.b.u,
          v2: measure.b.v,
          offset: hover
            ? this.offsetAt(view, measure.a, measure.b, hover.p)
            : 8,
          label: "",
        },
        color,
      );
      return;
    }
    if (measure) show(measure.first);
    if (!hover?.pick) return;
    show(hover.pick);
    if (!measure) return;
    const pair = pickPair(measure.first, hover.pick);
    if (typeof pair === "string") return;
    const a = at(pair.a),
      b = at(pair.b);
    this.overlay.append(
      svgNode("line", {
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        stroke: color,
        "stroke-width": 1.2 * px,
        "stroke-dasharray": `${6 * px} ${4 * px}`,
      }),
      svgNode(
        "text",
        {
          x: hover.p.x + 10 * px,
          y: hover.p.y - 10 * px,
          "font-size": 12 * px,
          fill: "#067a68",
        },
        `${fmt(Math.hypot(pair.b.u - pair.a.u, pair.b.v - pair.a.v))} mm`,
      ),
    );
  }
  private renderSheet() {
    const { width, height } = planSheet;
    // Stacked translucent rects rather than a blur filter: a filter is
    // re-rendered over the whole page at screen resolution on every repaint,
    // which grows with the zoom until panning a zoomed-in sheet crawls.
    const shadow = [3, 2, 1].map((spread) =>
      svgNode("rect", {
        x: -spread,
        y: 2 - spread,
        width: width + spread * 2,
        height: height + spread * 2,
        rx: spread,
        fill: "#000",
        "fill-opacity": 0.12,
        "pointer-events": "none",
      }),
    );
    this.sheet.replaceChildren(
      ...shadow,
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
        this.page.title || "Drawing plan",
      ),
    );
    this.sheet.append(block);
    this.nodes.clear();
    for (const item of this.items) {
      const node = this.itemNode(item);
      if (!node) continue;
      this.nodes.set(item.id, node);
      this.sheet.append(node);
    }
    this.sheet.append(this.overlay);
    this.renderOverlay();
  }
  /**
   * Redraws one item and the dimensions hanging off it in place, so dragging
   * does not rebuild the whole sheet on every move.
   */
  private redraw(item: PlanItem) {
    for (const entry of this.items) {
      if (
        entry !== item &&
        !(entry.kind === "dimension" && entry.view === item.id)
      )
        continue;
      const old = this.nodes.get(entry.id),
        node = this.itemNode(entry);
      if (!old || !node) {
        this.renderSheet();
        return;
      }
      old.replaceWith(node);
      this.nodes.set(entry.id, node);
    }
  }
  private itemNode(item: PlanItem): SVGElement | undefined {
    const selectedColor = "#09a68d";
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
      g.append(clip);
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
      const clipped = svgNode("g", { "clip-path": `url(#${clipId})` });
      clipped.append(this.drawnLines(item, lines));
      g.append(clipped);
      g.append(
        svgNode(
          "text",
          {
            x: item.x,
            y: item.y + item.height + 5,
            "font-size": 3.5,
            fill: "#24343b",
          },
          (item.label || this.caption(item)) +
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
      if (!view) return undefined;
      this.drawDimension(g, view, item, chosen ? selectedColor : "#235767");
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
    return g;
  }
  /**
   * A view's linework as path elements, built once per geometry and placed on
   * the sheet by a transform. Moving, resizing or rescaling a view then only
   * changes attributes, and the paths stay in model millimetres, tiled so a
   * zoomed-in sheet repaints just the tiles on screen.
   */
  private drawnLines(view: View, lines: Linework) {
    let group = this.drawn.get(lines);
    if (!group) {
      group = svgNode("g", { fill: "none", "stroke-linecap": "round" });
      const tile = Math.max(lines.width, lines.height, 1) / 12;
      for (const [set, layer] of [
        [lines.hidden, "hidden"],
        [lines.visible, "visible"],
      ] as const) {
        if (!set.length) continue;
        const paths = svgNode("g", { "data-lines": layer });
        for (const d of tiledPaths(set, tile))
          paths.append(svgNode("path", { d }));
        group.append(paths);
      }
      this.drawn.set(lines, group);
    }
    // Stroke widths are paper millimetres, so they grow with the model scale.
    const s = view.scale;
    group.setAttribute(
      "transform",
      `matrix(${1 / s},0,0,${-1 / s},${view.x + view.width / 2 - lines.cx / s},${view.y + view.height / 2 + lines.cy / s})`,
    );
    for (const layer of group.children) {
      const dashed = layer.getAttribute("data-lines") === "hidden";
      layer.setAttribute("stroke", dashed ? "#6b7d84" : "#24343b");
      layer.setAttribute(
        "stroke-width",
        String((dashed ? 0.18 : lines.exact ? 0.35 : 0.2) * s),
      );
      if (dashed) layer.setAttribute("stroke-dasharray", `${2 * s} ${s}`);
    }
    return group;
  }
  /** A dimension as drawn on the sheet; also previews one being placed. */
  private drawDimension(
    g: SVGElement,
    view: View,
    item: Pick<Dimension, "u1" | "v1" | "u2" | "v2" | "offset" | "label">,
    stroke: string,
  ) {
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
            Number(Math.hypot(item.u2 - item.u1, item.v2 - item.v1).toFixed(2)),
          ),
      ),
    );
  }
  /** Per-view checklist of the parts under its subject. */
  private partList(panel: HTMLElement, item: View) {
    const scope = item.subject;
    const parts = this.components.filter(
      (component) =>
        component.parent !== undefined &&
        component.path !== scope &&
        (scope === "*" || underPath(component.path, scope)),
    );
    const caption = document.createElement("span");
    caption.className = "plan-parts-head";
    panel.append(caption);
    if (!parts.length) {
      caption.textContent = "Drawn parts";
      const note = document.createElement("p");
      note.textContent = "This subject has no separate parts to switch off.";
      panel.append(note);
      return;
    }
    const drawn = parts.filter((part) => !hiddenBy(item, part.path)).length;
    caption.textContent = `Drawn parts · ${drawn} of ${parts.length}`;
    const list = document.createElement("div");
    list.className = "plan-parts";
    const base = scope === "*" ? 1 : scope.split("/").length;
    for (const part of parts) {
      const wrap = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      const hiding = hiddenBy(item, part.path);
      box.checked = !hiding;
      // A part inside a switched-off parent follows its parent.
      box.disabled = Boolean(hiding) && hiding !== part.path;
      if (box.disabled) wrap.className = "plan-part-implied";
      box.onchange = () => {
        const kept = (item.hiddenParts ?? []).filter(
          (root) => !underPath(root, part.path),
        );
        item.hiddenParts = box.checked ? kept : [...kept, part.path];
        if (!item.hiddenParts.length) delete item.hiddenParts;
        this.change();
      };
      const name = document.createElement("span");
      name.textContent = part.label;
      name.style.paddingLeft = `${Math.max(0, part.path.split("/").length - base) * 10}px`;
      name.title = part.path;
      wrap.append(box, name);
      list.append(wrap);
    }
    panel.append(list);
    if (drawn === parts.length) return;
    const all = document.createElement("button");
    all.className = "plan-parts-all";
    all.textContent = "Draw every part";
    all.onclick = () => {
      delete item.hiddenParts;
      this.change();
    };
    panel.append(all);
  }
  /**
   * Turn a view on the paper. Dimension points are kept in the view's own
   * projected frame, so they are turned by the same amount and stay on the
   * geometry they measure.
   */
  private rotateView(view: View, degrees: number) {
    const next = Number.isFinite(degrees)
      ? fmt(Math.max(-360, Math.min(360, degrees)))
      : 0;
    const delta = next - (view.rotate ?? 0);
    if (!delta) return;
    if (next) view.rotate = next;
    else delete view.rotate;
    for (const item of this.items) {
      if (item.kind !== "dimension" || item.view !== view.id) continue;
      const a = rotatePaper({ x: item.u1, y: item.v1 }, delta),
        c = rotatePaper({ x: item.u2, y: item.v2 }, delta);
      item.u1 = fmt(a.x);
      item.v1 = fmt(a.y);
      item.u2 = fmt(c.x);
      item.v2 = fmt(c.y);
    }
  }
  /** Keeps only switched-off paths that still sit under the view's subject. */
  private pruneHiddenParts(item: View) {
    if (!item.hiddenParts) return;
    const kept = item.hiddenParts.filter(
      (path) =>
        // Showing a part outright overrides having switched it off before.
        path !== item.subject &&
        (item.subject === "*" || underPath(path, item.subject)),
    );
    if (kept.length) item.hiddenParts = kept;
    else delete item.hiddenParts;
  }
  private fields() {
    const panel = byId("plan-fields");
    panel.replaceChildren();
    const item = this.items.find((entry) => entry.id === this.selected);
    const heading = byId("plan-heading");
    heading.textContent = !item
      ? `Sheet ${this.plan.sheets.indexOf(this.page) + 1} of ${this.plan.sheets.length}`
      : item.kind === "view"
        ? item.angle === "flat"
          ? "Part as cut"
          : "Model view"
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
      textField("Title", this.page.title, (value) => (this.page.title = value));
      hint(
        this.items.length
          ? "Select an item to edit it. Save plan writes the recipe beside the project and adds every sheet to the build as a page of the PDF and DXF."
          : "Use ▣ to add a view of the model, ◫ to place a part from 2D geometry, the ruler to measure and dimension it and T for notes. + above the sheet adds another sheet.",
      );
      if (this.plan.sheets.length > 1) {
        const remove = document.createElement("button");
        remove.className = "plan-delete";
        remove.textContent = "Delete sheet";
        remove.onclick = () => this.removeSheet();
        panel.append(remove);
      }
      return;
    }
    if (item.kind === "view" && item.angle === "flat") {
      selectField(
        "Part",
        item.subject,
        [
          ...[...this.flatParts.values()].map(
            (part) => [part.path, part.label] as const,
          ),
          ...(this.flatParts.has(item.subject)
            ? []
            : [
                [item.subject, `${item.subject} (not in 2D geometry)`] as const,
              ]),
        ],
        (value) => (item.subject = value),
      );
    }
    if (item.kind === "view" && item.angle !== "flat") {
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
        (value) => {
          item.subject = value;
          // Paths outside the new subject can no longer be switched off.
          this.pruneHiddenParts(item);
        },
      );
      this.partList(panel, item);
      selectField(
        "View from",
        item.angle,
        viewAngles.map(
          (angle) => [angle, angle[0]!.toUpperCase() + angle.slice(1)] as const,
        ),
        (value) => (item.angle = value as ViewAngle),
        false,
      );
    }
    if (item.kind === "view") {
      const turn = (degrees: number) => {
        const next = ((((item.rotate ?? 0) + degrees) % 360) + 360) % 360;
        this.rotateView(item, next);
        this.change();
      };
      const rotation = numberField("Rotate (°)", item.rotate ?? 0, (value) =>
        this.rotateView(item, value),
      );
      rotation.setAttribute("step", "15");
      const quarter = document.createElement("div");
      quarter.className = "plan-turn";
      for (const [label, degrees] of [
        ["↺ 90°", 90],
        ["↻ 90°", -90],
      ] as const) {
        const button = document.createElement("button");
        button.textContent = label;
        button.setAttribute(
          "aria-label",
          `Turn the view ${degrees > 0 ? "counter-clockwise" : "clockwise"} by 90 degrees`,
        );
        button.onclick = () => turn(degrees);
        quarter.append(button);
      }
      panel.append(quarter);
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
      if (item.angle !== "flat") {
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
      }
      textField(
        "Caption",
        item.label,
        (value) => (item.label = value),
        this.caption(item),
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
    if (
      !this.plan.sheets.some((sheet) =>
        sheet.items.some((item) => item.kind === "view"),
      )
    ) {
      this.status("Add a view before downloading the sheet.");
      return;
    }
    if (this.dirty) {
      if (!(await this.save())) return;
      this.status("Saved · the PDF is available once the rebuild finishes.");
      return;
    }
    await downloadWithProgress(
      this.artifactUrl("drawing-plan.pdf") + "&download",
      "drawing-plan.pdf",
      byId("plan-status"),
    );
  }
}
