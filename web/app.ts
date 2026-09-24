import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { ReportDownload } from "../src/reports.js";
import type { ParameterState } from "../src/parameters.js";
import { IsolationSession } from "./isolation.js";
import {
  reportProjectTitle,
  saveDesktopPreview,
  setupDesktop,
} from "./desktop.js";
import { loadPanes, rememberPane, whenRemembered } from "./panes.js";
import { pdfViewer, type PdfReport } from "./pdf-viewer.js";
import { availableViews } from "./available-views.js";
import { Plane2DCanvas } from "./plane2d.js";
import { DrawingPlanEditor } from "./drawing-plan-editor.js";
import { initiallyExpandedPaths } from "./component-tree.js";
import { formatMass, inspectorDetails } from "./inspector.js";
import { groupCutRows } from "../src/cut-rows.js";
import { applyWoodAppearance } from "./wood-material.js";
import {
  faceRegionGeometry,
  visibleSurfacePoint,
} from "./surface-visibility.js";
import type { View2DPrimitive } from "../src/view2d.js";
import type { Inspection } from "../src/inspection.js";
import type { CutRow } from "../src/manufacturing.js";
import {
  chooseMeasurePick,
  measure,
  type MeasurePick,
  type MeasureResult,
} from "./measurement.js";
import {
  codeEditor,
  configureEditor,
  setSource,
  onSourceChange,
  highlightLines,
} from "./editor.js";
type MeshData = {
  componentPath: string;
  positions: number[];
  normals: number[];
  indices: number[];
  edges: number[];
  matrix: number[];
  color: string;
  opacity: number;
  reflectivity: number;
  wood?: {
    direction: "width" | "height" | "none";
    layers: { thickness: number; direction: "width" | "height" }[];
  };
  holes: {
    center: [number, number, number];
    axis: [number, number, number];
    diameter: number;
  }[];
  volume: number;
  density?: number;
};
type MotionFrame = { t: number; matrices: Record<string, number[]> };
type StudioAnimation = {
  id: string;
  title: string;
  duration: number;
  frames: MotionFrame[];
  meshFrames?: MeshData[];
};
type Model = {
  view2D?: View2DPrimitive[];
  planViews?: Record<
    string,
    { key: string; visible: number[]; hidden: number[] }
  >;
  /** Sheet parts shown in 2D geometry, placeable on the drawing sheet. */
  flatParts?: { path: string; label: string; lines: number[] }[];
  parameters: ParameterState | null;
  components: {
    path: string;
    id: string;
    label: string;
    parent?: string;
    type: string;
    inspection: Inspection;
    source: { file: string; line: number }[];
  }[];
  duration: number;
  title: string;
  /** From the project's `PROJECTINFO`; absent for entry files without one. */
  info: {
    name: string;
    author?: string;
    description?: string;
    revision?: string;
  } | null;
  meshes: MeshData[];
  diagnostics: { severity: string; message: string }[];
  files: { name: string; kind: string; size: number; ready?: boolean }[];
  reports: ReportDownload[];
  frames: MotionFrame[];
  animations: StudioAnimation[];
  unfolds: { path: string; label: string; frames: MeshData[] }[];
  cutList: CutRow[];
};
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
let sourceFile = "";
const edgesEnabled = () => $("edges").getAttribute("aria-pressed") === "true";
/** Edge line strength, 0.05 - 1: WebGL ignores line width, so strength is opacity. */
const edgeStrength = () =>
  Number($<HTMLInputElement>("edge-strength").value) / 100;
/** Perceived brightness of a material colour, 0 - 1. */
const brightness = (colour: string) => {
  const hex = new THREE.Color(colour).getHex(THREE.SRGBColorSpace);
  return (
    (0.2126 * ((hex >> 16) & 255) +
      0.7152 * ((hex >> 8) & 255) +
      0.0722 * (hex & 255)) /
    255
  );
};
/** Edge line colour: automatic picks the contrast that reads on the material. */
const edgeColour = (materialColour: string) => {
  const choice = $<HTMLSelectElement>("edge-color").value;
  if (choice === "custom")
    return $<HTMLInputElement>("edge-color-custom").value;
  if (choice !== "auto") return choice;
  return brightness(materialColour) < 0.5 ? "#ffffff" : "#000000";
};
const applyEdgeAppearance = () => {
  const opacity = edgeStrength();
  for (const edges of edgeObjects.values()) {
    const material = edges.material as THREE.LineBasicMaterial;
    material.opacity = opacity;
    material.color.set(edgeColour(edges.userData.materialColour));
  }
  const custom = $<HTMLSelectElement>("edge-color").value === "custom";
  $<HTMLInputElement>("edge-color-custom").hidden = !custom;
  $<HTMLInputElement>("edge-strength").disabled = !edgesEnabled();
  $<HTMLSelectElement>("edge-color").disabled = !edgesEnabled();
  $<HTMLInputElement>("edge-color-custom").disabled = !edgesEnabled();
};
const isolation = new IsolationSession<{
  visible: Map<string, boolean>;
  position: THREE.Vector3;
  target: THREE.Vector3;
  center: THREE.Vector3;
  up: THREE.Vector3;
  zoom: number;
  near: number;
  far: number;
  selected: string;
}>();
const expanded = new Set<string>();
const within = (path: string, parent: string) =>
  path === parent || path.startsWith(parent + "/");
let version = "",
  token = "",
  dirty = false,
  model: Model | undefined,
  selected = "",
  playing = false,
  time = 0,
  shownGeneration = -1;
const selectedAnimation = (): StudioAnimation | undefined => {
  const id = $<HTMLSelectElement>("animation-select").value;
  const unfold = model?.unfolds?.find((item) => id === `unfold:${item.path}`);
  if (unfold)
    return {
      id,
      title: `Unfold · ${unfold.label}`,
      duration: 2,
      meshFrames: unfold.frames,
      frames: unfold.frames.map((_, index) => ({
        t: index / (unfold.frames.length - 1),
        matrices: {} as Record<string, number[]>,
      })),
    };
  return model?.animations.find((animation) => animation.id === id);
};
const renderedGeometry = new Map<string, string>();
function renderAnimationChoices() {
  const selector = $<HTMLSelectElement>("animation-select"),
    previous = selector.value;
  selector.replaceChildren();
  for (const animation of model?.animations ?? []) {
    const option = document.createElement("option");
    option.value = animation.id;
    option.textContent = animation.title;
    selector.append(option);
  }
  const unfold = model?.unfolds?.find((item) => item.path === selected);
  if (unfold) {
    const option = document.createElement("option");
    option.value = `unfold:${unfold.path}`;
    option.textContent = `Unfold · ${unfold.label}`;
    selector.append(option);
  }
  if ([...selector.options].some((option) => option.value === previous))
    selector.value = previous;
  else if (unfold) selector.value = `unfold:${unfold.path}`;
  if (selector.value !== previous) {
    playing = false;
    time = 0;
    $<HTMLInputElement>("motion").value = "0";
    $("play").textContent = "▶ Motion";
  }
  selector.hidden = !selector.options.length;
  const frames =
    selectedAnimation()?.frames.length ?? model?.frames.length ?? 0;
  $<HTMLButtonElement>("play").disabled = !frames;
  $<HTMLInputElement>("motion").disabled = !frames;
}
const canvas = $("canvas"),
  scene = new THREE.Scene(),
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
const plane2D = new Plane2DCanvas($<HTMLCanvasElement>("plane2d-canvas"));
const drawingPlan = new DrawingPlanEditor(
  () => token,
  (name) => artifactUrl(name),
);
let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera =
  new THREE.PerspectiveCamera(40, 1, 0.1, 100000);
camera.up.set(0, 0, 1);
camera.position.set(1500, -1700, 1350);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
canvas.append(renderer.domElement);
let controls: OrbitControls<
  THREE.PerspectiveCamera | THREE.OrthographicCamera
> = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.mouseButtons = {
  LEFT: null,
  MIDDLE: THREE.MOUSE.ROTATE,
  RIGHT: THREE.MOUSE.PAN,
};
scene.add(new THREE.HemisphereLight(0xe7f4ff, 0x766a55, 2.4));
const sun = new THREE.DirectionalLight(0xffffff, 3);
sun.position.set(700, -900, 1800);
scene.add(sun);
const fill = new THREE.DirectionalLight(0xb4d4ee, 1);
fill.position.set(-900, 600, 300);
scene.add(fill);
const grid = new THREE.GridHelper(3000, 30, 0x48606c, 0x344c57);
grid.rotation.x = Math.PI / 2;
grid.position.z = -1;
scene.add(grid);
const group = new THREE.Group();
scene.add(group);
const holeGroup = new THREE.Group(),
  measurementGroup = new THREE.Group(),
  hoverGroup = new THREE.Group();
scene.add(holeGroup, measurementGroup, hoverGroup);
const measureLabel = document.createElement("div");
measureLabel.className = "measure-label";
measureLabel.hidden = true;
canvas.append(measureLabel);
let measurementMode = false,
  measurePicks: MeasurePick[] = [],
  measured: MeasureResult | undefined;
const objects = new Map<string, THREE.Mesh>(),
  edgeObjects = new Map<string, THREE.LineSegments>();
let hoveredFace: { mesh: THREE.Mesh; faceIndex: number } | undefined;
let bounds = new THREE.Box3(),
  center = new THREE.Vector3();
function resize() {
  const w = canvas.clientWidth,
    h = canvas.clientHeight;
  if (w && h) {
    renderer.setSize(w, h);
    if (camera instanceof THREE.PerspectiveCamera) camera.aspect = w / h;
    else {
      const halfHeight = (camera.top - camera.bottom) / 2;
      camera.left = -halfHeight * (w / h);
      camera.right = halfHeight * (w / h);
    }
    camera.updateProjectionMatrix();
  }
}
new ResizeObserver(resize).observe(canvas);
function fit(direction?: string) {
  if (!model) return;
  group.updateWorldMatrix(true, true, true);
  bounds = new THREE.Box3();
  for (const mesh of objects.values())
    if (mesh.visible) bounds.union(new THREE.Box3().setFromObject(mesh));
  if (bounds.isEmpty()) return;
  center = bounds.getCenter(new THREE.Vector3());
  const extent = Math.max(bounds.getSize(new THREE.Vector3()).length(), 100);
  const aspect = Math.max(
    canvas.clientWidth / Math.max(canvas.clientHeight, 1),
    0.1,
  );
  const distance = (extent * 1.85) / Math.min(aspect, 1);
  const directions: Record<string, THREE.Vector3> = {
    front: new THREE.Vector3(0, -1, 0.02),
    back: new THREE.Vector3(0, 1, 0.02),
    left: new THREE.Vector3(-1, 0, 0.02),
    right: new THREE.Vector3(1, 0, 0.02),
    top: new THREE.Vector3(0, -0.001, 1),
  };
  const dir = (
    directions[direction ?? ""] ?? new THREE.Vector3(1, -1.5, 0.9)
  ).normalize();
  camera.position.copy(center).addScaledVector(dir, distance);
  controls.target.copy(center);
  camera.near = distance / 10000;
  camera.far = distance * 30;
  if (camera instanceof THREE.OrthographicCamera) {
    const half = (extent * 0.8) / Math.min(aspect, 1);
    camera.left = -half * aspect;
    camera.right = half * aspect;
    camera.top = half;
    camera.bottom = -half;
  }
  camera.updateProjectionMatrix();
  controls.update();
}
function setProjection(parallel: boolean) {
  if (parallel === camera instanceof THREE.OrthographicCamera) return;
  const position = camera.position.clone();
  const target = controls.target.clone();
  controls.dispose();
  camera = parallel
    ? new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100000)
    : new THREE.PerspectiveCamera(40, 1, 0.1, 100000);
  camera.up.set(0, 0, 1);
  camera.position.copy(position);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.mouseButtons = {
    LEFT: null,
    MIDDLE: THREE.MOUSE.ROTATE,
    RIGHT: THREE.MOUSE.PAN,
  };
  controls.target.copy(target);
  fit();
  // A fresh camera starts square. Without this the perspective view renders
  // at aspect 1 until the next canvas resize, which stretches the model.
  resize();
  const toggle = $("projection-toggle");
  toggle.setAttribute("aria-pressed", String(parallel));
  toggle.setAttribute(
    "aria-label",
    `Switch to ${parallel ? "perspective" : "parallel"} projection`,
  );
  toggle.title = `${parallel ? "Parallel" : "Perspective"} projection · switch to ${parallel ? "perspective" : "parallel"}`;
  toggle.textContent = parallel ? "▱" : "◈";
}
function clearScene() {
  for (const child of [...group.children]) {
    const o = child as THREE.Mesh;
    o.geometry.dispose();
    const material = o.material;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else material.dispose();
    group.remove(child);
  }
  objects.clear();
  edgeObjects.clear();
  renderedGeometry.clear();
  for (const overlay of [holeGroup, measurementGroup, hoverGroup]) {
    for (const child of [...overlay.children]) {
      const drawable = child as THREE.Mesh;
      drawable.geometry.dispose();
      const material = drawable.material;
      if (Array.isArray(material)) material.forEach((item) => item.dispose());
      else material.dispose();
      overlay.remove(child);
    }
  }
  measurePicks = [];
  measured = undefined;
  measureLabel.hidden = true;
  hoveredFace = undefined;
}
function updateHoleMarkers() {
  if (!model) return;
  for (const mesh of model.meshes)
    for (const [index, hole] of mesh.holes.entries()) {
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(
          Math.max(10, Math.min(30, hole.diameter * 1.5)),
          12,
          8,
        ),
        new THREE.MeshBasicMaterial({ color: 0x70e3d0, depthTest: false }),
      );
      marker.position
        .fromArray(hole.center)
        .applyMatrix4(new THREE.Matrix4().fromArray(mesh.matrix));
      marker.renderOrder = 1000;
      marker.userData.componentPath = mesh.componentPath;
      marker.userData.localCenter = hole.center;
      marker.userData.diameter = hole.diameter;
      marker.userData.label = `${mesh.componentPath} · hole ${index + 1} (Ø${hole.diameter} mm)`;
      holeGroup.add(marker);
    }
  holeGroup.visible = false;
}
function showModel(data: Model) {
  const first = !model;
  model = data;
  if (first)
    initiallyExpandedPaths(data.components).forEach((path) =>
      expanded.add(path),
    );
  document.title = data.title + " · CodeCAD";
  $("project-name").textContent = data.title;
  // The desktop tab beside this page is named by the project, not by its file.
  reportProjectTitle(data.title);
  // The identity from index.ts, so the header says whose project this is.
  $("project-name").title = [
    data.info?.description,
    data.info?.author && `Drawn by ${data.info.author}`,
    data.info?.revision && `Revision ${data.info.revision}`,
  ]
    .filter(Boolean)
    .join("\n");
  clearScene();
  for (const d of data.meshes) {
    const geometry = new THREE.BufferGeometry()
      .setAttribute(
        "position",
        new THREE.Float32BufferAttribute(d.positions, 3),
      )
      .setAttribute("normal", new THREE.Float32BufferAttribute(d.normals, 3))
      .setIndex(d.indices);
    const material = new THREE.MeshPhysicalMaterial({
      color: d.color,
      opacity: d.opacity,
      transparent: d.opacity < 1,
      depthWrite: d.opacity >= 1,
      reflectivity: d.reflectivity,
      roughness: 0.8 - d.reflectivity * 0.65,
      clearcoat: d.reflectivity * 0.35,
    });
    if (d.wood) applyWoodAppearance(material, d.wood);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.fromArray(d.matrix);
    mesh.userData.path = d.componentPath;
    group.add(mesh);
    objects.set(d.componentPath, mesh);
    renderedGeometry.set(d.componentPath, "base");
    const edges = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute(
        "position",
        new THREE.Float32BufferAttribute(d.edges, 3),
      ),
      new THREE.LineBasicMaterial({
        color: edgeColour(d.color),
        transparent: true,
        opacity: edgeStrength(),
      }),
    );
    edges.userData.materialColour = d.color;
    edges.matrixAutoUpdate = false;
    edges.matrix.copy(mesh.matrix);
    group.add(edges);
    edgeObjects.set(d.componentPath, edges);
  }
  updateHoleMarkers();
  $("summary").textContent =
    data.meshes.length + " solids · " + data.files.length + " outputs";
  $("messages").replaceChildren();
  for (const diagnostic of data.diagnostics) {
    const div = document.createElement("div");
    div.className = diagnostic.severity;
    div.textContent = diagnostic.message;
    $("messages").append(div);
  }
  if (!data.diagnostics.length) {
    $("messages").textContent = "Geometry and outputs built successfully.";
    $("messages").className = "success";
  } else $("messages").className = "";
  renderParts();
  plane2D.setItems(data.view2D ?? []);
  drawingPlan.setModel(data);
  renderOutputs();
  renderCuts();
  updateAvailableTabs();
  renderParameters(data.parameters);
  renderAnimationChoices();
  if (first) fit();
  applyPose();
  if (isolation.path) {
    if (data.components.some((c) => c.path === isolation.path)) {
      for (const [id, mesh] of objects)
        mesh.visible = within(id, isolation.path);
      applyPose();
    } else showOnly(isolation.path);
  }
  if (selected) select(selected);
  else renderInspector("");
  resize();
  requestAnimationFrame(() => {
    renderer.render(scene, camera);
    void saveDesktopPreview(renderer.domElement).catch(() => {
      // Preview persistence must never prevent a successful CAD build.
    });
  });
}
type ViewportToolPanel = "parameters" | "explode" | null;
let viewportToolPanel: ViewportToolPanel = null;
let parameterTimer: number | undefined;
let queuedParameterValues: Record<string, string | number | boolean> | null =
  null;
