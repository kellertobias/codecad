import {
  Part,
  PartInterface,
  Shape2D,
  Shapes,
  SolidShape,
  positive,
  sharedDefinition,
  type Length,
} from "./model.js";
export interface MaterialOptions {
  readonly id?: string;
  readonly name?: string;
  readonly color?: `#${string}`;
  readonly densityKgPerM3?: number;
}
let materialId = 0;
export class Material {
  readonly [sharedDefinition] = true;
  readonly id: string;
  readonly name: string;
  constructor(readonly options: MaterialOptions) {
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
}
export class Bend {
  constructor(readonly options: BendOptions) {
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
    if (o.bendRules.kFactor < 0 || o.bendRules.kFactor > 0.5)
      throw new Error("kFactor must be between 0 and 0.5");
    for (const b of o.bends ?? []) this.bend(b);
  }
  bend(operation: Bend): this {
    if (operation.options.insideRadius < this.bendRules.minimumInsideRadius)
      throw new Error("Bend radius is below the material minimum");
    if (this.bends.some((b) => b.options.id === operation.options.id))
      throw new Error("Duplicate bend id");
    this.bends.push(operation);
    return this;
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
