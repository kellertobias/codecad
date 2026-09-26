// HTTP routes for browser-edited projects:
//
//   GET    /api/projects        list
//   POST   /api/projects        create   { name, document }
//   GET    /api/projects/:id    load
//   PUT    /api/projects/:id    save     { basedOn, name?, document }
//   DELETE /api/projects/:id    delete
//
// A save names the revision it was based on; if another save came first the
// answer is 409 with the current revision, and nothing is overwritten.
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ProjectNotFound,
  RevisionConflict,
  maxDocumentBytes,
  type Workspace,
} from "./workspace.js";

export class BadRequest extends Error {}

export async function readJson(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    // Room for the document plus the few fields around it.
    if (size > maxDocumentBytes + 64 * 1024)
      throw new BadRequest("Request body is too large");
    chunks.push(chunk);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BadRequest("Request body is not JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BadRequest("Request body must be a JSON object");
  return value as Record<string, unknown>;
}

function documentField(body: Record<string, unknown>) {
  const document = body.document;
  if (!document || typeof document !== "object" || Array.isArray(document))
    throw new BadRequest("document must be a JSON object");
  return document as Record<string, unknown>;
}

/** Answers a request under /api/projects; returns false for other paths.
 * `trusted` says whether the request may change data (see server.ts). */
export async function handleProjects(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  workspace: Workspace,
  trusted: () => boolean,
): Promise<boolean> {
  const match = /^\/api\/projects(?:\/([0-9a-f-]{36}))?$/.exec(url.pathname);
  if (!match) return false;
  const id = match[1];
  const json = (value: unknown, status = 200) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
  };
  const method = req.method ?? "GET";
  if (method !== "GET" && !trusted()) {
    json({ error: "Invalid editor session" }, 403);
    return true;
  }
  try {
    if (!id && method === "GET") json({ projects: workspace.list() });
    else if (!id && method === "POST") {
      const body = await readJson(req);
      if (typeof body.name !== "string")
        throw new BadRequest("name must be a string");
      json(workspace.create(body.name, documentField(body)), 201);
    } else if (id && method === "GET") json(workspace.get(id));
    else if (id && method === "PUT") {
      const body = await readJson(req);
      if (!Number.isInteger(body.basedOn))
        throw new BadRequest(
          "basedOn must be the revision the edit started from",
        );
      if (body.name !== undefined && typeof body.name !== "string")
        throw new BadRequest("name must be a string");
      json(
        workspace.save(id, body.basedOn as number, {
          document: documentField(body),
          ...(body.name === undefined ? {} : { name: body.name as string }),
        }),
      );
    } else if (id && method === "DELETE") {
      workspace.delete(id);
      res.writeHead(204).end();
    } else {
      res.writeHead(405, { Allow: id ? "GET, PUT, DELETE" : "GET, POST" });
      res.end();
    }
  } catch (error) {
    if (error instanceof ProjectNotFound) json({ error: error.message }, 404);
    else if (error instanceof RevisionConflict)
      json({ error: error.message, revision: error.actual }, 409);
    else if (
      error instanceof BadRequest ||
      error instanceof TypeError ||
      error instanceof RangeError
    )
      json({ error: error.message }, 400);
    else throw error;
  }
  return true;
}
