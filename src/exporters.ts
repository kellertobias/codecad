import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import PDFDocument from "pdfkit";
import SVGtoPDF from "svg-to-pdfkit";
import * as b from "brepjs/quick";
import { Part, PartInterface, descendants, type Component } from "./model.js";
import type { MotionStudy } from "./motion.js";
import type { MeshData, OpenCascadeEngine } from "./engine.js";

export async function pdf(svg: Uint8Array): Promise<Uint8Array> {
  return pdfPages([svg]);
}
export async function pdfPages(
  pages: readonly Uint8Array[],
): Promise<Uint8Array> {
  if (!pages.length) throw new Error("A PDF must contain at least one page");
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ autoFirstPage: false, margin: 0 }),
      chunks: Buffer[] = [];
    doc.on("data", (data: Buffer) => chunks.push(data));
    doc.on("error", reject);
    doc.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    for (const svg of pages) {
      const text = new TextDecoder().decode(svg),
        match = text.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
      const width = (Number(match?.[1] ?? 420) * 72) / 25.4,
        height = (Number(match?.[2] ?? 297) * 72) / 25.4;
      doc.addPage({ size: [width, height], margin: 0 });
      SVGtoPDF(doc, text, 0, 0, { width, height, assumePt: false });
    }
    doc.end();
  });
}
export interface MotionFrame {
  t: number;
  matrices: Record<string, number[]>;
}
export interface ClearanceResult {
  between: string[];
  minimum: number;
  measured: number;
  at: number;
  passed: boolean;
  samples: number;
}
export function motionFrames(
  study: MotionStudy,
  parts: Part[],
  count = Math.max(
    2,
    Math.ceil(study.duration * (study.options.framesPerSecond ?? 30)) + 1,
  ),
): MotionFrame[] {
  return Array.from({ length: count }, (_, i) => ({
    t: i / (count - 1),
    matrices: Object.fromEntries(
      parts.map((p) => [p.path, study.pose(p, i / (count - 1)).toArray()]),
    ),
  }));
}
export function clearanceResults(
  engine: OpenCascadeEngine,
  study: MotionStudy,
): ClearanceResult[] {
  const component = (s: Component | PartInterface) =>
    s instanceof PartInterface ? s.owner : s;
  return study.clearances.map((check) => {
    const [a, c] = check.between.map(component);
    if (!a || !c)
      throw new Error("Clearance interface requires a component owner");
    const parts = (root: Component) =>
      [root, ...descendants(root)].filter((p): p is Part => p instanceof Part);
    let minimum = Infinity,
      at = 0;
    const samples = check.samples ?? 31;
    for (let i = 0; i < samples; i++) {
      const shapesA = parts(a).map((p) =>
        engine.transform(
          engine.shapes.get(p)!,
          study.pose(p, i / (samples - 1)),
        ),
      );
      const shapesB = parts(c).map((p) =>
        engine.transform(
          engine.shapes.get(p)!,
          study.pose(p, i / (samples - 1)),
        ),
      );
      const first = engine.own(b.compound(shapesA)),
        second = engine.own(b.compound(shapesB));
      const distance = b.unwrap(b.measureDistance(first, second));
      if (distance < minimum) {
        minimum = distance;
        at = i / (samples - 1);
      }
    }
    return {
      between: [a.path, c.path],
      minimum: check.minimum,
      measured: minimum,
      at,
      passed: minimum >= check.minimum,
      samples,
    };
  });
}
export async function glb(
  meshes: readonly MeshData[],
  frames: MotionFrame[] = [],
  duration = 3,
): Promise<Uint8Array> {
  // Three's exporter uses the browser FileReader API to encode Blob buffers.
  if (!globalThis.FileReader) {
    (globalThis as any).FileReader = class {
      result: ArrayBuffer | string | null = null;
      onloadend: (() => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      readAsArrayBuffer(blob: Blob) {
        blob
          .arrayBuffer()
          .then((data) => {
            this.result = data;
            this.onloadend?.();
          })
          .catch((e) => this.onerror?.(e));
      }
      readAsDataURL(blob: Blob) {
        blob
          .arrayBuffer()
          .then((data) => {
            this.result =
              "data:" +
              blob.type +
              ";base64," +
              Buffer.from(data).toString("base64");
            this.onloadend?.();
          })
          .catch((e) => this.onerror?.(e));
      }
    };
  }
  const scene = new THREE.Scene(),
    root = new THREE.Group();
  root.scale.setScalar(0.001);
  root.rotation.x = -Math.PI / 2;
  scene.add(root);
  const tracks: THREE.KeyframeTrack[] = [];
  for (const [i, data] of meshes.entries()) {
    const geometry = new THREE.BufferGeometry()
      .setAttribute("position", new THREE.BufferAttribute(data.positions, 3))
      .setAttribute("normal", new THREE.BufferAttribute(data.normals, 3))
      .setIndex(new THREE.BufferAttribute(data.indices, 1));
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ color: data.color }),
    );
    mesh.name = "part_" + i;
    mesh.userData = { componentPath: data.componentPath };
    new THREE.Matrix4()
      .fromArray(data.matrix)
      .decompose(mesh.position, mesh.quaternion, mesh.scale);
    root.add(mesh);
    if (frames.length) {
      const times: number[] = [],
        positions: number[] = [],
        rotations: number[] = [],
        scales: number[] = [];
      for (const frame of frames) {
        const matrix = frame.matrices[data.componentPath] ?? data.matrix;
        const p = new THREE.Vector3(),
          q = new THREE.Quaternion(),
          s = new THREE.Vector3();
        new THREE.Matrix4().fromArray(matrix).decompose(p, q, s);
        times.push(frame.t * duration);
        positions.push(...p.toArray());
        rotations.push(...q.toArray());
        scales.push(...s.toArray());
      }
      tracks.push(
        new THREE.VectorKeyframeTrack(
          mesh.name + ".position",
          times,
          positions,
        ),
        new THREE.QuaternionKeyframeTrack(
          mesh.name + ".quaternion",
          times,
          rotations,
        ),
        new THREE.VectorKeyframeTrack(mesh.name + ".scale", times, scales),
      );
    }
  }
  const result = await new GLTFExporter().parseAsync(scene, {
    binary: true,
    animations: tracks.length
      ? [new THREE.AnimationClip("Motion", duration, tracks)]
      : [],
  });
  for (const child of root.children) {
    const m = child as THREE.Mesh;
    m.geometry.dispose();
    (m.material as THREE.Material).dispose();
  }
  if (!(result instanceof ArrayBuffer)) throw new Error("Expected binary glTF");
  return new Uint8Array(result);
}
