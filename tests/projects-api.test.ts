import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { openWorkspace, type Workspace } from "../src/workspace.js";
import { handleProjects } from "../src/projects-api.js";
import { allowedHostNames, hostAllowed } from "../src/network.js";

let server: Server;
let workspace: Workspace;
let base = "";
const token = "test-token";

before(async () => {
  workspace = openWorkspace(":memory:");
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const trusted = () =>
      req.headers["x-codecad-token"] === token &&
      req.headers.origin === `http://${req.headers.host}`;
    if (!(await handleProjects(req, res, url, workspace, trusted)))
      res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  workspace.close();
});

const call = (
  path: string,
  init: { method?: string; body?: unknown; trusted?: boolean } = {},
) =>
  fetch(base + path, {
    method: init.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(init.trusted === false
        ? {}
        : { "x-codecad-token": token, Origin: base }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

test("projects are created, listed, loaded, saved and deleted over HTTP", async () => {
  const created = await call("/api/projects", {
    method: "POST",
    body: { name: "Shelf", document: { schemaVersion: 1 } },
  });
  assert.equal(created.status, 201);
  const project = (await created.json()) as { id: string; revision: number };
  assert.equal(project.revision, 1);

  const list = (await (await call("/api/projects")).json()) as {
    projects: { id: string }[];
  };
  assert.deepEqual(
    list.projects.map((p) => p.id),
    [project.id],
  );

  const saved = await call(`/api/projects/${project.id}`, {
    method: "PUT",
    body: { basedOn: 1, document: { schemaVersion: 1, width: 800 } },
  });
  assert.equal(saved.status, 200);
  const loaded = (await (await call(`/api/projects/${project.id}`)).json()) as {
    revision: number;
    document: { width: number };
  };
  assert.equal(loaded.revision, 2);
  assert.equal(loaded.document.width, 800);

  const removed = await call(`/api/projects/${project.id}`, {
    method: "DELETE",
  });
  assert.equal(removed.status, 204);
  assert.equal((await call(`/api/projects/${project.id}`)).status, 404);
});

test("a save based on an old revision gets 409 and the current revision", async () => {
  const { id } = workspace.create("Desk", { schemaVersion: 1 });
  workspace.save(id, 1, { document: { schemaVersion: 1, changed: true } });
  const stale = await call(`/api/projects/${id}`, {
    method: "PUT",
    body: { basedOn: 1, document: { schemaVersion: 1 } },
  });
  assert.equal(stale.status, 409);
  assert.equal(((await stale.json()) as { revision: number }).revision, 2);
});

test("changes without the session token are refused, reads are not", async () => {
  const refused = await call("/api/projects", {
    method: "POST",
    body: { name: "Sneaky", document: {} },
    trusted: false,
  });
  assert.equal(refused.status, 403);
  assert.equal((await call("/api/projects", { trusted: false })).status, 200);
});

test("malformed requests are answered with 400", async () => {
  const missing = await call("/api/projects", {
    method: "POST",
    body: { name: "No document" },
  });
  assert.equal(missing.status, 400);
  const { id } = workspace.create("Bench", { schemaVersion: 1 });
  const noRevision = await call(`/api/projects/${id}`, {
    method: "PUT",
    body: { document: {} },
  });
  assert.equal(noRevision.status, 400);
});

test("the Host header must name this server", () => {
  const loopback = allowedHostNames("127.0.0.1");
  assert.ok(hostAllowed("localhost:4317", 4317, loopback));
  assert.ok(hostAllowed("127.0.0.1:4317", 4317, loopback));
  assert.ok(hostAllowed("[::1]:4317", 4317, loopback));
  assert.ok(!hostAllowed("localhost:9999", 4317, loopback));
  // A rebinding attack arrives with the attacker's own name.
  assert.ok(!hostAllowed("evil.example:4317", 4317, loopback));
  assert.ok(!hostAllowed(undefined, 4317, loopback));
  // Opened to the network, extra names can be allowed explicitly.
  const network = allowedHostNames("0.0.0.0", ["cad.home.arpa"]);
  assert.ok(hostAllowed("cad.home.arpa:4317", 4317, network));
  assert.ok(!hostAllowed("evil.example:4317", 4317, network));
});
