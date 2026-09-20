import { Matrix4, Euler, Vector3 as V3 } from "three";
import type { Material } from "./stock.js";
import {
  InputParameters,
  defineParameters,
  resolveParameters,
  type ParameterSchema,
  type ParameterState,
  type ParameterValues,
} from "./parameters.js";
import { View2D } from "./view2d.js";
import {
  PartCorner,
  PartEdge,
  edgeQuery,
  selectionBasis,
  type DirectionName,
  type FaceDirection,
  type EdgeQuery,
  type EdgeTreatment,
  type SelectionOptions,
} from "./edges.js";

export type Length = number;
export type Angle = number;
export type Axis = "x" | "y" | "z";
export type SignedAxis = Axis | `-${Axis}`;
/** Unit world directions, for rotation axes named without a vector literal. */
export const WorldAxes = {
  X: { x: 1, y: 0, z: 0 },
  Y: { x: 0, y: 1, z: 0 },
  Z: { x: 0, y: 0, z: 1 },
} as const;
export const sharedDefinition = Symbol("CodeCAD shared definition");
export interface Point2 {
  readonly x: number;
  readonly y: number;
}
export interface Point3 extends Point2 {
  readonly z: number;
}
export interface Vector3 extends Point3 {}
export interface Placement {
  readonly x?: number;
  readonly y?: number;
  readonly z?: number;
  readonly rotate?: Partial<Record<Axis, number>>;
  readonly relativeTo?:
    "world" | "parent" | "target" | Component | PartInterface;
}
export interface MirrorOptions {
  readonly axis: Axis;
  readonly origin?: number;
}
export interface CopyOptions {
  readonly id?: string;
  readonly label?: string;
}
export interface Frame {
  readonly origin: Point3;
  readonly xAxis: Vector3;
  readonly yAxis: Vector3;
}
export type MeasurementSource = "measured" | "supplier-drawing" | "provisional";
export interface HoleFeature extends Point2 {
  readonly kind: "hole";
  readonly diameter: number;
  readonly source: MeasurementSource;
}
export interface SlotFeature extends Point2 {
  /** x/y is the lower-left of the slot bounds; length includes both round ends. */
  readonly kind: "slot";
  readonly length: number;
  readonly width: number;
  readonly axis: "x" | "y";
  readonly source: MeasurementSource;
}
export type MountingFeature = HoleFeature | SlotFeature;
export type MountingFeatures = Readonly<Record<string, MountingFeature>>;
/** Screw in the mating part: a slot locates one round hole at its centre. */
export function screwHole(feature: MountingFeature): HoleFeature {
  if (feature.kind === "hole") return { ...feature };
  positive(feature.width, "slot width");
  if (!Number.isFinite(feature.length) || feature.length < feature.width)
    throw new Error("Slot length must be at least its width");
  return {
    kind: "hole",
    x: feature.x + (feature.axis === "x" ? feature.length : feature.width) / 2,
    y: feature.y + (feature.axis === "y" ? feature.length : feature.width) / 2,
    diameter: feature.width,
    source: feature.source,
  };
}
export type Recipe =
  | { kind: "box"; width: number; depth: number; height: number }
  | { kind: "cylinder"; diameter: number; length: number }
  | { kind: "cone"; diameter: number; length: number }
  | { kind: "extrude"; points: Point2[]; height: number; arcTolerance?: number }
  | { kind: "step"; path: string }
  | { kind: "transform"; source: Recipe; matrix: number[] }
  | { kind: "cut" | "union" | "intersect"; left: Recipe; right: Recipe }
  | { kind: "offset"; source: Recipe; distance: number }
  | {
      kind: "fillet";
      source: Recipe;
      edges: EdgeQuery;
      radius: number;
      endRadius?: number;
    }
  | {
      kind: "chamfer";
      source: Recipe;
      edges: EdgeQuery;
      distance: number;
      secondDistance?: number;
    };
