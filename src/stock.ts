import {
  Part,
  PartInterface,
  Shape2D,
  Shapes,
  SolidShape,
  positive,
  sharedDefinition,
  framed,
  type Point2,
  finite,
  type Length,
} from "./model.js";
import {
  validateDrawingStyle,
  type MaterialDrawingStyle,
} from "./drawing-style.js";
export interface MaterialOptions {
  readonly id?: string;
  readonly name?: string;
  readonly color?: `#${string}`;
  readonly densityKgPerM3?: number;
  readonly drawingStyle?: MaterialDrawingStyle;
}
let materialId = 0;
export class Material {
  readonly [sharedDefinition] = true;
  readonly id: string;
  readonly name: string;
  constructor(readonly options: MaterialOptions) {
    if (options.drawingStyle) validateDrawingStyle(options.drawingStyle);
    this.id = options.id ?? `material-${++materialId}`;
    this.name = options.name ?? this.id;
  }
}
export interface SheetMaterialOptions extends MaterialOptions {
  readonly width?: number;
  readonly height?: number;
  readonly thickness: number;
  readonly grain?: "width" | "height" | "none";
  readonly rotations?: readonly (0 | 90 | 180 | 270)[];
  readonly kerf?: number;
  readonly partSpacing?: number;
  readonly sheetMargin?: number;
}
export interface MakeSheetPartOptions {
  readonly id?: string;
  readonly label?: string;
  readonly width: number;
  readonly height: number;
  readonly quantity?: number;
  readonly grain?: "width" | "height" | "none";
}
export interface MakeProfiledPartOptions {
  readonly id?: string;
  readonly label?: string;
  readonly outline: Shape2D;
  readonly quantity?: number;
}
export class SheetPart extends Part {
  readonly manufacturingOutline: Shape2D;
  readonly quantity: number;
  readonly grain: "width" | "height" | "none";
  constructor(
    readonly material: SheetMaterial,
    o: MakeSheetPartOptions | MakeProfiledPartOptions,
  ) {
    const outline = "outline" in o ? o.outline.copy() : new Shapes.Rectangle(o);
    super({ ...o, shape: outline.extrude(material.thickness) });
    this.manufacturingOutline = outline;
    this.quantity = o.quantity ?? 1;
    if (!Number.isInteger(this.quantity) || this.quantity < 1)
      throw new Error("quantity must be a positive integer");
    this.grain = "grain" in o ? (o.grain ?? "none") : "none";
  }
  override interface(name = "default"): PartInterface {
    if (name !== "default" || this.interfaces.has(name))
      return super.interface(name);
    return new PartInterface({
      shape: new SolidShape(structuredClone(this.recipe)),
      outline: this.manufacturingOutline.copy(),
    }).bind(this);
  }
}
export class SheetMaterial extends Material {
  readonly width: number | undefined;
  readonly height: number | undefined;
  readonly thickness: number;
  declare readonly options: SheetMaterialOptions;
  constructor(options: SheetMaterialOptions) {
    super(options);
    this.width = options.width;
    this.height = options.height;
    this.thickness = positive(options.thickness, "thickness");
    if (this.width !== undefined) positive(this.width, "sheet width");
    if (this.height !== undefined) positive(this.height, "sheet height");
    for (const v of [options.kerf, options.partSpacing, options.sheetMargin])
      if (v !== undefined && (!Number.isFinite(v) || v < 0))
        throw new Error("Stock margins and spacing must be nonnegative");
  }
  makePart(o: MakeSheetPartOptions | MakeProfiledPartOptions): SheetPart {
    return new SheetPart(this, o);
  }
  makeSheetMetalPart(
    o: MakeProfiledPartOptions & {
      readonly bends?: readonly Bend[];
      readonly bendRules: BendRules;
    },
  ): SheetMetalPart {
    return new SheetMetalPart(this, o);
  }
  /** Tangent-to-tangent straight lengths, not outside mould-line dimensions.
   * The neutral-axis bend allowances are inserted automatically. */
  makeBentProfile(o: BentProfileOptions): SheetMetalPart {
    positive(o.width, "profile width");
    if (o.lengths.length !== o.bends.length + 1)
      throw new Error(
        "A bent profile needs one more straight length than bends",
      );
    o.lengths.forEach((n) => positive(n, "straight length"));
    let length = o.lengths[0]!;
    const bends: Bend[] = [];
    for (const [i, bend] of o.bends.entries()) {
      bends.push(
        new Bend({
          ...bend,
          start: { x: 0, y: length },
          end: { x: o.width, y: length },
          movingSide: "left",
        }),
      );
      length +=
        ((bend.angle * Math.PI) / 180) *
          (bend.insideRadius + o.bendRules.kFactor * this.thickness) +
        o.lengths[i + 1]!;
    }
    return this.makeSheetMetalPart({
      ...o,
      outline: new Shapes.Rectangle({ width: o.width, height: length }),
      bends: bends.reverse(),
    });
  }
}
export interface BentProfileOptions {
  readonly id?: string;
  readonly label?: string;
  readonly width: number;
  readonly lengths: readonly number[];
  readonly bends: readonly Omit<BendOptions, "start" | "end" | "movingSide">[];
  readonly bendRules: BendRules;
}
/** Boards use the same XY blank / Z thickness convention as sheet goods. */
export class BoardMaterial extends SheetMaterial {}
export interface BlockPartOptions {
  readonly id?: string;
  readonly label?: string;
  readonly width: number;
  readonly depth: number;
  readonly height: number;
  readonly quantity?: number;
}
export class BlockPart extends Part {
  readonly quantity: number;
  constructor(
    readonly material: BlockMaterial,
    readonly dimensions: BlockPartOptions,
  ) {
    super({ ...dimensions, shape: new Shapes.Box(dimensions) });
    this.quantity = dimensions.quantity ?? 1;
    if (!Number.isInteger(this.quantity) || this.quantity < 1)
      throw new Error("quantity must be positive");
  }
}
export class BlockMaterial extends Material {
  makePart(options: BlockPartOptions): BlockPart {
    return new BlockPart(this, options);
  }
}
export interface BendRules {
  readonly kFactor: number;
  readonly minimumInsideRadius: Length;
  readonly defaultRelief: "rectangular" | "round" | "tear";
}
export interface BendOptions {
  readonly id: string;
  readonly start: { readonly x: number; readonly y: number };
  readonly end: { readonly x: number; readonly y: number };
  readonly direction: "up" | "down";
  readonly angle: number;
  readonly insideRadius: number;
  readonly relief?: "rectangular" | "round" | "tear";
  readonly movingSide?: "left" | "right";
  /** Free a partial-width flange with slots from the bend root to the blank edge. */
  readonly autoRelief?: boolean;
  readonly reliefWidth?: number;
  readonly reliefDepth?: number;
}
export class Bend {
  constructor(readonly options: BendOptions) {
    for (const point of [options.start, options.end]) {
      finite(point.x, "bend x");
      finite(point.y, "bend y");
    }
    positive(options.insideRadius, "bend radius");
    if (!(options.angle > 0 && options.angle < 180))
      throw new Error("Bend angle must be between 0 and 180 degrees");
    if (
      Math.hypot(
        options.end.x - options.start.x,
        options.end.y - options.start.y,
      ) < 1e-6
    )
      throw new Error("Bend line cannot be zero length");
  }
}
export class SheetMetalPart extends SheetPart {
  readonly bends: Bend[] = [];
  readonly bendRules: BendRules;
  constructor(
    material: SheetMaterial,
    o: MakeProfiledPartOptions & {
      bends?: readonly Bend[];
      bendRules: BendRules;
    },
  ) {
    super(material, o);
    this.bendRules = o.bendRules;
    if (
      !Number.isFinite(o.bendRules.kFactor) ||
      o.bendRules.kFactor < 0 ||
      o.bendRules.kFactor > 0.5
    )
      throw new Error("kFactor must be between 0 and 0.5");
    if (
      !Number.isFinite(o.bendRules.minimumInsideRadius) ||
      o.bendRules.minimumInsideRadius < 0
    )
      throw new Error("Minimum inside radius must be finite and nonnegative");
    for (const b of o.bends ?? []) this.bend(b);
  }
  bend(operation: Bend): this {
    if (operation.options.insideRadius < this.bendRules.minimumInsideRadius)
      throw new Error("Bend radius is below the material minimum");
    if (this.bends.some((b) => b.options.id === operation.options.id))
      throw new Error("Duplicate bend id");
    if (operation.options.autoRelief) this.addReliefs(operation);
    this.bends.push(operation);
    return this;
  }
  private addReliefs(bend: Bend): void {
    const o = bend.options,
      kind = o.relief ?? this.bendRules.defaultRelief;
    if (kind === "tear")
      throw new Error(
        "Tear relief has no safe generic cut geometry; choose rectangular or round relief",
      );
    const width = o.reliefWidth ?? this.material.thickness;
    const depth = o.reliefDepth ?? o.insideRadius + this.material.thickness;
    if (
      !(width >= this.material.thickness) ||
      !(depth >= this.material.thickness)
    )
      throw new Error(
        "Relief width and depth must be at least the sheet thickness",
      );
    const start = o.movingSide === "left" ? o.end : o.start;
    const end = o.movingSide === "left" ? o.start : o.end;
    const len = Math.hypot(end.x - start.x, end.y - start.y),
      dx = (end.x - start.x) / len,
      dy = (end.y - start.y) / len;
    const frame = framed({
      origin: { ...start, z: 0 },
      xAxis: { x: dy, y: -dx, z: 0 },
      yAxis: { x: dx, y: dy, z: 0 },
    });
    const reach =
      Math.max(
        ...this.manufacturingOutline.points.map(
          (p) => (p.x - start.x) * dy - (p.y - start.y) * dx,
        ),
      ) + width;
    for (const y of [-width, len]) {
      const root = -depth + (kind === "round" ? width / 2 : 0);
      if (reach <= root)
        throw new Error("Relief does not reach the moving flange");
      let recipe = new Shapes.Box({
        width: reach - root,
        depth: width,
        height: this.material.thickness,
      }).recipe;
      recipe = {
        kind: "transform",
        source: recipe,
        matrix: framed({
          origin: { x: root, y, z: 0 },
          xAxis: { x: 1, y: 0, z: 0 },
          yAxis: { x: 0, y: 1, z: 0 },
        }).toArray(),
      };
      if (kind === "round")
        recipe = {
          kind: "union",
          left: recipe,
          right: new Shapes.Cylinder({
            diameter: width,
            length: this.material.thickness + 2,
            x: root,
            y: y + width / 2,
            z: this.material.thickness / 2,
          }).recipe,
        };
      this.subtract(
        new SolidShape({
          kind: "transform",
          source: recipe,
          matrix: frame.toArray(),
        }),
      );
    }
  }
  /** History-based development, including all cutouts and reliefs. No registration
   * or mutation. This is not recognition/unfolding of arbitrary imported solids. */
  unfold(): UnfoldedSheet {
    return new UnfoldedSheet(this);
  }
  get flatPattern(): Shape2D {
    return this.manufacturingOutline.copy();
  }
  bendAllowance(b: Bend): number {
    return (
      ((b.options.angle * Math.PI) / 180) *
      (b.options.insideRadius +
        this.bendRules.kFactor * this.material.thickness)
    );
  }
}

