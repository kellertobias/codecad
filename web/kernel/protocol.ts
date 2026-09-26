import type { Recipe } from "../../src/model.js";
import type { BodyMesh, ShapeMesh } from "../../src/kernel/mesh.js";
import type { Evaluation, FeatureStatus } from "../../src/kernel/evaluator.js";
import type { JointKind } from "../../src/kernel/joints.js";
import type { PartInfo } from "../../src/kernel/parts.js";
import type { Frame } from "../../src/document/frames.js";
import type {
  CadDocument,
  EdgeReference,
  FaceReference,
} from "../../src/document/schema.js";

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
  | { readonly id: number; readonly type: "error"; readonly message: string };
