import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { ReportDownload } from "../src/reports.js";
import { IsolationSession } from "./isolation.js";
import { setupDesktop } from "./desktop.js";
import { pdfViewer, type PdfReport } from "./pdf-viewer.js";
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
  volume: number;
};
type Model = {
  components: {
    path: string;
    id: string;
    label: string;
    parent?: string;
    type: string;
    source: { file: string; line: number }[];
  }[];
  duration: number;
  title: string;
  meshes: MeshData[];
  diagnostics: { severity: string; message: string }[];
  files: { name: string; kind: string; size: number }[];
  reports: ReportDownload[];
  frames: { t: number; matrices: Record<string, number[]> }[];
  cutList: {
    path: string;
    label: string;
    material: string;
    width: number;
    height: number;
    thickness: number;
    quantity: number;
  }[];
};
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
let sourceFile = "";
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
const canvas = $("canvas"),
  scene = new THREE.Scene(),
  camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100000);
camera.up.set(0, 0, 1);
camera.position.set(1500, -1700, 1350);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
canvas.append(renderer.domElement);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
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
const objects = new Map<string, THREE.Mesh>(),
  edgeObjects = new Map<string, THREE.LineSegments>();
let bounds = new THREE.Box3(),
  center = new THREE.Vector3();
function resize() {
  const w = canvas.clientWidth,
    h = canvas.clientHeight;
  if (w && h) {
    renderer.setSize(w, h);
    camera.aspect = w / h;
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
  const distance =
    (Math.max(bounds.getSize(new THREE.Vector3()).length(), 100) * 1.85) /
    Math.min(camera.aspect, 1);
  const dir =
    direction === "front"
      ? new THREE.Vector3(0, -1, 0.02)
      : direction === "top"
        ? new THREE.Vector3(0, -0.001, 1)
        : new THREE.Vector3(1, -1.5, 0.9).normalize();
  camera.position.copy(center).addScaledVector(dir, distance);
  controls.target.copy(center);
  camera.near = distance / 10000;
  camera.far = distance * 30;
  camera.updateProjectionMatrix();
  controls.update();
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
}
function showModel(data: Model) {
  const first = !model;
  model = data;
  if (first)
    data.components
      .filter((c) => !c.parent)
      .forEach((c) => expanded.add(c.path));
  document.title = data.title + " · CodeCAD";
  clearScene();
  for (const d of data.meshes) {
    const geometry = new THREE.BufferGeometry()
      .setAttribute(
        "position",
        new THREE.Float32BufferAttribute(d.positions, 3),
      )
      .setAttribute("normal", new THREE.Float32BufferAttribute(d.normals, 3))
      .setIndex(d.indices);
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({
        color: d.color,
        roughness: 0.72,
        metalness: 0.06,
      }),
    );
    mesh.matrixAutoUpdate = false;
    mesh.matrix.fromArray(d.matrix);
    mesh.userData.path = d.componentPath;
    group.add(mesh);
    objects.set(d.componentPath, mesh);
    const edges = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute(
        "position",
        new THREE.Float32BufferAttribute(d.edges, 3),
      ),
      new THREE.LineBasicMaterial({
        color: 0x28383d,
        transparent: true,
        opacity: 0.55,
      }),
    );
    edges.matrixAutoUpdate = false;
    edges.matrix.copy(mesh.matrix);
    group.add(edges);
    edgeObjects.set(d.componentPath, edges);
  }
  $("count").textContent = String(data.meshes.length);
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
  renderOutputs();
  renderCuts();
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
  resize();
  $<HTMLButtonElement>("play").disabled = !data.frames.length;
  $<HTMLInputElement>("motion").disabled = !data.frames.length;
}
function select(path: string) {
  selected = path;
  for (const [id, mesh] of objects)
    (mesh.material as THREE.MeshStandardMaterial).emissive.setHex(
      path && within(id, path) ? 0x244c43 : 0,
    );
  const part = model?.meshes.find((m) => m.componentPath === path);
  $("selection").textContent = part
    ? path + " · " + (part.volume / 1000).toFixed(1) + " cm³"
    : path
      ? path + " · assembly"
      : "Select a part to inspect it";
  for (const component of model?.components ?? [])
    if (path.startsWith(component.path + "/")) expanded.add(component.path);
  const source = (model?.components ?? [])
    .filter((c) => path && within(c.path, path))
    .flatMap((c) => c.source ?? []);
  const lines = source.filter((s) => s.file === sourceFile).map((s) => s.line);
  highlightLines(dirty ? [] : lines);
  $("source-selection").textContent = dirty
    ? "Source changed · save and rebuild to refresh component links."
    : path
      ? `${path} · ${new Set(lines).size} source lines${source.some((s) => s.file !== sourceFile) ? " · also defined in other files" : ""}`
      : "Select a component to highlight its source references.";
  renderParts();
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
  $("count").textContent = String(components.length);
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
          visible.checked && $<HTMLInputElement>("edges").checked;
      });
      renderParts();
    });
    const label = document.createElement("span");
    label.textContent = d.id;
    row.title = `${d.path}\n${d.label} · ${d.type}`;
    row.append(toggle, visible, label);
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
  const frames = model.frames,
    index = Math.min(frames.length - 1, Math.round(t * (frames.length - 1)));
  for (const [i, d] of model.meshes.entries()) {
    const mesh = objects.get(d.componentPath)!,
      edges = edgeObjects.get(d.componentPath)!;
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
    edges.visible = mesh.visible && $<HTMLInputElement>("edges").checked;
    void i;
  }
  $("motion-label").textContent =
    t === 0 ? "Closed" : Math.round(t * 100) + "%";
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
  const pdfReports: { drawing: PdfReport[]; nesting: PdfReport[] } = {
    drawing: [],
    nesting: [],
  };
  for (const id of ["drawing", "nesting", "exports"]) $(id).replaceChildren();
  const grouped = new Set<string>();
  for (const report of model?.reports ?? []) {
    grouped.add(report.preview);
    report.previews?.forEach((name) => grouped.add(name));
    Object.values(report.formats).forEach((name) => grouped.add(name));
    if (report.kind !== "cutList") {
      pdfReports[report.kind === "drawing" ? "drawing" : "nesting"].push({
        title: report.title,
        url: artifactUrl(report.formats.pdf),
        download: downloadControl(report),
      });
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
      $(file.kind === "drawing" ? "drawing" : "nesting").append(card);
    }
    const row = document.createElement("div");
    row.className = "export-row";
    const link = document.createElement("a");
    link.href = url + "&download";
    link.textContent = file.name;
    const size = document.createElement("small");
    size.textContent = (file.size / 1024).toFixed(1) + " KB · " + file.kind;
    row.append(link, size);
    $("exports").append(row);
  }
  for (const id of ["drawing", "nesting"] as const) {
    if (!pdfReports[id].length) continue;
    const viewer = pdfViewer(pdfReports[id]);
    pdfViewers.push(viewer);
    $(id).append(viewer.element);
  }
}
function renderCuts() {
  $("cuts").replaceChildren();
  const reports =
    model?.reports.filter((report) => report.kind === "cutList") ?? [];
  for (const report of reports) {
    const heading = document.createElement("h3");
    heading.textContent = report.title;
    heading.append(downloadControl(report));
    $("cuts").append(heading);
    renderCutTable(report.rows ?? []);
  }
  if (!reports.length) renderCutTable(model?.cutList ?? []);
}
function renderCutTable(rows: Model["cutList"]) {
  const table = document.createElement("table");
  const header = document.createElement("tr");
  for (const name of ["Part", "Material", "W", "H", "T", "Qty"]) {
    const cell = document.createElement("th");
    cell.textContent = name;
    header.append(cell);
  }
  table.append(header);
  for (const r of rows) {
    const row = document.createElement("tr");
    for (const value of [
      r.path.split("/").slice(1).join("/"),
      r.material,
      r.width,
      r.height,
      r.thickness,
      r.quantity,
    ]) {
      const cell = document.createElement("td");
      cell.textContent = String(value);
      cell.title = String(value);
      row.append(cell);
    }
    table.append(row);
  }
  $("cuts").append(table);
}
async function loadSource() {
  const response = await fetch("/api/source"),
    data = await response.json();
  sourceFile = data.file;
  setSource(data.source, data.file);
  version = data.version;
  token = data.token;
  dirty = false;
  $("file").textContent = data.file;
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
  $("source-status").textContent = "Unsaved changes · Ctrl / ⌘ + S";
});
window.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "s") {
    event.preventDefault();
    void save();
  }
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
  $("toggle-source").textContent = open ? "3D view" : "Source";
};
$("toggle-parts").onclick = () => document.body.classList.toggle("parts-open");
$("reload-source").onclick = () => {
  if (!dirty || confirm("Discard unsaved editor changes?")) void loadSource();
};
$("rebuild").onclick = () =>
  void fetch("/api/rebuild", {
    method: "POST",
    headers: { "X-CodeCAD-Token": token },
  });
