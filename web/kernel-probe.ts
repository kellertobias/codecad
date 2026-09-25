// Loads the CAD kernel in a worker, builds a few solids and reports how long
// each step took. It is the acceptance check that the kernel runs in the
// browser, and a quick way to see its cost on a given machine.
import {
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  Box3,
  DirectionalLight,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";
import type { Recipe } from "../src/model.js";
import { KernelClient } from "./kernel/client.js";

const results = document.getElementById("results")!;
const status = document.getElementById("status")!;
const row = (label: string, value: string) => {
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = value;
  results.append(dt, dd);
};
const ms = (value: number) => `${value.toFixed(0)} ms`;

const translate = (
  source: Recipe,
  x: number,
  y: number,
  z: number,
): Recipe => ({
  kind: "transform",
  source,
  matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1],
});
// A shelf panel with a row of shelf-pin holes: a box, then booleans.
const hole: Recipe = { kind: "cylinder", diameter: 5, length: 40 };
let panel: Recipe = { kind: "box", width: 600, depth: 300, height: 18 };
for (let x = 50; x <= 550; x += 32)
  panel = { kind: "cut", left: panel, right: translate(hole, x, 40, 9) };

const pageStarted = performance.now();
const kernel = new KernelClient();
try {
  const ready = await kernel.ready;
  row("Kernel ready after page start", ms(performance.now() - pageStarted));
  row("Kernel init in worker", ms(ready.initMs));
  if (ready.heapBytes !== undefined)
    row("Worker JS heap", `${(ready.heapBytes / 2 ** 20).toFixed(1)} MB`);
  const box = await kernel.evaluate({
    kind: "box",
    width: 100,
    depth: 50,
    height: 20,
  });
  row("Box: build / mesh", `${ms(box.buildMs)} / ${ms(box.meshMs)}`);
  row("Box volume", `${box.volume.toFixed(0)} mm³`);
  const shelf = await kernel.evaluate(panel);
  row(
    "Panel with 16 holes: build / mesh",
    `${ms(shelf.buildMs)} / ${ms(shelf.meshMs)}`,
  );
  row("Panel triangles", String(shelf.mesh.indices.length / 3));
  status.textContent = "OK";
  show(shelf.mesh);
} catch (error) {
  status.textContent = `Failed: ${error instanceof Error ? error.message : String(error)}`;
}

function show(mesh: {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  edges: Float32Array;
}) {
  const canvas = document.getElementById("view") as HTMLCanvasElement;
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
  const scene = new Scene();
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(mesh.positions, 3));
  geometry.setAttribute("normal", new BufferAttribute(mesh.normals, 3));
  geometry.setIndex(new BufferAttribute(mesh.indices, 1));
  scene.add(new Mesh(geometry, new MeshStandardMaterial({ color: 0xc9aa78 })));
  const edges = new BufferGeometry();
  edges.setAttribute("position", new BufferAttribute(mesh.edges, 3));
  scene.add(
    new LineSegments(edges, new LineBasicMaterial({ color: 0x3b2f22 })),
  );
  scene.add(new AmbientLight(0xffffff, 1.2));
  const sun = new DirectionalLight(0xffffff, 2);
  sun.position.set(1, -2, 3);
  scene.add(sun);
  const bounds = new Box3().setFromBufferAttribute(
    geometry.getAttribute("position") as BufferAttribute,
  );
  const center = bounds.getCenter(new Vector3());
  const size = bounds.getSize(new Vector3()).length();
  const camera = new PerspectiveCamera(35, 1, 1, size * 10);
  camera.up.set(0, 0, 1);
  camera.position
    .copy(center)
    .add(new Vector3(0.4, -1, 0.7).multiplyScalar(size));
  camera.lookAt(center);
  const resize = () => {
    const { clientWidth: w, clientHeight: h } = canvas;
    renderer.setPixelRatio(devicePixelRatio);
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(h, 1);
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
  };
  addEventListener("resize", resize);
  resize();
}
