import {
  BufferGeometry,
  Float32BufferAttribute,
  Raycaster,
  Vector2,
  Vector3,
  type Camera,
  type Mesh,
} from "three";

type Topology = {
  triangles: Vector3[][];
  normals: Vector3[];
  neighbors: number[][];
  tolerance: number;
  regions: Map<number, number[]>;
};
const topologyCache = new WeakMap<BufferGeometry, Topology>();

function topology(geometry: BufferGeometry): Topology {
  const cached = topologyCache.get(geometry);
  if (cached) return cached;
  const positions = geometry.getAttribute("position");
  const indices = geometry.getIndex();
  if (!positions) throw new Error("Surface needs positions");
  geometry.computeBoundingBox();
  const size = geometry.boundingBox!.getSize(new Vector3()).length();
  const tolerance = Math.max(1e-5, size * 1e-7);
  const triangles: Vector3[][] = [];
  const normals: Vector3[] = [];
  const neighbors: number[][] = [];
  const sharedEdges = new Map<string, number[]>();
  const vertex = (index: number) =>
    new Vector3().fromBufferAttribute(positions, index);
  const key = (point: Vector3) =>
    [point.x, point.y, point.z]
      .map((value) => Math.round(value / tolerance))
      .join(",");
  const count = Math.floor((indices?.count ?? positions.count) / 3);
  for (let triangle = 0; triangle < count; triangle++) {
    const corners = [0, 1, 2].map((corner) =>
      vertex(indices?.getX(triangle * 3 + corner) ?? triangle * 3 + corner),
    );
    triangles.push(corners);
    neighbors.push([]);
    normals.push(
      corners[1]!
        .clone()
        .sub(corners[0]!)
        .cross(corners[2]!.clone().sub(corners[0]!))
        .normalize(),
    );
    for (let edge = 0; edge < 3; edge++) {
      const pair = [key(corners[edge]!), key(corners[(edge + 1) % 3]!)]
        .sort()
        .join("|");
      const previous = sharedEdges.get(pair) ?? [];
      for (const other of previous) {
        neighbors[triangle]!.push(other);
        neighbors[other]!.push(triangle);
      }
      previous.push(triangle);
      sharedEdges.set(pair, previous);
    }
  }
  const result = {
    triangles,
    normals,
    neighbors,
    tolerance,
    regions: new Map(),
  };
  topologyCache.set(geometry, result);
  return result;
}

/** The connected coplanar patch containing the ray-hit triangle. */
export function faceRegionGeometry(
  geometry: BufferGeometry,
  faceIndex: number,
) {
  const data = topology(geometry);
  if (!data.triangles[faceIndex]) return new BufferGeometry();
  let region = data.regions.get(faceIndex);
  if (!region) {
    region = [];
    const pending = [faceIndex];
    const seen = new Set<number>();
    const normal = data.normals[faceIndex]!;
    const origin = data.triangles[faceIndex]![0]!;
    while (pending.length) {
      const index = pending.pop()!;
      if (seen.has(index)) continue;
      seen.add(index);
      if (
        data.normals[index]!.dot(normal) < 0.9999 ||
        Math.abs(data.triangles[index]![0]!.clone().sub(origin).dot(normal)) >
          data.tolerance
      )
        continue;
      region.push(index);
      pending.push(...data.neighbors[index]!);
    }
    for (const index of region) data.regions.set(index, region);
  }
  const coordinates = region.flatMap((index) =>
    data.triangles[index]!.flatMap((point) => point.toArray()),
  );
  return new BufferGeometry().setAttribute(
    "position",
    new Float32BufferAttribute(coordinates, 3),
  );
}

/** Reject points behind the nearest rendered surface at their screen position. */
export function visibleSurfacePoint(
  point: Vector3,
  camera: Camera,
  width: number,
  height: number,
  meshes: readonly Mesh[],
  nearbyHit?: Vector3,
) {
  if (!width || !height) return false;
  const projected = point.clone().project(camera);
  if (
    projected.x < -1 ||
    projected.x > 1 ||
    projected.y < -1 ||
    projected.y > 1 ||
    projected.z < -1 ||
    projected.z > 1
  )
    return false;
  const nearby = new Vector3(
    projected.x + 4 / width,
    projected.y,
    projected.z,
  ).unproject(camera);
  const tolerance = Math.max(1e-4, nearby.distanceTo(point) * 2);
  const raycaster = new Raycaster();
  raycaster.setFromCamera(new Vector2(projected.x, projected.y), camera);
  const front = raycaster.intersectObjects([...meshes], false)[0];
  if (front) return front.point.distanceTo(point) <= tolerance;
  return !!nearbyHit && nearbyHit.distanceTo(point) <= tolerance * 3;
}
