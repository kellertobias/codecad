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
import {
  SheetPart,
  SheetMetalPart,
  BlockPart,
  MetalStockPart,
} from "./stock.js";
import type { ManufacturingDxf, TechnicalDrawing } from "./outputs.js";
import { renderDrawing } from "./drawing.js";
import { exportDxf, type ThinMaterial } from "./manufacturing.js";
import { profileFace } from "./profile.js";
import type { EdgeQuery } from "./edges.js";
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
  readonly wood?: {
    readonly direction: "width" | "height" | "none";
    readonly layers: readonly {
      readonly thickness: number;
      readonly direction: "width" | "height";
    }[];
  };
  readonly holes: readonly HoleAnchor[];
  readonly volume: number;
  /** The material's kg/m³, when it states one; weights come from it. */
  readonly density?: number;
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
  exportDxf(
    dxf: ManufacturingDxf,
    onThinMaterial?: (part: SheetPart, finding: ThinMaterial) => void,
  ): Promise<ReadonlyMap<string, Uint8Array>>;
  exportStep(subject: Component): Promise<Uint8Array>;
  validateSheetMetal(
    part: SheetMetalPart,
  ): Promise<readonly EngineDiagnostic[]>;
}
/** Edges selected by named face directions, plus the face the kernel will
 * measure an asymmetric chamfer's first distance against. */
interface SelectedEdge {
  readonly edge: b.Edge;
  /** Face index chosen for each named direction, in the order they were named. */
  readonly faces: readonly (number | undefined)[];
  /** Every face meeting at this edge. */
  readonly adjacent: readonly number[];
  /** First face containing the edge, which is the face OpenCascade pairs it with. */
  readonly reference: number;
}
function outwardNormals(faces: readonly b.Face[]): (Vector3 | undefined)[] {
  return faces.map((face) => {
    try {
      const n = b.normalAt(face);
      const v = new Vector3(n[0]!, n[1]!, n[2]!);
      return v.lengthSq() > 1e-12 ? v.normalize() : undefined;
    } catch {
      return undefined;
    }
  });
}
function selectEdges(
  solid: b.Shape3D,
  query: EdgeQuery,
  path: string,
): { faces: readonly b.Face[]; selected: SelectedEdge[] } {
  const faces = b.getFaces(solid),
    normals = outwardNormals(faces);
  const wanted = query.directions.map((d) =>
    new Vector3(d.x, d.y, d.z).normalize(),
  );
  const limit = Math.cos((query.tolerance * Math.PI) / 180);
  // Faces per edge, in the same order OpenCascade explores them.
  const byEdge = new Map<number, number[]>();
  faces.forEach((face, index) => {
    for (const edge of b.edgesOfFace(face)) {
      const hash = b.getHashCode(edge),
        list = byEdge.get(hash);
      if (!list) byEdge.set(hash, [index]);
      else if (!list.includes(index)) list.push(index);
    }
  });
  const selected: SelectedEdge[] = [];
  for (const edge of b.getEdges(solid)) {
    const adjacent = byEdge.get(b.getHashCode(edge));
    if (!adjacent?.length) continue;
    const chosen = wanted.map((direction) => {
      let best: number | undefined,
        score = limit;
      for (const index of adjacent) {
        const dot = normals[index]?.dot(direction) ?? -1;
        if (dot >= score) {
          score = dot;
          best = index;
        }
      }
      return best;
    });
    const distinct = new Set(chosen.filter((index) => index !== undefined));
    if (distinct.size < Math.min(wanted.length, 2)) continue;
    selected.push({ edge, faces: chosen, adjacent, reference: adjacent[0]! });
  }
  if (!selected.length)
    throw new Error(
      `No ${query.labels.join("/")} edge on ${path}; the named faces do not meet within ${query.tolerance}\u00b0`,
    );
  return { faces, selected };
}
/** How far a face reaches away from an edge, inside the face's own surface.
 * A blend has to land within this, which is what makes plate thickness, not
 * plan size, the limit on rounding a plate's edge. */
function faceReach(face: b.Face, edge: b.Edge): number | undefined {
  try {
    const at = b.curvePointAt(edge, 0.5),
      along = b.curveTangentAt(edge, 0.5),
      up = b.normalAt(face);
    const origin = new Vector3(at[0]!, at[1]!, at[2]!);
    const across = new Vector3(up[0]!, up[1]!, up[2]!).cross(
      new Vector3(along[0]!, along[1]!, along[2]!).normalize(),
    );
    if (across.lengthSq() < 1e-9) return undefined;
    across.normalize();
    const middle = b.faceCenter(face);
    const inward =
      Math.sign(
        new Vector3(middle[0]!, middle[1]!, middle[2]!).sub(origin).dot(across),
      ) || 1;
    let reach = 0;
    for (const vertex of b.getVertices(face)) {
      const p = b.vertexPosition(vertex);
      reach = Math.max(
        reach,
        new Vector3(p[0]!, p[1]!, p[2]!).sub(origin).dot(across) * inward,
      );
    }
    return reach > 1e-9 ? reach : undefined;
  } catch {
    return undefined;
  }
}
/** The tightest face any selected edge runs along, named where it was named. */
function narrowestFace(
  faces: readonly b.Face[],
  selected: readonly SelectedEdge[],
  query: EdgeQuery,
): { reach: number; label: string } | undefined {
  let tightest: { reach: number; label: string } | undefined;
  for (const edge of selected)
    for (const index of edge.adjacent) {
      const reach = faceReach(faces[index]!, edge.edge);
      if (reach === undefined || (tightest && reach >= tightest.reach))
        continue;
      const named = edge.faces.indexOf(index);
      tightest = {
        reach,
        label:
          named >= 0 ? `${query.labels[named]} face` : "face across the edge",
      };
    }
  return tightest;
}
/** Unequal setbacks as the kernel takes them: a distance measured on the face
 * it pairs the edge with, plus the angle that produces the other setback.
 * (The `[d1, d2]` pair form of `chamfer` silently applies `d1` to both sides.) */
