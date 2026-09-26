// The model of the open document: the kernel worker evaluates it whenever
// the document changes. Evaluations do not queue up behind fast edits:
// while one runs, only the newest document waits for its turn.
import { useEffect, useRef, useState } from "react";
import { KernelClient } from "../../web/kernel/client.ts";
import solverWasm from "@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url";
import type { BodyView, KernelResponse } from "../../web/kernel/protocol.ts";

type Answer = Extract<KernelResponse, { type: "model" }>;
import type { CadDocument } from "../../src/document/schema.ts";
import type { Frame } from "../../src/document/frames.ts";
import type { FeatureStatus } from "../../src/kernel/evaluator.ts";
import type { PartInfo } from "../../src/kernel/parts.ts";

let client: KernelClient | undefined;
/** One worker for the page, started on first use; it lives as long as the
 * page (a React remount must not kill it). */
export const kernel = () => {
  if (!client) {
    client = new KernelClient("/kernel.worker.js");
    // Library instances with values of their own need the sketch solver.
    void client.useSolver(solverWasm).catch(() => {});
  }
  return client;
};

export interface Model {
  readonly bodies: readonly BodyView[];
  readonly status: ReadonlyMap<string, FeatureStatus>;
  readonly frames: ReadonlyMap<string, Frame>;
  readonly projections: ReadonlyMap<string, Float32Array>;
  readonly parts: readonly PartInfo[];
  readonly hardware: Answer["hardware"];
  readonly ms: number;
  readonly meshMs: number;
  /** The document the model was made from. */
  readonly document: CadDocument;
  readonly until: number | undefined;
}

export function useModel(
  document: CadDocument | undefined,
  until: number | undefined,
  /** Changes when the kernel has new code-part results to build with. */
  generation = 0,
): { model?: Model; busy: boolean; error?: string } {
  const [model, setModel] = useState<Model>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const wanted = useRef<{ document: CadDocument; until?: number }>(undefined);
  const running = useRef(false);

  useEffect(() => {
    if (!document) {
      setModel(undefined);
      return;
    }
    wanted.current = { document, ...(until === undefined ? {} : { until }) };
    if (running.current) return;
    running.current = true;
    setBusy(true);
    void (async () => {
      while (wanted.current) {
        const next = wanted.current;
        wanted.current = undefined;
        try {
          const result = await kernel().evaluateDocument(
            next.document,
            next.until,
          );
          setModel({
            bodies: result.bodies,
            status: new Map(result.status),
            frames: new Map(result.frames),
            projections: new Map(result.projections),
            parts: result.parts,
            hardware: result.hardware,
            ms: result.ms,
            meshMs: result.meshMs,
            document: next.document,
            until: next.until,
          });
          setError(undefined);
        } catch (problem) {
          setError(
            problem instanceof Error ? problem.message : String(problem),
          );
        }
      }
      running.current = false;
      setBusy(false);
    })();
  }, [document, until, generation]);

  return { ...(model ? { model } : {}), busy, ...(error ? { error } : {}) };
}
