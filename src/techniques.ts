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
} from "./model.js";
import { RouterBit } from "./tools.js";
import { SheetPart } from "./stock.js";
import { Vector3 } from "three";
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
export class FingerJoint extends Technique {
  /** Protected material at BOTH ends, measured against the untrimmed overlap. */
  static interval(
    length: number,
    options: { internal: boolean; edgeMargin?: number },
  ) {
    positive(length, "joint overlap");
    const requested = options.edgeMargin ?? 0;
    if (!Number.isFinite(requested) || requested < 0)
      throw new Error("Finger edge margin must be non-negative");
    const margin = Math.max(requested, options.internal ? length * 0.2 : 0);
    if (margin * 2 >= length)
      throw new Error("Finger margins leave no joint overlap");
    return { start: margin, end: length - margin };
  }
  constructor(
    readonly options: { id?: string; fingerWidth: number; clearance?: number },
  ) {
    super(options.id ?? "finger-joint");
    positive(options.fingerWidth, "finger width");
  }
  connect(o: {
    first: PartInterface;
    second: PartInterface;
    startWith?: "first" | "second";
    edgeMargin?: number;
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
    });
    const cut = (i: PartInterface, x: number, end: number) => {
      const p = owner(i),
        thickness = (p as any).material?.thickness;
      if (!thickness) throw new Error("Finger joints require sheet parts");
      p.subtract(
        new Shapes.Box({
          width: end - x,
          depth: thickness,
          height: thickness,
        }).move({ z: -thickness }),
        { relativeTo: i, x },
      );
    };
    // Trim the entering sheet at the protected ends: leaving both parts here
    // would preserve the receiving sheet but create an impossible interference.
    if (firstInternal || secondInternal) {
      const entering = firstInternal ? o.second : o.first;
      cut(entering, 0, interval.start);
      cut(entering, interval.end, w);
    }
    for (let x = interval.start, n = 0; x < interval.end; x += pitch, n++) {
      const i =
        (n % 2 === 0) === (o.startWith !== "second") ? o.first : o.second;
      cut(
        i,
        Math.max(interval.start, x - clearance / 2),
        Math.min(interval.end, x + pitch + clearance / 2),
      );
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