export function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`${name} must be positive`);
  return value;
}
export function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
  return value;
}
export function matrix(p: Placement = {}): Matrix4 {
  const d = Math.PI / 180;
  return new Matrix4()
    .makeRotationFromEuler(
      new Euler(
        finite(p.rotate?.x ?? 0, "rotation") * d,
        finite(p.rotate?.y ?? 0, "rotation") * d,
        finite(p.rotate?.z ?? 0, "rotation") * d,
        "XYZ",
      ),
    )
    .setPosition(
      finite(p.x ?? 0, "x"),
      finite(p.y ?? 0, "y"),
      finite(p.z ?? 0, "z"),
    );
}
export function framed(f?: Frame): Matrix4 {
  if (!f) return new Matrix4();
  const x = new V3(f.xAxis.x, f.xAxis.y, f.xAxis.z).normalize();
  const y = new V3(f.yAxis.x, f.yAxis.y, f.yAxis.z).normalize();
  if (Math.abs(x.dot(y)) > 1e-6 || x.length() === 0 || y.length() === 0)
    throw new Error("Interface axes must be orthonormal");
  return new Matrix4()
    .makeBasis(x, y, new V3().crossVectors(x, y))
    .setPosition(f.origin.x, f.origin.y, f.origin.z);
}
export function transformed(source: Recipe, m: Matrix4): Recipe {
  return { kind: "transform", source, matrix: m.toArray() };
}
export function reflection(o: MirrorOptions): Matrix4 {
  const n = o.origin ?? 0;
  return new Matrix4()
    .makeTranslation(
      o.axis === "x" ? n : 0,
      o.axis === "y" ? n : 0,
      o.axis === "z" ? n : 0,
    )
    .multiply(
      new Matrix4().makeScale(
        o.axis === "x" ? -1 : 1,
        o.axis === "y" ? -1 : 1,
        o.axis === "z" ? -1 : 1,
      ),
    )
    .multiply(
      new Matrix4().makeTranslation(
        o.axis === "x" ? -n : 0,
        o.axis === "y" ? -n : 0,
        o.axis === "z" ? -n : 0,
      ),
    );
}
export interface InterfaceOptions<
  F extends MountingFeatures = MountingFeatures,
