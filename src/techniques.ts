import {
  Part,
  PartInterface,
  Shape,
  Shape2D,
  Shapes,
  SolidShape,
  positive,
  framed,
  type Placement,
  type Point3,
} from "./model.js";
import { RouterBit } from "./tools.js";
import { SheetPart } from "./stock.js";
import { Box3, Matrix4, Vector3 } from "three";
export abstract class Technique {
  constructor(readonly id: string) {}
}
export class Groove extends Technique {
  constructor(readonly options: { id?: string; toolDiameter?: number } = {}) {
    super(options.id ?? "groove");
  }
  cut(o: {
    target: Part;
    profile: Shape | PartInterface;
    placement?: Placement;
    depth: number;
    clearance?: number;
  }): Part {
    const profile =
      o.profile instanceof PartInterface ? o.profile.outline : o.profile;
    if (!(profile instanceof Shape2D))
      throw new Error("Groove needs an explicit 2D outline");
    return new RouterBit({ diameter: this.options.toolDiameter ?? 6 }).pocket(
      o.target,
      profile,
      {
        depth: o.depth,
        ...(o.placement ? { placement: o.placement } : {}),
        allowance:
          o.clearance ??
          (o.profile instanceof PartInterface
            ? (o.profile.options.defaultClearance ?? 0)
            : 0),
      },
    );
  }
}
function owner(i: PartInterface): Part {
  if (!(i.owner instanceof Part))
    throw new Error("Joinery requires interfaces bound to manufactured parts");
  return i.owner;
}
function width(i: PartInterface): number {
  const p = i.outline?.points;
  if (!p) throw new Error("Joinery requires a 2D edge outline");
  return Math.max(...p.map((p) => p.x)) - Math.min(...p.map((p) => p.x));
}
export class DominoJoint extends Technique {
  constructor(
    readonly options: {
      id?: string;
      width: number;
      thickness: number;
      depthPerSide: number;
    },
  ) {
    super(options.id ?? "domino");
    positive(options.width, "width");
    positive(options.thickness, "thickness");
    positive(options.depthPerSide, "depth");
  }
  /** The loose connector spans both matching mortises about their contact plane. */
  connectorShape(): SolidShape {
    const radius = this.options.thickness / 2;
    const straight = this.options.width - this.options.thickness;
    const depth = this.options.depthPerSide * 2;
    const middle = new Shapes.Box({
      width: straight,
      depth: this.options.thickness,
      height: depth,
    }).move({ x: -straight / 2, y: -radius, z: -depth / 2 });
    const left = new Shapes.Cylinder({
      diameter: this.options.thickness,
      length: depth,
      x: -straight / 2,
    });
    const right = new Shapes.Cylinder({
      diameter: this.options.thickness,
      length: depth,
      x: straight / 2,
    });
    return new SolidShape({
      kind: "union",
      left: { kind: "union", left: middle.recipe, right: left.recipe },
      right: right.recipe,
    });
  }
  connect(o: {
    first: PartInterface;
    second: PartInterface;
    count: number;
    edgeOffset?: number;
    distribution?: "equal" | { spacing: number };
  }): readonly number[] {
    if (!Number.isInteger(o.count) || o.count < 1)
      throw new Error("Domino count must be positive");
    const w = Math.min(width(o.first), width(o.second)),
      edge = o.edgeOffset ?? this.options.width;
    if (!Number.isFinite(edge) || edge < 0)
      throw new Error("Domino edge offset must be non-negative");
    if (w < 2 * edge)
      throw new Error("Domino edge offset exceeds joint length");
    if (this.options.width <= this.options.thickness)
      throw new Error("Domino width must exceed its thickness");
    if (
      o.distribution &&
      typeof o.distribution === "object" &&
      (!Number.isFinite(o.distribution.spacing) || o.distribution.spacing <= 0)
    )
      throw new Error("Domino spacing must be positive");
    const positions = Array.from({ length: o.count }, (_, n) =>
      o.distribution && typeof o.distribution === "object"
        ? edge + n * o.distribution.spacing
        : o.count === 1
          ? w / 2
          : edge + (n * (w - 2 * edge)) / (o.count - 1),
    );
    if (
      positions.some(
        (x) => x - this.options.width / 2 < 0 || x + this.options.width / 2 > w,
      )
    )
      throw new Error("Domino spacing exceeds joint length");
    for (const x of positions) {
      for (const i of [o.first, o.second]) {
        const d = this.options.depthPerSide;
        const radius = this.options.thickness / 2,
          straight = this.options.width - this.options.thickness;
        const middle = new Shapes.Box({
          width: straight,
          depth: radius * 2,
          height: d,
        }).move({ x: -straight / 2, y: -radius, z: -d });
        const a = new Shapes.Cylinder({
          diameter: radius * 2,
          length: d,
          x: -straight / 2,
          z: -d / 2,
        });
        const c = new Shapes.Cylinder({
          diameter: radius * 2,
          length: d,
          x: straight / 2,
          z: -d / 2,
        });
        owner(i).subtract(
          new SolidShape({
            kind: "union",
            left: { kind: "union", left: middle.recipe, right: a.recipe },
            right: c.recipe,
          }),
          { relativeTo: i, x },
        );
        Object.assign(owner(i).operations.at(-1)!, {
          kind: "domino",
          depth: d,
        });
      }
    }
    return positions;
  }
}
/** A sheet panel reduced to what a joint needs: its blank extent, its
 * thickness, and how its own axes lie in the world. */