let savingParameters = false;
function showViewportToolPanel(panel: ViewportToolPanel) {
  if (panel && measurementMode) {
    measurementMode = false;
    $("measure-panel").hidden = true;
    $("measure-toggle").setAttribute("aria-pressed", "false");
    clearMeasurement();
    clearHover();
    updateMeshHighlights();
  }
  viewportToolPanel = panel;
  $("parameters-panel").hidden = panel !== "parameters";
  $("explode-panel").hidden = panel !== "explode";
  for (const [id, active] of [
    ["parameters-toggle", panel === "parameters"],
    ["explode-toggle", panel === "explode"],
  ] as const) {
    const button = $(id);
    button.setAttribute("aria-pressed", String(active));
    button.title = `${active ? "Hide" : "Show"} ${id === "explode-toggle" ? "explode tools" : "parameters"}`;
    button.setAttribute("aria-label", button.title);
  }
}
async function saveQueuedParameters() {
  if (savingParameters) return;
  savingParameters = true;
  const status = $("parameter-status");
  try {
    while (queuedParameterValues) {
      const values = queuedParameterValues;
      queuedParameterValues = null;
      status.textContent = "Updating model…";
      const response = await fetch("/api/parameters", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CodeCAD-Token": token,
        },
        body: JSON.stringify({ values }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error ?? "Parameter update failed");
      status.textContent = "Saved · rebuilding model";
    }
  } catch (error) {
    status.textContent = String(error);
  } finally {
    savingParameters = false;
    if (queuedParameterValues)
      parameterTimer = window.setTimeout(
        () => void saveQueuedParameters(),
        350,
      );
  }
}
function renderParameters(state: ParameterState | null) {
  const panel = $("parameters-panel"),
    form = $<HTMLFormElement>("parameters"),
    status = $("parameter-status");
  const available = Boolean(state && Object.keys(state.definitions).length);
  $("parameters-toggle").hidden = !available;
  if (!available && viewportToolPanel === "parameters")
    showViewportToolPanel(null);
  panel.hidden = viewportToolPanel !== "parameters";
  form.replaceChildren();
  if (!savingParameters && !queuedParameterValues) status.textContent = "";
  if (!available || !state) return;
  const controls = new Map<string, HTMLInputElement | HTMLSelectElement>();
  for (const [key, definition] of Object.entries(state.definitions)) {
    const row = document.createElement("label"),
      caption = document.createElement("span");
    row.className = "parameter-row";
    caption.textContent =
      definition.label +
      ("unit" in definition && definition.unit ? ` (${definition.unit})` : "");
    row.append(caption);
    if (definition.type === "select") {
      const control = document.createElement("select");
      for (const option of definition.options) {
        const item = document.createElement("option");
        item.value = option.value;
        item.textContent = option.label;
        control.append(item);
      }
      control.value = String(state.values[key]);
      row.append(control);
      controls.set(key, control);
    } else {
      const control = document.createElement("input");
      control.type = definition.type === "boolean" ? "checkbox" : "number";
      if (definition.type === "number") {
        control.value = String(state.values[key]);
        control.required = true;
        control.step =
          definition.step === undefined ? "any" : String(definition.step);
        if (definition.min !== undefined) control.min = String(definition.min);
        if (definition.max !== undefined) control.max = String(definition.max);
      } else control.checked = Boolean(state.values[key]);
      row.append(control);
      controls.set(key, control);
    }
    form.append(row);
  }
  const hint = document.createElement("p");
  hint.className = "parameter-hint";
  hint.textContent = "Changes rebuild the model automatically.";
  form.append(hint);
  const queue = () => {
    if (!form.checkValidity()) {
      window.clearTimeout(parameterTimer);
      queuedParameterValues = null;
      status.textContent = "Enter a valid value within the shown range.";
      return;
    }
    const values: Record<string, string | number | boolean> = {};
    for (const [key, definition] of Object.entries(state.definitions)) {
      const control = controls.get(key)!;
      values[key] =
        definition.type === "boolean"
          ? (control as HTMLInputElement).checked
          : definition.type === "number"
            ? Number(control.value)
            : control.value;
    }
    queuedParameterValues = values;
    status.textContent = "Waiting for changes…";
    window.clearTimeout(parameterTimer);
    parameterTimer = window.setTimeout(() => void saveQueuedParameters(), 450);
  };
  for (const [key, definition] of Object.entries(state.definitions)) {
    const control = controls.get(key)!;
    control.addEventListener(
      definition.type === "number" ? "input" : "change",
      queue,
    );
  }
  form.onsubmit = (event) => {
    event.preventDefault();
    queue();
  };
}
function updateMeshHighlights() {
  for (const [id, mesh] of objects)
    (mesh.material as THREE.MeshStandardMaterial).emissive.setHex(
      !measurementMode && selected && within(id, selected) ? 0x244c43 : 0,
    );
}
function renderInspector(path: string) {
  const panel = $("inspector");
  const content = $("inspector-content");
  content.replaceChildren();
  const component = model?.components.find((item) => item.path === path);
  panel.hidden = !component;
  if (!component) return;
  const title = document.createElement("strong");
  title.textContent = component.label;
  const detail = document.createElement("div");
  detail.textContent = component.path;
  const { rows, operations } = inspectorDetails(component.inspection);
  const list = document.createElement("dl");
  for (const [name, value] of rows) {
    const term = document.createElement("dt");
    term.textContent = name;
    const description = document.createElement("dd");
    description.textContent = value;
    list.append(term, description);
  }
  const heading = document.createElement("strong");
  heading.textContent = "Operations";
  const steps = document.createElement("ol");
  for (const operation of operations) {
    const item = document.createElement("li");
    item.textContent = operation;
    steps.append(item);
  }
  content.append(title, detail, list, heading);
  if (operations.length) content.append(steps);
  else {
    const empty = document.createElement("p");
    empty.textContent =
      component.inspection.kind === "part"
        ? "No machining operations recorded."
        : "Select a part to see its operations.";
    content.append(empty);
  }
}
function select(path: string) {
  selected = path;
  renderInspector(path);
  renderAnimationChoices();
  updateMeshHighlights();
  const part = model?.meshes.find((m) => m.componentPath === path);
  const mass = model?.components.find((c) => c.path === path)?.inspection.mass;
  const weight = mass === undefined ? "" : " · " + formatMass(mass);
  $("selection").textContent = part
    ? path + " · " + (part.volume / 1000).toFixed(1) + " cm³" + weight
    : path
      ? path + " · assembly" + weight
      : "Select a part to inspect it";
  for (const component of model?.components ?? [])
    if (path.startsWith(component.path + "/")) expanded.add(component.path);
  const source = (model?.components ?? [])
    .filter((c) => path && within(c.path, path))
    .flatMap((c) => c.source ?? []);
  const lines = source.filter((s) => s.file === sourceFile).map((s) => s.line);
  highlightLines(dirty ? [] : lines);
  const sourceSelection = $("source-selection");
  sourceSelection.textContent = dirty
    ? "Source changed · save and rebuild to refresh component links."
    : path
      ? `${path} · ${new Set(lines).size} source lines${source.some((s) => s.file !== sourceFile) ? " · also defined in other files" : ""}`
      : "";
  sourceSelection.hidden = !sourceSelection.textContent;
  renderParts();
  applyPose();
}
function showOnly(path: string) {
  document.querySelector<HTMLButtonElement>('[data-tab="model"]')?.click();
  const previous = path
    ? isolation.toggle(path, () => ({
        visible: new Map([...objects].map(([id, mesh]) => [id, mesh.visible])),
        position: camera.position.clone(),
        target: controls.target.clone(),
        center: center.clone(),
        up: camera.up.clone(),
        zoom: camera.zoom,
        near: camera.near,
        far: camera.far,
        selected,
      }))
    : isolation.restore();
  if (previous && path) {
    const damping = controls.enableDamping;
    controls.enableDamping = false;
    controls.update(); // Clear any remaining isolated-view orbit momentum.
    for (const [id, mesh] of objects)
      mesh.visible = previous.visible.get(id) ?? true;
    camera.position.copy(previous.position);
    camera.up.copy(previous.up);
    camera.zoom = previous.zoom;
    camera.near = previous.near;
    camera.far = previous.far;
    controls.target.copy(previous.target);
    center.copy(previous.center);
    camera.updateProjectionMatrix();
    controls.update();
    controls.enableDamping = damping;
    applyPose();
    select(
      model?.components.some((c) => c.path === previous.selected)
        ? previous.selected
        : "",
    );
    $("show-all").hidden = true;
    return;
  }
  for (const [id, mesh] of objects) mesh.visible = !path || within(id, path);
  applyPose();
  select(path);
  fit();
  $("show-all").hidden = !path;
}
function renderParts() {
  const focusedPath = document.activeElement?.getAttribute("data-path");
  const filter = $<HTMLInputElement>("filter").value.toLowerCase();
  $("parts").replaceChildren();
  const components = model?.components ?? [];
  const children = (path?: string) =>
    components.filter((c) => c.parent === path);
  const matches = (c: Model["components"][number]) =>
    `${c.path} ${c.label}`.toLowerCase().includes(filter);
  const show = (
    d: Model["components"][number],
    container: HTMLElement,
    depth: number,
  ) => {
    if (filter && !components.some((c) => within(c.path, d.path) && matches(c)))
      return;
    const descendants = children(d.path),
      branch = descendants.length > 0;
    const open = filter.length > 0 || expanded.has(d.path);
    const item = document.createElement("div");
    item.setAttribute("role", "treeitem");
    item.setAttribute("aria-selected", String(selected === d.path));
    item.dataset.path = d.path;
    item.setAttribute("aria-label", d.id);
    item.tabIndex = selected === d.path || (!selected && !d.parent) ? 0 : -1;
    if (branch) item.setAttribute("aria-expanded", String(open));
    const row = document.createElement("div");
    row.className = "part-row" + (selected === d.path ? " selected" : "");
    row.style.paddingLeft = 8 + depth * 14 + "px";
    const toggle = document.createElement("button");
    toggle.className = "tree-toggle";
    toggle.textContent = branch ? (open ? "▾" : "▸") : "·";
    toggle.disabled = !branch;
    toggle.tabIndex = -1;
    toggle.setAttribute(
      "aria-label",
      `${open ? "Collapse" : "Expand"} ${d.id}`,
    );
    toggle.onclick = (e) => {
      e.stopPropagation();
      if (open) expanded.delete(d.path);
      else expanded.add(d.path);
      renderParts();
    };
    const meshes = [...objects]
      .filter(([path]) => within(path, d.path))
      .map(([, mesh]) => mesh);
    const visible = document.createElement("input");
    visible.type = "checkbox";
    visible.checked = meshes.length > 0 && meshes.every((m) => m.visible);
    visible.indeterminate = meshes.some((m) => m.visible) && !visible.checked;
    visible.disabled = !meshes.length;
    visible.setAttribute("aria-label", "Show " + d.path);
    visible.addEventListener("click", (e) => e.stopPropagation());
    visible.addEventListener("change", () => {
      meshes.forEach((mesh) => {
        mesh.visible = visible.checked;
        edgeObjects.get(mesh.userData.path)!.visible =
          visible.checked && edgesEnabled();
      });
      renderParts();
    });
    const label = document.createElement("span");
    label.textContent = d.id;
    row.title = `${d.path}\n${d.label} · ${d.type}`;
    row.append(toggle, visible, label);
    // The weight a part or assembly carries, once its stock states a density.
    if (d.inspection.mass !== undefined) {
      const weight = document.createElement("span");
      weight.className = "part-weight";
      weight.textContent = formatMass(d.inspection.mass);
      weight.title = d.inspection.massPartial
        ? "Weight of the parts whose material states a density"
        : "Weight from the material density";
      row.append(weight);
    }
    const solo = document.createElement("button");
    solo.className = "show-only";
    solo.textContent = "◎";
    solo.title = "Show only " + d.path;
    solo.setAttribute("aria-label", "Show only " + d.path);
    solo.setAttribute("aria-pressed", String(isolation.path === d.path));
    if (isolation.path === d.path)
      solo.title = "Restore previous visibility and view";
    solo.onclick = (e) => {
      e.stopPropagation();
      document.body.classList.remove("parts-open");
      showOnly(d.path);
    };
    row.append(solo);
    row.addEventListener("click", () => select(d.path));
    item.addEventListener("keydown", (e) => {
      if (e.target !== item) return;
      e.stopPropagation();
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        if (e.key === "ArrowRight") expanded.add(d.path);
        else expanded.delete(d.path);
        renderParts();
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        select(d.path);
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const items = [
          ...$("parts").querySelectorAll<HTMLElement>('[role="treeitem"]'),
        ];
        items[items.indexOf(item) + (e.key === "ArrowDown" ? 1 : -1)]?.focus();
      }
    });
    item.append(row);
    container.append(item);
    if (branch && open) {
      const group = document.createElement("div");
      group.setAttribute("role", "group");
      item.append(group);
      descendants.forEach((c) => show(c, group, depth + 1));
    }
  };
  children().forEach((c) => show(c, $("parts"), 0));
  if (focusedPath)
    [...$("parts").querySelectorAll<HTMLElement>('[role="treeitem"]')]
      .find((item) => item.dataset.path === focusedPath)
      ?.focus();
}
function applyPose() {
  if (!model) return;
  const slider = $<HTMLInputElement>("motion"),
    t = Number(slider.value) / 1000,
    explode = Number($<HTMLInputElement>("explode").value);
  const animation = selectedAnimation(),
    frames = animation?.frames ?? model.frames,
    index = Math.min(frames.length - 1, Math.round(t * (frames.length - 1)));
  for (const [i, d] of model.meshes.entries()) {
    const mesh = objects.get(d.componentPath)!,
      edges = edgeObjects.get(d.componentPath)!;
    const candidate = animation?.meshFrames?.[index];
    const animatedMesh =
      candidate?.componentPath === d.componentPath ? candidate : undefined;
    const geometryData = animatedMesh ?? d;
    const geometryKey = animatedMesh ? `${animation!.id}:${index}` : "base";
    if (renderedGeometry.get(d.componentPath) !== geometryKey) {
      const geometry = new THREE.BufferGeometry()
        .setAttribute(
          "position",
          new THREE.Float32BufferAttribute(geometryData.positions, 3),
        )
        .setAttribute(
          "normal",
          new THREE.Float32BufferAttribute(geometryData.normals, 3),
        )
        .setIndex(geometryData.indices);
      mesh.geometry.dispose();
      mesh.geometry = geometry;
      edges.geometry.dispose();
      edges.geometry = new THREE.BufferGeometry().setAttribute(
        "position",
        new THREE.Float32BufferAttribute(geometryData.edges, 3),
      );
      renderedGeometry.set(d.componentPath, geometryKey);
    }
    mesh.matrix.fromArray(frames[index]?.matrices[d.componentPath] ?? d.matrix);
    if (explode) {
      const direction = new THREE.Vector3()
        .setFromMatrixPosition(mesh.matrix)
        .sub(center)
        .normalize();
      if (direction.length() < 0.1) direction.set(0, 0, 1);
      mesh.matrix.elements[12]! += direction.x * explode;
      mesh.matrix.elements[13]! += direction.y * explode;
      mesh.matrix.elements[14]! += direction.z * explode;
    }
    mesh.matrixWorldNeedsUpdate = true;
    edges.matrix.copy(mesh.matrix);
    edges.matrixWorldNeedsUpdate = true;
    edges.visible = mesh.visible && edgesEnabled();
    void i;
  }
  for (const marker of holeGroup.children) {
    const mesh = objects.get(marker.userData.componentPath);
    if (!mesh) continue;
    marker.position
      .fromArray(marker.userData.localCenter)
      .applyMatrix4(mesh.matrix);
    marker.visible = mesh.visible;
  }
  $("motion-label").textContent = animation?.meshFrames
    ? t === 0
      ? "Folded"
      : t === 1
        ? "Flat"
        : `${Math.round(t * 100)}% unfolded`
    : t === 0
      ? "Closed"
      : `${Math.round(t * 100)}%`;
}
function artifactUrl(name: string) {
  return "/artifacts/" + encodeURIComponent(name) + "?v=" + shownGeneration;
}
function downloadControl(report: ReportDownload) {
  const control = document.createElement("span"),
    select = document.createElement("select"),
    link = document.createElement("a");
  control.className = "download-control";
  select.setAttribute("aria-label", `${report.title} download format`);
  for (const format of ["pdf", "dxf", "csv"] as const) {
    if (!report.formats[format]) continue;
    const option = document.createElement("option");
    option.value = format;
    option.textContent = format.toUpperCase();
    select.append(option);
  }
  const update = () => {
    const format = select.value as keyof ReportDownload["formats"];
    const name = report.formats[format]!;
    link.href = artifactUrl(name) + "&download";
    link.download = name;
    link.textContent = "Download " + format.toUpperCase();
  };
  select.value = "pdf";
  select.addEventListener("change", update);
  update();
  control.append(select, link);
  return control;
}
let pdfViewers: ReturnType<typeof pdfViewer>[] = [];
function renderOutputs() {
  pdfViewers.forEach((viewer) => viewer.dispose());
  pdfViewers = [];
  const pdfReports: PdfReport[] = [],
    sheetReports: PdfReport[] = [];
  for (const id of [
    "drawing-download-list",
    "drawing-sheets",
    "nesting",
    "exports",
  ])
    $(id).replaceChildren();
  const grouped = new Set<string>();
  for (const report of model?.reports ?? []) {
    grouped.add(report.preview);
    report.previews?.forEach((name) => grouped.add(name));
    Object.values(report.formats).forEach((name) => grouped.add(name));
    if (report.kind === "nesting") {
      pdfReports.push({
        title: report.title,
        ...(report.summary ? { summary: report.summary } : {}),
        url: artifactUrl(report.formats.pdf),
        download: downloadControl(report),
      });
    }
    if (report.kind === "drawing") {
      sheetReports.push({
        title: report.title,
        url: artifactUrl(report.formats.pdf),
        download: downloadControl(report),
      });
      const row = document.createElement("div"),
        label = document.createElement("span");
      row.className = "export-row";
      label.textContent = report.title;
      row.append(label, downloadControl(report));
      $("drawing-download-list").append(row);
    }
    const row = document.createElement("div"),
      label = document.createElement("span");
    row.className = "export-row";
    label.textContent = report.title;
    row.append(label, downloadControl(report));
    $("exports").append(row);
  }
  for (const file of model?.files ?? []) {
    if (grouped.has(file.name)) continue;
    const url =
      "/artifacts/" + encodeURIComponent(file.name) + "?v=" + shownGeneration;
    if (file.kind === "drawing" || file.kind === "nesting") {
      const card = document.createElement("section"),
        title = document.createElement("h3"),
        link = document.createElement("a");
      title.textContent = file.name;
      link.href = url + "&download";
      link.textContent = "Download";
      title.append(link);
      card.append(title);
      $(file.kind === "drawing" ? "drawing-download-list" : "nesting").append(
        card,
      );
    }
    const row = document.createElement("div");
    row.className = "export-row";
    const link = document.createElement("a");
    link.href = url + "&download";
    link.textContent = file.name;
    const size = document.createElement("small");
    size.textContent =
      file.ready === false
        ? `Generated when requested · ${file.kind}`
        : `${(file.size / 1024).toFixed(1)} KB · ${file.kind}`;
    row.append(link, size);
    $("exports").append(row);
  }
  if (!$("drawing-download-list").childElementCount)
    $("drawing-download-list").textContent = "No printable plans configured.";
  if (sheetReports.length) {
    const viewer = pdfViewer(sheetReports);
    pdfViewers.push(viewer);
    $("drawing-sheets").append(viewer.element);
  } else {
    const empty = document.createElement("p");
    empty.textContent =
      "No drawing sheets yet. Compose one in the Sheet editor, or return a TechnicalDrawing from a @cad.output method.";
    $("drawing-sheets").append(empty);
  }
  // Open on finished sheets when the project has them, else on the editor.
  showDrawingMode(drawingMode ?? (sheetReports.length ? "sheets" : "plan"));
  if (pdfReports.length) {
    const viewer = pdfViewer(pdfReports);
    pdfViewers.push(viewer);
    $("nesting").append(viewer.element);
    if ($("nesting").classList.contains("active")) viewer.start();
  }
}
/** Identical blanks read as one line with a quantity, as a shop expects;
 * the toggle lists every part on its own row instead. */
