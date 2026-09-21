import { createServer, type ServerResponse } from "node:http";
import { readFile, writeFile, mkdir, stat, cp, rename } from "node:fs/promises";
import { watch } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve, join, dirname, basename } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { build } from "esbuild";
import { editorService } from "./editor-service.js";
import { resolveParameters, type ParameterSchema } from "./parameters.js";
import { drawingPlanFile, validateDrawingPlan } from "./drawing-plan.js";

const root = resolve(new URL("..", import.meta.url).pathname);
const entry = resolve(
  process.argv[2] ?? join(root, "examples/kitchen-cabinet/index.ts"),
);
let port = Number(process.env.PORT ?? 4317);
const token = randomBytes(24).toString("hex");
const storage = process.env.CODECAD_STORAGE ?? join(root, ".codecad"),
  ui = join(storage, "ui");
await mkdir(ui, { recursive: true });
const parameterFile = join(
  storage,
  "parameters",
  createHash("sha256").update(entry).digest("hex") + ".json",
);
const planFile = drawingPlanFile(entry);
// Which panes were open last time this project was looked at. It belongs to
// the project rather than the browser, because every session gets a fresh
// port and so a fresh origin: anything kept in the page's own storage would be
// gone the next time the project is opened.
const viewFile = join(
  storage,
  "views",
  createHash("sha256").update(entry).digest("hex") + ".json",
);
const paneNames = ["code", "parts"] as const;
type PaneState = Partial<Record<(typeof paneNames)[number], boolean>>;
// Never fatal: a missing or damaged file just means no preference yet.
const readPanes = async (): Promise<PaneState> => {
  try {
    return validatePanes(JSON.parse(await readFile(viewFile, "utf8")));
  } catch {
    return {};
  }
};
/** Only the panes we know about, and only as booleans. */
function validatePanes(value: unknown): PaneState {
  if (!value || typeof value !== "object")
    throw new Error("Expected an object");
  const panes: PaneState = {};
  for (const name of paneNames) {
    const open = (value as Record<string, unknown>)[name];
    if (open === undefined) continue;
    if (typeof open !== "boolean")
      throw new Error(`Pane ${name} must be a boolean`);
    panes[name] = open;
  }
  return panes;
}
let parameterValues: Record<string, number | boolean | string> = {};
try {
  parameterValues = JSON.parse(await readFile(parameterFile, "utf8"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
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
const snapshotParameters = new Map<string, string>();
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
  const activeParameters = JSON.stringify(parameterValues);
  snapshotParameters.set(directory, activeParameters);
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
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        CODECAD_LAZY_EXPORTS: "1",
        CODECAD_PARAMETER_VALUES: activeParameters,
      },
    },
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
const generating = new Map<string, Promise<void>>();
async function generateArtifact(
  name: string,
  directory: string,
): Promise<void> {
  const path = join(directory, name);
  try {
    await stat(path);
    return;
  } catch {
    /* Not generated yet. */
  }
  // One export worker per snapshot avoids overlapping writes when two
  // formats of the same report are requested at the same time.
  const previous = generating.get(directory);
  const running = (previous ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      try {
        await stat(path);
        return;
      } catch {
        /* Another request may have completed it. */
      }
      await new Promise<void>((resolve, reject) => {
        const native = process.env.CODECAD_COMPILER !== "esbuild";
        const child = spawn(
          process.execPath,
          [
            "--enable-source-maps",
            "--import",
            native ? join(root, "src/native-loader.mjs") : "tsx",
            join(root, "src/worker.ts"),
            entry,
            directory,
          ],
          {
            cwd: root,
            stdio: ["ignore", "pipe", "pipe"],
            env: {
              ...process.env,
              CODECAD_EXPORT_ONLY: name,
              CODECAD_PARAMETER_VALUES:
                snapshotParameters.get(directory) ?? "{}",
              ...(native
                ? { CODECAD_NATIVE_OUTPUT: join(directory, ".native/js") }
                : {}),
            },
          },
        );
        let log = "";
        for (const stream of [child.stdout, child.stderr])
          stream?.on("data", (chunk: Buffer) => {
            log = (log + chunk.toString()).slice(-4000);
          });
        const timeout = setTimeout(() => child.kill("SIGTERM"), 120000);
        child.on("error", reject);
        child.on("close", (code) => {
          clearTimeout(timeout);
          if (code === 0) resolve();
          else
            reject(
              new Error(`Export failed (${code ?? "terminated"}): ${log}`),
            );
        });
      });
    });
  generating.set(directory, running);
  try {
    await running;
  } finally {
    if (generating.get(directory) === running) generating.delete(directory);
  }
  await stat(path);
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
    if (url.pathname === "/api/drawing-plan" && req.method === "GET") {
      try {
        const source = await readFile(planFile, "utf8");
        json({
          plan: validateDrawingPlan(JSON.parse(source)),
          version: hash(source),
          file: planFile,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          json({
            plan: { version: 1, title: "", items: [] },
            version: "",
            file: planFile,
          });
        else throw error;
      }
      return;
    }
    if (url.pathname === "/api/view" && req.method === "GET") {
      json({ panes: await readPanes() });
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
      if (url.pathname === "/api/view") {
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 1_000) {
            json({ error: "View state exceeds 1 KB" }, 413);
            return;
          }
        }
        try {
          // Merge, so a page that only knows about one pane cannot drop the
          // other one's state.
          const panes = {
            ...(await readPanes()),
            ...validatePanes(JSON.parse(body)),
          };
          await mkdir(dirname(viewFile), { recursive: true });
          const staged = viewFile + ".tmp-" + randomBytes(6).toString("hex");
          await writeFile(staged, JSON.stringify(panes));
          await rename(staged, viewFile);
          json({ panes });
        } catch (error) {
          json(
            { error: error instanceof Error ? error.message : String(error) },
            400,
          );
        }
        return;
      }
      if (url.pathname === "/api/drawing-plan") {
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 250_000) {
            json({ error: "Drawing plan exceeds 250 KB" }, 413);
            return;
          }
        }
        try {
          const input = JSON.parse(body);
          let previous = "";
          try {
            previous = await readFile(planFile, "utf8");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          if (input.version !== (previous ? hash(previous) : "")) {
            json(
              { error: "Drawing plan changed on disk. Reload before saving." },
              409,
            );
            return;
          }
          const plan = validateDrawingPlan(input.plan);
          const serialized = JSON.stringify(plan, null, 2) + "\n";
          const staged = planFile + ".tmp-" + randomBytes(6).toString("hex");
          await writeFile(staged, serialized);
          await rename(staged, planFile);
          json({ version: hash(serialized), file: planFile });
          // The sheet is a build output: refresh its hidden-line views and PDF.
          schedule();
        } catch (error) {
          json(
            { error: error instanceof Error ? error.message : String(error) },
            400,
          );
        }
        return;
      }
      if (url.pathname === "/api/parameters") {
        if (!currentDirectory) {
          json({ error: "Model is building" }, 503);
          return;
        }
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 100_000) {
            json({ error: "Parameter request exceeds 100 KB" }, 413);
            return;
          }
        }
        try {
          const input = JSON.parse(body);
          const model = JSON.parse(
            await readFile(join(currentDirectory, "model.json"), "utf8"),
          );
          if (!model.parameters) throw new Error("Project has no parameters");
          const values = resolveParameters(
            model.parameters.definitions as ParameterSchema,
            input.values,
          );
          await mkdir(dirname(parameterFile), { recursive: true });
          const staged =
            parameterFile + ".tmp-" + randomBytes(6).toString("hex");
          await writeFile(staged, JSON.stringify(values));
          await rename(staged, parameterFile);
          parameterValues = values;
          schedule();
          json({ values });
        } catch (error) {
          json(
            { error: error instanceof Error ? error.message : String(error) },
            400,
          );
        }
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
      const activeDirectory = currentDirectory;
      const manifest = JSON.parse(
        await readFile(join(activeDirectory, "model.json"), "utf8"),
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
      await generateArtifact(name, activeDirectory);
      res.writeHead(200, {
        "Content-Type": mime,
        "Cache-Control": "no-store",
        ...(url.searchParams.has("download")
          ? {
              "Content-Disposition": `attachment; filename="${name.replaceAll('"', "_")}"`,
            }
          : {}),
      });
      res.end(await readFile(join(activeDirectory, name)));
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
      "/project-tabs.css": [join(root, "web/project-tabs.css"), "text/css"],
      "/codecad-icon.png": [join(root, "desktop/icon.png"), "image/png"],
      "/previews/cabinet.png": [
        join(root, "desktop/previews/cabinet.png"),
        "image/png",
      ],
      "/previews/keyboard.png": [
        join(root, "desktop/previews/keyboard.png"),
        "image/png",
      ],
      "/previews/apartment.png": [
        join(root, "desktop/previews/apartment.png"),
        "image/png",
      ],
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
