// GET /api/projects/<id>/outputs/<kind>?format=…&target=… makes a file
// from the project's saved document as a server job, and sends it.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { JobQueue } from "./jobs.js";
import type { Workspace } from "./workspace.js";
import { readDocument } from "./document/schema.js";
import {
  documentOutput,
  OutputError,
  type OutputFormat,
  type OutputKind,
} from "./kernel/outputs.js";

export async function handleOutputs(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  workspace: Workspace,
  jobs: JobQueue,
): Promise<boolean> {
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
      lane: `output\0${id}`,
      label: `${project.name}: ${kind}${target ? ` ${target}` : ""} (${format})`,
      work: () =>
        documentOutput(document, {
          kind,
          format,
          ...(target ? { target } : {}),
        }),
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
      error instanceof OutputError ? 400 : 500,
      error instanceof Error ? error.message : String(error),
    );
  }
  return true;
}
