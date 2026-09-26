// HTTP routes for the part library:
//
//   GET    /api/library                      list
//   POST   /api/library                      create  { name, description?, tags?, document, exposed, thumbnail? }
//   GET    /api/library/:id                  the item and its versions
//   PUT    /api/library/:id                  rename, describe, tag
//   DELETE /api/library/:id                  delete
//   POST   /api/library/:id/versions         save a new version { document, exposed, note?, thumbnail? }
//   GET    /api/library/:id/versions/:n      one version's document
//   GET    /api/library/:id/file             the item as one file
//   POST   /api/library/import               a file, as a new item
import type { IncomingMessage, ServerResponse } from "node:http";
import { LibraryItemNotFound, type Library } from "./library.js";
import { LibraryError } from "./document/library-file.js";
import { BadRequest, readJson } from "./projects-api.js";

const id = "([0-9a-f-]{36})";

export async function handleLibrary(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  library: Library,
  trusted: () => boolean,
): Promise<boolean> {
  const path = url.pathname;
  if (path !== "/api/library" && !path.startsWith("/api/library/"))
    return false;
  const method = req.method ?? "GET";
  const json = (value: unknown, status = 200) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
  };
  if (method !== "GET" && !trusted()) {
    json({ error: "Invalid editor session" }, 403);
    return true;
  }
  const match = (pattern: string) => new RegExp(`^${pattern}$`).exec(path);
  const details = (body: Record<string, unknown>) => ({
    ...(typeof body.name === "string" ? { name: body.name } : {}),
    ...(typeof body.description === "string"
      ? { description: body.description }
      : {}),
    ...(Array.isArray(body.tags) ? { tags: body.tags as string[] } : {}),
  });
  const version = (body: Record<string, unknown>) => ({
    document: body.document,
    exposed: body.exposed ?? [],
    ...(typeof body.note === "string" ? { note: body.note } : {}),
    ...(typeof body.thumbnail === "string"
      ? { thumbnail: body.thumbnail }
      : {}),
  });
  try {
    let m: RegExpExecArray | null;
    if (path === "/api/library" && method === "GET")
      json({ items: library.list() });
    else if (path === "/api/library" && method === "POST") {
      const body = await readJson(req);
      json(
        library.create(
          { name: String(body.name ?? ""), ...details(body) },
          version(body),
        ),
        201,
      );
    } else if (path === "/api/library/import" && method === "POST")
      json(library.importFile(await readJson(req)), 201);
    else if ((m = match(`/api/library/${id}`))) {
      if (method === "GET") json(library.get(m[1]!));
      else if (method === "PUT")
        json(library.update(m[1]!, details(await readJson(req))));
      else if (method === "DELETE") {
        library.delete(m[1]!);
        res.writeHead(204).end();
      } else json({ error: "Method not allowed" }, 405);
    } else if ((m = match(`/api/library/${id}/versions`)) && method === "POST")
      json(library.addVersion(m[1]!, version(await readJson(req))), 201);
    else if (
      (m = match(`/api/library/${id}/versions/(\\d+)`)) &&
      method === "GET"
    )
      json(library.version(m[1]!, Number(m[2])));
    else if ((m = match(`/api/library/${id}/file`)) && method === "GET") {
      const file = library.exportFile(m[1]!);
      const name = file.item.name.replace(/[^a-zA-Z0-9_.-]+/g, "_") || "item";
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${name}.codecad-part.json"`,
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(file, null, 2));
    } else json({ error: "Not found" }, 404);
  } catch (error) {
    if (error instanceof LibraryItemNotFound)
      json({ error: error.message }, 404);
    else if (error instanceof LibraryError || error instanceof BadRequest)
      json({ error: error.message }, 400);
    else throw error;
  }
  return true;
}
