import type { Recipe } from "../../src/model.js";
import type { BodyMesh, ShapeMesh } from "../../src/kernel/mesh.js";
import type { Evaluation, FeatureStatus } from "../../src/kernel/evaluator.js";
import type { JointKind } from "../../src/kernel/joints.js";
import type { PartInfo } from "../../src/kernel/parts.js";
import type { Frame } from "../../src/document/frames.js";
import type {
  CadDocument,
  DrawingSheet,
  EdgeReference,
  FaceReference,
  Layout,
  Placement,
  StockPiece,
} from "../../src/document/schema.js";
import type { LayoutPart } from "../../src/document/layout.js";
import type { CodeResult } from "../../src/document/code-part.js";

/** Messages the page sends to the kernel worker. */
export type KernelRequest =
  | { readonly id: number; readonly type: "evaluate"; readonly recipe: Recipe }
  /** Evaluates a solved document, up to feature `until` when given. */
  | {
      readonly id: number;
      readonly type: "document";
      readonly document: CadDocument;
      readonly until?: number;
    }
  /** A reference to a face of the last evaluated model. */
  | {
      readonly id: number;
      readonly type: "pick-face";
      readonly body: string;
      readonly face: number;
    }
  | {
      readonly id: number;
      readonly type: "pick-edge";
      readonly body: string;
      readonly edge: number;
    }
  /** Loads the sketch solver from this URL, for library instances whose
   * variables are set. */
  | { readonly id: number; readonly type: "solver"; readonly wasm: string }
  /** A drawing sheet of a document, as SVG. */
  | {
      readonly id: number;
      readonly type: "drawing";
      readonly document: CadDocument;
      readonly sheet: DrawingSheet;
      /** Not the open document (a preview): evaluated on its own. */
      readonly scratch?: boolean;
    }
  /** Fills a stock piece with the parts still to place. */
  | {
      readonly id: number;
      readonly type: "nest";
      readonly layout: Layout;
      readonly piece: StockPiece;
      readonly parts: readonly LayoutPart[];
      readonly others: readonly Layout[];
    }
  /** Builds what a code part's code returned (from the sandbox, checked
   * here) into a result to store under `key`. */
  | {
      readonly id: number;
      readonly type: "code-build";
      readonly output: unknown;
      readonly key: string;
      /** The part's STEP files, base64 by name. */
      readonly files?: Readonly<Record<string, string>>;
    }
  /** Results of code parts the documents to evaluate use. */
  | {
      readonly id: number;
      readonly type: "code-results";
      readonly results: readonly CodeResult[];
    }
  /** How two bodies of the last evaluated model meet, and the joints
   * that fit. */
  | {
      readonly id: number;
      readonly type: "contact";
      /** Evaluated up to feature `until`, as the joint sees them. */
      readonly document: CadDocument;
      readonly until?: number;
      readonly a: string;
      readonly b: string;
    };

export interface BodyView {
  readonly id: string;
  readonly name: string;
  readonly feature: string;
  readonly mesh: BodyMesh;
  readonly volume: number;
}

/** Messages the kernel worker sends back. `ready` is sent once, unasked,
 * when the kernel has loaded. */
export type KernelResponse =
  | {
      readonly type: "ready";
      /** Download, compile and initialisation of the WASM kernel. */
      readonly initMs: number;
      /** Kernel heap size once loaded, when the runtime reports it. */
      readonly heapBytes?: number;
    }
  | {
      readonly id: number;
      readonly type: "mesh";
      readonly mesh: ShapeMesh;
      readonly volume: number;
      /** Building the solid, and tessellating it. */
      readonly buildMs: number;
      readonly meshMs: number;
    }
  | {
      readonly id: number;
      readonly type: "model";
      readonly bodies: readonly BodyView[];
      readonly status: readonly (readonly [string, FeatureStatus])[];
      readonly frames: readonly (readonly [string, Frame])[];
      readonly projections: readonly (readonly [string, Float32Array])[];
      readonly parts: readonly PartInfo[];
      readonly hardware: Evaluation["hardware"];
      /** Evaluating, and tessellating what changed. */
      readonly ms: number;
      readonly meshMs: number;
      readonly rerunFrom: number;
    }
  | {
      readonly id: number;
      readonly type: "face";
      readonly ref?: FaceReference;
      readonly planar: boolean;
      /** Why there is no reference. */
      readonly reason?: string;
    }
  | {
      readonly id: number;
      readonly type: "edge";
      readonly ref?: EdgeReference;
      readonly reason?: string;
    }
  | {
      readonly id: number;
      readonly type: "contact";
      /** How they meet, in words. */
      readonly description: string;
      readonly joints: readonly JointKind[];
    }
  | { readonly id: number; readonly type: "drawing"; readonly svg: string }
  | { readonly id: number; readonly type: "solver" }
  | {
      readonly id: number;
      readonly type: "code-build";
      readonly result: CodeResult;
    }
  | {
      readonly id: number;
      readonly type: "code-results";
      /** Keys the worker now has. */
      readonly keys: readonly string[];
    }
  | {
      readonly id: number;
      readonly type: "nest";
      readonly placements: readonly Placement[];
      readonly left: readonly string[];
      /** By rectangles or by true outlines. */
      readonly method: "guillotine" | "shape";
    }
  | { readonly id: number; readonly type: "error"; readonly message: string };
