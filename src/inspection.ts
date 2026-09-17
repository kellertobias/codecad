import { Box3, Matrix4, Vector3 } from "three";
import { Component, Part } from "./model.js";
import type { MeshData } from "./engine.js";
import { BlockPart, SheetPart } from "./stock.js";

export interface Inspection {
  kind: "part" | "assembly";
  volume: number;
  /** Local X/Y/Z for a part; world X/Y/Z for an assembly. */
  dimensions?: [number, number, number];
  material?: string;
  partCount: number;
  operations: {
    kind: string;
    toolId?: string;
    diameter?: number;
    depth?: number;
    angle?: number;
  }[];
}

export function inspectComponent(
  component: Component,
  meshes: readonly MeshData[],
): Inspection {
  const isPart = component instanceof Part;
  const relevant = meshes.filter(
    (mesh) =>
      mesh.componentPath === component.path ||
      (!isPart && mesh.componentPath.startsWith(component.path + "/")),
  );
  const bounds = new Box3();
  for (const mesh of relevant) {
    const local = new Box3().setFromArray(mesh.positions);
    if (!isPart) local.applyMatrix4(new Matrix4().fromArray(mesh.matrix));
    bounds.union(local);
  }
  const size = bounds.isEmpty() ? undefined : bounds.getSize(new Vector3());
  const material = isPart
    ? (component.drawingMaterial ??
      (component instanceof SheetPart || component instanceof BlockPart
        ? component.material
        : undefined))
    : undefined;
  return {
    kind: isPart ? "part" : "assembly",
    volume: relevant.reduce((total, mesh) => total + mesh.volume, 0),
    ...(size
      ? { dimensions: [size.x, size.y, size.z] as [number, number, number] }
      : {}),
    ...(material ? { material: material.name } : {}),
    partCount: relevant.length,
    operations: isPart
      ? component.operations.map(
          ({ kind, toolId, diameter, depth, angle }) => ({
            kind,
            ...(toolId ? { toolId } : {}),
            ...(diameter !== undefined ? { diameter } : {}),
            ...(depth !== undefined ? { depth } : {}),
            ...(angle !== undefined ? { angle } : {}),
          }),
        )
      : [],
  };
}
