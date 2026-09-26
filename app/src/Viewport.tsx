// The 3D view of the model, managed imperatively inside a React component:
// React owns the canvas; the scene, camera and render loop live in a ref so
// re-renders never rebuild them. Bodies arrive as meshes whose triangles
// are grouped by face and whose lines are grouped by edge, which is what
// picking reads: a click names a face or an edge by the kernel's hash.
import { useEffect, useRef, useState, type PointerEvent } from "react";
import {
  AmbientLight,
  Box3,
  BufferAttribute,
  BufferGeometry,
  DirectionalLight,
  Group,
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
  type Intersection,
  type Object3D,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { BodyView } from "../../web/kernel/protocol.ts";
import {
  measure,
  type MeasurePick,
  type MeasureResult,
} from "../../web/measurement.ts";
import type { Frame } from "../../src/document/frames.ts";

export type PickMode = "none" | "face" | "edge" | "body" | "measure";

export type Pick =
  | {
      readonly kind: "face";
      readonly body: string;
      readonly face: number;
      readonly point: Vector3;
      readonly normal: Vector3;
    }
  | {
      readonly kind: "edge";
      readonly body: string;
      readonly edge: number;
      readonly a: Vector3;
      readonly b: Vector3;
    }
  | { readonly kind: "body"; readonly body: string };

export interface Highlight {
  /** Face hashes per body id. */
  readonly faces?: ReadonlyMap<string, ReadonlySet<number>>;
  readonly edges?: ReadonlyMap<string, ReadonlySet<number>>;
  readonly bodies?: ReadonlySet<string>;
}

/** A sketch drawn in the model: its curves as x1, y1, x2, y2 runs in its
 * own plane. */
export interface SketchOverlay {
  readonly id: string;
  readonly frame: Frame;
  readonly segments: Float32Array;
  readonly active: boolean;
}

interface Scenery {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  controls: OrbitControls;
  bodies: Group;
  overlays: Group;
  sketches: Group;
  measures: Group;
  framed: boolean;
  resize(): void;
  render(): void;
}

const colors = {
  body: 0xc9aa78,
  edge: 0x3b2f22,
  hover: 0x7fb0ff,
  selected: 0x2f6fdb,
  sketch: 0x1f8a4c,
  activeSketch: 0x2f6fdb,
  measure: 0xd1242f,
};

export function Viewport({
  bodies,
  sketches = [],
  mode = "none",
  highlight = {},
  onPick,
}: {
  bodies: readonly BodyView[];
  sketches?: readonly SketchOverlay[];
  mode?: PickMode;
  highlight?: Highlight;
  onPick?: (pick: Pick | undefined) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const view = useRef<Scenery | undefined>(undefined);
  const [hover, setHover] = useState<Pick>();
  const [measured, setMeasured] = useState<{
    picks: MeasurePick[];
    result?: MeasureResult;
    error?: string;
  }>({ picks: [] });
  const props = useRef({ bodies, mode, onPick });
  props.current = { bodies, mode, onPick };

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
    const groups = {
      bodies: new Group(),
      overlays: new Group(),
      sketches: new Group(),
      measures: new Group(),
    };
    scene.add(...Object.values(groups));
    const render = () => renderer.render(scene, camera);
    controls.addEventListener("change", render);
    const resize = () => {
      const { clientWidth: width, clientHeight: height } = element;
      if (!width || !height) return;
      renderer.setPixelRatio(devicePixelRatio);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
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
      ...groups,
      framed: false,
      resize,
      render,
    };
    resize();
    return () => {
      observer.disconnect();
      controls.dispose();
      renderer.dispose();
      view.current = undefined;
    };
  }, []);

  // Bodies.
  useEffect(() => {
    const current = view.current;
    if (!current) return;
    clear(current.bodies);
    for (const body of bodies) {
      const geometry = new BufferGeometry();
      geometry.setAttribute(
        "position",
        new BufferAttribute(body.mesh.positions, 3),
      );
      geometry.setAttribute(
        "normal",
        new BufferAttribute(body.mesh.normals, 3),
      );
      geometry.setIndex(new BufferAttribute(body.mesh.indices, 1));
      const mesh = new Mesh(
        geometry,
        new MeshStandardMaterial({
          color: colors.body,
          polygonOffset: true,
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 1,
        }),
      );
      mesh.userData = { body: body.id, kind: "faces" };
      const lines = new BufferGeometry();
      lines.setAttribute("position", new BufferAttribute(body.mesh.edges, 3));
      const edges = new LineSegments(
        lines,
        new LineBasicMaterial({ color: colors.edge }),
      );
      edges.userData = { body: body.id, kind: "edges" };
      current.bodies.add(mesh, edges);
    }
    if (!current.framed && bodies.length) {
      frame(current);
      current.framed = true;
    }
    current.render();
  }, [bodies]);

  // Selection and hover highlights.
  useEffect(() => {
    const current = view.current;
    if (!current) return;
    clear(current.overlays);
    const add = (
      body: BodyView,
      faces: ReadonlySet<number>,
      edges: ReadonlySet<number>,
      color: number,
      opacity: number,
    ) => {
      const faceOverlay = faceGeometry(body, faces);
      if (faceOverlay)
        current.overlays.add(
          new Mesh(
            faceOverlay,
            new MeshStandardMaterial({
              color,
              transparent: true,
              opacity,
              depthWrite: false,
            }),
          ),
        );
      const edgeOverlay = edgeGeometry(body, edges);
      if (edgeOverlay)
        current.overlays.add(
          new LineSegments(
            edgeOverlay,
            new LineBasicMaterial({ color, depthTest: false }),
          ),
        );
    };
    for (const body of bodies) {
      const whole = highlight.bodies?.has(body.id);
      const faces = whole
        ? new Set(faceIds(body))
        : (highlight.faces?.get(body.id) ?? new Set<number>());
      add(
        body,
        faces,
        highlight.edges?.get(body.id) ?? new Set(),
        colors.selected,
        0.55,
      );
      if (hover && "body" in hover && hover.body === body.id)
        add(
          body,
          hover.kind === "face"
            ? new Set([hover.face])
            : hover.kind === "body"
              ? new Set(faceIds(body))
              : new Set(),
          hover.kind === "edge" ? new Set([hover.edge]) : new Set(),
          colors.hover,
          0.35,
        );
    }
    current.render();
  }, [bodies, highlight, hover]);

  // Sketches drawn in their planes.
  useEffect(() => {
    const current = view.current;
    if (!current) return;
    clear(current.sketches);
    for (const sketch of sketches) {
      const { origin: o, x, y } = sketch.frame;
      const s = sketch.segments;
      const positions = new Float32Array((s.length / 2) * 3);
      for (let i = 0, j = 0; i < s.length; i += 2, j += 3) {
        positions[j] = o[0] + x[0] * s[i]! + y[0] * s[i + 1]!;
        positions[j + 1] = o[1] + x[1] * s[i]! + y[1] * s[i + 1]!;
        positions[j + 2] = o[2] + x[2] * s[i]! + y[2] * s[i + 1]!;
      }
      const geometry = new BufferGeometry();
      geometry.setAttribute("position", new BufferAttribute(positions, 3));
      current.sketches.add(
        new LineSegments(
          geometry,
          new LineBasicMaterial({
            color: sketch.active ? colors.activeSketch : colors.sketch,
            depthTest: false,
          }),
        ),
      );
    }
    current.render();
  }, [sketches]);

  // Measurement guides.
  useEffect(() => {
    const current = view.current;
    if (!current) return;
    clear(current.measures);
    const guides = measured.result?.guides ?? [];
    if (guides.length) {
      const geometry = new BufferGeometry().setFromPoints(guides.flat());
      current.measures.add(
        new LineSegments(
          geometry,
          new LineBasicMaterial({ color: colors.measure, depthTest: false }),
        ),
      );
    }
    current.render();
  }, [measured]);

  useEffect(() => {
    if (mode !== "measure") setMeasured({ picks: [] });
    setHover(undefined);
  }, [mode]);

  /** What is under the pointer, for the current mode. */
  const pickAt = (clientX: number, clientY: number): Pick | undefined => {
    const current = view.current;
    const element = canvas.current;
    const { mode } = props.current;
    if (!current || !element || mode === "none") return undefined;
    const rect = element.getBoundingClientRect();
    const pointer = new Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new Raycaster();
    raycaster.setFromCamera(pointer, current.camera);
    const faceHit = raycaster
      .intersectObjects(current.bodies.children.filter(isFaces), false)
      .at(0);
    if (mode === "edge" || mode === "measure") {
      // A few pixels either side of the line, at the distance of what is
      // under the pointer.
      const distance =
        faceHit?.distance ??
        current.camera.position.distanceTo(current.controls.target);
      const pixel =
        (2 * distance * Math.tan((current.camera.fov * Math.PI) / 360)) /
        rect.height;
      raycaster.params.Line = { threshold: 6 * pixel };
      const edgeHit = raycaster
        .intersectObjects(current.bodies.children.filter(isEdges), false)
        .filter(
          (hit) => !faceHit || hit.distance <= faceHit.distance + 8 * pixel,
        )
        .at(0);
      const edge = edgeHit && edgeOf(edgeHit, props.current.bodies);
      if (edge) return edge;
      if (mode === "edge") return undefined;
    }
    if (!faceHit) return undefined;
    const body = props.current.bodies.find(
      (b) => b.id === faceHit.object.userData.body,
    );
    if (!body) return undefined;
    if (mode === "body") return { kind: "body", body: body.id };
    const face = faceOf(body, faceHit.faceIndex ?? 0);
    if (face === undefined) return undefined;
    return {
      kind: "face",
      body: body.id,
      face,
      point: faceHit.point.clone(),
      normal: (faceHit.face?.normal ?? new Vector3(0, 0, 1))
        .clone()
        .transformDirection(faceHit.object.matrixWorld),
    };
  };

  const down = useRef<{ x: number; y: number } | undefined>(undefined);
  const onPointerDown = (event: PointerEvent) => {
    down.current = { x: event.clientX, y: event.clientY };
  };
  const onPointerUp = (event: PointerEvent) => {
    const start = down.current;
    down.current = undefined;
    // A drag turns the camera; only a click picks.
    if (
      !start ||
      Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4
    )
      return;
    const pick = pickAt(event.clientX, event.clientY);
    if (props.current.mode === "measure") {
      const next = pick && toMeasure(pick, event.clientX, event.clientY);
      if (!next) return;
      setMeasured((m) => {
        const picks = m.picks.length >= 2 ? [next] : [...m.picks, next];
        if (picks.length < 2) return { picks };
        try {
          return { picks, result: measure(picks[0]!, picks[1]!) };
        } catch (error) {
          return {
            picks,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      });
      return;
    }
    props.current.onPick?.(pick);
  };
  const frameRequest = useRef(0);
  const onPointerMove = (event: PointerEvent) => {
    if (down.current || props.current.mode === "none") return;
    const { clientX, clientY } = event;
    cancelAnimationFrame(frameRequest.current);
    frameRequest.current = requestAnimationFrame(() => {
      const pick = pickAt(clientX, clientY);
      setHover((old) => (same(old, pick) ? old : pick));
    });
  };

  /** A measurement pick: a vertex when the pointer is near an end of the
   * picked edge, else the edge or the face. */
  const toMeasure = (
    pick: Pick,
    x: number,
    y: number,
  ): MeasurePick | undefined => {
    const current = view.current!;
    if (pick.kind === "edge") {
      const rect = canvas.current!.getBoundingClientRect();
      const screen = (p: Vector3) => {
        const v = p.clone().project(current.camera);
        return new Vector2(
          rect.left + ((v.x + 1) / 2) * rect.width,
          rect.top + ((1 - v.y) / 2) * rect.height,
        );
      };
      for (const end of [pick.a, pick.b])
        if (screen(end).distanceTo(new Vector2(x, y)) <= 10)
          return { kind: "point", point: end.clone() };
      return { kind: "edge", a: pick.a.clone(), b: pick.b.clone() };
    }
    if (pick.kind === "face")
      return { kind: "face", point: pick.point, normal: pick.normal };
    return undefined;
  };

  const setView = (direction: [number, number, number]) => {
    const current = view.current;
    if (!current) return;
    frame(current, new Vector3(...direction));
  };

  return (
    <div className="viewport">
      <canvas
        ref={canvas}
        className={`pick-${mode}`}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHover(undefined)}
      />
      <div className="view-buttons">
        <button onClick={() => setView([0.4, -1, 0.7])} title="Fit the model">
          Fit
        </button>
        <button onClick={() => setView([0, -1, 0])}>Front</button>
        <button onClick={() => setView([0, 0, 1])}>Top</button>
        <button onClick={() => setView([1, 0, 0])}>Right</button>
      </div>
      {mode === "measure" ? (
        <p className="measure-result">
          {measured.result
            ? measured.result.description
            : measured.error
              ? measured.error
              : measured.picks.length === 1
                ? "Pick the second point, edge or face"
                : "Pick a point, edge or face to measure from"}
        </p>
      ) : null}
    </div>
  );
}

const isFaces = (object: Object3D) => object.userData.kind === "faces";
const isEdges = (object: Object3D) => object.userData.kind === "edges";

function clear(group: Group) {
  for (const child of [...group.children]) {
    group.remove(child);
    if (child instanceof Mesh || child instanceof LineSegments) {
      child.geometry.dispose();
      (child.material as { dispose(): void }).dispose();
    }
  }
}

function faceIds(body: BodyView): number[] {
  const out: number[] = [];
  for (let i = 0; i < body.mesh.faces.length; i += 3)
    out.push(body.mesh.faces[i + 2]!);
  return out;
}

/** The face a triangle belongs to. */
function faceOf(body: BodyView, triangle: number): number | undefined {
  const index = triangle * 3;
  const groups = body.mesh.faces;
  for (let i = 0; i < groups.length; i += 3)
    if (index >= groups[i]! && index < groups[i]! + groups[i + 1]!)
      return groups[i + 2];
  return undefined;
}

function edgeOf(
  hit: Intersection,
  bodies: readonly BodyView[],
): Pick | undefined {
  const body = bodies.find((b) => b.id === hit.object.userData.body);
  if (!body || hit.index === undefined) return undefined;
  const groups = body.mesh.edgeGroups;
  for (let i = 0; i < groups.length; i += 3)
    if (hit.index >= groups[i]! && hit.index < groups[i]! + groups[i + 1]!) {
      const p = body.mesh.edges;
      // The whole edge's ends: its first and last vertex.
      const first = groups[i]! * 3;
      const last = (groups[i]! + groups[i + 1]! - 1) * 3;
      return {
        kind: "edge",
        body: body.id,
        edge: groups[i + 2]!,
        a: new Vector3(p[first], p[first + 1], p[first + 2]),
        b: new Vector3(p[last], p[last + 1], p[last + 2]),
      };
    }
  return undefined;
}

function faceGeometry(
  body: BodyView,
  faces: ReadonlySet<number>,
): BufferGeometry | undefined {
  if (!faces.size) return undefined;
  const groups = body.mesh.faces;
  const indices: number[] = [];
  for (let i = 0; i < groups.length; i += 3)
    if (faces.has(groups[i + 2]!))
      for (let j = groups[i]!; j < groups[i]! + groups[i + 1]!; j++)
        indices.push(body.mesh.indices[j]!);
  if (!indices.length) return undefined;
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(body.mesh.positions, 3),
  );
  geometry.setAttribute("normal", new BufferAttribute(body.mesh.normals, 3));
  geometry.setIndex(indices);
  return geometry;
}

