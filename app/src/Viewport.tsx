// A three.js view managed imperatively inside a React component: React owns
// the canvas element and hands over meshes; the scene, camera and render loop
// live in refs so re-renders never rebuild them.
import { useEffect, useRef } from "react";
import {
  AmbientLight,
  Box3,
  BufferAttribute,
  BufferGeometry,
  DirectionalLight,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
  type Object3D,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { ShapeMesh } from "../../src/kernel/mesh.ts";

interface View {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  controls: OrbitControls;
  shown: Object3D[];
  framed: boolean;
  /** Matches the renderer and camera to the canvas's current size. */
  resize(): void;
}

export function Viewport({ mesh }: { mesh: ShapeMesh | undefined }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const view = useRef<View | undefined>(undefined);

  useEffect(() => {
    const element = canvas.current!;
    const renderer = new WebGLRenderer({
      canvas: element,
      antialias: true,
      alpha: true,
    });
    const scene = new Scene();
    scene.add(new AmbientLight(0xffffff, 1.2));
    const sun = new DirectionalLight(0xffffff, 2);
    sun.position.set(1, -2, 3);
    scene.add(sun);
    const camera = new PerspectiveCamera(35, 1, 1, 100000);
    camera.up.set(0, 0, 1);
    camera.position.set(400, -900, 600);
    const controls = new OrbitControls(camera, element);
    const render = () => renderer.render(scene, camera);
    controls.addEventListener("change", render);
    const resize = () => {
      const { clientWidth: width, clientHeight: height } = element;
      renderer.setPixelRatio(devicePixelRatio);
      renderer.setSize(width, height, false);
      camera.aspect = width / Math.max(height, 1);
      camera.updateProjectionMatrix();
      render();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    view.current = {
      renderer,
      scene,
      camera,
      controls,
      shown: [],
      framed: false,
      resize,
    };
    return () => {
      observer.disconnect();
      controls.dispose();
      renderer.dispose();
      view.current = undefined;
    };
  }, []);

  useEffect(() => {
    const current = view.current;
    if (!current) return;
    for (const object of current.shown) {
      current.scene.remove(object);
      if (object instanceof Mesh || object instanceof LineSegments)
        object.geometry.dispose();
    }
    current.shown = [];
    if (!mesh) return;
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(mesh.positions, 3));
    geometry.setAttribute("normal", new BufferAttribute(mesh.normals, 3));
    geometry.setIndex(new BufferAttribute(mesh.indices, 1));
    const edges = new BufferGeometry();
    edges.setAttribute("position", new BufferAttribute(mesh.edges, 3));
    current.shown = [
      new Mesh(geometry, new MeshStandardMaterial({ color: 0xc9aa78 })),
      new LineSegments(edges, new LineBasicMaterial({ color: 0x3b2f22 })),
    ];
    current.scene.add(...current.shown);
    // Frame the first model; after that, edits keep the user's camera.
    if (!current.framed) {
      // Measure now rather than trust the resize observer to have run: the
      // fit depends on the aspect ratio.
      current.resize();
      const bounds = new Box3().setFromBufferAttribute(
        geometry.getAttribute("position") as BufferAttribute,
      );
      const center = bounds.getCenter(new Vector3());
      const size = bounds.getSize(new Vector3()).length();
      // Far enough back that the model's bounding sphere fits the narrower
      // of the two fields of view, so portrait phone screens fit it too.
      const vertical = (current.camera.fov * Math.PI) / 180;
      const horizontal =
        2 * Math.atan(Math.tan(vertical / 2) * current.camera.aspect);
      const distance =
        (size / 2 / Math.tan(Math.min(vertical, horizontal) / 2)) * 1.05;
      current.controls.target.copy(center);
      current.camera.position
        .copy(center)
        .add(new Vector3(0.4, -1, 0.7).normalize().multiplyScalar(distance));
      current.controls.update();
      current.framed = true;
    }
    current.renderer.render(current.scene, current.camera);
  }, [mesh]);

  // The canvas is laid out by its wrapper: sized directly, its drawing
  // buffer would feed back into the layout and grow without end.
  return (
    <div className="viewport">
      <canvas ref={canvas} />
    </div>
  );
}
