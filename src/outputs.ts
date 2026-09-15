import type {
  Component,
  PartInterface,
  Placement,
  Point2,
  Point3,
} from "./model.js";
import type { Material, SheetPart } from "./stock.js";
export interface DrawingOptions {
  readonly id?: string;
  readonly title: string;
  readonly paper?: "A4" | "A3" | "A2" | "A1";
  readonly orientation?: "portrait" | "landscape";
}
export type DrawingSubject = Component | readonly Component[];
export interface DrawingView {
  readonly id: string;
  readonly of: DrawingSubject;
  readonly kind:
    | "front"
    | "back"
    | "left"
    | "right"
    | "top"
    | "bottom"
    | "isometric"
    | "exploded";
  readonly at: Point2;
  readonly scale: number;
  readonly hiddenLines?: boolean;
  readonly explode?: number;
}
export interface DrawingDimension {
  readonly view?: string;
  readonly from: Point3 | PartInterface;
  readonly to: Point3 | PartInterface;
  readonly offset: number;
  readonly label?: string;
}
export class TechnicalDrawing {
  readonly views: DrawingView[] = [];
  readonly dimensions: DrawingDimension[] = [];
  readonly notes: { at: Point2; text: string }[] = [];
  constructor(readonly options: DrawingOptions) {}
  view(o: DrawingView): this {
    if (this.views.some((v) => v.id === o.id))
      throw new Error("Duplicate view id");
    if (!(o.scale > 0)) throw new Error("View scale must be positive");
    this.views.push(o);
    return this;
  }
  dimension(o: DrawingDimension): this {
    this.dimensions.push(o);
    return this;
  }
  note(o: { at: Point2; text: string }): this {
    this.notes.push(o);
    return this;
  }
}
export class CutList {
  constructor(
    readonly options: {
      readonly materials?: readonly Material[];
      readonly nesting?: "automatic" | "rectangular" | "none";
      readonly includeLayouts?: boolean;
    } = {},
  ) {}
}
export class ManufacturingDxf {
  constructor(
    readonly options: {
      readonly parts: "all" | readonly SheetPart[];
      readonly layout: "one-file-per-part" | "nested-by-sheet";
      readonly includeReferenceGeometry?: boolean;
    },
  ) {}
}
export class StepModel {
  constructor(
    readonly options: {
      readonly of: DrawingSubject;
      readonly placement?: Placement;
    },
  ) {}
}