let groupBlanks = true;
function renderCuts() {
  $("cuts").replaceChildren();
  const reports =
    model?.reports.filter((report) => report.kind === "cutList") ?? [];
  const rows = reports.length
    ? reports.flatMap((report) => report.rows ?? [])
    : (model?.cutList ?? []);
  if (rows.length > 1) {
    const tools = document.createElement("label"),
      toggle = document.createElement("input");
    tools.className = "cuts-tools";
    toggle.type = "checkbox";
    toggle.checked = groupBlanks;
    toggle.onchange = () => {
      groupBlanks = toggle.checked;
      renderCuts();
    };
    tools.append(toggle, " Group identical blanks");
    $("cuts").append(tools);
  }
  for (const report of reports) {
    const heading = document.createElement("h3");
    heading.textContent = report.title;
    heading.append(downloadControl(report));
    $("cuts").append(heading);
    renderCutTable(report.rows ?? []);
  }
  if (!reports.length) renderCutTable(model?.cutList ?? []);
}
function updateAvailableTabs() {
  const available: Record<string, boolean> = availableViews({
    files: model?.files ?? [],
    reports: model?.reports ?? [],
    cutList: model?.cutList ?? [],
  });
  for (const [id, enabled] of Object.entries(available)) {
    const button = document.querySelector<HTMLButtonElement>(
      `[data-tab="${id}"]`,
    )!;
    button.hidden = !enabled;
    button.disabled = !enabled;
    if (!enabled && $(id).classList.contains("active")) activateTab("model");
  }
  $("more-views").hidden =
    !available.nesting && !available.cuts && !available.exports;
}
function renderCutTable(rows: Model["cutList"]) {
  const table = document.createElement("table");
  const header = document.createElement("tr");
  for (const name of [
    "Part",
    "Material",
    "W",
    "H",
    "T / L",
    "Wall",
    "R",
    "Qty",
  ]) {
    const cell = document.createElement("th");
    cell.textContent = name;
    header.append(cell);
  }
  table.append(header);
  // Computed sizes such as 463.99999999 read as the millimetres they mean.
  const mm = (value: number | null | undefined) =>
    value == null ? "" : String(Number(value.toFixed(2)));
  const within = (path: string) => path.split("/").slice(1).join("/");
  const shown = groupBlanks
    ? groupCutRows(rows)
    : rows.map((r) => ({ ...r, paths: [r.path] }));
  const pieces = rows.reduce((sum, r) => sum + r.quantity, 0);
  for (const r of shown) {
    const row = document.createElement("tr");
    const names = r.paths.map(within);
    for (const [i, value] of [
      names.join(", "),
      r.material,
      mm(r.width),
      mm(r.height),
      mm(r.length ?? r.thickness),
      mm(r.wallThickness),
      mm(r.cornerRadius),
      r.quantity,
    ].entries()) {
      const cell = document.createElement("td");
      cell.textContent = String(value);
      cell.title = i === 0 ? names.join("\n") : String(value);
      if (i === 0 && names.length > 1) {
        cell.className = "cut-parts";
        cell.textContent = "";
        const first = document.createElement("span");
        first.textContent = names[0]!;
        const rest = document.createElement("small");
        rest.textContent = ` +${names.length - 1} more`;
        cell.append(first, rest);
      }
      row.append(cell);
    }
    table.append(row);
  }
  const foot = document.createElement("tr");
  foot.className = "cut-total";
  const label = document.createElement("td");
  label.colSpan = 7;
  label.textContent = `${shown.length} ${groupBlanks ? "blank size" : "part"}${shown.length === 1 ? "" : "s"}`;
  const total = document.createElement("td");
  total.textContent = String(pieces);
  total.title = "Pieces to cut";
  foot.append(label, total);
  table.append(foot);
  $("cuts").append(table);
}
async function loadSource() {
  const response = await fetch("/api/source"),
    data = await response.json();
  sourceFile = data.file;
  const projectFile = $("project-file");
  projectFile.textContent = data.file.split(/[\\/]/).at(-1) ?? data.file;
  projectFile.title = data.file;
  setSource(data.source, data.file);
  version = data.version;
  token = data.token;
  try {
    await drawingPlan.load();
    if (model) drawingPlan.setModel(model);
  } catch (error) {
    $("plan-status").textContent = String(error);
  }
  dirty = false;
  if (!model)
    $("project-name").textContent =
      data.file.split(/[\\/]/).at(-1) ?? data.file;
  select(selected);
  $("source-status").textContent = "Changes save on Ctrl / ⌘ + S";
}
async function save() {
  $("source-status").textContent = "Saving…";
  try {
    const response = await fetch("/api/source", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CodeCAD-Token": token },
      body: JSON.stringify({ source: codeEditor.getValue(), version }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    version = data.version;
    dirty = false;
    $("source-status").textContent = "Saved · rebuilding";
  } catch (error) {
    $("source-status").textContent = String(error);
  }
}
onSourceChange(() => {
  dirty = true;
  highlightLines([], false);
  $("source-selection").textContent =
    "Source changed · save and rebuild to refresh component links.";
  $("source-selection").hidden = false;
  $("source-status").textContent = "Unsaved changes · Ctrl / ⌘ + S";
});
window.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "s") {
    event.preventDefault();
    // Save what the user is looking at: the sheet editor or the source.
    if ($("tabs").classList.contains("drawing-active")) void drawingPlan.save();
    else void save();
    return;
  }
  const typing = (event.target as HTMLElement | null)?.closest(
    "input, select, textarea, [contenteditable], .monaco-editor",
  );
  if (
    typing ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    !$("model").classList.contains("active")
  )
    return;
  const camera = { "1": "front", "2": "right", "3": "top", "0": "iso" }[
    event.key
  ];
  if (event.key === "f" || event.key === "F") fit();
  else if (camera) fit(camera);
  else if (event.key === "Escape" && measurementMode)
    $("measure-toggle").click();
});
window.addEventListener("beforeunload", (event) => {
  if (dirty) {
    event.preventDefault();
    event.returnValue = "";
  }
});
$("save").onclick = () => void save();
$("toggle-source").onclick = () => {
  const open = document.body.classList.toggle("source-open");
  $("toggle-source").setAttribute(
    "aria-label",
    open ? "Hide code" : "Show code",
  );
  rememberPane("code", open);
};
$("toggle-parts").onclick = () =>
  rememberPane("parts", document.body.classList.toggle("parts-open"));
