import { createServer, type ServerResponse } from "node:http";
import { readFile, writeFile, mkdir, stat, cp } from "node:fs/promises";
import { watch } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve, join, dirname, basename } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { build } from "esbuild";
import { editorService } from "./editor-service.js";

const root = resolve(new URL("..", import.meta.url).pathname);
const entry = resolve(
  process.argv[2] ?? join(root, "examples/kitchen-cabinet.ts"),
);
let port = Number(process.env.PORT ?? 4317);
const token = randomBytes(24).toString("hex");
const storage = process.env.CODECAD_STORAGE ?? join(root, ".codecad"),
  ui = join(storage, "ui");
await mkdir(ui, { recursive: true });
if (process.env.CODECAD_DESKTOP) {
  await cp(join(root, "ui"), ui, { recursive: true });
} else {
  await build({
    entryPoints: [join(root, "web/app.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    outfile: join(ui, "app.js"),
    sourcemap: true,
    loader: { ".ttf": "dataurl" },
  });
  await build({
    entryPoints: {
      "ts.worker": join(
        root,
        "node_modules/monaco-editor/esm/vs/language/typescript/ts.worker.js",
      ),
      "editor.worker": join(
        root,
        "node_modules/monaco-editor/esm/vs/editor/editor.worker.js",
      ),
    },
    outdir: ui,
    bundle: true,
    format: "esm",
    platform: "browser",
  });
}
const languageService = await editorService(root, entry);
const listeners = new Set<ServerResponse>();
let generation = 0,
  currentDirectory = "",
  child: ChildProcess | undefined,
  timer: NodeJS.Timeout | undefined;
let state: { phase: string; generation: number; message: string; log: string } =
  { phase: "starting", generation: 0, message: "Loading project", log: "" };
function broadcast() {
  for (const listener of listeners)
    listener.write("data: " + JSON.stringify(state) + "\n\n");
}
function rebuild() {
  const id = ++generation;
  if (child) child.kill("SIGTERM");
  const directory = join(storage, "run-" + id + "-" + Date.now());
  state = {
    phase: "building",
    generation: id,
    message: "Compiling TypeScript and evaluating geometry",
    log: "",
  };
  broadcast();
  const processHandle = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      ...(process.env.CODECAD_DESKTOP
        ? ["--import", join(root, "src/desktop-loader.ts")]
        : []),
      join(
        root,
        process.env.CODECAD_COMPILER === "esbuild"
          ? "src/worker.ts"
          : "src/native-rebuild.ts",
      ),
      entry,
      directory,
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  child = processHandle;
  let log = "";
  const collect = (data: Buffer) => {
    log = (log + data.toString()).slice(-20000);
  };
  processHandle.stdout?.on("data", collect);
  processHandle.stderr?.on("data", collect);
  const timeout = setTimeout(() => {
    processHandle.kill("SIGTERM");
  }, 120000);
  processHandle.on("error", (error) => {
    if (id !== generation) return;
    state = { phase: "error", generation: id, message: error.message, log };
    broadcast();
  });
  processHandle.on("exit", async (code) => {
    clearTimeout(timeout);
    if (id !== generation) return;
    try {
      await stat(join(directory, "model.json"));
      currentDirectory = directory;
      state = {
        phase: code === 0 ? "ready" : "partial",
        generation: id,
        message:
          code === 0
            ? "Model and outputs are ready"
            : "Model ready; an output needs attention",
        log,
      };
    } catch {
      state = {
        phase: "error",
        generation: id,
        message: "Build failed — previous model retained",
        log,
      };
    }
    broadcast();
  });
}
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(rebuild, 350);
}
const watchers = [...new Set([dirname(entry), join(root, "src")])].map((path) =>
  watch(path, { recursive: true }, (_event, file) => {
    if (file?.endsWith(".ts")) schedule();
  }),
);
function hash(text: string) {
  return createHash("sha256").update(text).digest("hex");
}
const server = createServer(async (req, res) => {
  try {
    if (
      req.headers.host !== `127.0.0.1:${port}` &&
      req.headers.host !== `localhost:${port}`
    ) {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const json = (value: unknown, status = 200) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      listeners.add(res);
      res.write("data: " + JSON.stringify(state) + "\n\n");
      req.on("close", () => listeners.delete(res));
      return;
    }
    if (url.pathname === "/api/source" && req.method === "GET") {
      const source = await readFile(entry, "utf8");
      json({ source, version: hash(source), file: entry, token });
      return;
    }
    if (url.pathname === "/api/editor-libraries" && req.method === "GET") {
      json(languageService.libraries());
      return;
    }
    if (req.method === "POST") {
      const origin = req.headers.origin;
      if (
        req.headers["x-codecad-token"] !== token ||
        (origin !== `http://127.0.0.1:${port}` &&
          origin !== `http://localhost:${port}`)
      ) {
        json({ error: "Invalid editor session" }, 403);
        return;
      }
      if (url.pathname === "/api/rebuild") {
        schedule();
        json({ ok: true });
        return;
      }
      if (url.pathname === "/api/editor-completions") {
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 1_000_000) {
            json({ error: "Source exceeds 1 MB" }, 413);
            return;
          }
        }
        const input = JSON.parse(body);
        if (
          typeof input.source !== "string" ||
          !Number.isInteger(input.position) ||
          input.position < 0 ||
          input.position > input.source.length
        ) {
          json({ error: "Invalid completion request" }, 400);
          return;
        }
        json(languageService.complete(input.source, input.position));
        return;
      }
      if (url.pathname === "/api/source") {
        let data = "";
        for await (const chunk of req) {
          data += chunk;
          if (data.length > 1_000_000) {
            json({ error: "Source exceeds 1 MB" }, 413);
            return;
          }
        }
        const input = JSON.parse(data),
          source = await readFile(entry, "utf8");
        if (input.version !== hash(source)) {
          json({ error: "Source changed on disk. Reload before saving." }, 409);
          return;
        }
        if (typeof input.source !== "string") {
          json({ error: "Source must be text" }, 400);
          return;
        }
        await writeFile(entry, input.source);
        schedule();
        json({ version: hash(input.source) });
        return;
      }
      json({ error: "Unknown endpoint" }, 404);
      return;
    }
    if (url.pathname === "/api/model") {
      if (!currentDirectory) {
        json({ error: "Model is building" }, 503);
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(await readFile(join(currentDirectory, "model.json")));
      return;
    }
    if (url.pathname.startsWith("/artifacts/")) {
      const name = decodeURIComponent(url.pathname.slice(11));
      if (
        basename(name) !== name ||
        name.startsWith(".") ||
        !currentDirectory
      ) {
        res.writeHead(404).end();
        return;
      }
      const manifest = JSON.parse(
        await readFile(join(currentDirectory, "model.json"), "utf8"),
      );
      if (!manifest.files.some((f: { name: string }) => f.name === name)) {
        res.writeHead(404).end();
        return;
      }
      const mime = name.endsWith(".svg")
        ? "image/svg+xml"
        : name.endsWith(".pdf")
          ? "application/pdf"
          : name.endsWith(".csv")
            ? "text/csv"
            : "application/octet-stream";
      res.writeHead(200, {
        "Content-Type": mime,
        "Cache-Control": "no-store",
        ...(url.searchParams.has("download")
          ? {
              "Content-Disposition": `attachment; filename="${name.replaceAll('"', "_")}"`,
            }
          : {}),
      });
      res.end(await readFile(join(currentDirectory, name)));
      return;
    }
    const resources: Record<string, [string, string]> = {
      "/": [join(root, "web/index.html"), "text/html"],
      "/app.js": [join(ui, "app.js"), "text/javascript"],
      "/app.css": [join(ui, "app.css"), "text/css"],
      "/ts.worker.js": [join(ui, "ts.worker.js"), "text/javascript"],
      "/editor.worker.js": [join(ui, "editor.worker.js"), "text/javascript"],
      "/pdf.worker.mjs": [
        join(root, "node_modules/pdfjs-dist/build/pdf.worker.mjs"),
        "text/javascript",
      ],
      "/style.css": [join(root, "web/style.css"), "text/css"],
    };
    const resource = resources[url.pathname];
    if (!resource) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": resource[1],
      "Cache-Control": "no-store",
    });
    res.end(await readFile(resource[0]));
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
});
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address !== "string") port = address.port;
  console.log(`CODECAD_READY:${port}`);
  console.log(`CodeCAD: http://127.0.0.1:${port}\nProject: ${entry}`);
  rebuild();
});
function close() {
  clearTimeout(timer);
  child?.kill();
  for (const watcher of watchers) watcher.close();
  for (const listener of listeners) listener.end();
  server.close();
  process.exit(0);
}
process.on("SIGINT", close);
process.on("SIGTERM", close);
