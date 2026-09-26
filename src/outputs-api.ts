// GET /api/projects/<id>/outputs/<kind>?format=…&target=… makes a file
// from the project's saved document as a server job, and sends it.
import type { IncomingMessage, ServerResponse } from "node:http";
import { JobsBusy, ownerLane, type JobQueue } from "./jobs.js";
import {
  JobLimitExceeded,
  outputJob,
  type KernelJobLimits,
} from "./kernel-jobs.js";
import type { Workspace } from "./workspace.js";
import { readDocument } from "./document/schema.js";
import type { CodeResultStore } from "./code-results.js";
import {
  NeedsRegeneration,
  OutputError,
  type OutputFormat,
  type OutputKind,
} from "./kernel/outputs.js";

export async function handleOutputs(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  context: {
    readonly workspace: Workspace;
    readonly jobs: JobQueue;
    readonly codeResults?: CodeResultStore;
    /** Whose project it is: their jobs run one at a time. */
    readonly owner?: string;
    readonly limits?: KernelJobLimits;
  },
): Promise<boolean> {
  const { workspace, jobs, codeResults, owner = "local", limits } = context;
  const match =
    /^\/api\/projects\/([0-9a-f-]{36})\/outputs\/(drawing|layout|part|cutlist|bom)$/.exec(
      url.pathname,
    );
  if (!match || req.method !== "GET") return false;
  const [, id, kind] = match as unknown as [string, string, OutputKind];
  const format = (url.searchParams.get("format") ?? "pdf") as OutputFormat;
  const target = url.searchParams.get("target") ?? undefined;
  const fail = (status: number, message: string) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  };
  let project;
  try {
    project = workspace.get(id);
  } catch {
    fail(404, "There is no such project");
    return true;
  }
  try {
    const document = readDocument(project.document);
    // One job per saved revision and request: asking twice waits for the
    // same work.
    const file = await jobs.run({
      key: `output\0${id}\0${project.revision}\0${kind}\0${target ?? ""}\0${format}`,
      lane: ownerLane(owner),
      label: `${project.name}: ${kind}${target ? ` ${target}` : ""} (${format})`,
      // In a bounded worker; code parts come from their stored results,
      // and nothing runs code.
      work: async () =>
        outputJob(
          document,
          { kind, format, ...(target ? { target } : {}) },
          (await codeResults?.results(document)) ?? [],
          limits,
        ),
    });
    res.writeHead(200, {
      "Content-Type": file.type,
      "Content-Length": file.bytes.byteLength,
      "Content-Disposition": `attachment; filename="${file.name}"`,
      "Cache-Control": "no-store",
    });
    res.end(file.bytes);
  } catch (error) {
    fail(
      error instanceof NeedsRegeneration
        ? 409
        : error instanceof JobsBusy
          ? 429
          : error instanceof JobLimitExceeded
            ? 503
            : error instanceof OutputError
              ? 400
              : 500,
      error instanceof Error ? error.message : String(error),
    );
  }
  return true;
}