$("reload-source").onclick = () => {
  if (!dirty || confirm("Discard unsaved editor changes?")) void loadSource();
};
$("rebuild").onclick = () =>
  void fetch("/api/rebuild", {
    method: "POST",
    headers: { "X-CodeCAD-Token": token },
  });
$("fit").onclick = () => {
  fit();
  $("view-presets").removeAttribute("open");
};
$("plane2d-fit").onclick = () => plane2D.fit();
type DrawingMode = "sheets" | "plan" | "plane";
let drawingMode: DrawingMode | undefined;
function showDrawingMode(mode: DrawingMode) {
  drawingMode = mode;
  for (const [button, panel, id] of [
    ["show-sheets", "drawing-sheets", "sheets"],
    ["show-plan", "plan-editor", "plan"],
    ["show-plane", "plane2d-workspace", "plane"],
  ] as const) {
    $(panel).hidden = mode !== id;
    $(button).setAttribute("aria-pressed", String(mode === id));
  }
  // Every sheet carries its own download control.
  $("drawing-downloads").hidden = mode === "sheets";
  $("tabs").classList.toggle(
    "drawing-active",
    mode === "plan" && $("drawing").classList.contains("active"),
  );
  if (mode === "plane") plane2D.render();
  if (mode === "sheets")
    pdfViewers
      .filter((viewer) => viewer.element.parentElement?.id === "drawing-sheets")
      .forEach((viewer) => viewer.start());
}
$("show-sheets").onclick = () => showDrawingMode("sheets");
$("show-plan").onclick = () => showDrawingMode("plan");
$("show-plane").onclick = () => showDrawingMode("plane");
$("projection-toggle").onclick = () =>
  setProjection(!(camera instanceof THREE.OrthographicCamera));