interface PanelPlacement {
  readonly part: SheetPart;
  readonly matrix: Matrix4;
  readonly inverse: Matrix4;
  readonly thickness: number;
  readonly min: { x: number; y: number };
  readonly max: { x: number; y: number };
  /** World axis index (0/1/2) each local axis runs along. */
  readonly axisOf: { x: number; y: number; z: number };
  readonly box: Box3;
}
function panelPlacement(part: SheetPart): PanelPlacement {
  const matrix = part.worldMatrix();
  const axisOf = (local: Vector3) => {
    const world = local.clone().transformDirection(matrix);
    const size = [Math.abs(world.x), Math.abs(world.y), Math.abs(world.z)];
    const axis = size.indexOf(Math.max(...size));
    if (size.reduce((sum, c) => sum + c, 0) - size[axis]! > 1e-6)
      throw new Error(
        `Automatic finger joints need panels square to the world axes; ${part.path} is not`,
      );
    return axis;
  };
  const points = part.manufacturingOutline.points;
  const min = {
    x: Math.min(...points.map((p) => p.x)),
    y: Math.min(...points.map((p) => p.y)),
  };
  const max = {
    x: Math.max(...points.map((p) => p.x)),
    y: Math.max(...points.map((p) => p.y)),
  };
  const thickness = part.material.thickness;
  const box = new Box3();
  for (const x of [min.x, max.x])
    for (const y of [min.y, max.y])
      for (const z of [0, thickness])
        box.expandByPoint(new Vector3(x, y, z).applyMatrix4(matrix));
  return {
    part,
    matrix,
    inverse: matrix.clone().invert(),
    thickness,
    min,
    max,
    axisOf: {
      x: axisOf(new Vector3(1, 0, 0)),
      y: axisOf(new Vector3(0, 1, 0)),
      z: axisOf(new Vector3(0, 0, 1)),
    },
    box,
  };
}
const span = (box: Box3, axis: number): [number, number] =>
  axis === 0
    ? [box.min.x, box.max.x]
    : axis === 1
      ? [box.min.y, box.max.y]
      : [box.min.z, box.max.z];
/** The mating frame on one panel: x runs along the joint in the same world
 * direction for both partners, so their alternating cuts interlock; y points
 * into the material the joint removes; and z is chosen so a cut of one
 * thickness passes right through the panel. */
