import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SketchSolver } from "../src/document/sketch-solver.js";
import { ownerStores } from "../src/owner-stores.js";
import { openShares, type Shares } from "../src/shares.js";
import { handleShares } from "../src/shares-api.js";
import { handleProjects } from "../src/projects-api.js";
import { handleLibrary } from "../src/library-api.js";
import { viewerService, type ViewerService } from "../src/viewer-api.js";
import { JobQueue } from "../src/jobs.js";
import type { ViewerManifest } from "../src/document/viewer.js";
import { shop } from "./support/documents.js";

// Two users, as the server tells them apart (a header stands in for the
// session cookie here).
const ada = "11111111-1111-4111-8111-111111111111";
const bob = "22222222-2222-4222-8222-222222222222";

let solver: SketchSolver;
let server: Server;
let directory = "";
let base = "";
let stores: ReturnType<typeof ownerStores>;
let shares: Shares;
let viewer: ViewerService;

before(async () => {
  solver = await SketchSolver.create();
  directory = await mkdtemp(join(tmpdir(), "codecad-sharing-"));
  stores = ownerStores(directory);
  shares = openShares(join(directory, "workspace.sqlite"));
  const jobs = new JobQueue({ concurrency: 1 });
  viewer = viewerService({
    directory: join(directory, "viewer"),
    jobs,
    stores: (owner) => stores.get(owner),
    shares,
  });
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const trusted = () => true;
    if (await viewer.handleShared(req, res, url)) return;
    const owner = req.headers["x-user"] as string | undefined;
    if (!owner) return void res.writeHead(401).end();
    const own = stores.get(owner);
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
    if (await handleProjects(req, res, url, own.workspace, trusted)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.close();
  await stores.close();
  shares.close();
  solver.dispose();
  await rm(directory, { recursive: true, force: true });
});

const as = (
  user: string | undefined,
  path: string,
  method = "GET",
  body?: unknown,
) =>
  fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(user ? { "x-user": user } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

test("each user sees only their own projects and library", async () => {
  const made = await as(ada, "/api/projects", "POST", {
    name: "Ada's shelf",
    document: shop(solver),
  });
  const { id } = (await made.json()) as { id: string };
  await as(bob, "/api/projects", "POST", {
    name: "Bob's box",
    document: shop(solver),
  });
  const names = async (user: string) =>
    (
      (await (await as(user, "/api/projects")).json()) as {
        projects: { name: string }[];
      }
    ).projects.map((p) => p.name);
  assert.deepEqual(await names(ada), ["Ada's shelf"]);
  assert.deepEqual(await names(bob), ["Bob's box"]);
  // Another user's project is not there at all, not even its viewer.
  assert.equal((await as(bob, `/api/projects/${id}`)).status, 404);
  assert.equal((await as(bob, `/api/projects/${id}/viewer`)).status, 404);
  assert.equal(
    (
      await as(bob, `/api/projects/${id}`, "PUT", {
        basedOn: 1,
        document: shop(solver),
      })
    ).status,
    404,
  );
  await as(ada, "/api/library", "POST", {
    name: "Ada's part",
    document: shop(solver),
    exposed: [],
  });
  const library = async (user: string) =>
    ((await (await as(user, "/api/library")).json()) as { items: unknown[] })
      .items.length;
  assert.equal(await library(ada), 1);
  assert.equal(await library(bob), 0);
});

test("a view link shows the project without an account, read-only, until revoked", async () => {
  const { projects } = (await (await as(ada, "/api/projects")).json()) as {
    projects: { id: string }[];
  };
  const id = projects[0]!.id;
  // Only the owner can make one.
  assert.equal(
    (await as(bob, `/api/projects/${id}/shares`, "POST", {})).status,
    404,
  );
  const made = await as(ada, `/api/projects/${id}/shares`, "POST", {});
  assert.equal(made.status, 201);
  const link = (await made.json()) as { token: string; path: string };
  assert.equal(link.path, `/s/${link.token}`);

  const manifest = (await (
    await as(undefined, `/api/shared/${link.token}/viewer`)
  ).json()) as ViewerManifest;
  assert.equal(manifest.name, "Ada's shelf");
  const model = await as(
    undefined,
    `/api/shared/${link.token}/viewer/${manifest.revision}/${manifest.model}`,
  );
  assert.equal(model.status, 200);
  assert.equal(
    (
      await as(
        undefined,
        `/api/shared/${link.token}/progress/${manifest.revision}`,
      )
    ).status,
    200,
  );
  // Nothing can be changed through it.
  assert.equal(
    (
      await as(undefined, `/api/shared/${link.token}/progress/1`, "POST", {
        changes: [{ key: "side:0#0", done: true }],
      })
    ).status,
    405,
  );
  // Revoked, it is gone; guesses never worked.
  assert.equal(
    (await as(bob, `/api/shares/${link.token}`, "DELETE")).status,
    404,
  );
  assert.equal(
    (await as(ada, `/api/shares/${link.token}`, "DELETE")).status,
    204,
  );
  assert.equal(
    (await as(undefined, `/api/shared/${link.token}/viewer`)).status,
    404,
  );
  assert.equal(
    (await as(undefined, `/api/shared/${"x".repeat(32)}/viewer`)).status,
    404,
  );
});
