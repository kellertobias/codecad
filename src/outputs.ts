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
  readonly project?: string;
  readonly drawingNumber?: string;
  readonly revision?: string;
  readonly author?: string;
  readonly material?: string;
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
    | "exploded"
    | "flat";
  readonly at: Point2;
  readonly scale: number;
  readonly hiddenLines?: boolean;
  readonly explode?: number;
  readonly tangentEdges?: boolean;
  readonly label?: string;
  /** Architectural horizontal cut in world Z (mm). Does not alter the model. */
  readonly cutHeight?: number;
  /** Optional paper-space caption position, useful around dimension chains. */
  readonly labelAt?: Point2;
}
export interface DrawingDimension {
  readonly view?: string;
  readonly from: Point3 | PartInterface;
  readonly to: Point3 | PartInterface;
  readonly offset: number;
  readonly label?: string;
  /** World coordinates by default; use a component for part-local points. */
  readonly relativeTo?: Component;
  /** Paper-space offset (mm), independent of model/view scale. */
  readonly paperOffset?: number;
}
export interface DrawingAngle {
  readonly view: string;
  readonly vertex: Point3;
  readonly from: Point3;
  readonly to: Point3;
  readonly relativeTo?: Component;
  /** Radius in paper mm. The 3D angle is projected into the selected view. */
  readonly radius: number;
  readonly label?: string;
}
export interface DrawingLeader {
  readonly view: string;
  readonly from: Point3 | PartInterface;
  readonly relativeTo?: Component;
  readonly at: Point2;
  readonly text: string;
}
export class TechnicalDrawing {
  readonly views: DrawingView[] = [];
  readonly dimensions: DrawingDimension[] = [];
  readonly notes: { at: Point2; text: string }[] = [];
  readonly additionalPages: TechnicalDrawing[] = [];
  readonly angles: DrawingAngle[] = [];
  readonly leaders: DrawingLeader[] = [];
  readonly paths: {
    view: string;
    points: readonly Point3[];
    closed?: boolean;
    layer?: string;
  }[] = [];
  readonly labels: {
    view: string;
    at: Point3;
    text: string;
    height?: number;
  }[] = [];
  constructor(readonly options: DrawingOptions) {}
  view(o: DrawingView): this {
    if (this.views.some((v) => v.id === o.id))
      throw new Error("Duplicate view id");
    if (!(o.scale > 0)) throw new Error("View scale must be positive");
    if (
      o.cutHeight !== undefined &&
      (o.kind === "flat" || !Number.isFinite(o.cutHeight))
    )
      throw new Error(
        "A horizontal cut requires a spatial view and finite height",
      );
    this.views.push(o);
    return this;
  }
  dimension(o: DrawingDimension): this {
    if (
      !Number.isFinite(o.offset) ||
      (o.paperOffset !== undefined && !Number.isFinite(o.paperOffset))
    )
      throw new Error("Dimension offset must be finite");
    this.dimensions.push(o);
    return this;
  }
  angle(o: DrawingAngle): this {
    if (!(o.radius > 0) || !Number.isFinite(o.radius))
      throw new Error("Angular dimension radius must be positive");
    this.angles.push(o);
    return this;
  }
  leader(o: DrawingLeader): this {
    this.leaders.push(o);
    return this;
  }
  path(o: {
    view: string;
    points: readonly Point3[];
    closed?: boolean;
    layer?: string;
  }): this {
    this.paths.push(o);
    return this;
  }
  label(o: { view: string; at: Point3; text: string; height?: number }): this {
    this.labels.push(o);
    return this;
  }
  note(o: { at: Point2; text: string }): this {
    this.notes.push(o);
    return this;
  }
  page(page: TechnicalDrawing): this {
    if (page === this || page.additionalPages.length)
      throw new Error("Drawing pages must be non-nested, distinct drawings");
    this.additionalPages.push(page);
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
