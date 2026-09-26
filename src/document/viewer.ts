// What the mobile viewer shows of a saved project revision: prebuilt by the
// server, so the phone never runs the kernel. The manifest lists the parts,
// layouts and drawings; the files it names (the model as GLB, drawings as
// SVG and PDF, the cut list as PDF and CSV) are served beside it.
import type { Point2 } from "./schema.js";

export const viewerFormatVersion = 1;

export interface ViewerPart {
  readonly body: string;
  readonly name: string;
  readonly material: string;
  readonly color?: string;
  readonly stock: "sheet" | "solid";
  /** Sheet parts: the blank's size and the sheet's thickness. */
  readonly width?: number;
  readonly height?: number;
  readonly thickness?: number;
  readonly quantity: number;
}

export interface ViewerDrawing {
  readonly id: string;
  readonly name: string;
  /** A drawing of the project, or a part's manufacturing sheet. */
  readonly kind: "drawing" | "part";
  /** Paper size in mm. */
  readonly width: number;
  readonly height: number;
  readonly svg: string;
  readonly pdf: string;
}

export interface ViewerPlacement {
  readonly part: string;
  readonly copy: number;
  /** The blank's outline where it lies on the stock. */
  readonly outline: readonly Point2[];
}

export interface ViewerLayout {
  readonly id: string;
  readonly name: string;
  readonly stock: {
    readonly name: string;
    readonly outline: readonly Point2[];
  };
  readonly placements: readonly ViewerPlacement[];
}

export interface ViewerManifest {
  readonly format: typeof viewerFormatVersion;
  readonly project: string;
  readonly name: string;
  readonly revision: number;
  readonly builtAt: string;
  /** File names, relative to the revision's file URL. */
  readonly model?: string;
  readonly cutList?: { readonly pdf: string; readonly csv: string };
  readonly parts: readonly ViewerPart[];
  readonly hardware: readonly {
    readonly kind: string;
    readonly size: string;
    readonly count: number;
  }[];
  readonly drawings: readonly ViewerDrawing[];
  readonly layouts: readonly ViewerLayout[];
  /** What could not be built, said plainly. */
  readonly problems: readonly string[];
  /** A code part's result was missing: built again once one is stored. */
  readonly needsRegeneration?: boolean;
}

/** One copy of a part, as cut progress records it. */
export const copyKey = (body: string, copy: number) => `${body}#${copy}`;

/** Every copy of every part: what a workshop checks off. */
export const allCopies = (parts: readonly ViewerPart[]) =>
  parts.flatMap((part) =>
    Array.from({ length: part.quantity }, (_, i) => copyKey(part.body, i)),
  );