export class UnfoldedSheet {
  readonly shape: SolidShape;
  readonly outline: Shape2D;
  readonly thickness: number;
  readonly bends: {
    id: string;
    angle: number;
    direction: "up" | "down";
    insideRadius: number;
    allowance: number;
    deduction: number;
    start: Point2;
    end: Point2;
    tangentStart: [Point2, Point2];
    tangentEnd: [Point2, Point2];
  }[];
  constructor(part: SheetMetalPart) {
    this.shape = new SolidShape(structuredClone(part.recipe));
    this.outline = part.manufacturingOutline.copy();
    this.thickness = part.material.thickness;
    this.bends = part.bends.map((bend) => {
      const o = bend.options,
        allowance = part.bendAllowance(bend);
      const len = Math.hypot(o.end.x - o.start.x, o.end.y - o.start.y),
        sign = o.movingSide === "left" ? -1 : 1;
      const dx = (sign * (o.end.y - o.start.y)) / len,
        dy = (-sign * (o.end.x - o.start.x)) / len;
      const shift = (p: Point2, amount: number) => ({
        x: p.x + dx * amount,
        y: p.y + dy * amount,
      });
      return {
        id: o.id,
        angle: o.angle,
        direction: o.direction,
        insideRadius: o.insideRadius,
        allowance,
        deduction:
          2 *
            (o.insideRadius + this.thickness) *
            Math.tan((o.angle * Math.PI) / 360) -
          allowance,
        start: shift(o.start, allowance / 2),
        end: shift(o.end, allowance / 2),
        tangentStart: [structuredClone(o.start), structuredClone(o.end)],
        tangentEnd: [shift(o.start, allowance), shift(o.end, allowance)],
      };
    });
  }
}