> {
  readonly name?: string;
  readonly frame?: Frame;
  readonly shape?: Shape;
  readonly outline?: Shape2D;
  readonly features?: F;
  readonly defaultClearance?: number;
}
export class PartInterface<F extends MountingFeatures = MountingFeatures> {
  owner: Component | undefined;
  readonly features: F;
  readonly options: InterfaceOptions<F>;
  constructor(options: InterfaceOptions<F> = {}) {
    this.options = { ...options };
    this.features = structuredClone(options.features ?? {}) as F;
  }
  get name() {
    return this.options.name;
  }
  get frame() {
    return this.options.frame;
  }
  get outline() {
    return this.options.outline;
  }
  /** Round mating holes, preserving feature names, owner and interface frame. */
  screwHoles(): PartInterface<{ readonly [K in keyof F]: HoleFeature }> {
    const features = Object.fromEntries(
      Object.entries(this.features).map(([name, feature]) => [
        name,
        screwHole(feature),
      ]),
    ) as { readonly [K in keyof F]: HoleFeature };
    const result = new PartInterface({ ...this.options, features });
    result.owner = this.owner;
    return result;
  }
  bind(owner: Component): PartInterface<F> {
    const i = new PartInterface(this.options);
    i.owner = owner;
    return i;
  }
  worldMatrix(): Matrix4 {
    return (this.owner?.worldMatrix() ?? new Matrix4()).multiply(
      framed(this.frame),
    );
  }
  withClearance(clearance: number): PartInterface<F> {
    const i = new PartInterface({
      ...this.options,
      defaultClearance: finite(clearance, "clearance"),
    });
    i.owner = this.owner;
    return i;
  }
  select<const K extends keyof F & string>(
    ...names: readonly K[]
  ): PartInterface<Pick<F, K>> {
    const features = Object.fromEntries(
      names.map((name) => {
        if (!(name in this.features))
          throw new Error(`Unknown feature: ${name}`);
        return [name, this.features[name]];
      }),
    ) as Pick<F, K>;
    const i = new PartInterface({ ...this.options, features });
    i.owner = this.owner;
    return i;
  }
  /** The same features, with the interface frame carried into `component`'s own
   * coordinates. Use it to hand a fitting's holes on to the assembly around it,
   * or to a part that has to be machined for them. */
  relativeTo(component: Component): PartInterface<F> {
    const m = component.worldMatrix().invert().multiply(this.worldMatrix());
    const origin = new V3().applyMatrix4(m);
    const axis = (x: number, y: number, z: number) =>
      new V3(x, y, z).transformDirection(m);
    const xAxis = axis(1, 0, 0),
      yAxis = axis(0, 1, 0);
    const i = new PartInterface({
      ...this.options,
      frame: {
        origin: { x: origin.x, y: origin.y, z: origin.z },
        xAxis: { x: xAxis.x, y: xAxis.y, z: xAxis.z },
        yAxis: { x: yAxis.x, y: yAxis.y, z: yAxis.z },
      },
    });
    i.owner = component;
    return i;
  }
  recipe(): Recipe {
    const r =
      this.options.shape?.recipe ??
      (this.owner instanceof Part ? this.owner.recipe : undefined);
    if (!r)
      throw new Error(
        "Interface needs a solid for subtraction; use Groove for outlines or Drill.pattern for holes",
      );
    const c = this.options.defaultClearance ?? 0;
    return c
      ? { kind: "offset", source: structuredClone(r), distance: c }
      : structuredClone(r);
  }
}
export abstract class Shape {
  constructor(public recipe: Recipe) {}
  copy(): this {
    const c = Object.create(Object.getPrototypeOf(this)) as this;
    Object.assign(c, structuredClone(this));
    return c;
  }
  move(p: Placement): this {
    if (p.relativeTo)
      throw new Error(
        "Shape.move uses local coordinates; specify the reference on the consuming part operation",
      );
    this.recipe = transformed(this.recipe, matrix(p));
    return this;
  }
  mirror(o: MirrorOptions): this {
    this.recipe = transformed(this.recipe, reflection(o));
    return this;
  }
  interface(options: InterfaceOptions = {}): PartInterface {
    return new PartInterface({ shape: this.copy(), ...options });
  }
}
export abstract class Shape2D extends Shape {
  private arcTolerance?: number;
  /** The tolerance `fitArcs` was asked for, when it was. Consumers that can
   * carry exact arcs — the DXF writer — reconstruct them instead of the
   * sampled points. */
  get fittedArcTolerance(): number | undefined {
    return this.arcTolerance;
  }
  /** Opt in to circular-arc reconstruction for sampled curved profiles. */
  fitArcs(tolerance = 0.01): this {
    this.arcTolerance = positive(tolerance, "arc fit tolerance");
    return this;
  }
  constructor(public points: Point2[]) {
    super({ kind: "extrude", points, height: 1 });
  }
  extrude(height: number): Shape {
    return new SolidShape({
      kind: "extrude",
      points: this.points.map((p) => ({ ...p })),
      height: positive(height, "height"),
      ...(this.arcTolerance === undefined
        ? {}
        : { arcTolerance: this.arcTolerance }),
    });
  }
  override move(p: Placement): this {
    if (p.z || p.rotate?.x || p.rotate?.y || p.relativeTo)
      throw new Error("2D profiles support local XY placement only");
    const m = matrix(p);
    this.points = this.points.map((p) => {
      const v = new V3(p.x, p.y, 0).applyMatrix4(m);
      return { x: v.x, y: v.y };
    });
    this.recipe = { kind: "extrude", points: this.points, height: 1 };
    return this;
  }
  override mirror(o: MirrorOptions): this {
    const m = reflection(o);
    this.points = this.points.map((p) => {
      const v = new V3(p.x, p.y, 0).applyMatrix4(m);
      return { x: v.x, y: v.y };
    });
    this.recipe = { kind: "extrude", points: this.points, height: 1 };
    return this;
  }
}
export class SolidShape extends Shape {}
export namespace Shapes {
  export class Rectangle extends Shape2D {
    constructor(o: { width: number; height: number; center?: boolean }) {
      positive(o.width, "width");
      positive(o.height, "height");
      const x = o.center ? -o.width / 2 : 0,
        y = o.center ? -o.height / 2 : 0;
      super([
        { x, y },
        { x: x + o.width, y },
        { x: x + o.width, y: y + o.height },
        { x, y: y + o.height },
      ]);
    }
  }
  export class Circle extends Shape2D {
    constructor(o: { diameter: number; x?: number; y?: number }) {
      positive(o.diameter, "diameter");
      super(
        Array.from({ length: 128 }, (_, i) => ({
          x: (o.x ?? 0) + (Math.cos((i * Math.PI) / 64) * o.diameter) / 2,
          y: (o.y ?? 0) + (Math.sin((i * Math.PI) / 64) * o.diameter) / 2,
        })),
      );
    }
    override extrude(height: number): Shape {
      const xs = this.points.map((p) => p.x),
        ys = this.points.map((p) => p.y);
      return new Cylinder({
        diameter: Math.max(...xs) - Math.min(...xs),
        length: height,
        x: (Math.max(...xs) + Math.min(...xs)) / 2,
        y: (Math.max(...ys) + Math.min(...ys)) / 2,
        z: height / 2,
      });
    }
  }
  export class Polygon extends Shape2D {
    constructor(o: { points: readonly Point2[] }) {
      if (o.points.length < 3)
        throw new Error("A polygon needs at least three points");
      super(
        o.points.map((p) => ({ x: finite(p.x, "x"), y: finite(p.y, "y") })),
      );
    }
  }
  export class Box extends Shape {
    constructor(o: { width: number; depth: number; height: number }) {
      super({
        kind: "box",
        width: positive(o.width, "width"),
        depth: positive(o.depth, "depth"),
        height: positive(o.height, "height"),
      });
    }
  }
  /** Cylinder position is its center; Box and sheet profiles start at their minimum corner. */
  export class Cylinder extends Shape {
    constructor(o: {
      diameter: number;
      length: number;
      x?: number;
      y?: number;
      z?: number;
      axis?: SignedAxis;
    }) {
      super({
        kind: "cylinder",
        diameter: positive(o.diameter, "diameter"),
        length: positive(o.length, "length"),
      });
      const axis = o.axis ?? "z";
      const dir = new V3(
        axis.endsWith("x") ? 1 : 0,
        axis.endsWith("y") ? 1 : 0,
        axis.endsWith("z") ? 1 : 0,
      ).multiplyScalar(axis.startsWith("-") ? -1 : 1);
      // Cylinders are symmetric; exact axis rotation is selected explicitly.
      const m = axis.endsWith("x")
        ? matrix({ rotate: { y: 90 } })
        : axis.endsWith("y")
          ? matrix({ rotate: { x: 90 } })
          : new Matrix4();
      void dir;
      this.recipe = transformed(
        this.recipe,
        new Matrix4().makeTranslation(o.x ?? 0, o.y ?? 0, o.z ?? 0).multiply(m),
      );
    }
  }
  export class ImportedStep extends Shape {
    constructor(o: { path: string; unit?: "mm" }) {
      super({ kind: "step", path: o.path });
    }
  }
}