function edgeGeometry(
  body: BodyView,
  edges: ReadonlySet<number>,
): BufferGeometry | undefined {
  if (!edges.size) return undefined;
  const groups = body.mesh.edgeGroups;
  const points: number[] = [];
  for (let i = 0; i < groups.length; i += 3)
    if (edges.has(groups[i + 2]!))
      points.push(
        ...body.mesh.edges.subarray(
          groups[i]! * 3,
          (groups[i]! + groups[i + 1]!) * 3,
        ),
      );
  if (!points.length) return undefined;
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(new Float32Array(points), 3),
  );
  return geometry;
}

const same = (a: Pick | undefined, b: Pick | undefined) =>
  a === b ||
  (!!a &&
    !!b &&
    a.kind === b.kind &&
    a.body === b.body &&
    (a.kind === "face"
      ? a.face === (b as typeof a).face
      : a.kind === "edge"
        ? a.edge === (b as typeof a).edge
        : true));

/** Looks at the whole model from `direction`, far enough back that its
 * bounding sphere fits the narrower field of view (portrait phones too). */
function frame(current: Scenery, direction = new Vector3(0.4, -1, 0.7)) {
  current.resize();
  const bounds = new Box3().setFromObject(current.bodies);
  if (bounds.isEmpty()) bounds.setFromObject(current.sketches);
  if (bounds.isEmpty()) return;
  const center = bounds.getCenter(new Vector3());
  const size = Math.max(bounds.getSize(new Vector3()).length(), 1);
  const vertical = (current.camera.fov * Math.PI) / 180;
  const horizontal =
    2 * Math.atan(Math.tan(vertical / 2) * current.camera.aspect);
  const distance =
    (size / 2 / Math.tan(Math.min(vertical, horizontal) / 2)) * 1.05;
  current.controls.target.copy(center);
  current.camera.up.set(0, 0, 1);
  // Straight down would leave "up" undefined: tilt a hair.
  const d = direction.clone().normalize();
  if (Math.abs(d.z) > 0.999) d.y -= 0.001;
  current.camera.position.copy(center).add(d.multiplyScalar(distance));
  current.camera.near = Math.max(distance / 1000, 0.1);
  current.camera.far = distance * 100;
  current.camera.updateProjectionMatrix();
  current.controls.update();
  current.render();
}