$("show-all").onclick = () => showOnly("");
document.querySelectorAll<HTMLButtonElement>("[data-camera]").forEach(
  (button) =>
    (button.onclick = () => {
      fit(button.dataset.camera);
      $("view-presets").removeAttribute("open");
    }),
);
$("filter").oninput = renderParts;
$("parameters-toggle").onclick = () =>
  showViewportToolPanel(
    viewportToolPanel === "parameters" ? null : "parameters",
  );
$("explode-toggle").onclick = () =>
  showViewportToolPanel(viewportToolPanel === "explode" ? null : "explode");
$("edges").onclick = () => {
  const button = $("edges");
  const enabled = !edgesEnabled();
  button.setAttribute("aria-pressed", String(enabled));
  button.title = enabled ? "Hide edges" : "Show edges";
  applyEdgeAppearance();
  applyPose();
};
$("edge-strength").oninput = applyEdgeAppearance;
$("edge-color").onchange = applyEdgeAppearance;
$("edge-color-custom").oninput = applyEdgeAppearance;
applyEdgeAppearance();
$("explode").oninput = () => {
  clearMeasurement();
  applyPose();
};
$("motion").oninput = () => {
  playing = false;
  $("play").textContent = "▶ Motion";
  clearMeasurement();
  applyPose();
};
$("animation-select").onchange = () => {
  playing = false;
  time = 0;
  $<HTMLInputElement>("motion").value = "0";
  $("play").textContent = "▶ Motion";
  clearMeasurement();
  applyPose();
};
$("play").onclick = () => {
  playing = !playing;
  if (playing) clearMeasurement();
  $("play").textContent = playing ? "Ⅱ Pause" : "▶ Motion";
};
function activateTab(id: string) {
  document
    .querySelectorAll("[data-tab],.tab")
    .forEach((el) => el.classList.remove("active"));
  document.querySelector(`[data-tab="${id}"]`)?.classList.add("active");
  $(id).classList.add("active");
  $("tabs").classList.toggle("model-active", id === "model");
  $("tabs").classList.toggle(
    "drawing-active",
    id === "drawing" && drawingMode === "plan",
  );
  $("more-views").classList.toggle(
    "active",
    ["nesting", "cuts", "exports"].includes(id),
  );
  if (id !== "model") $("view-presets").removeAttribute("open");
  pdfViewers
    .filter(
      (viewer) =>
        viewer.element.parentElement?.id ===
        (id === "drawing" && drawingMode === "sheets" ? "drawing-sheets" : id),
    )
    .forEach((viewer) => viewer.start());
  resize();
  if (id === "drawing") plane2D.render();
}
document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((button) => {
  button.onclick = () => {
    activateTab(button.dataset.tab!);
    $("more-views").removeAttribute("open");
  };
});
const raycaster = new THREE.Raycaster();
function clearMeasurement() {
  for (const child of [...measurementGroup.children]) {
    const drawable = child as THREE.Mesh;
    drawable.geometry.dispose();
    (drawable.material as THREE.Material).dispose();
    measurementGroup.remove(child);
  }
  measurePicks = [];
  measured = undefined;
  measureLabel.hidden = true;
  $("measure-result").textContent = "Pick the first target.";
}
function clearHover() {
  for (const child of [...hoverGroup.children]) {
    const drawable = child as THREE.Mesh;
    drawable.geometry.dispose();
    (drawable.material as THREE.Material).dispose();
    hoverGroup.remove(child);
  }
  hoveredFace = undefined;
}
function showHover(pick: MeasurePick | undefined, hit?: THREE.Intersection) {
  if (
    pick?.kind === "face" &&
    hit?.faceIndex != null &&
    hoveredFace?.mesh === hit.object &&
    hoveredFace.faceIndex === hit.faceIndex
  )
    return;
  clearHover();
  if (!pick) return;
  if (pick.kind === "face") {
    if (hit?.faceIndex == null) return;
    const mesh = hit.object as THREE.Mesh;
    const surface = new THREE.Mesh(
      faceRegionGeometry(mesh.geometry, hit.faceIndex),
      new THREE.MeshBasicMaterial({
        color: 0x20dc88,
        transparent: true,
        opacity: 0.88,
        depthTest: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
        side: THREE.DoubleSide,
      }),
    );
    surface.matrixAutoUpdate = false;
    surface.matrix.copy(mesh.matrixWorld);
    surface.renderOrder = 1003;
    hoverGroup.add(surface);
    hoveredFace = { mesh, faceIndex: hit.faceIndex };
    return;
  }
  const radius = Math.max(
    3,
    Math.min(8, bounds.getSize(new THREE.Vector3()).length() * 0.001),
  );
  const marker =
    pick.kind === "edge"
      ? new THREE.Mesh(
          new THREE.TubeGeometry(
            new THREE.LineCurve3(pick.a, pick.b),
            1,
            Math.max(2, radius * 0.5),
            8,
            false,
          ),
          new THREE.MeshBasicMaterial({
            color: 0x70e3b0,
            depthTest: true,
            depthWrite: false,
          }),
        )
      : new THREE.Mesh(
          new THREE.SphereGeometry(radius, 12, 8),
          new THREE.MeshBasicMaterial({
            color: 0x70e3b0,
            depthTest: true,
            depthWrite: false,
          }),
        );
  if (pick.kind !== "edge") marker.position.copy(pick.point);
  marker.renderOrder = 1003;
  hoverGroup.add(marker);
}
function measurementMarker(point: THREE.Vector3, color = 0xffd277) {
  const radius = Math.max(
    2,
    Math.min(8, bounds.getSize(new THREE.Vector3()).length() * 0.001),
  );
  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 12, 8),
    new THREE.MeshBasicMaterial({ color, depthTest: false }),
  );
  marker.position.copy(point);
  marker.renderOrder = 1001;
  measurementGroup.add(marker);
}
function measurementLine(a: THREE.Vector3, b: THREE.Vector3, guide = false) {
  if (guide && a.distanceTo(b) > 1e-7) {
    const radius = Math.max(
      1.8,
      Math.min(4, bounds.getSize(new THREE.Vector3()).length() * 0.0015),
    );
    const solid = new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.LineCurve3(a, b), 1, radius, 8, false),
      new THREE.MeshBasicMaterial({ color: 0x70e3d0, depthTest: false }),
    );
    solid.renderOrder = 1002;
    measurementGroup.add(solid);
    return;
  }
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([a, b]),
    new THREE.LineBasicMaterial({ color: 0xffd277, depthTest: false }),
  );
  line.renderOrder = 1001;
  measurementGroup.add(line);
}
function showMeasurement() {
  for (const child of [...measurementGroup.children]) {
    const drawable = child as THREE.Mesh;
    drawable.geometry.dispose();
    (drawable.material as THREE.Material).dispose();
    measurementGroup.remove(child);
  }
  for (const pick of measurePicks) {
    if (pick.kind === "point" || pick.kind === "hole")
      measurementMarker(pick.point);
    else if (pick.kind === "edge") measurementLine(pick.a, pick.b);
    else {
      measurementMarker(pick.point);
      measurementLine(
        pick.point,
        pick.point.clone().addScaledVector(pick.normal, 30),
      );
    }
  }
  if (!measured) return;
  for (const [a, b] of measured.guides)
    if (a.distanceTo(b) > 1e-7) {
      measurementLine(a, b, true);
      measurementMarker(a, 0x70e3d0);
      measurementMarker(b, 0x70e3d0);
    }
  if (measured.intersection) measurementMarker(measured.intersection, 0x70e3d0);
  measureLabel.textContent = measured.description;
  measureLabel.hidden = false;
}
function geometryPick(
  hit: THREE.Intersection,
  pointer: THREE.Vector2,
  shift: boolean,
  visibleMeshes: THREE.Mesh[],
): MeasurePick | undefined {
  const mesh = hit.object as THREE.Mesh,
    face = hit.face,
    positions = mesh.geometry.getAttribute("position");
  if (!face || !positions) return undefined;
  const screen = (point: THREE.Vector3) => {
    const projected = point.clone().project(camera);
    return new THREE.Vector2(
      ((projected.x + 1) / 2) * renderer.domElement.clientWidth,
      ((1 - projected.y) / 2) * renderer.domElement.clientHeight,
    );
  };
  const world = (index: number) =>
    new THREE.Vector3()
      .fromBufferAttribute(positions, index)
      .applyMatrix4(mesh.matrix);
  const corners = [world(face.a), world(face.b), world(face.c)];
  const data = model?.meshes.find(
    (item) => item.componentPath === mesh.userData.path,
  );
  const points: { pick: MeasurePick; screenDistance: number }[] = [];
  const edges: { pick: MeasurePick; screenDistance: number }[] = [];
  const consider = (a: THREE.Vector3, b: THREE.Vector3) => {
    const surfaceDistance = new THREE.Line3(a, b)
      .closestPointToPoint(hit.point, true, new THREE.Vector3())
      .distanceTo(hit.point);
    if (
      surfaceDistance >
      Math.max(20, bounds.getSize(new THREE.Vector3()).length() * 0.02)
    )
      return;
    const x = screen(a),
      y = screen(b);
    const delta = y.clone().sub(x);
    const t = Math.max(
      0,
      Math.min(
        1,
        pointer.clone().sub(x).dot(delta) / Math.max(delta.lengthSq(), 1e-8),
      ),
    );
    const edgeDistance = pointer.distanceTo(x.addScaledVector(delta, t));
    const visible = (point: THREE.Vector3) =>
      visibleSurfacePoint(
        point,
        camera,
        renderer.domElement.clientWidth,
        renderer.domElement.clientHeight,
        visibleMeshes,
        hit.point,
      );
    if (edgeDistance <= 8 && visible(a.clone().lerp(b, t)))
      edges.push({
        pick: { kind: "edge", a, b },
        screenDistance: edgeDistance,
      });
    for (const point of [a, b]) {
      const screenDistance = pointer.distanceTo(screen(point));
      if (screenDistance <= 10 && visible(point))
        points.push({
          pick: { kind: "point", point },
          screenDistance,
        });
    }
  };
  if (data?.edges.length) {
    for (let i = 0; i < data.edges.length; i += 6)
      consider(
        new THREE.Vector3(
          data.edges[i]!,
          data.edges[i + 1]!,
          data.edges[i + 2]!,
        ).applyMatrix4(mesh.matrix),
        new THREE.Vector3(
          data.edges[i + 3]!,
          data.edges[i + 4]!,
          data.edges[i + 5]!,
        ).applyMatrix4(mesh.matrix),
      );
  } else {
    for (let i = 0; i < 3; i++) consider(corners[i]!, corners[(i + 1) % 3]!);
  }
  const holes: { pick: MeasurePick; screenDistance: number }[] = [];
  if (shift)
    for (const hole of data?.holes ?? []) {
      const center = new THREE.Vector3()
        .fromArray(hole.center)
        .applyMatrix4(mesh.matrix);
      const axis = new THREE.Vector3()
        .fromArray(hole.axis)
        .transformDirection(mesh.matrix);
      const difference = hit.point.clone().sub(center);
      if (Math.abs(difference.dot(axis)) > Math.max(2, hole.diameter * 0.05))
        continue;
      const radial = difference
        .addScaledVector(axis, -difference.dot(axis))
        .length();
      const tangent =
        Math.abs(axis.x) < 0.9
          ? new THREE.Vector3(1, 0, 0)
          : new THREE.Vector3(0, 1, 0);
      tangent.addScaledVector(axis, -tangent.dot(axis)).normalize();
      const pixelRadius = screen(center).distanceTo(
        screen(center.clone().addScaledVector(tangent, hole.diameter / 2)),
      );
      const screenDistance =
        (Math.abs(radial - hole.diameter / 2) * pixelRadius) /
        Math.max(hole.diameter / 2, 1e-6);
      holes.push({
        pick: { kind: "hole", point: center, diameter: hole.diameter },
        screenDistance,
      });
    }
  return chooseMeasurePick(
    points,
    edges,
    holes,
    {
      kind: "face",
      point: hit.point.clone(),
      normal: face.normal.clone().transformDirection(mesh.matrix),
    },
    shift,
  );
}
$<HTMLButtonElement>("measure-toggle").onclick = () => {
  measurementMode = !measurementMode;
  if (measurementMode) {
    showViewportToolPanel(null);
    playing = false;
    $("play").textContent = "▶ Motion";
  }
  $("measure-panel").hidden = !measurementMode;
  $("measure-toggle").setAttribute("aria-pressed", String(measurementMode));
  clearMeasurement();
  clearHover();
  updateMeshHighlights();
};
$("measure-clear").onclick = clearMeasurement;
let downX = 0,
  downY = 0;
