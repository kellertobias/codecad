import {
  Part,
  Shapes,
  SolidShape,
  positive,
  type Placement,
  type Point2,
  type SignedAxis,
  type PartInterface,
  type Shape2D,
  type Shape,
} from "./model.js";
export type CutSpan = readonly [surface: number, signedDepth: number];
export interface ToolPlacement extends Point2 {
  readonly z: number | CutSpan;
  readonly axis?: SignedAxis;
  readonly relativeTo?: Placement["relativeTo"];
}
export abstract class Tool {
  constructor(readonly id: string) {}
}
function span(
  target: Part,
  p: ToolPlacement,
): { center: number; depth: number } {
  if (typeof p.z === "number")
    throw new Error(
      "Use z: [surface, signedDepth] to specify a safe explicit drilling depth",
    );
  positive(Math.abs(p.z[1]), "drilling depth");
  void target;
  return { center: p.z[0] + p.z[1] / 2, depth: Math.abs(p.z[1]) };
}
export class Drill extends Tool {
  readonly diameter: number;
  constructor(o: {
    id?: string;
    diameter?: number;
    size?: number;
    tip?: "flat" | "brad-point" | "standard";
  }) {
    super(o.id ?? "drill");
    this.diameter = positive(o.diameter ?? o.size ?? NaN, "drill diameter");
    if (
      o.diameter !== undefined &&
      o.size !== undefined &&
      o.diameter !== o.size
    )
      throw new Error("diameter and size disagree");
  }
  drill(target: Part, p: ToolPlacement): Part {
    const s = span(target, p),
      axis = p.axis ?? "z";
    if (axis !== "z" && axis !== "-z")
      throw new Error(
        "Use a rotated interface frame for side drilling; z is the depth axis in that frame",
      );
    target.subtract(
      new Shapes.Cylinder({
        diameter: this.diameter,
        length: s.depth,
        z: s.center,
      }),
      { x: p.x, y: p.y, ...(p.relativeTo ? { relativeTo: p.relativeTo } : {}) },
    );
    Object.assign(target.operations.at(-1)!, {
      kind: "drill",
      toolId: this.id,
      diameter: this.diameter,
      depth: s.depth,
    });
    return target;
  }
  pattern(
    target: Part,
    mount: PartInterface,
    options: { z: CutSpan; placement?: Placement },
  ): Part {
    const s = span(target, { x: 0, y: 0, z: options.z });
    for (const f of Object.values(mount.features)) {
      if (f.kind !== "hole")
        throw new Error(
          "Slotted mounting interfaces require a routing operation",
        );
      target.subtract(
        new Shapes.Cylinder({
          diameter: this.diameter,
          length: s.depth,
          x: f.x,
          y: f.y,
          z: s.center,
        }),
        options.placement,
      );
      Object.assign(target.operations.at(-1)!, {
        kind: "drill",
        toolId: this.id,
        diameter: this.diameter,
        depth: s.depth,
      });
    }
    return target;
  }
}
export class CounterSink extends Tool {
  constructor(
    readonly options: { id?: string; diameter: number; angle: number },
  ) {
    super(options.id ?? "countersink");
    positive(options.diameter, "diameter");
    if (!(options.angle > 0 && options.angle < 180))
      throw new Error("Invalid countersink angle");
  }
  cut(target: Part, p: ToolPlacement): Part {
    if (p.axis && p.axis !== "z" && p.axis !== "-z")
      throw new Error("Use a rotated interface frame for side countersinks");
    const s = span(target, p),
      coneDepth =
        this.options.diameter /
        2 /
        Math.tan((this.options.angle * Math.PI) / 360);
    if (Math.abs(s.depth - coneDepth) > 1e-6)
      throw new Error(
        `Countersink depth must be ${coneDepth} mm for this diameter and angle`,
      );
    const surface = (p.z as CutSpan)[0],
      down = (p.z as CutSpan)[1] < 0;
    target.subtract(
      new SolidShape({
        kind: "cone",
        diameter: this.options.diameter,
        length: coneDepth,
      }),
      {
        x: p.x,
        y: p.y,
        z: surface,
        rotate: { x: down ? 180 : 0 },
        ...(p.relativeTo ? { relativeTo: p.relativeTo } : {}),
      },
    );
    Object.assign(target.operations.at(-1)!, {
      kind: "countersink",
      toolId: this.id,
      diameter: this.options.diameter,
      depth: s.depth,
    });
    return target;
  }
}
export class RouterBit extends Tool {
  constructor(
    readonly options: {
      id?: string;
      diameter: number;
      kind?: "straight" | "compression";
    },
  ) {
    super(options.id ?? "router");
    positive(options.diameter, "diameter");
  }
  pocket(
    target: Part,
    outline: Shape2D,
    o: { depth: number; placement?: Placement; allowance?: number },
  ): Part {
    let shape = outline.extrude(positive(o.depth, "depth"));
    if (o.allowance) {
      const extent =
        Math.max(
          ...outline.points.flatMap((p) => [Math.abs(p.x), Math.abs(p.y)]),
        ) +
        Math.abs(o.allowance) +
        1;
      const offset: Shape["recipe"] = {
        kind: "offset",
        source: shape.recipe,
        distance: o.allowance,
      };
      const slab = new Shapes.Box({
        width: extent * 2,
        depth: extent * 2,
        height: o.depth,
      }).move({ x: -extent, y: -extent });
      shape = new SolidShape({
        kind: "intersect",
        left: offset,
        right: slab.recipe,
      });
    }
    target.subtract(shape, o.placement);
    Object.assign(target.operations.at(-1)!, {
      kind: "pocket",
      toolId: this.id,
      depth: o.depth,
    });
    return target;
  }
}
