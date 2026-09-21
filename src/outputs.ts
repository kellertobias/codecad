import type {
  Component,
  PartInterface,
  Placement,
  Point2,
  Point3,
} from "./model.js";
import { validateMmPrecision } from "./precision.js";
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
  readonly mmPrecision?: number;
}
export type DrawingSubject = Component | readonly Component[];
export type DrawingViewKind =
  | "front"
  | "back"
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "isometric"
  | "exploded"
  | "flat";
export interface DrawingView {
  /** Defaults to the view kind (`front`, `top-2`, …). */
  readonly id?: string;
  readonly of: DrawingSubject;
  /** Components to leave out of `of`, with their children. */
  readonly without?: DrawingSubject;
  readonly kind: DrawingViewKind;
  /** Paper position (mm) of the view's top-left corner. Omit for automatic
   * third-angle layout: top above front, side views beside it. */
  readonly at?: Point2;
  /** Paper/model ratio, e.g. 0.1 for 1:10. Omit to let automatically placed
   * views share the largest standard scale that fits the sheet. */
  readonly scale?: number;
  /** With `at`: centre the geometry in this paper box instead of anchoring
   * its top-left corner. */
  readonly box?: { readonly width: number; readonly height: number };
  /** Add overall width and height dimensions of the projected subject. */
  readonly overallDimensions?: boolean;
  /** Degrees to turn the projection counter-clockwise on the paper, so a long
   * part can lie across the sheet. Dimensions and notes turn with it. */
  readonly rotate?: number;
  readonly hiddenLines?: boolean;
  readonly explode?: number;
  readonly tangentEdges?: boolean;
  readonly label?: string;
  /** Architectural horizontal cut in world Z (mm). Does not alter the model. */
  readonly cutHeight?: number;
  /** Optional paper-space caption position, useful around dimension chains. */
  readonly labelAt?: Point2;
}
export type ResolvedDrawingView = DrawingView & { readonly id: string };
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
  readonly views: ResolvedDrawingView[] = [];
  readonly dimensions: DrawingDimension[] = [];
  readonly notes: { at: Point2; text: string; height?: number }[] = [];
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
  constructor(readonly options: DrawingOptions) {
    validateMmPrecision(options.mmPrecision);
  }
  view(o: DrawingView): this {
    let id = o.id ?? o.kind;
    if (o.id === undefined)
      for (let n = 2; this.views.some((v) => v.id === id); n++)
        id = `${o.kind}-${n}`;
    if (this.views.some((v) => v.id === id))
      throw new Error("Duplicate view id");
    if (o.scale !== undefined && !(o.scale > 0))
      throw new Error("View scale must be positive");
    if (o.rotate !== undefined && !Number.isFinite(o.rotate))
      throw new Error("View rotation must be finite degrees");
    if (o.box && !(o.box.width > 0 && o.box.height > 0))
      throw new Error("View box must have positive width and height");
    if (o.box && !o.at) throw new Error("A view box needs a paper position");
    if (
      o.cutHeight !== undefined &&
      (o.kind === "flat" || !Number.isFinite(o.cutHeight))
    )
      throw new Error(
        "A horizontal cut requires a spatial view and finite height",
      );
    this.views.push({ ...o, id });
    return this;
  }
  /** Automatically arranged and scaled views of one subject, with overall
   * dimensions on the orthographic ones. */
  standardViews(
    of: DrawingSubject,
    o: {
      readonly kinds?: readonly DrawingViewKind[];
      readonly hiddenLines?: boolean;
      readonly overallDimensions?: boolean;
    } = {},
  ): this {
    for (const kind of o.kinds ?? ["front", "top", "right", "isometric"])
      this.view({
        of,
        kind,
        ...(o.hiddenLines === undefined ? {} : { hiddenLines: o.hiddenLines }),
        overallDimensions:
          (o.overallDimensions ?? true) &&
          kind !== "isometric" &&
          kind !== "exploded",
      });
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
  note(o: { at: Point2; text: string; height?: number }): this {
    if (o.height !== undefined && !(o.height > 0))
      throw new Error("Note height must be positive");
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
      readonly mmPrecision?: number;
    } = {},
  ) {
    validateMmPrecision(options.mmPrecision);
  }
}
export class ManufacturingDxf {
  constructor(
    readonly options: {
      readonly parts: "all" | readonly SheetPart[];
      readonly layout: "one-file-per-part" | "nested-by-sheet";
      readonly includeReferenceGeometry?: boolean;
      /** Report a warning for any part left with less material than this
       * anywhere between two cuts, or between a cut and the blank's edge. It is
       * a sampled check on the cut contours, so it catches a pocket that runs
       * into an edge or a web that came out too narrow. */
      readonly minimumMaterial?: number;
      /** Also place this CAM geometry in the Drawings workspace, laid out the
       * way the files are: nested sheets, or the parts in a row. It is the same
       * geometry the DXFs carry, so it costs a full section pass up front. */
      readonly showInDrawings?: boolean;
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
