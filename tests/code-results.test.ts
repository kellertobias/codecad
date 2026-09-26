import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SketchSolver } from "../src/document/sketch-solver.js";
import type { CadDocument, InstanceFeature } from "../src/document/schema.js";
import { codeInstances, type CodeResult } from "../src/document/code-part.js";
import type { ViewerManifest } from "../src/document/viewer.js";
import { buildCodeResult } from "../src/kernel/code-parts.js";
import { openWorkspace, type Workspace } from "../src/workspace.js";
import { openCodeResults, type CodeResultStore } from "../src/code-results.js";
import { handleCodeResults } from "../src/code-results-api.js";
import { handleOutputs } from "../src/outputs-api.js";
import { viewerService, type ViewerService } from "../src/viewer-api.js";
import { openCutProgress } from "../src/cut-progress.js";
import { JobQueue } from "../src/jobs.js";
import { insertInstance } from "../src/document/library.js";
import { openLibrary } from "../src/library.js";
import { extrude, rectangle, solvedDocument } from "./support/documents.js";
import { codePart, plateSource, runCode } from "./support/code.js";

let solver: SketchSolver;
let server: Server;
let workspace: Workspace;
let store: CodeResultStore;
let viewer: ViewerService;
let directory = "";
let base = "";
let project = "";
let document: CadDocument;
let result: CodeResult;

