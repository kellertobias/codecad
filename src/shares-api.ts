// View links for a project (see shares.ts):
//
//   GET    /api/projects/:id/shares    the project's links
//   POST   /api/projects/:id/shares    a new link      { token, path }
//   DELETE /api/shares/:token          revoke it
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Shares } from "./shares.js";
import type { Workspace } from "./workspace.js";
import { ProjectNotFound } from "./workspace.js";

export async function handleShares(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  context: {
    readonly shares: Shares;
    readonly workspace: Workspace;
    readonly owner: string;
    readonly trusted: () => boolean;
  },
): Promise<boolean> {
  const project = /^\/api\/projects\/([0-9a-f-]{36})\/shares$/.exec(
    url.pathname,
  );
  const link = /^\/api\/shares\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname);
  if (!project && !link) return false;
  const { shares, workspace, owner, trusted } = context;
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
  const withPath = (share: { token: string }) => ({
    ...share,
    path: `/s/${share.token}`,
  });
  try {
    if (project) {
      const id = project[1]!;
      workspace.get(id);
      if (method === "GET")
        json({ shares: shares.list(owner, id).map(withPath) });
      else if (method === "POST") json(withPath(shares.create(owner, id)), 201);
      else res.writeHead(405, { Allow: "GET, POST" }).end();
    } else if (method === "DELETE") {
      if (shares.revoke(owner, link![1]!)) res.writeHead(204).end();
      else json({ error: "There is no such link" }, 404);
    } else res.writeHead(405, { Allow: "DELETE" }).end();
  } catch (error) {
    if (error instanceof ProjectNotFound)
      json({ error: "There is no such project" }, 404);
    else if (error instanceof RangeError) json({ error: error.message }, 400);
    else throw error;
  }
  return true;
}