renderer.domElement.addEventListener("pointerdown", (event) => {
  downX = event.clientX;
  downY = event.clientY;
  if (event.button !== 0) clearHover();
});
function raycastAt(event: PointerEvent) {
  group.updateWorldMatrix(true, true);
  const rect = renderer.domElement.getBoundingClientRect();
  const pointer = new THREE.Vector2(
    event.clientX - rect.left,
    event.clientY - rect.top,
  );
  raycaster.setFromCamera(
    new THREE.Vector2(
      (pointer.x / rect.width) * 2 - 1,
      -(pointer.y / rect.height) * 2 + 1,
    ),
    camera,
  );
  const visibleMeshes = [...objects.values()].filter((mesh) => mesh.visible);
  const hit = raycaster.intersectObjects(visibleMeshes, false)[0];
  return {
    hit,
    pick: hit
      ? geometryPick(hit, pointer, event.shiftKey, visibleMeshes)
      : undefined,
  };
}
function pickLabel(pick: MeasurePick | undefined) {
  return pick
    ? `${pick.kind === "hole" ? "Hole centre" : pick.kind === "point" ? "Point" : pick.kind === "edge" ? "Edge" : "Face"} under cursor${pick.kind === "hole" ? ` · Ø${pick.diameter} mm` : ""}`
    : "No geometry under cursor";
}
renderer.domElement.addEventListener("pointermove", (event) => {
  if (!measurementMode) return;
  if (event.buttons) {
    clearHover();
    return;
  }
  const { hit, pick } = raycastAt(event);
  $("measure-hover").textContent = pickLabel(pick);
  showHover(pick, hit);
});
renderer.domElement.addEventListener("pointerleave", clearHover);
renderer.domElement.addEventListener("wheel", clearHover);
renderer.domElement.addEventListener("pointerup", (event) => {
  if (event.button !== 0) return;
  if (Math.hypot(event.clientX - downX, event.clientY - downY) > 4) return;
  const { hit, pick } = raycastAt(event);
  if (measurementMode) {
    $("measure-hover").textContent = pickLabel(pick);
    showHover(pick, hit);
    if (!pick) {
      $("measure-result").textContent =
        "Click geometry to choose a point, edge or face.";
      return;
    }
    if (measurePicks.length === 2) clearMeasurement();
    measurePicks.push(pick);
    if (measurePicks.length === 2) {
      try {
        measured = measure(measurePicks[0]!, measurePicks[1]!);
        $("measure-result").textContent = measured.description;
      } catch (error) {
        $("measure-result").textContent = String(error);
      }
    } else $("measure-result").textContent = "Pick the second target.";
    showMeasurement();
    return;
  }
  select(hit?.object.userData.path ?? "");
});
setupDesktop(() => !dirty || confirm("Discard unsaved editor changes?"));
$<HTMLButtonElement>("copy-build-output").onclick = async () => {
  const status = $("copy-build-status");
  const output = [$("summary").textContent, $("messages").innerText]
    .filter(Boolean)
    .join("\n")
    .trim();
  if (!output) {
    status.textContent = "Nothing to copy yet.";
    return;
  }
  try {
    await navigator.clipboard.writeText(output);
    status.textContent = "Build output copied.";
  } catch {
    status.textContent = "Could not copy build output.";
  }
};
await loadSource();
await configureEditor(token);
// Put the panes back the way this project was left. The desktop shell applies
// the code pane itself, because there it is a different pane with a toggle of
// its own.
whenRemembered((panes) => {
  if (panes.parts) document.body.classList.add("parts-open");
  if (panes.code && !document.body.classList.contains("desktop"))
    $("toggle-source").click();
});
await loadPanes(token);
const events = new EventSource("/api/events");
events.onmessage = async (event) => {
  const state = JSON.parse(event.data);
  $("status").textContent =
    state.phase === "ready"
      ? "● Ready"
      : state.phase === "building"
        ? "◌ Building…"
        : state.phase === "partial"
          ? "● Output error"
          : "● Build error";
  $("status").style.color =
    state.phase === "error" || state.phase === "partial"
      ? "#f3b293"
      : "#68cbb5";
  if (
    (state.phase === "ready" || state.phase === "partial") &&
    shownGeneration !== state.generation
  ) {
    shownGeneration = state.generation;
    try {
      const response = await fetch("/api/model");
      showModel(await response.json());
      if (!dirty) await loadSource();
    } catch (error) {
      $("messages").textContent = String(error);
    }
  } else if (state.phase === "error") {
    $("messages").textContent = state.message + "\n" + state.log;
    $("messages").className = "error";
  }
};
events.onerror = () => {
  $("status").textContent = "○ Reconnecting…";
};
let last = performance.now();
function animate(now: number) {
  requestAnimationFrame(animate);
  const dt = (now - last) / 1000;
  last = now;
  const animation = selectedAnimation();
  if (playing && (animation?.frames.length ?? model?.frames.length)) {
    time = (time + dt / (animation?.duration ?? model!.duration)) % 2;
    $<HTMLInputElement>("motion").value = String(
      Math.round((time <= 1 ? time : 2 - time) * 1000),
    );
    applyPose();
  }
  controls.update();
  if (measured && !measureLabel.hidden) {
    const projected = measured.labelAt.clone().project(camera);
    measureLabel.style.left = `${((projected.x + 1) / 2) * canvas.clientWidth}px`;
    measureLabel.style.top = `${((1 - projected.y) / 2) * canvas.clientHeight}px`;
  }
  renderer.render(scene, camera);
}
requestAnimationFrame(animate);