before(async () => {
  solver = await SketchSolver.create();
  directory = await mkdtemp(join(tmpdir(), "codecad-results-"));
  workspace = openWorkspace(":memory:");
  store = openCodeResults(join(directory, "results"));
  const jobs = new JobQueue({ concurrency: 1 });
  const progress = openCutProgress(":memory:");
  viewer = viewerService({
    directory: join(directory, "viewer"),
    jobs,
    stores: () => ({ workspace, progress, codeResults: store }),
  });
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const trusted = () => req.headers["x-test"] === "yes";
    try {
      if (
        await handleOutputs(req, res, url, {
          workspace,
          jobs,
          codeResults: store,
        })
      )
        return;
      if (await viewer.handle(req, res, url, { owner: "local", trusted }))
        return;
      if (
        await handleCodeResults(req, res, url, store, trusted, () => {
          void viewer.refreshRegenerated();
        })
      )
        return;
      res.writeHead(404).end();
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // A door with a code plate mated onto it, 90 wide.
  const library = openLibrary(":memory:");
  const item = library.create(
    { name: "Plate" },
    { code: await codePart(plateSource), exposed: ["w"] },
  );
  const inserted = insertInstance(
    solvedDocument(solver, {}, [
      rectangle("d", "XY", "0", "0", "400", "600"),
      extrude("door", "d", { name: "Door" }),
    ]),
    { id: item.id, name: item.name },
    library.version(item.id, 1),
  );
  document = {
    ...inserted.document,
    features: inserted.document.features.map((f) =>
      f.id === inserted.id
        ? ({
            ...f,
            values: { w: "90" },
            mate: {
              interface: "mount",
              target: { body: "door:0", origin: "door", role: "end" },
              at: ["100", "200"],
            },
          } as InstanceFeature)
        : f,
    ),
  };
  library.close();
  project = workspace.create("Door", { ...document }).id;
  const [need] = codeInstances(document);
  result = await buildCodeResult(
    await runCode(need!.pinned.code.source, need!.values),
    need!.key!,
  );
});
after(async () => {
  server.close();
  workspace.close();
  await store.close();
  solver.dispose();
  await rm(directory, { recursive: true, force: true });
});

const put = (key: string, body: string, trusted = true) =>
  fetch(`${base}/api/code-results/${key}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...(trusted ? { "x-test": "yes" } : {}),
    },
    body,
  });
const error = async (response: Response) =>
  ((await response.json()) as { error: string }).error;

test("server jobs say a code part needs regeneration until its result is stored", async () => {
  const bom = await fetch(
    `${base}/api/projects/${project}/outputs/bom?format=csv`,
  );
  assert.equal(bom.status, 409);
  assert.match(await error(bom), /Plate needs regeneration in the editor/);
  const manifest = (await (
    await fetch(`${base}/api/projects/${project}/viewer`)
  ).json()) as ViewerManifest;
  assert.equal(manifest.needsRegeneration, true);
  assert.match(manifest.problems.join("\n"), /needs regeneration/);
  // Only the door is there.
  assert.deepEqual(
    manifest.parts.map((p) => p.body),
    ["door:0"],
  );

  const stored = await put(result.key, JSON.stringify(result));
  assert.equal(stored.status, 201);
  assert.deepEqual(await stored.json(), { key: result.key, bodies: 1 });
  const got = await fetch(`${base}/api/code-results/${result.key}`);
  assert.deepEqual(await got.json(), result);

  const after = await fetch(
    `${base}/api/projects/${project}/outputs/bom?format=csv`,
  );
  assert.equal(after.status, 200);
  const csv = await after.text();
  assert.match(csv, /Plate · Plate/);
  assert.match(csv, /"hardware","Screw","","Ø3","2"/);
  // The viewer revision built without it is built again.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const rebuilt = (await (
    await fetch(`${base}/api/projects/${project}/viewer`)
  ).json()) as ViewerManifest;
  assert.equal(rebuilt.needsRegeneration, undefined);
  assert.deepEqual(rebuilt.problems, []);
  assert.equal(rebuilt.parts.length, 2);
});

test("malformed, oversized and foreign uploads are refused", async () => {
  const key = "0".repeat(28);
  const good = JSON.stringify({ ...result, key });
  assert.equal((await put(key, good, false)).status, 403);
  const notJson = await put(key, "{nope");
  assert.equal(notJson.status, 400);
  assert.match(await error(notJson), /not JSON/);
  const wrongKey = await put(key, JSON.stringify(result));
  assert.equal(wrongKey.status, 400);
  assert.match(await error(wrongKey), /another key/);
  const notResult = await put(key, JSON.stringify({ key, format: "x" }));
  assert.match(await error(notResult), /not a CodeCAD code-part result/);
  const badShape = await put(
    key,
    JSON.stringify({
      ...result,
      key,
      bodies: [{ ...result.bodies[0], brep: "CASCADE Topology V3\nrubbish" }],
    }),
  );
  assert.equal(badShape.status, 400);
  assert.match(await error(badShape), /geometry does not read/);
  const badRecipe = await put(
    key,
    JSON.stringify({
      ...result,
      key,
      bodies: [
        {
          ...result.bodies[0],
          machining: [
            {
              kind: "drill",
              recipe: { kind: "step", path: "/etc/passwd" },
              diameter: 3,
              depth: 3,
            },
          ],
        },
      ],
    }),
  );
  assert.equal(badRecipe.status, 400);
  const huge = await put(key, "x".repeat(17 * 1024 * 1024)).catch(
    () => undefined,
  );
  // Refused before it is read to the end (or the connection is cut).
  assert.ok(!huge || huge.status === 413);
  assert.equal(
    (await fetch(`${base}/api/code-results/${key}`)).status,
    404,
    "nothing was stored",
  );
  assert.equal((await fetch(`${base}/api/code-results/nope`)).status, 400);
});

test("a check that takes too long is ended without harm", async () => {
  const slow = openCodeResults(join(directory, "slow"), { timeoutMs: 1 });
  const key = "1".repeat(28);
  await assert.rejects(slow.put({ ...result, key }), /took too long/);
  assert.equal(await slow.has(key), false);
  // A fresh worker takes over for the next check.
  const patient = openCodeResults(join(directory, "slow"));
  await patient.put({ ...result, key });
  assert.equal(await patient.has(key), true);
  await slow.close();
  await patient.close();
});
