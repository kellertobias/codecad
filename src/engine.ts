import * as b from "brepjs/quick";
import { readFile } from "node:fs/promises";
import {
  Matrix4,
  Box3,
  Vector3,
  BufferGeometry,
  Float32BufferAttribute,
  EdgesGeometry,
} from "three";
import {
  Component,
  Part,
  PartInterface,
  Shape,
  descendants,
  framed,
  type Recipe,
} from "./model.js";
import { SheetPart, SheetMetalPart, BlockPart } from "./stock.js";
import type { ManufacturingDxf, TechnicalDrawing } from "./outputs.js";
import { renderDrawing } from "./drawing.js";
import { exportDxf } from "./manufacturing.js";
import { profileFace } from "./profile.js";
export interface ModelSnapshot {
  readonly root: Component;
  readonly revision: number;
}
export interface EngineCapabilities {
  readonly exactBrep: boolean;
  readonly stepImport: boolean;
  readonly stepExport: boolean;
  readonly hiddenLineProjection: boolean;
  readonly sheetMetalFolding: boolean;
  readonly sheetMetalUnfolding: "history-based";
  readonly sheetMetalReliefs: readonly string[];
  readonly engineName: string;
  readonly engineVersion: string;
}
export interface EngineDiagnostic {
  readonly severity: "info" | "warning" | "error";
  readonly code: string;
  readonly message: string;
  readonly componentPath?: string;
}
export interface MeshData {
  readonly componentPath: string;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  readonly edges: Float32Array;
  readonly matrix: number[];
  readonly color: string;
  readonly opacity: number;
  readonly reflectivity: number;
  readonly holes: readonly HoleAnchor[];
  readonly volume: number;
}
export interface HoleAnchor {
  readonly center: readonly [number, number, number];
  readonly axis: readonly [number, number, number];
  readonly diameter: number;
}
function circularCut(
  recipe: Recipe,
  matrix = new Matrix4(),
): HoleAnchor | undefined {
  if (recipe.kind === "transform")
    return circularCut(
      recipe.source,
      matrix.clone().multiply(new Matrix4().fromArray(recipe.matrix)),
    );
  if (recipe.kind !== "cylinder") return undefined;
  const center = new Vector3().applyMatrix4(matrix);
  const axis = new Vector3(0, 0, 1).transformDirection(matrix);
  return {
    center: [center.x, center.y, center.z],
    axis: [axis.x, axis.y, axis.z],
    diameter: recipe.diameter,
  };
}
export interface EvaluatedModel {
  readonly meshes: readonly MeshData[];
  readonly diagnostics: readonly EngineDiagnostic[];
  minimumDistance(
    a: Component | Shape | PartInterface,
    b: Component | Shape | PartInterface,
  ): number;
}
export interface CadEngine {
  readonly capabilities: EngineCapabilities;
  evaluate(snapshot: ModelSnapshot): Promise<EvaluatedModel>;
  renderDrawing(drawing: TechnicalDrawing): Promise<Uint8Array>;
  exportDxf(dxf: ManufacturingDxf): Promise<ReadonlyMap<string, Uint8Array>>;
  exportStep(subject: Component): Promise<Uint8Array>;
  validateSheetMetal(
    part: SheetMetalPart,
  ): Promise<readonly EngineDiagnostic[]>;
}
export class OpenCascadeEngine implements CadEngine {
  readonly capabilities: EngineCapabilities = {
    exactBrep: true,
    stepImport: true,
    stepExport: true,
    hiddenLineProjection: true,
    sheetMetalFolding: true,
    sheetMetalUnfolding: "history-based",
    sheetMetalReliefs: ["rectangular", "round"],
    engineName: "OpenCascade / occt-wasm",
    engineVersion: "5.0.0",
  };
  readonly shapes = new Map<Part, b.Shape3D>();
  readonly flatShapes = new Map<Part, b.Shape3D>();
  private owned = new Set<b.AnyShape<b.Dimension>>();
  private cache = new WeakMap<Recipe, b.Shape3D>();
  root: Component | undefined;
  own<T extends b.AnyShape<b.Dimension>>(shape: T): T {
    this.owned.add(shape);
    return shape;
  }
  dispose(): void {
    for (const s of this.owned) s[Symbol.dispose]();
    this.owned.clear();
    this.shapes.clear();
    this.flatShapes.clear();
    this.cache = new WeakMap();
  }
  transform<T extends b.AnyShape>(s: T, m: Matrix4): T {
    const e = m.elements;
    return this.own(
      b.unwrap(
        b.applyMatrix(s, {
          linear: [
            e[0]!,
            e[4]!,
            e[8]!,
            e[1]!,
            e[5]!,
            e[9]!,
            e[2]!,
            e[6]!,
            e[10]!,
          ],
          translation: [e[12]!, e[13]!, e[14]!],
        }),
      ),
    );
  }
  async recipe(r: Recipe): Promise<b.Shape3D> {
    const cached = this.cache.get(r);
    if (cached) return cached;
    let shape: b.Shape3D;
    switch (r.kind) {
      case "box":
        shape = b.box(r.width, r.depth, r.height);
        break;
      case "cylinder":
        shape = b.cylinder(r.diameter / 2, r.length, { centered: true });
        break;
      case "cone":
        shape = b.cone(r.diameter / 2, 0, r.length);
        break;
      case "extrude": {
        const face = this.own(
          r.arcTolerance
            ? profileFace(r.points, r.arcTolerance)
            : b.unwrap(b.polygon(r.points.map((p) => [p.x, p.y, 0]))),
        );
        shape = b.unwrap(b.extrude(face, r.height));
        break;
      }
      case "step": {
        const data = await readFile(r.path);
        const imported = b.unwrap(
          await b.importSTEP(new Blob([new Uint8Array(data)])),
        );
        if (!b.isShape3D(imported))
          throw new Error("Imported STEP must contain solids");
        shape = imported;
        break;
      }
      case "transform":
        shape = this.transform(
          await this.recipe(r.source),
          new Matrix4().fromArray(r.matrix),
        );
        break;
      case "cut":
        shape = b.unwrap(
          b.cut(await this.recipe(r.left), await this.recipe(r.right)),
        );
        break;
      case "union":
        shape = b.unwrap(
          b.fuse(await this.recipe(r.left), await this.recipe(r.right)),
        );
        break;
      case "offset": {
        const original = await this.recipe(r.source);
        if (!b.isSolid(original))
          throw new Error("Clearance offset currently requires a single solid");
        const valid = b.unwrap(b.validSolid(original));
        shape = b.unwrap(b.offset(valid, r.distance));
        break;
      }
      case "intersect":
        shape = b.unwrap(
          b.intersect(await this.recipe(r.left), await this.recipe(r.right)),
        );
        break;
    }
    this.own(shape);
    this.cache.set(r, shape);
    return shape;
  }
  bounds(s: b.AnyShape): Box3 {
    const vertices = b.mesh(s, { tolerance: 0.1 }).vertices;
    const bounds = new Box3();
    for (let i = 0; i < vertices.length; i += 3)
      bounds.expandByPoint(
        new Vector3(vertices[i]!, vertices[i + 1]!, vertices[i + 2]!),
      );
    return bounds;
  }
  private meshData(part: Part, solid: b.Shape3D): MeshData {
    const mesh = b.mesh(solid, {
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
    const material =
      part.drawingMaterial ??
      (part instanceof SheetPart || part instanceof BlockPart
        ? part.material
        : undefined);
    return {
      componentPath: part.path,
      positions: mesh.vertices,
      normals: mesh.normals,
      indices: mesh.triangles,
      edges,
      matrix: part.worldMatrix().toArray(),
      color: material?.options.color ?? (material ? "#c9aa78" : "#8b9da8"),
      opacity: material?.options.opacity ?? 1,
      reflectivity: material?.options.reflectivity ?? 0.08,
      holes: part.operations
        .filter(
          (operation) => operation.kind === "cut" || operation.kind === "drill",
        )
        .flatMap((operation) => {
          const anchor = circularCut(operation.recipe);
          return anchor ? [anchor] : [];
        }),
      volume: b.unwrap(b.measureVolume(solid)),
    };
  }
  /** Geometry samples from the folded shape to its developed blank. */
  async unfoldFrames(part: SheetMetalPart, count = 9): Promise<MeshData[]> {
    if (!Number.isInteger(count) || count < 2)
      throw new Error("At least two unfold frames required");
    const flat = this.flatShapes.get(part);
    if (!flat)
      throw new Error("Evaluate the sheet-metal part before animating it");
    const frames: MeshData[] = [];
    for (let i = 0; i < count; i++) {
      const fraction = 1 - i / (count - 1);
      const shape =
        fraction === 0 ? flat : await this.fold(part, flat, fraction);
      if (!b.isValid(shape))
        throw new Error(`Invalid unfold shape at frame ${i}`);
      frames.push(this.meshData(part, shape));
    }
    return frames;
  }
  async evaluate(snapshot: ModelSnapshot): Promise<EvaluatedModel> {
    this.dispose();
    this.root = snapshot.root;
    const meshes: MeshData[] = [],
      diagnostics: EngineDiagnostic[] = [];
    const parts = [snapshot.root, ...descendants(snapshot.root)].filter(
      (c): c is Part => c instanceof Part,
    );
    for (const part of parts) {
      try {
        let solid = await this.recipe(part.recipe);
        this.flatShapes.set(part, solid);
        if (part instanceof SheetMetalPart) {
          solid = await this.fold(part, solid);
        }
        if (!b.isValid(solid))
          throw new Error("Kernel produced an invalid solid");
        this.shapes.set(part, solid);
        meshes.push(this.meshData(part, solid));
      } catch (error) {
        diagnostics.push({
          severity: "error",
          code: "GEOMETRY",
          componentPath: part.path,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      meshes,
      diagnostics,
      minimumDistance: (a, c) =>
        b.unwrap(b.measureDistance(this.subject(a), this.subject(c))),
    };
  }
  subject(subject: Component | Shape | PartInterface): b.Shape3D {
    if (subject instanceof Shape) {
      const s = this.cache.get(subject.recipe);
      if (!s) throw new Error("Shape was not evaluated");
      return s;
    }
    if (subject instanceof PartInterface) {
      if (!subject.owner) throw new Error("Interface has no owner");
      return this.subject(subject.owner);
    }
    if (subject instanceof Part) {
      const s = this.shapes.get(subject);
      if (!s) throw new Error(`Part has no evaluated solid: ${subject.path}`);
      return this.transform(s, subject.worldMatrix());
    }
    return this.own(
      b.compound(
        descendants(subject)
          .filter((c): c is Part => c instanceof Part)
          .map((p) => this.subject(p)),
      ),
    );
  }
  async exportStep(subject: Component): Promise<Uint8Array> {
    return new Uint8Array(
      await b.unwrap(b.exportSTEP(this.subject(subject))).arrayBuffer(),
    );
  }
  renderDrawing(drawing: TechnicalDrawing): Promise<Uint8Array> {
    return renderDrawing(this, drawing);
  }
  exportDxf(dxf: ManufacturingDxf): Promise<ReadonlyMap<string, Uint8Array>> {
    return exportDxf(this, dxf);
  }
  async validateSheetMetal(
    part: SheetMetalPart,
  ): Promise<readonly EngineDiagnostic[]> {
    try {
      await this.fold(part, await this.recipe(part.recipe));
      return [];
    } catch (e) {
      return [
        {
          severity: "error",
          code: "SHEET_METAL",
          message: String(e),
          componentPath: part.path,
        },
      ];
    }
  }
  /** Exact cylindrical bands, including relieved partial-width flanges.
   * Unsupported pierced bands are rejected rather than silently filled in. */
  private async fold(
    part: SheetMetalPart,
    flat: b.Shape3D,
    fraction = 1,
  ): Promise<b.Shape3D> {
    let result = flat;
    for (const bend of part.bends) {
      const o = bend.options,
        t = part.material.thickness,
        BA = part.bendAllowance(bend),
        angle = ((o.angle * Math.PI) / 180) * fraction,
        R = BA / angle - part.bendRules.kFactor * t;
      let start = o.start,
        end = o.end;
      if (o.movingSide === "left") {
        start = o.end;
        end = o.start;
      }
      const len = Math.hypot(end.x - start.x, end.y - start.y),
        dx = (end.x - start.x) / len,
        dy = (end.y - start.y) / len;
      const frame = framed({
        origin: { x: start.x, y: start.y, z: 0 },
        xAxis: { x: dy, y: -dx, z: 0 },
        yAxis: { x: dx, y: dy, z: 0 },
      });
      const local = this.transform(result, frame.clone().invert()),
        bounds = this.bounds(local);
      const size = Math.max(bounds.getSize(new Vector3()).length() * 4, 1000);
      const region = (x: number, width: number) =>
        this.own(
          b.box(width, len, size * 2, {
            at: [x + width / 2, len / 2, 0],
            centered: true,
          }),
        );
      if ((bounds.min.y < -0.01 || bounds.max.y > len + 0.01) && !o.autoRelief)
        throw new Error(
          `Partial-width bend ${o.id} requires autoRelief to release its flange`,
        );
      const fixed = this.own(b.unwrap(b.cut(local, region(0, size))));
      const moving = this.own(b.unwrap(b.intersect(local, region(BA, size))));
      const band = this.own(b.unwrap(b.intersect(local, region(0, BA))));
      const expected = BA * len * t,
        actual = b.unwrap(b.measureVolume(band));
      if (Math.abs(actual - expected) > Math.max(0.01, expected * 1e-5))
        throw new Error(
          `Bend ${o.id} needs an uncut rectangular band of ${BA.toFixed(3)} mm; pierced or intersecting bend bands are not supported`,
        );
      const up = o.direction === "up",
        pivot = up ? R + t : -R,
        sign = up ? -1 : 1;
      const face = this.own(
        b.unwrap(
          b.polygon([
            [0, 0, 0],
            [0, len, 0],
            [0, len, t],
            [0, 0, t],
          ]),
        ),
      );
      const curved = this.own(
        b.unwrap(
          b.revolve(face, { axis: [0, sign, 0], at: [0, 0, pivot], angle }),
        ),
      );
      const transform = new Matrix4()
        .makeTranslation(0, 0, pivot)
        .multiply(new Matrix4().makeRotationY(sign * angle))
        .multiply(new Matrix4().makeTranslation(-BA, 0, -pivot));
      const flange = this.transform(moving, transform);
      const interference = this.own(b.unwrap(b.intersect(fixed, flange)));
      if (Math.abs(b.unwrap(b.measureVolume(interference))) > 0.01)
        throw new Error(
          `Bend ${o.id} causes flange self-intersection; adjust the profile or bend order`,
        );
      const folded = this.own(
        b.unwrap(b.fuse(this.own(b.unwrap(b.fuse(fixed, curved))), flange)),
      );
      result = this.transform(folded, frame);
    }
    return result;
  }
}
