// Runs one kernel job (an export, or the phone viewer's files) in a worker
// thread, so its time and memory can be bounded and a job that goes wrong
// is ended without touching the server (see kernel-jobs.ts).
import { parentPort, workerData } from "node:worker_threads";
import type { CadDocument } from "./document/schema.js";
import type { CodeResult } from "./document/code-part.js";
import { CodeResults } from "./kernel/code-parts.js";
import {
  documentOutput,
  NeedsRegeneration,
  OutputError,
  type OutputRequest,
} from "./kernel/outputs.js";
import { viewerBundle } from "./kernel/viewer.js";

export type KernelJob =
  | {
      readonly kind: "output";
      readonly document: CadDocument;
      readonly request: OutputRequest;
      readonly results: readonly CodeResult[];
    }
  | {
      readonly kind: "viewer";
      readonly document: CadDocument;
      readonly project: { id: string; name: string; revision: number };
      readonly results: readonly CodeResult[];
    };

const job = workerData as KernelJob;
const results = new CodeResults(Number.POSITIVE_INFINITY);
try {
  for (const result of job.results) results.add(result);
  if (job.kind === "output") {
    const file = await documentOutput(job.document, job.request, results);
    // Copied, not transferred: Node's pooled buffers cannot move.
    parentPort!.postMessage({ type: "done", value: file });
  } else {
    const bundle = await viewerBundle(
      job.document,
      job.project,
      (fraction, message) =>
        parentPort!.postMessage({ type: "progress", fraction, message }),
      results,
    );
    const files = [...bundle.files];
    parentPort!.postMessage({
      type: "done",
      value: { manifest: bundle.manifest, files },
    });
  }
} catch (error) {
  parentPort!.postMessage({
    type: "error",
    kind:
      error instanceof NeedsRegeneration
        ? "regenerate"
        : error instanceof OutputError
          ? "output"
          : "other",
    message: error instanceof Error ? error.message : String(error),
  });
} finally {
  results.dispose();
}
