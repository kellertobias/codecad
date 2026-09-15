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
  connect(o: {
    first: PartInterface;
    second: PartInterface;
    count: number;
    edgeOffset?: number;
    distribution?: "equal" | { spacing: number };
  }): void {
    if (!Number.isInteger(o.count) || o.count < 1)
      throw new Error("Domino count must be positive");
    const w = Math.min(width(o.first), width(o.second)),
      edge = o.edgeOffset ?? this.options.width;
    if (w < 2 * edge)
      throw new Error("Domino edge offset exceeds joint length");
    for (let n = 0; n < o.count; n++) {
      const x =
        o.distribution && typeof o.distribution === "object"
          ? edge + n * o.distribution.spacing
          : o.count === 1
            ? w / 2
            : edge + (n * (w - 2 * edge)) / (o.count - 1);
      if (x + this.options.width / 2 > w)
        throw new Error("Domino spacing exceeds joint length");
      for (const i of [o.first, o.second]) {
        const d = this.options.depthPerSide;
        const radius = this.options.thickness / 2,
          straight = this.options.width - this.options.thickness;
        if (straight <= 0)
          throw new Error("Domino width must exceed its thickness");
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
  }
}
export class FingerJoint extends Technique {
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
  }): void {
    const w = Math.min(width(o.first), width(o.second)),
      pitch = this.options.fingerWidth,
      clearance = this.options.clearance ?? 0;
    for (let x = 0, n = 0; x < w; x += pitch, n++) {
      const i =
        (n % 2 === 0) === (o.startWith !== "second") ? o.first : o.second;
      const p = owner(i),
        thickness = (p as any).material?.thickness;
      if (!thickness) throw new Error("Finger joints require sheet parts");
      p.subtract(
        new Shapes.Box({
          width: Math.min(pitch, w - x) + clearance,
          depth: thickness,
          height: thickness,
        }).move({ z: -thickness, x: -clearance / 2 }),
        { relativeTo: i, x },
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
