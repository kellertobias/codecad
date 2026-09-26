import { createServer, type ServerResponse } from "node:http";
import { readFile, writeFile, mkdir, stat, cp, rename } from "node:fs/promises";
import { watch } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve, join, dirname, basename } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { build, context, type BuildContext } from "esbuild";
import { editorService } from "./editor-service.js";
import { progressReader, type Progress } from "./progress.js";
import { resolveParameters, type ParameterSchema } from "./parameters.js";
import {
  allowedHostNames,
  hostAllowed,
  isLoopbackAddress,
  reachableAddresses,
} from "./network.js";
import { handleProjects } from "./projects-api.js";
import { handleOutputs } from "./outputs-api.js";
import { handleLibrary } from "./library-api.js";
import { ownerStores } from "./owner-stores.js";
import { openAccounts } from "./accounts.js";
import { cookie, handleAccounts, sessionCookie } from "./accounts-api.js";
import { openShares } from "./shares.js";
import { handleShares } from "./shares-api.js";
import { viewerService } from "./viewer-api.js";
import { handleCodeResults } from "./code-results-api.js";
import { JobQueue } from "./jobs.js";
import {
  kernelBundleOptions,
  copyKernelWasm,
} from "../scripts/web-bundles.mjs";
import {
  drawingPlanFile,
  emptyDrawingPlan,
  validateDrawingPlan,
} from "./drawing-plan.js";

const root = resolve(new URL("..", import.meta.url).pathname);
const entry = resolve(
  process.argv[2] ?? join(root, "examples/kitchen-cabinet/index.ts"),
);
let port = Number(process.env.PORT ?? 4317);
// 127.0.0.1 unless CODECAD_HOST opens the server to the network, e.g.
// CODECAD_HOST=0.0.0.0 so phones on the LAN can view drawings and cut lists.
const bindHost = process.env.CODECAD_HOST ?? "127.0.0.1";
const hostNames = allowedHostNames(
  bindHost,
  (process.env.CODECAD_ALLOWED_HOSTS ?? "").split(","),
);
const token = randomBytes(24).toString("hex");
const storage = process.env.CODECAD_STORAGE ?? join(root, ".codecad"),
  ui = join(storage, "ui");
await mkdir(ui, { recursive: true });
// Projects, libraries and results by owner. With CODECAD_ACCOUNTS=1 people
// sign in with passkeys and each has their own; otherwise everything is
// the machine's ("local").
const stores = ownerStores(storage, {
  resultQuotaBytes:
    Number(process.env.CODECAD_RESULT_QUOTA_MB ?? 512) * 1024 * 1024,
});
const accounts =
  process.env.CODECAD_ACCOUNTS === "1"
    ? openAccounts(join(storage, "workspace.sqlite"))
    : undefined;
const shares = openShares(join(storage, "workspace.sqlite"));
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
/** Identifies Studio's current build: the page reloads itself when it sees
 * a different one. Seeded from the start time so a restarted server (the
 * dev script in scripts/dev.mjs restarts it when server.ts changes) also
 * reloads the page. */
