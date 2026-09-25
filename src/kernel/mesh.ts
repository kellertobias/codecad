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
