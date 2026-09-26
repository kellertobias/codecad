// Code-part results over HTTP (see code-results.ts):
//
//   GET /api/code-results/:key             a stored result, or 404
//   PUT /api/code-results/:key[?replace]   store one the editor made
//
// A PUT is refused with 413 past the size limit and 400 when the result is
// malformed or its geometry does not read; the server stays as it was.
import type { IncomingMessage, ServerResponse } from "node:http";
import { codeLimits, isResultKey } from "./document/code-part.js";
import { RejectedResult, type CodeResultStore } from "./code-results.js";

class TooLarge extends Error {}

async function readLimited(req: IncomingMessage, max: number) {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > max) throw new TooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > max) throw new TooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function handleCodeResults(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  store: CodeResultStore,
  trusted: () => boolean,
  stored: (key: string) => void = () => {},
): Promise<boolean> {
  const match = /^\/api\/code-results\/([^/]+)$/.exec(url.pathname);
  if (!match) return false;
  const key = match[1]!;
  const json = (value: unknown, status = 200) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
  };
  if (!isResultKey(key)) {
    json({ error: "Not a result key" }, 400);
    return true;
  }
  const method = req.method ?? "GET";
  if (method === "GET") {
    const result = await store.get(key);
    if (result) json(result);
    else json({ error: "No result for this key yet" }, 404);
    return true;
  }
  if (method !== "PUT") {
    res.writeHead(405, { Allow: "GET, PUT" }).end();
    return true;
  }
  if (!trusted()) {
    json({ error: "Invalid editor session" }, 403);
    return true;
  }
  try {
    const text = await readLimited(req, codeLimits.result);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new RejectedResult("The upload is not JSON");
    }
    if ((value as { key?: unknown } | null)?.key !== key)
      throw new RejectedResult("The upload is for another key");
    const result = await store.put(value, {
      replace: url.searchParams.has("replace"),
    });
    stored(result.key);
    json({ key: result.key, bodies: result.bodies.length }, 201);
  } catch (error) {
    if (error instanceof TooLarge) {
      res.setHeader("Connection", "close");
      json(
        {
          error: `A result may be at most ${codeLimits.result / 1024 / 1024} MB`,
        },
        413,
      );
      req.destroy();
    } else if (error instanceof RejectedResult)
      json({ error: error.message }, error.status);
    else throw error;
  }
  return true;
}