let bundleVersion = Date.now();
let bundleChanged = () => {};
let bundle: BuildContext | undefined;
let kernelBundles: BuildContext | undefined;
if (process.env.CODECAD_DESKTOP) {
  await cp(join(root, "ui"), ui, { recursive: true });
} else {
  // A watch context rebuilds app.js whenever a file it bundles changes, so
  // Studio changes show up without restarting the server.
  bundle = await context({
    entryPoints: [join(root, "web/app.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    outfile: join(ui, "app.js"),
    sourcemap: true,
    loader: { ".ttf": "dataurl" },
    plugins: [
      {
        name: "studio-reload",
        setup(build) {
          let first = true;
          build.onEnd((result) => {
            if (first) first = false;
            else if (!result.errors.length) bundleChanged();
          });
        },
      },
    ],
  });
  await bundle.rebuild();
  await bundle.watch();
  const kernelBundle = await context(kernelBundleOptions(root, ui));
  await kernelBundle.rebuild();
  await kernelBundle.watch();
  kernelBundles = kernelBundle;
  await copyKernelWasm(root, ui);
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
let state: {
  phase: string;
  generation: number;
  message: string;
  log: string;
  /** How far the running build is, from 0 to 1, while it reports it. */
  progress?: number;
} = { phase: "starting", generation: 0, message: "Loading project", log: "" };
/** Slow work done on request, such as exports. Every page hears about the
 * queue's progress through the event stream. */
const jobs = new JobQueue({
  concurrency: 2,
  onChange: () => broadcast(),
  // Per owner: one job runs at a time, a few more may wait.
  maxPerLane: 8,
});
const viewer = viewerService({
  directory: join(storage, "viewer"),
  jobs,
  stores: (owner) => stores.get(owner),
  shares,
});
/** Files being generated on request, by name, so each download can show
 * its progress. */
const exporting = (): Record<string, Progress> =>
  Object.fromEntries(
    jobs.snapshot().map((job) => [job.label, job.progress as Progress]),
  );
const announced = () =>
  JSON.stringify({
    ...state,
    exporting: exporting(),
    bundle: bundleVersion,
  });
function broadcast() {
  for (const listener of listeners)
    listener.write("data: " + announced() + "\n\n");
}
bundleChanged = () => {
  bundleVersion++;
  broadcast();
};
function rebuild() {
  const id = ++generation;
  if (child) child.kill("SIGTERM");
  const directory = join(storage, "run-" + id + "-" + Date.now());
  const activeParameters = JSON.stringify(parameterValues);
  snapshotParameters.set(directory, activeParameters);
  state = {
    phase: "building",
    generation: id,
    message: "Building the model",
    log: "",
    progress: 0,
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
        CODECAD_PROGRESS: "1",
        CODECAD_PARAMETER_VALUES: activeParameters,
      },
    },
  );
  child = processHandle;
  let log = "";
  const collect = (text: string | Buffer) => {
    log = (log + text.toString()).slice(-20000);
  };
  processHandle.stdout?.on(
    "data",
    progressReader(({ fraction, message }) => {
      if (id !== generation || state.phase !== "building") return;
      state = { ...state, message, progress: fraction };
      broadcast();
    }, collect),
  );
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
// Stylesheets and the page are served straight from disk, so a change to
// them only needs the page to reload.
if (!process.env.CODECAD_DESKTOP)
  watchers.push(
    watch(join(root, "web"), (_event, file) => {
      if (file?.endsWith(".css") || file?.endsWith(".html")) bundleChanged();
    }),
  );
function hash(text: string) {
  return createHash("sha256").update(text).digest("hex");
}
async function generateArtifact(
  name: string,
  directory: string,
): Promise<void> {
  const path = join(directory, name);
  const exists = () =>
    stat(path).then(
      () => true,
      () => false,
    );
  if (await exists()) return;
  // One lane per build directory: overlapping export workers would write
  // into the same snapshot when two formats of one report are requested.
  await jobs.run({
    key: `${directory}\0${name}`,
    lane: directory,
    label: name,
    work: async (report) => {
      // Another request may have made it while this one waited.
      if (await exists()) return;
      await exportArtifact(name, directory, report);
    },
  });
  await stat(path);
}
/** Runs a worker that writes one lazy output of a build directory. */
function exportArtifact(
  name: string,
  directory: string,
  report: (progress: Progress) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
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
          CODECAD_PROGRESS: "1",
          CODECAD_PARAMETER_VALUES: snapshotParameters.get(directory) ?? "{}",
          ...(native
            ? { CODECAD_NATIVE_OUTPUT: join(directory, ".native/js") }
            : {}),
        },
      },
    );
    let log = "";
    const collect = (chunk: Buffer | string) => {
      log = (log + chunk.toString()).slice(-4000);
    };
    child.stdout?.on("data", progressReader(report, collect));
    child.stderr?.on("data", collect);
    const timeout = setTimeout(() => child.kill("SIGTERM"), 120000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`Export failed (${code ?? "terminated"}): ${log}`));
    });
  });
}
/** The browser editor, built by `npm run app:build` into app/dist. Paths
 * that are not files fall back to its index page, which routes itself. */