export interface ComponentOptions {
  readonly id?: string;
  readonly label?: string;
}
interface ConstructionScope {
  owner?: Component;
  detached?: boolean;
  /** Decorator metadata used when the class passes no id or label to super(). */
  defaults?: ComponentOptions | undefined;
}
const scopes: ConstructionScope[] = [];
export const interfaceMethods = new WeakMap<object, Map<string, string>>();
export function construction<T>(
  fn: () => T,
  detached = false,
  defaults?: ComponentOptions,
): T {
  scopes.push({ detached, defaults });
  try {
    return fn();
  } finally {
    scopes.pop();
  }
}
let outsideId = 0;
export abstract class Component {
  /** @internal Source provenance for Studio selection. Copied parts retain their recipe provenance. */
  sourceTraces: string[] = [new Error().stack ?? ""];
  id: string;
  label: string;
  parent: Assembly | undefined;
  protected placement: Placement = {};
  protected extraMatrix = new Matrix4();
  protected interfaces = new Map<string, PartInterface>();
  constructor(o: ComponentOptions = {}) {
    const scope = scopes.at(-1),
      parentScope = scope?.owner ? scope : scopes.at(-2);
    const parent = scope?.detached ? undefined : parentScope?.owner;
    this.parent = parent instanceof Assembly ? parent : undefined;
    const siblings = this.parent?.children ?? [];
    // The first component of a decorated class is the instance itself.
    const defaults = scope && !scope.owner ? scope.defaults : undefined;
    let id = o.id ?? defaults?.id;
    if (o.id === undefined && id !== undefined)
      for (let n = 2; siblings.some((c) => c.id === id); n++)
        id = `${defaults!.id}-${n}`;
    this.id = id ?? `part-${siblings.length + 1 || ++outsideId}`;
    this.label = o.label ?? defaults?.label ?? this.id;
    // Ids only have to tell siblings apart. They are joined with "/" into
    // paths and sanitized before they reach file names, so anything that is not
    // a path separator, a traversal segment or padded with whitespace is fine.
    if (
      !this.id.trim() ||
      this.id !== this.id.trim() ||
      /[/\\]|[\x00-\x1f]/.test(this.id) ||
      this.id === "." ||
      this.id === ".."
    )
      throw new Error(
        `Invalid component id ${JSON.stringify(this.id)}: ids must be nonempty, must not be "." or "..", and must not contain slashes or leading or trailing whitespace`,
      );
    if (siblings.some((c) => c.id === this.id))
      throw new Error(
        `Duplicate component id ${this.id}${this.parent ? ` in ${this.parent.path}` : ""}`,
      );
    if (this.parent) this.parent.children.push(this);
    if (scope && !scope.owner) scope.owner = this;
  }
  get path(): string {
    return this.parent ? `${this.parent.path}/${this.id}` : this.id;
  }
  /** The frame `placement` is expressed in: the reference, parent or world. */
  protected baseMatrix(visiting = new Set<Component>()): Matrix4 {
    if (visiting.has(this))
      throw new Error(`Circular placement reference: ${this.path}`);
    visiting.add(this);
    const ref = this.placement.relativeTo;
    let base: Matrix4;
    if (ref instanceof Component) base = ref.worldMatrix(visiting);
    else if (ref instanceof PartInterface)
      base = (ref.owner?.worldMatrix(visiting) ?? new Matrix4()).multiply(
        framed(ref.frame),
      );
    else
      base =
        ref === "world"
          ? new Matrix4()
          : (this.parent?.worldMatrix(visiting) ?? new Matrix4());
    visiting.delete(this);
    return base;
  }
  worldMatrix(visiting = new Set<Component>()): Matrix4 {
    return this.baseMatrix(visiting)
      .multiply(matrix(this.placement))
      .multiply(this.extraMatrix);
  }
  place(p: Placement): this;
  /** Translate so that a point on this component lands on a target point.
   * Both are world points; the current rotation is kept. */
  place(from: Point3 | PartCorner, to: Point3 | PartCorner): this;
  place(p: Placement | Point3 | PartCorner, to?: Point3 | PartCorner): this {
    this.sourceTraces.push(new Error().stack ?? "");
    if (to !== undefined) return this.shift(worldPoint(p), worldPoint(to));
    const old = this.placement;
    this.placement = {
      ...(p as Placement),
      rotate: { ...(p as Placement).rotate },
    };
    try {
      this.worldMatrix();
    } catch (error) {
      this.placement = old;
      throw error;
    }
    return this;
  }
  private shift(from: Point3, to: Point3): this {
    const delta = new V3(
      to.x - from.x,
      to.y - from.y,
      to.z - from.z,
    ).applyMatrix4(new Matrix4().extractRotation(this.baseMatrix()).invert());
    this.placement = {
      ...this.placement,
      x: (this.placement.x ?? 0) + delta.x,
      y: (this.placement.y ?? 0) + delta.y,
      z: (this.placement.z ?? 0) + delta.z,
    };
    return this;
  }
  /** Turn the component about a world axis. The axis is a direction through
   * `through` (the component's own origin by default), or the line `from`→`to`.
   * The world frame is read once, here; later moves of a reference do not
   * revisit it. */
  rotate(o: RotationOptions): this {
    this.sourceTraces.push(new Error().stack ?? "");
    const angle = finite(o.angle ?? o.rotation ?? NaN, "rotation angle");
    const axis =
      o.from && o.to
        ? new V3(o.to.x - o.from.x, o.to.y - o.from.y, o.to.z - o.from.z)
        : o.axis
          ? new V3(o.axis.x, o.axis.y, o.axis.z)
          : undefined;
    if (!axis) throw new Error("Rotation needs an axis, or a from/to line");
    if (axis.lengthSq() < 1e-12)
      throw new Error("Rotation axis must not be zero length");
    const through =
      o.through ?? o.from ?? new V3().setFromMatrixPosition(this.worldMatrix());
    const pivot = new V3(through.x, through.y, through.z);
    const world = new Matrix4()
      .makeTranslation(pivot.x, pivot.y, pivot.z)
      .multiply(
        new Matrix4().makeRotationAxis(
          axis.normalize(),
          (angle * Math.PI) / 180,
        ),
      )
      .multiply(new Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
    const placed = this.baseMatrix().multiply(matrix(this.placement));
    this.extraMatrix = placed
      .clone()
      .invert()
      .multiply(world)
      .multiply(placed)
      .multiply(this.extraMatrix);
    return this;
  }
  move(p: Placement): this {
    this.sourceTraces.push(new Error().stack ?? "");
    if (p.relativeTo) return this.place(p);
    this.extraMatrix.multiply(matrix(p));
    return this;
  }
  mirror(o: MirrorOptions): this {
    this.sourceTraces.push(new Error().stack ?? "");
    this.extraMatrix.multiply(reflection(o));
    return this;
  }
  /** @internal Used by interface mating to apply the inverse local frame. */
  extraMatrixForMate(m: Matrix4): void {
    this.extraMatrix = m.clone();
  }
  copy(o: CopyOptions = {}): this {
    const map = new Map<any, any>();
    const clone = (value: any): any => {
      if (value === null || typeof value !== "object") return value;
      if (map.has(value)) return map.get(value);
      if (
        value instanceof Component &&
        value !== this &&
        !value.path.startsWith(this.path + "/")
      )
        return value;
      // Materials are shared stock definitions, not component instances.
      if (value[sharedDefinition] === true) return value;
      const result =
        value instanceof Matrix4
          ? value.clone()
          : value instanceof Map
            ? new Map()
            : Array.isArray(value)
              ? []
              : Object.create(Object.getPrototypeOf(value));
      map.set(value, result);
      if (value instanceof Component && interfaceMethods.has(value))
        interfaceMethods.set(result, new Map(interfaceMethods.get(value)));
      if (value instanceof Matrix4) return result;
      if (value instanceof Map) {
        for (const [k, v] of value) result.set(k, clone(v));
        return result;
      }
      for (const key of Object.keys(value)) {
        if (key === "registry" || key === "parts" || key === "parent") continue;
        result[key] = clone(value[key]);
      }
      return result;
    };
    const c = clone(this) as this;
    const copyTrace = new Error().stack ?? "";
    for (const node of [c, ...descendants(c)]) {
      node.sourceTraces = node.sourceTraces.map((trace) =>
        trace.startsWith("snapshot\n") ? trace : "snapshot\n" + trace,
      );
      node.sourceTraces.push(copyTrace);
    }
    c.id = o.id ?? `${this.id}-copy-${(this.parent?.children.length ?? 0) + 1}`;
    c.label = o.label ?? this.label;
    c.parent = this.parent;
    if (c.parent?.children.some((p) => p.id === c.id))
      throw new Error(`Duplicate component id: ${c.id}`);
    const reparent = (node: Component) => {
      if (node instanceof Assembly)
        for (const child of node.children) {
          child.parent = node;
          reparent(child);
        }
    };
    reparent(c);
    c.parent?.children.push(c);
    return c;
  }
  /** Publish an interface on this component. An assembly can carry one too, so
   * a fitting's holes can be handed on to whatever the assembly mounts into. */
  addInterface<F extends MountingFeatures>(
    name: string,
    value: PartInterface<F>,
  ): this {
    this.interfaces.set(name, value.bind(this));
    return this;
  }
  interface(name = "default"): PartInterface {
    const method = interfaceMethods.get(this)?.get(name);
    if (method) return (this as any)[method]();
    const i = this.interfaces.get(name);
    if (i) return i.bind(this);
    if (name === "default" && this instanceof Part)
      return new PartInterface({
        shape: new SolidShape(structuredClone(this.recipe)),
      }).bind(this);
    throw new Error(`Unknown interface ${name} on ${this.path}`);
  }
}
export interface RotationOptions {
  /** A direction in world space, e.g. `WorldAxes.Z`. */
  readonly axis?: Vector3;
  /** Axis through two world points, instead of `axis`. */
  readonly from?: Point3;
  readonly to?: Point3;
  /** A world point the axis passes through. Defaults to `from`, then to the
   * component's own origin. */
  readonly through?: Point3;
  readonly angle?: number;
  /** Alias for `angle`. */
  readonly rotation?: number;
}
function worldPoint(value: Point3 | PartCorner | Placement): Point3 {
  if (value instanceof PartCorner) return value.point();
  const p = value as Point3;
  return {
    x: finite(p.x, "point x"),
    y: finite(p.y, "point y"),
    z: finite(p.z, "point z"),
  };
}
function splitSelection(selection: readonly unknown[]): {
  names: DirectionName[];
  options: SelectionOptions;
} {
  const last = selection.at(-1);
  const options =
    typeof last === "object" && last !== null ? (last as SelectionOptions) : {};
  const names = (
    typeof last === "string" ? selection : selection.slice(0, -1)
  ) as DirectionName[];
  return { names, options };
}
export type SubtractionSource = Shape | Component | PartInterface;
export interface MachiningOperation {
  kind: string;
  recipe: Recipe;
  toolId?: string;
  diameter?: number;
  depth?: number;
  angle?: number;
}
export class Part extends Component {
  recipe: Recipe;
  operations: MachiningOperation[] = [];
  /** Fillets and chamfers applied to named edges, in application order. */
  edgeTreatments: EdgeTreatment[] = [];
  /** Display material retained when homogeneous stock parts are fused. */
  drawingMaterial?: Material;
  constructor(o: ComponentOptions & { shape: Shape }) {
    super(o);
    this.recipe = structuredClone(o.shape.recipe);
  }
  operationMatrix(p: Placement = {}): Matrix4 {
    const ref = p.relativeTo;
    const basis =
      ref === "world"
        ? new Matrix4()
        : ref instanceof Component
          ? ref.worldMatrix()
          : ref instanceof PartInterface
            ? ref.worldMatrix()
            : this.worldMatrix();
    return this.worldMatrix().invert().multiply(basis).multiply(matrix(p));
  }
  subtract(source: SubtractionSource, p: Placement = {}): this {
    return this.apply("cut", source, p);
  }
  union(source: Shape | Component, p: Placement = {}): this {
    return this.apply("union", source, p);
  }
  private apply(
    kind: "cut" | "union",
    source: SubtractionSource,
    p: Placement,
  ): this {
    this.sourceTraces.push(new Error().stack ?? "");
    if (source instanceof Component)
      source.sourceTraces.push(new Error().stack ?? "");
    if (source instanceof PartInterface && source.owner)
      source.owner.sourceTraces.push(new Error().stack ?? "");
    const r =
      source instanceof Shape
        ? source.recipe
        : source instanceof PartInterface
          ? source.recipe()
          : source instanceof Part
            ? source.recipe
            : undefined;
    if (!r)
      throw new Error("Boolean sources must be solids or solid interfaces");
    const cutter = transformed(structuredClone(r), this.operationMatrix(p));
    this.recipe = { kind, left: this.recipe, right: cutter };
    this.operations.push({ kind, recipe: cutter });
    return this;
  }
  /** How a named direction maps into this part's own material coordinates.
   * The identity for solids modelled where they stand; sheet panels override
   * it so a blank is named as if it stood upright, facing the viewer. */
  materialBasis(): Matrix4 {
    return new Matrix4();
  }
  /** Extra direction names this part answers to, mapped onto the canonical
   * six. Sheet panels add the compass they are already named by elsewhere. */
  directionAliases(): Readonly<Partial<Record<string, FaceDirection>>> {
    return {};
  }
  /** The edges where the named faces meet, as a fillet/chamfer target.
   * Directions are read in the part's material frame unless
   * `{ frame: "world" }` is given. */
  getEdge(...names: DirectionName[]): PartEdge;
  getEdge(
    ...selection: [...names: DirectionName[], options: SelectionOptions]
  ): PartEdge;
  getEdge(...selection: unknown[]): PartEdge {
    const { names, options } = splitSelection(selection);
    if (names.length < 1 || names.length > 2)
      throw new Error("An edge is named by one or two face directions");
    return new PartEdge(
      this,
      edgeQuery(this, names, options),
      selectionBasis(this, options),
    );
  }
  /** A named bounding-box corner: its point, and the edges meeting there. */
  getCorner(...names: DirectionName[]): PartCorner;
  getCorner(
    ...selection: [...names: DirectionName[], options: SelectionOptions]
  ): PartCorner;
  getCorner(...selection: unknown[]): PartCorner {
    const { names, options } = splitSelection(selection);
    if (names.length !== 3)
      throw new Error("A corner is named by three face directions");
    return new PartCorner(
      this,
      edgeQuery(this, names, options),
      selectionBasis(this, options),
    );
  }
}
export class HardwarePart extends Part {
  readonly hardware: {
    manufacturer?: string;
    supplierPartNumber?: string;
    measurementStatus: MeasurementSource;
  };
  constructor(
    o: ComponentOptions & {
      shape: Shape;
      manufacturer?: string;
      supplierPartNumber?: string;
      measurementStatus: MeasurementSource;
      interfaces?: Readonly<Record<string, PartInterface>>;
    },
  ) {
    super(o);
    this.hardware = {
      measurementStatus: o.measurementStatus,
      ...(o.manufacturer ? { manufacturer: o.manufacturer } : {}),
      ...(o.supplierPartNumber
        ? { supplierPartNumber: o.supplierPartNumber }
        : {}),
    };
    for (const [name, value] of Object.entries(o.interfaces ?? {}))
      this.addInterface(name, value);
  }
}
export abstract class Assembly extends Component {
  children: Component[] = [];
  /** Fuse placed components into one generic part. Inputs are consumed by default.
   * Placement is snapshotted in this assembly's coordinates; disconnected inputs
   * may still produce multiple solid bodies. Stock and machining metadata are not merged.
   */
  joinSolids(
    sources: readonly Component[],
    options: ComponentOptions & { keepSources?: boolean } = {},
  ): Part {
    const available = new Set(descendants(this));
    if (!sources.length || sources.some((source) => !available.has(source)))
      throw new Error(
        "joinSolids requires components belonging to this assembly",
      );
    const roots = [...new Set(sources)].filter(
      (source) =>
        !sources.some(
          (other) => other !== source && descendants(other).includes(source),
        ),
    );
    const parts = [
      ...new Set(
        roots.flatMap((source) =>
          [source, ...descendants(source)].filter(
            (c): c is Part => c instanceof Part,
          ),
        ),
      ),
    ];
    if (!parts.length)
      throw new Error("joinSolids requires at least one solid part");
    if (
      parts.some(
        (part) =>
          "bends" in part && Array.isArray(part.bends) && part.bends.length,
      )
    )
      throw new Error(
        "joinSolids does not yet support folded sheet metal; its recipe describes the flat blank",
      );
    const inverse = this.worldMatrix().invert();
    const recipes = parts.map((part) =>
      transformed(
        structuredClone(part.recipe),
        inverse.clone().multiply(part.worldMatrix()),
      ),
    );
    const recipe = recipes
      .slice(1)
      .reduce<Recipe>(
        (left, right) => ({ kind: "union", left, right }),
        recipes[0]!,
      );
    let id = options.id;
    if (!id) {
      let suffix = 1;
      while (this.children.some((c) => c.id === `joined-${suffix}`)) suffix++;
      id = `joined-${suffix}`;
    }
    if (this.children.some((c) => c.id === id))
      throw new Error(`Duplicate component id: ${id}`);
    const worlds = roots.map((source) => source.worldMatrix());
    // Isolate construction from the caller's active decorator scope.
    const result = construction(
      () =>
        new Part({
          id,
          ...(options.label ? { label: options.label } : {}),
          shape: new SolidShape(recipe),
        }),
      true,
    );
    const materials = parts.map(
      (part) =>
        part.drawingMaterial ??
        ("material" in part ? (part.material as Material) : undefined),
    );
    if (
      materials[0] &&
      materials.every((material) => material === materials[0])
    )
      result.drawingMaterial = materials[0];
    result.sourceTraces.push(
      ...parts.flatMap((part) => part.sourceTraces),
      new Error().stack ?? "",
    );
    this.add(result);
    if (!options.keepSources)
      roots.forEach((source, index) => {
        source.parent!.children = source.parent!.children.filter(
          (c) => c !== source,
        );
        source.parent = undefined;
        source.place({ relativeTo: "world" });
        source.extraMatrixForMate(worlds[index]!);
      });
    return result;
  }
  protected add<T extends Component>(component: T, p?: Placement): T {
    if (component.parent !== this) {
      if (this.children.some((c) => c.id === component.id))
        throw new Error(`Duplicate component id: ${component.id}`);
      if (component.parent)
        component.parent.children = component.parent.children.filter(
          (c) => c !== component,
        );
      component.parent = this;
      this.children.push(component);
    }
    if (p) component.place(p);
    return component;
  }
  protected mate(
    moving: PartInterface,
    fixed: PartInterface,
    p: Placement = {},
  ): void {
    if (!moving.owner)
      throw new Error("Moving interface must belong to a component");
    moving.owner.place({ ...p, relativeTo: fixed });
    moving.owner.extraMatrixForMate(framed(moving.frame).invert());
  }
  protected exposeInterface(name: string, value: PartInterface): void {
    this.interfaces.set(name, value.bind(this));
  }
}
export abstract class Project extends Assembly {
  readonly registry = new ComponentRegistry(this);
  readonly parts = this.registry.parts;
  readonly view2D = new View2D();
  parameterState?: ParameterState;
  /** Resolve the active Studio values before constructing dependent geometry. */
  protected configureParameters<const S extends ParameterSchema>(
    parameters: S | InputParameters<S>,
    defaults?: Partial<ParameterValues<S>>,
  ): ParameterValues<S> {
    if (this.parameterState)
      throw new Error("Project parameters are already configured");
    const schema =
      parameters instanceof InputParameters
        ? parameters.with(defaults)
        : defaults
          ? new InputParameters(parameters).with(defaults)
          : defineParameters(parameters);
    const overrides = JSON.parse(process.env.CODECAD_PARAMETER_VALUES ?? "{}");
    const values = resolveParameters(schema, overrides);
    this.parameterState = { definitions: schema, values };
    return values;
  }
}
export type ComponentConstructor<T extends Component> = abstract new (
  ...args: any[]
) => T;
export function descendants(root: Component): Component[] {
  return root instanceof Assembly
    ? root.children.flatMap((c) => [c, ...descendants(c)])
    : [];
}
export class ComponentRegistry {
  readonly parts: PartRegistry;
  constructor(readonly root: Component) {
    this.parts = new PartRegistry(this);
  }
  get all(): readonly Component[] {
    return descendants(this.root);
  }
  get tree(): ComponentTree {
    const branch = (component: Component): ComponentTree => ({
      component,
      children:
        component instanceof Assembly ? component.children.map(branch) : [],
    });
    return branch(this.root);
  }
  get(id: string): Component | undefined {
    const matches = this.all.filter((c) => c.id === id || c.path === id);
    if (matches.length > 1)
      throw new Error(`Ambiguous id ${id}; use a full component path`);
    return matches[0];
  }
  has(id: string): boolean {
    return !!this.get(id);
  }
  require<T extends Component>(id: string, type: ComponentConstructor<T>): T {
    const c = this.get(id);
    if (!(c instanceof type))
      throw new Error(`Missing or wrong component type: ${id}`);
    return c;
  }
  find(predicate: (component: Component) => boolean): readonly Component[] {
    return this.all.filter(predicate);
  }
}
export interface ComponentTree {
  component: Component;
  children: ComponentTree[];
}
export class PartRegistry {
  constructor(private readonly registry: ComponentRegistry) {}
  /** Preserve assembly nodes while browsing parts hierarchically. */
  get tree(): ComponentTree {
    return this.registry.tree;
  }
  get all(): readonly Part[] {
    return this.registry.all.filter((c): c is Part => c instanceof Part);
  }
  get(id: string): Part | undefined {
    const p = this.registry.get(id);
    return p instanceof Part ? p : undefined;
  }
  has(id: string): boolean {
    return !!this.get(id);
  }
  require<T extends Part>(id: string, type: ComponentConstructor<T>): T {
    return this.registry.require(id, type);
  }
  byMaterial(id: string): readonly Part[] {
    return this.all.filter((p) => (p as any).material?.id === id);
  }
}