$("fit").onclick = () => fit();
$("show-all").onclick = () => showOnly("");
document
  .querySelectorAll<HTMLButtonElement>("[data-camera]")
  .forEach((button) => (button.onclick = () => fit(button.dataset.camera)));
$("filter").oninput = renderParts;
$("edges").onchange = applyPose;
$("explode").oninput = applyPose;
$("motion").oninput = () => {
  playing = false;
  $("play").textContent = "▶ Motion";
  applyPose();
};
$("play").onclick = () => {
  playing = !playing;
  $("play").textContent = playing ? "Ⅱ Pause" : "▶ Motion";
};
document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach(
  (button) =>
    (button.onclick = () => {
      document
        .querySelectorAll("#tabs button,.tab")
        .forEach((el) => el.classList.remove("active"));
      button.classList.add("active");
      $(button.dataset.tab!).classList.add("active");
      resize();
    }),
);
const raycaster = new THREE.Raycaster();
let downX = 0,
  downY = 0;
renderer.domElement.addEventListener("pointerdown", (event) => {
  downX = event.clientX;
  downY = event.clientY;
});
renderer.domElement.addEventListener("pointerup", (event) => {
  if (Math.hypot(event.clientX - downX, event.clientY - downY) > 4) return;
  const r = renderer.domElement.getBoundingClientRect();
  raycaster.setFromCamera(
    new THREE.Vector2(
      ((event.clientX - r.left) / r.width) * 2 - 1,
      (-(event.clientY - r.top) / r.height) * 2 + 1,
    ),
    camera,
  );
  const hit = raycaster.intersectObjects(
    [...objects.values()].filter((m) => m.visible),
  )[0];
  select(hit?.object.userData.path ?? "");
});
setupDesktop(() => !dirty || confirm("Discard unsaved editor changes?"));
await loadSource();
await configureEditor(token);
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
  if (playing && model?.frames.length) {
    time = (time + dt / model.duration) % 2;
    $<HTMLInputElement>("motion").value = String(
      Math.round((time <= 1 ? time : 2 - time) * 1000),
    );
    applyPose();
  }
  controls.update();
  renderer.render(scene, camera);
}
requestAnimationFrame(animate);
