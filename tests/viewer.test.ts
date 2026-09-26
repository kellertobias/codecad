import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SketchSolver } from "../src/document/sketch-solver.js";
import { openWorkspace, type Workspace } from "../src/workspace.js";
import { openCutProgress } from "../src/cut-progress.js";
import { handleProjects } from "../src/projects-api.js";
import { viewerService, type ViewerService } from "../src/viewer-api.js";
import { JobQueue } from "../src/jobs.js";
import { allCopies, type ViewerManifest } from "../src/document/viewer.js";
import { shop } from "./support/documents.js";

let solver: SketchSolver;
let server: Server;
let workspace: Workspace;
let viewer: ViewerService;
let directory = "";
let base = "";
let project = "";
const built: Promise<unknown>[] = [];

before(async () => {
  solver = await SketchSolver.create();
  directory = await mkdtemp(join(tmpdir(), "codecad-viewer-"));
  workspace = openWorkspace(":memory:");
  const jobs = new JobQueue({ concurrency: 1 });
  viewer = viewerService({
    directory,
    workspace,
    jobs,
    progress: openCutProgress(":memory:"),
  });
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const trusted = () => req.headers["x-test"] === "yes";
    if (await viewer.handle(req, res, url, trusted)) return;
    if (
      await handleProjects(req, res, url, workspace, trusted, (p) =>
        built.push(viewer.build(p.id)),
      )
    )
      return;
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.close();
  workspace.close();
  solver.dispose();
  await rm(directory, { recursive: true, force: true });
});

const call = (path: string, method = "GET", body?: unknown) =>
  fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", "x-test": "yes" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

test("saving a project prebuilds the viewer's files", async () => {
  const created = await call("/api/projects", "POST", {
    name: "Shop",
    document: shop(solver),
  });
  assert.equal(created.status, 201);
  project = ((await created.json()) as { id: string }).id;
  assert.equal(built.length, 1);
  await Promise.all(built);
  // Built already: the manifest is on disk before anyone asks.
  assert.deepEqual(await readdir(join(directory, project)), ["1"]);
  const manifest = (await (
    await call(`/api/projects/${project}/viewer`)
  ).json()) as ViewerManifest;
  assert.equal(manifest.revision, 1);
  assert.deepEqual(manifest.problems, []);
  assert.deepEqual(
    manifest.parts.map((p) => [p.body, p.name, p.quantity]),
    [
      ["side:0", "side", 1],
      ["bottom:0", "Bottom", 1],
    ],
  );
  // The project's drawing and a sheet per part.
  assert.deepEqual(
    manifest.drawings.map((d) => [d.id, d.kind]),
    [
      ["d1", "drawing"],
      ["part:side:0", "part"],
      ["part:bottom:0", "part"],
    ],
  );
  const layout = manifest.layouts[0]!;
  assert.deepEqual(
    layout.placements.map((p) => [p.part, p.copy]),
    [
      ["side:0", 0],
      ["bottom:0", 0],
    ],
  );
  assert.equal(layout.placements[1]!.outline[0]!.x, 400);
  assert.deepEqual(manifest.hardware, [
    { kind: "domino", size: "5x30", count: 2 },
  ]);
  const file = (name: string) =>
    call(`/api/projects/${project}/viewer/1/${name}`);
  const model = await file(manifest.model!);
  assert.equal(model.headers.get("content-type"), "model/gltf-binary");
  assert.match(model.headers.get("cache-control")!, /immutable/);
  const bytes = new Uint8Array(await model.arrayBuffer());
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), "glTF");
  // The meshes carry their body ids, for isolating parts on the phone.
  assert.match(new TextDecoder().decode(bytes), /"componentPath":"bottom:0"/);
  assert.match(await (await file(manifest.drawings[0]!.svg)).text(), /^<svg/);
  assert.equal(
    (await file(manifest.drawings[0]!.pdf)).headers.get("content-type"),
    "application/pdf",
  );
  assert.match(await (await file(manifest.cutList!.csv)).text(), /Bottom/);
  assert.equal((await file("nothing.svg")).status, 404);
});

test("cut progress is kept per revision", async () => {
  const path = `/api/projects/${project}/progress/1`;
  assert.deepEqual(await (await call(path)).json(), {
    revision: 1,
    done: [],
  });
  const ticked = await call(path, "POST", {
    changes: [
      { key: "side:0#0", done: true },
      { key: "bottom:0#0", done: true },
    ],
  });
  assert.deepEqual(((await ticked.json()) as { done: string[] }).done, [
    "bottom:0#0",
    "side:0#0",
  ]);
  await call(path, "POST", { changes: [{ key: "side:0#0", done: false }] });
  assert.deepEqual(
    ((await (await call(path)).json()) as { done: string[] }).done,
    ["bottom:0#0"],
  );
  // Changes need the session; reading does not.
  const refused = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ changes: [] }),
  });
  assert.equal(refused.status, 403);
  assert.equal((await call(path, "POST", { changes: [{}] })).status, 400);
  // A new revision starts unticked, and is built as it is saved.
  const saved = await call(`/api/projects/${project}`, "PUT", {
    basedOn: 1,
    document: shop(solver),
  });
  assert.equal(saved.status, 200);
  await Promise.all(built);
  assert.deepEqual(
    (
      (await (await call(`/api/projects/${project}/progress/2`)).json()) as {
        done: string[];
      }
    ).done,
    [],
  );
  const manifest = (await (
    await call(`/api/projects/${project}/viewer`)
  ).json()) as ViewerManifest;
  assert.equal(manifest.revision, 2);
  assert.deepEqual(allCopies(manifest.parts), ["side:0#0", "bottom:0#0"]);
});
