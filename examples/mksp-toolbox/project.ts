import {
  Assembly,
  Project,
  Part,
  HardwarePart,
  SheetMaterial,
  Shapes,
  PartInterface,
  screwHole,
  FingerJoint,
  TechnicalDrawing,
  CutList,
  ManufacturingDxf,
  StepModel,
  MotionStudy,
  LinearJoint,
  cad,
  type SheetPart,
  type MountingFeature,
  type Point2,
} from "../../src/index.js";

/** Port of Projects/MKSP-Toolbox/project.py, not the older makerspace_toolbox.py variant. */
export const toolbox = {
  width: 360,
  depth: 220,
  height: 300,
  thickness: 6,
  drawerOuterHeight: 48,
  gap: 1,
  topDepartmentHeight: 120,
  railWidth: 12.75,
  drawerHeight: 45,
  radius: 30,
  handleDiameter: 30,
  handleWall: 2,
  fingerWidth: 30,
  fingerClearance: 0.15,
  fingerEdgeMargin: 30,
} as const;
const t = toolbox.thickness,
  drawerWidth = toolbox.width - 2 * t - 2 * toolbox.railWidth;
const drawerDepth = toolbox.depth - 2 * t - 2;
const shelfZ = t + 3 * toolbox.gap + 2 * toolbox.drawerOuterHeight;
type Plane = "XY" | "XZ" | "YZ";
type Meta = { plane: Plane; origin: number[]; width: number; height: number };
const axes = { XY: [0, 1, 2], XZ: [0, 2, 1], YZ: [1, 2, 0] } as const;
const metadata = new WeakMap<SheetPart, Meta>();
function plate(
  material: SheetMaterial,
  id: string,
  width: number,
  height: number,
  plane: Plane,
  origin: number[],
  rounded = false,
) {
  const points: Point2[] = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height - toolbox.radius },
  ];
  if (rounded) {
    for (let i = 1; i <= 24; i++) {
      const a = (i * Math.PI) / 48;
      points.push({
        x: width - toolbox.radius + toolbox.radius * Math.cos(a),
        y: height - toolbox.radius + toolbox.radius * Math.sin(a),
      });
    }
    for (let i = 0; i <= 24; i++) {
      const a = Math.PI / 2 + (i * Math.PI) / 48;
      points.push({
        x: toolbox.radius + toolbox.radius * Math.cos(a),
        y: height - toolbox.radius + toolbox.radius * Math.sin(a),
      });
    }
  }
  const part = material.makePart(
    rounded
      ? { id, outline: new Shapes.Polygon({ points }) }
      : { id, width, height },
  );
  if (rounded && part.recipe.kind === "extrude")
    part.recipe.arcTolerance = 0.02;
  part.place({
    x: origin[0]!,
    y: origin[1]! + (plane === "XZ" ? t : 0),
    z: origin[2]!,
    rotate: plane === "YZ" ? { y: 90, z: 90 } : plane === "XZ" ? { x: 90 } : {},
  });
  metadata.set(part, { plane, origin, width, height });
  return part;
}
/** Alternating intersection cuts, with protected ends on internal joints. */
function fingers(a: SheetPart, b: SheetPart) {
  const A = metadata.get(a)!,
    B = metadata.get(b)!;
  const aa = axes[A.plane],
    bb = axes[B.plane];
  const shared = aa.slice(0, 2).find((axis) => bb.slice(0, 2).includes(axis))!;
  const extent = (m: Meta, axis: number) =>
    m.origin[axis]! + (axes[m.plane][0] === axis ? m.width : m.height);
  let start = Math.max(A.origin[shared]!, B.origin[shared]!);
  let end = Math.min(extent(A, shared), extent(B, shared));
  const receiving = [
    [A, B],
    [B, A],
  ].find(([source, target]) => {
    const axis = axes[source!.plane][2];
    const fixed = source!.origin[axis]!;
    return (
      fixed - target!.origin[axis]! > 1e-6 &&
      extent(target!, axis) - fixed - t > 1e-6
    );
  });
  const central = receiving !== undefined;
  const originalStart = start,
    originalEnd = end;
  const interval = FingerJoint.interval(end - start, {
    internal: central,
    edgeMargin: central ? toolbox.fingerEdgeMargin : 0,
  });
  end = start + interval.end;
  start += interval.start;
  if (end <= start) throw new Error("Toolbox joint has no overlap");
  const count = Math.max(2, Math.ceil((end - start) / toolbox.fingerWidth)),
    pitch = (end - start) / count;
  const cut = (target: SheetPart, begin: number, finish: number) => {
    const targetMeta = target === a ? A : B,
      other = target === a ? B : A;
    const local = axes[targetMeta.plane],
      cross = local[0] === shared ? local[1] : local[0];
    const along = begin - targetMeta.origin[shared]!;
    const across =
      other.origin[cross]! -
      targetMeta.origin[cross]! -
      toolbox.fingerClearance / 2;
    target.subtract(
      new Shapes.Box({
        width:
          local[0] === shared ? finish - begin : t + toolbox.fingerClearance,
        depth:
          local[0] === shared ? t + toolbox.fingerClearance : finish - begin,
        height: t + 2,
      }),
      {
        x: local[0] === shared ? along : across,
        y: local[0] === shared ? across : along,
        z: -1,
      },
    );
  };
  if (receiving) {
    const entering = receiving[0] === A ? a : b;
    cut(entering, originalStart, start);
    cut(entering, end, originalEnd);
  }
  for (let i = 0; i < count; i++)
    cut(i % 2 ? b : a, start + i * pitch, start + (i + 1) * pitch);
}
function hole(
  part: Part,
  x: number,
  y: number,
  diameter: number,
  depth: number = t,
) {
  part.subtract(
    new Shapes.Cylinder({ diameter, length: depth + 2, x, y, z: depth / 2 }),
  );
}
function slot(
  part: Part,
  x: number,
  y: number,
  length: number,
  width: number,
  vertical = false,
  depth: number = t,
) {
  const r = width / 2;
  part.subtract(
    new Shapes.Box({
      width: vertical ? width : length - width,
      depth: vertical ? length - width : width,
      height: depth + 2,
    }),
    { x: x + (vertical ? 0 : r), y: y + (vertical ? r : 0), z: -1 },
  );
  hole(part, x + r, y + r, width, depth);
  hole(
    part,
    x + (vertical ? r : length - r),
    y + (vertical ? length - r : r),
    width,
    depth,
  );
}
const outerFeatures: Record<string, MountingFeature> = {
  "slot-back": {
    kind: "slot",
    x: 48,
    y: 20.3,
    length: 9,
    width: 4.5,
    axis: "x",
    source: "measured",
  },
  "large-back": {
    kind: "hole",
    x: 68.6,
    y: 22.55,
    diameter: 6.2,
    source: "measured",
  },
  "slot-right": {
    kind: "slot",
    x: 142.9,
    y: 20.3,
    length: 9,
    width: 4.5,
    axis: "x",
    source: "measured",
  },
  "large-right": {
    kind: "hole",
    x: 164.45,
    y: 22.55,
    diameter: 6.1,
    source: "measured",
  },
  "small-left": {
    kind: "hole",
    x: 173.75,
    y: 22.55,
    diameter: 4.5,
    source: "measured",
  },
  "small-right": {
    kind: "hole",
    x: 193.75,
    y: 22.55,
    diameter: 4.5,
    source: "measured",
  },
};
const innerFeatures: Record<string, MountingFeature> = {
  "slot-right": {
    kind: "slot",
    x: 160,
    y: 10.25,
    length: 9,
    width: 4.5,
    axis: "x",
    source: "measured",
  },
  "cross-right": {
    kind: "slot",
    x: 146.5,
    y: 8,
    length: 9,
    width: 4.5,
    axis: "y",
    source: "measured",
  },
  "hole-right": {
    kind: "hole",
    x: 139.75,
    y: 12.5,
    diameter: 4.5,
    source: "measured",
  },
  "slot-left": {
    kind: "slot",
    x: 41.5,
    y: 10.25,
    length: 9,
    width: 4.5,
    axis: "x",
    source: "measured",
  },
  "cross-left": {
    kind: "slot",
    x: 28,
    y: 8,
    length: 9,
    width: 4.5,
    axis: "y",
    source: "measured",
  },
  "hole-left": {
    kind: "hole",
    x: 20.75,
    y: 12.5,
    diameter: 4.5,
    source: "measured",
  },
};
function features(
  part: Part,
  pattern: Record<string, MountingFeature>,
  depth: number,
) {
  for (const f of Object.values(pattern)) {
    if (f.kind === "hole") hole(part, f.x, f.y, f.diameter, depth);
    else slot(part, f.x, f.y, f.length, f.width, f.axis === "y", depth);
  }
  part.addInterface("mounts", new PartInterface({ features: pattern }));
}
@cad.part({ id: "mksp-rail", revision: "1" })
class ToolboxRail extends Assembly {
  readonly fixed: HardwarePart;
  readonly middle: HardwarePart;
  readonly inner: HardwarePart;
  constructor(id: string, x: number, railZ: number, right: boolean) {
    super({ id, label: "Measured 200 mm slide · simplified channels" });
    const channel = (id: string, height: number, depth: number) => {
      const p = new HardwarePart({
        id,
        shape: new Shapes.Box({ width: 200, depth: height, height: depth }),
        measurementStatus: "measured",
      });
      p.subtract(
        new Shapes.Box({ width: 202, depth: height - 2.4, height: depth }),
        { x: -1, y: 1.2, z: 1.2 },
      );
      return p;
    };
    this.fixed = channel("fixed", 45.1, 12.7);
    features(this.fixed, outerFeatures, 12.7);
    // Centre the middle within the measured 12.75 mm envelope; the legacy Python
    // middle starts at 6.375 and protrudes beyond it. Keep this correction explicit.
    this.middle = channel("middle", 35, 9.5).place({ y: 5.05, z: 1.625 });
    this.inner = channel("inner", 25, 11.3);
    features(this.inner, innerFeatures, 11.3);
    this.inner.mirror({ axis: "z" }).place({ y: 10.05, z: 12.75 });
    this.place({ x, y: 210, z: railZ, rotate: { y: -90, z: -90 } });
    if (!right) this.mirror({ axis: "z" });
  }
}
function railMounts(part: SheetPart, inner: boolean, railZ: number) {
  const m = metadata.get(part)!;
  const pattern = inner ? innerFeatures : outerFeatures;
  for (const id of inner
    ? ["slot-right", "hole-left"]
    : ["slot-back", "small-right"]) {
    const f = screwHole(pattern[id]!);
    const x = 210 - f.x - m.origin[1]!;
    const y = railZ + (inner ? 10.05 : 0) + f.y - m.origin[2]!;
    hole(part, x, y, f.diameter);
  }
}
@cad.part({ id: "mksp-drawer", revision: "1" })
class ToolboxDrawer extends Assembly {
  readonly left: SheetPart;
  readonly right: SheetPart;
  constructor(id: string, material: SheetMaterial, frontZ: number) {
    super({ id });
    const x = t + toolbox.railWidth,
      y = t + toolbox.gap,
      z = frontZ + toolbox.gap;
    const floor = plate(material, "floor", drawerWidth, drawerDepth, "XY", [
      x,
      y,
      z,
    ]);
    this.left = plate(material, "left", drawerDepth, 45, "YZ", [x, y, z]);
    this.right = plate(material, "right", drawerDepth, 45, "YZ", [
      x + drawerWidth - t,
      y,
      z,
    ]);
    const back = plate(material, "back", drawerWidth, 45, "XZ", [
      x,
      y + drawerDepth - t,
      z,
    ]);
    const front = plate(material, "front", 346, 48, "XZ", [7, 0, frontZ]);
    for (const [a, b] of [
      [floor, this.left],
      [floor, this.right],
      [floor, back],
      [this.left, back],
      [this.right, back],
    ] as const)
      fingers(a, b);
    for (const [i, bx] of [x + 20, x + drawerWidth - 60].entries()) {
      const bracket = new HardwarePart({
        id: `bracket-${i + 1}`,
        shape: new Shapes.Box({ width: 40, depth: 30, height: 2 }),
        measurementStatus: "provisional",
      });
      bracket.union(new Shapes.Box({ width: 40, depth: 2, height: 30 }));
      for (const u of [10, 30]) {
        hole(bracket, u, 15, 4.5, 2);
        bracket.subtract(
          new Shapes.Cylinder({
            diameter: 4.5,
            length: 4,
            axis: "y",
            x: u,
            y: 1,
            z: 15,
          }),
        );
        hole(floor, bx + u - x, 14, 4.5);
        hole(front, bx + u - 7, z + t + 15 - frontZ, 4.5);
      }
      bracket.place({ x: bx, y: t, z: z + t });
    }
  }
}
@cad.project({
  id: "mksp-toolbox",
  units: "mm",
  title: "Makerspace toolbox · Python port",
})
export class MakerspaceToolbox extends Project {
  readonly drawers: ToolboxDrawer[] = [];
  readonly rails: ToolboxRail[] = [];
  constructor() {
    super({ id: "mksp-toolbox", label: "MKSP toolbox · 360 × 220 × 300 mm" });
    const material = new SheetMaterial({
      id: "mpx6",
      name: "6 mm multiplex",
      thickness: t,
      width: 1250,
      height: 2500,
      color: "#cc9c5c",
    });
    const left = plate(
      material,
      "left-sidewall",
      220,
      300,
      "YZ",
      [0, 0, 0],
      true,
    );
    const right = plate(
      material,
      "right-sidewall",
      220,
      300,
      "YZ",
      [354, 0, 0],
      true,
    );
    for (const side of [left, right]) hole(side, 110, 270, 30);
    const back = plate(material, "back-wall", 360, 180, "XZ", [0, 214, 0]);
    const bottom = plate(material, "bottom", 360, 220, "XY", [0, 0, 0]);
    const shelf = plate(material, "drawer-shelf", 360, 220, "XY", [
      0,
      0,
      shelfZ,
    ]);
    const front = plate(material, "top-department-front", 360, 120, "XZ", [
      0,
      0,
      shelfZ,
    ]);
    for (const [a, b] of [
      [left, back],
      [right, back],
      [bottom, left],
      [bottom, right],
      [bottom, back],
      [shelf, left],
      [shelf, right],
      [shelf, back],
      [front, left],
      [front, right],
      [front, shelf],
    ] as const)
      fingers(a, b);
    const handle = new HardwarePart({
      id: "handle",
      shape: new Shapes.Cylinder({
        diameter: 30,
        length: 360,
        axis: "x",
        x: 180,
        y: 110,
        z: 270,
      }),
      measurementStatus: "provisional",
    });
    handle.subtract(
      new Shapes.Cylinder({
        diameter: 26,
        length: 362,
        axis: "x",
        x: 180,
        y: 110,
        z: 270,
      }),
    );
    for (let i = 0; i < 2; i++) {
      const frontZ = 7 + i * 49,
        railZ = frontZ + (48 - 45.1) / 2;
      const drawer = new ToolboxDrawer(`drawer-${i + 1}`, material, frontZ);
      this.drawers.push(drawer);
      railMounts(left, false, railZ);
      railMounts(right, false, railZ);
      railMounts(drawer.left, true, railZ);
      railMounts(drawer.right, true, railZ);
      this.rails.push(
        new ToolboxRail(`rail-${i + 1}-left`, 6, railZ, false),
        new ToolboxRail(`rail-${i + 1}-right`, 354, railZ, true),
      );
    }
  }
  @cad.output.technicalDrawing({ fileName: "mksp-toolbox.pdf" })
  drawing() {
    const iso = new TechnicalDrawing({
      title: "MKSP toolbox - assembly",
      paper: "A3",
      orientation: "landscape",
      project: "Makerspace toolbox",
      revision: "TS port 1",
    })
      .view({
        id: "iso",
        of: this,
        kind: "isometric",
        at: { x: 28, y: 30 },
        scale: 0.5,
      })
      .dimension({
        view: "iso",
        from: { x: 0, y: 0, z: 0 },
        to: { x: 360, y: 0, z: 0 },
        paperOffset: 12,
        offset: 0,
      });
    const orthographic = new TechnicalDrawing({
      title: "MKSP toolbox - elevations",
      paper: "A3",
      orientation: "landscape",
    })
      .view({
        id: "front",
        of: this,
        kind: "front",
        at: { x: 30, y: 30 },
        scale: 0.5,
      })
      .view({
        id: "right",
        of: this,
        kind: "right",
        at: { x: 255, y: 30 },
        scale: 0.5,
      });
    return iso.page(orthographic);
  }
  @cad.output.cutList() cutList() {
    return new CutList({ includeLayouts: true });
  }
  @cad.output.manufacturingDxf() dxf() {
    return new ManufacturingDxf({ parts: "all", layout: "one-file-per-part" });
  }
  @cad.output.step() step() {
    return new StepModel({ of: this });
  }
  @cad.output.motion() motion() {
    const study = new MotionStudy({ of: this });
    for (const [i, drawer] of this.drawers.entries()) {
      const motion = (moving: Assembly | Part, to: number) =>
        study.animate({
          joint: new LinearJoint({
            id: `open-${moving.id}`,
            fixed: this,
            moving,
            axis: { x: 0, y: -1, z: 0 },
            limits: { min: 0, max: 160 },
          }),
          from: 0,
          to,
          durationSeconds: 3,
          delaySeconds: i * 0.75,
        });
      motion(drawer, 160);
      for (const rail of this.rails.slice(i * 2, i * 2 + 2)) {
        motion(rail.middle, 80);
        motion(rail.inner, 160);
      }
    }
    return study;
  }
}