function chamferSetback(
  selected: readonly SelectedEdge[],
  first: number,
  second: number,
  query: EdgeQuery,
  path: string,
): { distance: number; angle: number } {
  const named = query.labels.join("/");
  const variants = new Map<string, { distance: number; angle: number }>();
  for (const { faces, reference } of selected) {
    const onFirstFace = reference === faces[0];
    if (!onFirstFace && reference !== faces[1])
      throw new Error(
        `Chamfer on the ${named} edge of ${path} cannot tell its two faces apart; use a single distance`,
      );
    const distance = onFirstFace ? first : second,
      other = onFirstFace ? second : first;
    const value = {
      distance,
      angle: (Math.atan2(other, distance) * 180) / Math.PI,
    };
    variants.set(`${value.distance}/${value.angle}`, value);
  }
  if (variants.size > 1)
    throw new Error(
      `The ${named} selection on ${path} matched edges the kernel measures from opposite faces; chamfer them in separate getEdge calls, or use one distance`,
    );
  return [...variants.values()][0]!;
}
/** A tapered round varies along one edge, so its selection must name one. */
function single(edges: readonly b.Edge[], named: string, path: string): b.Edge {
  if (edges.length !== 1)
    throw new Error(
      `A tapered fillet rounds one edge at a time; ${named} on ${path} matched ${edges.length}`,
    );
  return edges[0]!;
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
  /** Part being evaluated, so edge-selection failures name their component. */
  private currentPath: string | undefined;
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
      case "fillet":
      case "chamfer": {
        const source = await this.recipe(r.source);
        // A cut or fused body is still one solid, but no longer typed as one.
        const bodies = b.isSolid(source) ? [source] : b.getSolids(source);
        const path = this.currentPath ?? "part";
        if (bodies.length !== 1)
          throw new Error(
            `A ${r.kind} needs one solid body; ${path} evaluates to ${bodies.length}. Fuse the bodies before rounding their edges`,
          );
        const solid = b.unwrap(b.validSolid(bodies[0]!));
        const { faces, selected } = selectEdges(solid, r.edges, path);
        const edges = selected.map((s) => s.edge);
        const named = r.edges.labels.join("/");
        try {
          if (r.kind === "fillet")
            shape =
              r.endRadius === undefined
                ? b.unwrap(b.fillet(solid, edges, r.radius))
                : b.unwrap(
                    b.variableFillet(solid, single(edges, named, path), [
                      { param: 0, radius: r.radius },
                      { param: 1, radius: r.endRadius },
                    ]),
                  );
          else
            shape = b.unwrap(
              b.chamfer(
                solid,
                edges,
                r.secondDistance === undefined
                  ? r.distance
                  : chamferSetback(
                      selected,
                      r.distance,
                      r.secondDistance,
                      r.edges,
                      path,
                    ),
              ),
            );
        } catch (error) {
          const size = r.kind === "fillet" ? r.radius : r.distance;
          const tight = narrowestFace(faces, selected, r.edges);
          throw new Error(
            `${r.kind === "fillet" ? `Fillet R${size}` : `Chamfer ${size}`} on the ${named} ${
              edges.length === 1 ? "edge" : `edges (${edges.length} selected)`
            } of ${path} was refused by the kernel. ${
              tight && size >= tight.reach
                ? `A blend has to land inside the faces it joins, and the ${tight.label} is only ${Number(tight.reach.toFixed(3))} mm across here, so stay below that. The part's overall size does not set this limit.`
                : "A radius or setback larger than an adjacent face, or edges that already run into another blend, are the usual causes."
            } Kernel: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        break;
      }
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
      (part instanceof SheetPart ||
      part instanceof BlockPart ||
      part instanceof MetalStockPart
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
      ...(part instanceof SheetPart &&
      (part.material.options.grain || part.material.options.layers)
        ? {
            wood: {
              direction:
                part.grain === "none"
                  ? (part.material.options.grain ?? "none")
                  : part.grain,
              layers: (part.material.options.layers ?? []).map((layer) => ({
                thickness: layer.thickness,
                direction: layer.direction,
              })),
            },
          }
        : {}),
      holes: part.operations
        .filter(
          (operation) => operation.kind === "cut" || operation.kind === "drill",
        )
        .flatMap((operation) => {
          const anchor = circularCut(operation.recipe);
          return anchor ? [anchor] : [];
        }),
      volume: b.unwrap(b.measureVolume(solid)),
      ...(material?.options.densityKgPerM3 === undefined
        ? {}
        : { density: material.options.densityKgPerM3 }),
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
        this.currentPath = part.path;
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
      } finally {
        this.currentPath = undefined;
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
  exportDxf(
    dxf: ManufacturingDxf,
    onThinMaterial?: (part: SheetPart, finding: ThinMaterial) => void,
  ): Promise<ReadonlyMap<string, Uint8Array>> {
    return exportDxf(this, dxf, onThinMaterial);
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