const appRoot = join(root, "app/dist");
const appTypes: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".wasm": "application/wasm",
};
async function serveApp(pathname: string, res: ServerResponse) {
  const relative = decodeURIComponent(pathname.slice("/app/".length));
  const requested = resolve(appRoot, relative);
  const file =
    requested.startsWith(appRoot + "/") &&
    (await stat(requested).then(
      (info) => info.isFile(),
      () => false,
    ))
      ? requested
      : join(appRoot, "index.html");
  let data: Buffer;
  try {
    data = await readFile(file);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("The editor is not built yet: run npm run app:build");
    return;
  }
  const extension = file.slice(file.lastIndexOf("."));
  res.writeHead(200, {
    "Content-Type": appTypes[extension] ?? "application/octet-stream",
    // Vite puts a content hash in asset names; the index must stay fresh.
    "Cache-Control": file.includes("/assets/")
      ? "public, max-age=31536000, immutable"
      : "no-store",
  });
  res.end(data);
}
const server = createServer(async (req, res) => {
  try {
    if (!hostAllowed(req.headers.host, port, hostNames)) {
      res.writeHead(403).end();
      return;
    }
    // Changes need the session token and must come from a page served by
    // this server under the name the request was sent to. The host itself
    // was checked above.
    const trusted = () =>
      req.headers["x-codecad-token"] === token &&
      req.headers.origin === `http://${req.headers.host}`;
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
      res.write("data: " + announced() + "\n\n");
      req.on("close", () => listeners.delete(res));
      return;
    }
    // The session token that changes must carry. Pages served by this
    // server fetch it; other sites cannot, as the Host check above and the
    // browser's same-origin rules keep their requests out.
    if (url.pathname === "/api/session" && req.method === "GET") {
      json({ token });
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
            plan: emptyDrawingPlan(),
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
    // Accounts: who is asking decides whose projects they see.
    const user = accounts?.session(cookie(req, sessionCookie));
    const owner = accounts ? user?.id : "local";
    if (
      await handleAccounts(req, res, url, {
        accounts,
        user,
        trusted,
      })
    )
      return;
    // View links need no account.
    if (await viewer.handleShared(req, res, url)) return;
    if (
      !owner &&
      /^\/api\/(projects|library|code-results|shares)(\/|$)/.test(url.pathname)
    ) {
      json({ error: "Sign in first" }, 401);
      return;
    }
    if (owner) {
      const own = stores.get(owner);
      if (
        await handleOutputs(req, res, url, {
          workspace: own.workspace,
          jobs,
          codeResults: own.codeResults,
          owner,
        })
      )
        return;
      if (
        await handleCodeResults(req, res, url, own.codeResults, trusted, () => {
          void viewer.refreshRegenerated();
        })
      )
        return;
      if (
        await handleShares(req, res, url, {
          shares,
          workspace: own.workspace,
          owner,
          trusted,
        })
      )
        return;
      if (await viewer.handle(req, res, url, { owner, trusted })) return;
      if (await handleLibrary(req, res, url, own.library, trusted)) return;
      if (
        await handleProjects(req, res, url, own.workspace, trusted, (project) =>
          // Prebuilt now, so the phone finds the files ready.
          viewer
            .build(owner, project.id)
            .catch((error) =>
              console.error(`Viewer files for ${project.name}: ${error}`),
            ),
        )
      )
        return;
    }
    if (req.method === "POST") {
      if (!trusted()) {
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
        // The project source is TypeScript this server compiles and runs,
        // so only this machine may change it, even when the server is open
        // to the network.
        if (!isLoopbackAddress(req.socket.remoteAddress)) {
          json(
            { error: "Project source can only be edited on this machine" },
            403,
          );
          return;
        }
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
      // Studio asks for the file to be made first, so it can show progress,
      // and only then downloads it.
      if (url.searchParams.has("prepare")) {
        res.writeHead(204, { "Cache-Control": "no-store" }).end();
        return;
      }
      const data = await readFile(join(activeDirectory, name));
      res.writeHead(200, {
        "Content-Type": mime,
        "Content-Length": data.length,
        "Cache-Control": "no-store",
        ...(url.searchParams.has("download")
          ? {
              "Content-Disposition": `attachment; filename="${name.replaceAll('"', "_")}"`,
            }
          : {}),
      });
      res.end(data);
      return;
    }
    if (url.pathname === "/app" || url.pathname.startsWith("/app/")) {
      await serveApp(url.pathname, res);
      return;
    }
    // The mobile viewer is a page of the editor's build, under /p/ so its
    // service worker (/p/sw.js) can keep it for use offline.
    if (/^\/p\/[0-9a-f-]{36}\/view\/?$/.test(url.pathname)) {
      await serveApp("/app/viewer.html", res);
      return;
    }
    // A view link: the same viewer, for a project shared by its token.
    if (/^\/s\/[A-Za-z0-9_-]{32}\/?$/.test(url.pathname)) {
      await serveApp("/app/viewer.html", res);
      return;
    }
    if (url.pathname === "/p/sw.js" || url.pathname === "/s/sw.js") {
      await serveApp("/app/viewer-sw.js", res);
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
      "/kernel-probe": [join(root, "web/kernel-probe.html"), "text/html"],
      "/kernel-probe.js": [join(ui, "kernel-probe.js"), "text/javascript"],
      "/kernel.worker.js": [join(ui, "kernel.worker.js"), "text/javascript"],
      "/code-sandbox.js": [join(ui, "code-sandbox.js"), "text/javascript"],
      "/occt-wasm.wasm": [join(ui, "occt-wasm.wasm"), "application/wasm"],
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
      // The kernel binary is 22 MB and only changes with the occt-wasm
      // version, so the browser may keep it; everything else is rebuilt
      // while the server runs.
      "Cache-Control":
        resource[1] === "application/wasm"
          ? "public, max-age=86400"
          : "no-store",
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
server.listen(port, bindHost, () => {
  const address = server.address();
  if (address && typeof address !== "string") port = address.port;
  console.log(`CODECAD_READY:${port}`);
  console.log(
    `CodeCAD: ${reachableAddresses(bindHost, port).join("  ")}\nProject: ${entry}`,
  );
  rebuild();
});
function close() {
  clearTimeout(timer);
  child?.kill();
  void bundle?.dispose();
  void kernelBundles?.dispose();
  for (const watcher of watchers) watcher.close();
  for (const listener of listeners) listener.end();
  server.close();
  void stores.close();
  accounts?.close();
  shares.close();
  process.exit(0);
}
process.on("SIGINT", close);
process.on("SIGTERM", close);