function jointInterface(
  panel: PanelPlacement,
  other: PanelPlacement,
  runAxis: number,
  runFrom: number,
  length: number,
  receiving: boolean,
): PartInterface {
  const runLocal = panel.axisOf.x === runAxis ? "x" : "y";
  const crossLocal = runLocal === "x" ? "y" : "x";
  const crossAxis = panel.axisOf[crossLocal];
  const centre = panel.box.getCenter(new Vector3());
  const localAt = (axis: number, value: number) => {
    const world = centre.clone();
    world.setComponent(axis, value);
    return world.applyMatrix4(panel.inverse);
  };
  const crossAt = (value: number) => localAt(crossAxis, value)[crossLocal];
  const [otherFrom, otherTo] = span(other.box, crossAxis);
  const guest = [crossAt(otherFrom), crossAt(otherTo)].sort((a, b) => a - b);
  // Receiving panels are slotted where the other panel crosses them; entering
  // panels are fingered from their own edge nearest it.
  let start: number;
  let inward: number;
  if (receiving) {
    start = guest[0]!;
    inward = 1;
  } else {
    const middle = (guest[0]! + guest[1]!) / 2;
    const low = panel.min[crossLocal],
      high = panel.max[crossLocal];
    const atLow = Math.abs(middle - low) <= Math.abs(middle - high);
    start = atLow ? low : high;
    inward = atLow ? 1 : -1;
  }
  const axisVector = (local: "x" | "y", sign: number) =>
    local === "x" ? { x: sign, y: 0, z: 0 } : { x: 0, y: sign, z: 0 };
  const yAxis = axisVector(crossLocal, inward);
  // Both partners must measure the joint from the same end, so x always runs
  // toward increasing world coordinate on the shared axis.
  const forward = Math.sign(
    new Vector3(runLocal === "x" ? 1 : 0, runLocal === "y" ? 1 : 0, 0)
      .transformDirection(panel.matrix)
      .getComponent(runAxis),
  );
  const xAxis = axisVector(runLocal, forward || 1);
  // framed() takes z as x cross y, and the cut reaches one thickness along -z,
  // so the origin sits on whichever face that points away from.
  const towardFront =
    new Vector3(xAxis.x, xAxis.y, xAxis.z).cross(
      new Vector3(yAxis.x, yAxis.y, yAxis.z),
    ).z > 0;
  const origin = {
    [runLocal]: localAt(runAxis, runFrom)[runLocal],
    [crossLocal]: start,
    z: towardFront ? panel.thickness : 0,
  } as unknown as Point3;
  return new PartInterface({
    name: `finger-${panel.part.id}`,
    frame: { origin, xAxis, yAxis },
    outline: new Shapes.Rectangle({
      width: length,
      height: panel.thickness,
    }),
  }).bind(panel.part);
}
/** Perpendicular panels whose blanks overlap on every axis share a joint. */
function meeting(first: SheetPart, second: SheetPart): boolean {
  const a = panelPlacement(first),
    b = panelPlacement(second);
  if (a.axisOf.z === b.axisOf.z) return false;
  return [0, 1, 2].every((axis) => {
    const [a0, a1] = span(a.box, axis),
      [b0, b1] = span(b.box, axis);
    return Math.min(a1, b1) - Math.max(a0, b0) > 1e-6;
  });
}
export interface AutomaticFingerOptions {
  readonly id?: string;
  readonly fingerWidth: number;
  readonly clearance?: number;
  /** Material kept at both ends of an internal joint, where one panel is
   * slotted through another's face. Corner joints finger the whole overlap. */
  readonly edgeMargin?: number;
  readonly startWith?: "first" | "second";
  /** Material the receiving panel keeps between the slots of an internal
   * joint. Fingers stay `fingerWidth` wide; the stretches between them grow to
   * this, so a sheet slotted through its middle is not left as narrow webs.
   * Corner joints alternate evenly and ignore it. */
  readonly minimumWeb?: number;
  /** Keep exactly this much material at both ends of an internal joint,
   * instead of the automatic fifth of the overlap: the receiving panel is left
   * uncut within that distance of its edges. Zero fingers right out to the
   * ends, so the entering panel shows at the receiving panel's edge. */
  readonly exactEdgeMargin?: number;
  /** Other panels meeting these two. Where three panels claim the same corner
   * only one can fill it, so the other two are cleared there instead of being
   * fingered — otherwise both joints cut the corner and it falls out. */
  readonly context?: readonly SheetPart[];
}
export class FingerJoint extends Technique {
  /** Protected material at BOTH ends, measured against the untrimmed overlap. */
  static interval(
    length: number,
    options: {
      internal: boolean;
      edgeMargin?: number;
      exactEdgeMargin?: number;
    },
  ) {
    positive(length, "joint overlap");
    const requested = options.exactEdgeMargin ?? options.edgeMargin ?? 0;
    if (!Number.isFinite(requested) || requested < 0)
      throw new Error("Finger edge margin must be non-negative");
    // An internal joint keeps a fifth of the overlap at each end, so the
    // receiving panel is not left hanging on its edges — unless the caller
    // states the margin exactly.
    const margin =
      options.exactEdgeMargin !== undefined
        ? requested
        : Math.max(requested, options.internal ? length * 0.2 : 0);
    if (margin * 2 >= length)
      throw new Error("Finger margins leave no joint overlap");
    return { start: margin, end: length - margin };
  }
  readonly options: {
    id?: string;
    fingerWidth: number;
    clearance?: number;
    minimumWeb?: number;
  };
  constructor(options: {
    id?: string;
    fingerWidth: number;
    clearance?: number;
    minimumWeb?: number;
  });
  /** Cut the joint straight away between two panels that already intersect,
   * working out which edges meet and which panel receives the other. */
  constructor(
    first: SheetPart,
    second: SheetPart,
    options: AutomaticFingerOptions,
  );
  constructor(
    first:
      | {
          id?: string;
          fingerWidth: number;
          clearance?: number;
          minimumWeb?: number;
        }
      | SheetPart,
    second?: SheetPart,
    third?: AutomaticFingerOptions,
  ) {
    const options = first instanceof SheetPart ? third! : first;
    super(options.id ?? "finger-joint");
    this.options = options;
    positive(options.fingerWidth, "finger width");
    if (first instanceof SheetPart) this.join(first, second!, third!);
  }
  /** Which panels of a set actually meet, as index pairs. */
  static intersecting(
    panels: readonly SheetPart[],
  ): readonly (readonly [SheetPart, SheetPart])[] {
    const pairs: (readonly [SheetPart, SheetPart])[] = [];
    for (const [index, first] of panels.entries())
      for (const second of panels.slice(index + 1))
        if (meeting(first, second)) pairs.push([first, second]);
    return pairs;
  }
  /** Finger every intersecting pair in a carcass in one call. */
  static joinAll(
    panels: readonly SheetPart[],
    options: AutomaticFingerOptions,
  ): number {
    const pairs = FingerJoint.intersecting(panels);
    // Every joint sees the whole carcass, so shared corners resolve the same
    // way whichever pair is being cut.
    for (const [first, second] of pairs)
      new FingerJoint(first, second, { context: panels, ...options });
    return pairs.length;
  }
  /** Derive both mating frames from where the panels actually overlap. */
  private join(
    first: SheetPart,
    second: SheetPart,
    options: AutomaticFingerOptions,
  ): void {
    const a = panelPlacement(first),
      b = panelPlacement(second);
    if (a.axisOf.z === b.axisOf.z)
      throw new Error(
        `${first.path} and ${second.path} are parallel; a finger joint needs panels that meet at an angle`,
      );
    for (const axis of [0, 1, 2]) {
      const [a0, a1] = span(a.box, axis),
        [b0, b1] = span(b.box, axis);
      if (Math.min(a1, b1) - Math.max(a0, b0) <= 1e-6)
        throw new Error(
          `${first.path} and ${second.path} do not overlap, so they share no joint`,
        );
    }
    const runAxis = [0, 1, 2].find(
      (axis) => axis !== a.axisOf.z && axis !== b.axisOf.z,
    )!;
    const [a0, a1] = span(a.box, runAxis),
      [b0, b1] = span(b.box, runAxis);
    const inside = (host: PanelPlacement, guest: PanelPlacement) => {
      const axis = guest.axisOf.z;
      const [h0, h1] = span(host.box, axis),
        [g0, g1] = span(guest.box, axis);
      return g0 > h0 + 1e-6 && g1 < h1 - 1e-6;
    };
    // A panel receives the other when that other's slab lands in its middle.
    const aReceives = inside(a, b),
      bReceives = inside(b, a);
    if (aReceives && bReceives)
      throw new Error(
        `${first.path} and ${second.path} cross each other; that is a half-lap, not a finger joint`,
      );
    const from = Math.max(a0, b0),
      to = Math.min(a1, b1);
    // A third panel square to both of these stands across their joint. The
    // corner it shares belongs to exactly one of the three; the rule picks the
    // same winner from every joint's point of view, so the corner ends up
    // filled once rather than cut twice.
    const reserved = (options.context ?? [])
      .filter(
        (panel) =>
          panel !== first &&
          panel !== second &&
          meeting(panel, first) &&
          meeting(panel, second),
      )
      .flatMap((panel) => {
        const c = panelPlacement(panel);
        if (c.axisOf.z !== runAxis) return [];
        const [c0, c1] = span(c.box, runAxis);
        const claim = {
          from: Math.max(from, c0) - from,
          to: Math.min(to, c1) - from,
        };
        if (claim.to - claim.from <= 1e-6) return [];
        const owner = [
          [a, "first"],
          [b, "second"],
          [c, undefined],
        ].reduce((best, entry) =>
          (entry[0] as PanelPlacement).axisOf.z <
          (best[0] as PanelPlacement).axisOf.z
            ? entry
            : best,
        );
        return [
          {
            ...claim,
            ...(owner[1] ? { keep: owner[1] as "first" | "second" } : {}),
          },
        ];
      });
    this.connect({
      ...(reserved.length ? { reserved } : {}),
      first: jointInterface(a, b, runAxis, from, to - from, aReceives),
      second: jointInterface(b, a, runAxis, from, to - from, bReceives),
      ...(options.startWith ? { startWith: options.startWith } : {}),
      // Like `edgeMargin`, a stated margin is only meaningful where one panel
      // receives the other: a corner joint has to finger the whole overlap.
      ...(options.exactEdgeMargin !== undefined && (aReceives || bReceives)
        ? { exactEdgeMargin: options.exactEdgeMargin }
        : {}),
      // A corner joint has to finger the whole overlap: material left at both
      // ends of both panels would simply collide. Only the internal case has
      // a receiving panel whose edges are worth protecting.
      edgeMargin: aReceives || bReceives ? (options.edgeMargin ?? 0) : 0,
    });
  }
  connect(o: {
    first: PartInterface;
    second: PartInterface;
    startWith?: "first" | "second";
    edgeMargin?: number;
    /** Keep exactly this much at both ends of an internal joint. */
    exactEdgeMargin?: number;
    /** Stretches of the joint a third panel also claims. No fingers are cut
     * there; instead every partner except `keep` is cleared, so exactly one
     * panel fills the corner. */
    reserved?: readonly {
      from: number;
      to: number;
      keep?: "first" | "second";
    }[];
  }): void {
    const w = Math.min(width(o.first), width(o.second)),
      pitch = this.options.fingerWidth,
      clearance = this.options.clearance ?? 0;
    if (!Number.isFinite(clearance) || clearance < 0)
      throw new Error("Finger clearance must be non-negative");
    const internal = (i: PartInterface) => {
      const p = owner(i);
      if (!(p instanceof SheetPart))
        throw new Error("Finger joints require sheet parts");
      const points = p.manufacturingOutline.points;
      const inside = (y: number) => {
        const q = new Vector3(w / 2, y, 0).applyMatrix4(framed(i.frame));
        let contained = false;
        for (let n = 0, j = points.length - 1; n < points.length; j = n++) {
          const a = points[j]!,
            c = points[n]!;
          const dx = c.x - a.x,
            dy = c.y - a.y;
          const t = Math.max(
            0,
            Math.min(
              1,
              ((q.x - a.x) * dx + (q.y - a.y) * dy) / (dx * dx + dy * dy || 1),
            ),
          );
          if (Math.hypot(q.x - a.x - t * dx, q.y - a.y - t * dy) < 1e-6)
            return false;
          if (
            a.y > q.y !== c.y > q.y &&
            q.x < ((c.x - a.x) * (q.y - a.y)) / (c.y - a.y) + a.x
          )
            contained = !contained;
        }
        return contained;
      };
      return inside(0) && inside(p.material.thickness);
    };
    const firstInternal = internal(o.first),
      secondInternal = internal(o.second);
    if (firstInternal && secondInternal)
      throw new Error(
        "Internal finger joint needs one receiving face and one entering edge",
      );
    const interval = FingerJoint.interval(w, {
      internal: firstInternal || secondInternal,
      ...(o.edgeMargin !== undefined ? { edgeMargin: o.edgeMargin } : {}),
      ...(o.exactEdgeMargin !== undefined
        ? { exactEdgeMargin: o.exactEdgeMargin }
        : {}),
    });
    const cut = (i: PartInterface, x: number, end: number) => {
      const p = owner(i),
        thickness = (p as any).material?.thickness;
      if (!thickness) throw new Error("Finger joints require sheet parts");
      // The cut runs through this panel, and reaches as far into it as the
      // mating panel is thick.
      const mating =
        (owner(i === o.first ? o.second : o.first) as any).material
          ?.thickness ?? thickness;
      p.subtract(
        new Shapes.Box({
          width: end - x,
          depth: mating,
          height: thickness,
        }).move({ z: -thickness }),
        { relativeTo: i, x },
      );
    };
    // Trim the entering sheet at the protected ends: leaving both parts here
    // would preserve the receiving sheet but create an impossible interference.
    if (firstInternal || secondInternal) {
      const entering = firstInternal ? o.second : o.first;
      // A joint that reaches the ends protects nothing, so there is nothing to
      // trim there either.
      if (interval.start > 1e-6) cut(entering, 0, interval.start);
      if (w - interval.end > 1e-6) cut(entering, interval.end, w);
    }
    // Corner claims first, so the fingers can skip what they cover.
    const claims = (o.reserved ?? [])
      .map((claim) => ({
        ...claim,
        from: Math.max(interval.start, claim.from),
        to: Math.min(interval.end, claim.to),
      }))
      .filter((claim) => claim.to - claim.from > 1e-6)
      .sort((a, c) => a.from - c.from);
    for (const claim of claims) {
      const from = Math.max(interval.start, claim.from - clearance / 2),
        to = Math.min(interval.end, claim.to + clearance / 2);
      if (claim.keep !== "first") cut(o.first, from, to);
      if (claim.keep !== "second") cut(o.second, from, to);
    }
    // Finger the stretches the corners left over, alternating right across
    // them so the two panels keep interlocking either side of a corner.
    const runs: { start: number; end: number }[] = [];
    let open = interval.start;
    for (const claim of claims) {
      if (claim.from > open + 1e-6) runs.push({ start: open, end: claim.from });
      open = Math.max(open, claim.to);
    }
    if (interval.end > open + 1e-6)
      runs.push({ start: open, end: interval.end });
    // A slot through a face can be spaced out: the receiving panel keeps wider
    // stretches between slots while the fingers stay their own width. A corner
    // joint has no receiving panel, so it alternates evenly.
    const receiving = firstInternal
      ? o.first
      : secondInternal
        ? o.second
        : undefined;
    const web = Math.max(pitch, this.options.minimumWeb ?? 0);
    let n = 0;
    for (const run of runs) {
      let x = run.start;
      while (x < run.end - 1e-6) {
        const i =
          (n % 2 === 0) === (o.startWith !== "second") ? o.first : o.second;
        const span = receiving && i !== receiving ? web : pitch;
        const end = Math.min(run.end, x + span);
        cut(
          i,
          Math.max(run.start, x - clearance / 2),
          Math.min(run.end, end + clearance / 2),
        );
        x = end;
        n++;
      }
    }
  }
}
export class MiterJoint extends Technique {
  constructor(
    readonly options: { id?: string; angle?: number; gap?: number } = {},
  ) {
    super(options.id ?? "miter");
  }
  connect(o: { first: PartInterface; second: PartInterface }): void {
    const angle = this.options.angle ?? 45;
    if (!(angle > 0 && angle < 90))
      throw new Error("Miter angle must be between 0 and 90");
    for (const i of [o.first, o.second]) {
      const p = owner(i),
        t = (p as any).material?.thickness;
      if (!t) throw new Error("Miter requires sheet material");
      const run = t / Math.tan((angle * Math.PI) / 180),
        w = width(i);
      // Wedge extruded along the interface's X direction.
      const wedge = new Shapes.Polygon({
        points: [
          { x: 0, y: 0 },
          { x: run, y: 0 },
          { x: 0, y: t },
        ],
      }).extrude(w);
      const r = framed({
        origin: { x: 0, y: 0, z: -t },
        xAxis: { x: 0, y: 1, z: 0 },
        yAxis: { x: 0, y: 0, z: 1 },
      });
      p.subtract(
        new SolidShape({
          kind: "transform",
          source: wedge.recipe,
          matrix: r.toArray(),
        }),
        { relativeTo: i, y: this.options.gap ?? 0 },
      );
      Object.assign(p.operations.at(-1)!, { kind: "miter", angle });
    }
  }
}
