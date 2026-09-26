// The model on a phone: the prebuilt GLB, turned with one finger, zoomed
// with two. Tapping a part selects it; a selected part can be shown alone.
// Loaded only when the model is looked at, so the rest of the viewer does
// not wait for three.js.
import { useEffect, useRef, useState } from "react";
import {
  AmbientLight,
  Box3,
  Color,
  DirectionalLight,
  EdgesGeometry,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Material,
  type Object3D,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { Icon } from "../icons.tsx";

interface Part {
  readonly body: string;
  readonly mesh: Mesh;
  readonly edges: LineSegments;
  readonly material: MeshStandardMaterial;
  readonly color: Color;
}

export default function ModelView({
  url,
  selected,
  isolate,
  select,
}: {
  url: string;
  selected: string | undefined;
  /** Show the selected part alone rather than the others faded. */
  isolate: boolean;
  select(body: string | undefined): void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const state = useRef<{
    renderer: WebGLRenderer;
    scene: Scene;
    camera: PerspectiveCamera;
    controls: OrbitControls;
    parts: Part[];
    render(): void;
    fit(): void;
  }>(undefined);
  const [status, setStatus] = useState("Loading the model…");
  const selectRef = useRef(select);
  selectRef.current = select;

  useEffect(() => {
    const element = canvas.current!;
    const renderer = new WebGLRenderer({ canvas: element, antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    const scene = new Scene();
    scene.background = new Color(
      matchMedia("(prefers-color-scheme: dark)").matches ? 0x202226 : 0xf3f2ee,
    );
    scene.add(new AmbientLight(0xffffff, 1.6));
    const sun = new DirectionalLight(0xffffff, 1.8);
    sun.position.set(1, 2, 1.5);
    scene.add(sun);
    const fill = new DirectionalLight(0xffffff, 0.6);
    fill.position.set(-1.5, 0.5, -1);
    scene.add(fill);
    const camera = new PerspectiveCamera(40, 1, 0.001, 100);
    const controls = new OrbitControls(camera, element);
    controls.enableDamping = true;
    let frame = 0;
    const render = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (controls.update()) render();
        renderer.render(scene, camera);
      });
    };
    controls.addEventListener("change", render);
    const parts: Part[] = [];
    const fit = () => {
      const visible = parts.filter((p) => p.mesh.visible);
      if (!visible.length) return;
      const box = new Box3();
      for (const part of visible) box.expandByObject(part.mesh);
      const centre = box.getCenter(new Vector3());
      const radius = box.getSize(new Vector3()).length() / 2 || 0.1;
      const distance =
        radius /
        Math.sin((camera.fov * Math.PI) / 360) /
        Math.min(1, camera.aspect);
      camera.position
        .copy(centre)
        .add(new Vector3(0.9, 0.7, 1.2).normalize().multiplyScalar(distance));
      camera.near = distance / 100;
      camera.far = distance * 10;
      camera.updateProjectionMatrix();
      controls.target.copy(centre);
      render();
    };
    const resize = () => {
      const { clientWidth: w, clientHeight: h } = element;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      render();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    state.current = { renderer, scene, camera, controls, parts, render, fit };

    let cancelled = false;
    new GLTFLoader().load(
      url,
      (gltf) => {
        if (cancelled) return;
        gltf.scene.traverse((object: Object3D) => {
          if (!(object instanceof Mesh)) return;
          const body = String(object.userData.componentPath ?? object.name);
          const source = object.material as Material & { color?: Color };
          const color = source.color?.clone() ?? new Color(0xc9a878);
          const material = new MeshStandardMaterial({
            color,
            roughness: 0.75,
            metalness: 0,
            polygonOffset: true,
            polygonOffsetFactor: 1,
            polygonOffsetUnits: 1,
          });
          object.material = material;
          const edges = new LineSegments(
            new EdgesGeometry(object.geometry, 20),
            new LineBasicMaterial({ color: 0x3b2f22, transparent: true }),
          );
          object.add(edges);
          parts.push({ body, mesh: object, edges, material, color });
        });
        scene.add(gltf.scene);
        setStatus("");
        resize();
        fit();
      },
      undefined,
      () => setStatus("The model did not load."),
    );

    // A tap (not a drag) picks the part under the finger.
    let down: { x: number; y: number } | undefined;
    const onDown = (event: globalThis.PointerEvent) => {
      down = event.isPrimary
        ? { x: event.clientX, y: event.clientY }
        : undefined;
    };
    const onUp = (event: globalThis.PointerEvent) => {
      if (
        !down ||
        Math.hypot(event.clientX - down.x, event.clientY - down.y) > 6
      )
        return;
      const rect = element.getBoundingClientRect();
      const ray = new Raycaster();
      ray.setFromCamera(
        new Vector2(
          ((event.clientX - rect.left) / rect.width) * 2 - 1,
          -((event.clientY - rect.top) / rect.height) * 2 + 1,
        ),
        camera,
      );
      const hit = ray.intersectObjects(
        parts.filter((p) => p.mesh.visible).map((p) => p.mesh),
        false,
      )[0];
      const part = parts.find((p) => p.mesh === hit?.object);
      selectRef.current(part?.body);
    };
    element.addEventListener("pointerdown", onDown);
    element.addEventListener("pointerup", onUp);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      element.removeEventListener("pointerdown", onDown);
      element.removeEventListener("pointerup", onUp);
      controls.dispose();
      scene.traverse((object) => {
        if (object instanceof Mesh || object instanceof LineSegments) {
          object.geometry.dispose();
          (object.material as Material).dispose();
        }
      });
      renderer.dispose();
      state.current = undefined;
    };
  }, [url]);

  // The selection: highlighted, the rest faded or hidden.
  useEffect(() => {
    const current = state.current;
    if (!current) return;
    for (const part of current.parts) {
      const chosen = part.body === selected;
      const faded = selected !== undefined && !chosen;
      part.mesh.visible = !(faded && isolate);
      part.material.color.copy(
        chosen ? new Color(0x2f6fdb).lerp(part.color, 0.35) : part.color,
      );
      part.material.transparent = faded;
      part.material.opacity = faded ? 0.15 : 1;
      part.material.depthWrite = !faded;
      part.material.needsUpdate = true;
      (part.edges.material as LineBasicMaterial).opacity = faded ? 0.15 : 1;
    }
    if (isolate) current.fit();
    else current.render();
  }, [selected, isolate, status]);

  return (
    <div className="model-view">
      <canvas ref={canvas} aria-label="The model; tap a part to select it" />
      {status ? <p className="model-status">{status}</p> : null}
      <button
        type="button"
        className="fit-button"
        aria-label="Fit the model"
        onClick={() => state.current?.fit()}
      >
        <Icon name="fit" size={20} />
      </button>
    </div>
  );
}
