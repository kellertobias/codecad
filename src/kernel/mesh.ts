import * as b from "brepjs/quick";
import { BufferGeometry, EdgesGeometry, Float32BufferAttribute } from "three";

/** A tessellated solid, as typed arrays that can be transferred between
 * threads without copying. */
export interface ShapeMesh {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  /** Line segments along the solid's feature edges, as xyz pairs. */
  readonly edges: Float32Array;
}

/** Tessellates a solid for display. Feature edges are those whose faces meet
 * at more than 12°, so smooth blends do not draw a line at every facet. */
export function meshShape(shape: b.Shape3D): ShapeMesh {
  const mesh = b.mesh(shape, {
    tolerance: 0.025,
    angularTolerance: 0.08,
    cache: false,
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new Float32BufferAttribute(mesh.vertices, 3),
  );
  geometry.setIndex(Array.from(mesh.triangles));
  const features = new EdgesGeometry(geometry, 12);
  const edges = new Float32Array(features.getAttribute("position").array);
  geometry.dispose();
  features.dispose();
  return {
    positions: mesh.vertices,
    normals: mesh.normals,
    indices: mesh.triangles,
    edges,
  };
}

/** The buffers of a mesh, for `postMessage`'s transfer list. */
export function meshTransferables(mesh: ShapeMesh): ArrayBuffer[] {
  return [mesh.positions, mesh.normals, mesh.indices, mesh.edges].map(
    (array) => array.buffer as ArrayBuffer,
  );
}

/** A solid tessellated for display and picking: its triangles grouped by
 * the face they belong to, and its true edges grouped by edge. */
export interface BodyMesh {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  /** Per face: the first index into `indices`, how many, and the face's
   * hash (what the kernel calls it; stable within one evaluation). */
  readonly faces: Float64Array;
  /** Line segments along the edges, as xyz pairs. */
  readonly edges: Float32Array;
  /** Per edge: the first vertex in `edges`, how many, and its hash. */
  readonly edgeGroups: Float64Array;
}

export function meshBody(shape: b.Shape3D): BodyMesh {
  const mesh = b.mesh(shape, {
    tolerance: 0.05,
    angularTolerance: 0.1,
    cache: false,
  });
  const lines = b.meshEdges(shape, { tolerance: 0.05, cache: false });
  return {
    positions: mesh.vertices,
    normals: mesh.normals,
    indices: mesh.triangles,
    faces: Float64Array.from(
      mesh.faceGroups.flatMap((g) => [g.start, g.count, g.faceId]),
    ),
    edges: lines.lines,
    edgeGroups: Float64Array.from(
      lines.edgeGroups.flatMap((g) => [g.start, g.count, g.edgeId]),
    ),
  };
}

/** The buffers of a body mesh, for `postMessage`'s transfer list. */
export function bodyMeshTransferables(mesh: BodyMesh): ArrayBuffer[] {
  return [
    mesh.positions,
    mesh.normals,
    mesh.indices,
    mesh.faces,
    mesh.edges,
    mesh.edgeGroups,
  ].map((array) => array.buffer as ArrayBuffer);
}
