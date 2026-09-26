import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SketchSolver } from "../src/document/sketch-solver.js";
import { openWorkspace, type Workspace } from "../src/workspace.js";
import { handleOutputs } from "../src/outputs-api.js";
import { JobQueue } from "../src/jobs.js";
import { shop } from "./support/documents.js";

let solver: SketchSolver;
let server: Server;
let workspace: Workspace;
let base = "";
let project = "";

before(async () => {
  solver = await SketchSolver.create();
  workspace = openWorkspace(":memory:");
  const jobs = new JobQueue({ concurrency: 1 });
  project = workspace.create("Shop", { ...shop(solver) }).id;
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!(await handleOutputs(req, res, url, workspace, jobs)))
      res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  workspace.close();
  solver.dispose();
});

const get = (kind: string, query: string) =>
  fetch(`${base}/api/projects/${project}/outputs/${kind}?${query}`);
const body = async (response: Response) =>
  new TextDecoder().decode(new Uint8Array(await response.arrayBuffer()));

test("drawings come as PDF, SVG and DXF from the saved document", async () => {
  const pdf = await get("drawing", "target=d1&format=pdf");
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
  assert.match(pdf.headers.get("content-disposition")!, /Assembly\.pdf/);
  assert.match(await body(pdf), /^%PDF-/);
  assert.match(
    await body(await get("drawing", "target=d1&format=dxf")),
    /SECTION_HATCH_ply/,
  );
  assert.match(
    await body(await get("drawing", "target=d1&format=svg")),
    /^<svg/,
  );
  // A part's manufacturing sheet.
  const sheet = await get("drawing", "target=part:bottom:0&format=pdf");
  assert.equal(sheet.status, 200);
});

test("layouts, parts, cut lists and the BOM come as their files", async () => {
  const layout = await body(await get("layout", "target=l1&format=dxf"));
  assert.match(layout, /STOCK_BOUNDARY/);
  assert.match(layout, /PART_OUTLINE/);
  const part = await body(await get("part", "target=bottom:0&format=dxf"));
  assert.match(part, /BLANK_OUTLINE/);
  const cuts = await body(await get("cutlist", "format=csv"));
  assert.match(cuts, /Bottom/);
  assert.equal((await get("cutlist", "format=pdf")).status, 200);
  const bom = await body(await get("bom", "format=csv"));
  assert.match(bom, /"hardware","Domino","","5x30","2"/);
});

test("unknown targets and formats are refused with a reason", async () => {
  const missing = await get("layout", "target=nope&format=dxf");
  assert.equal(missing.status, 400);
  assert.match(await body(missing), /no layout nope/);
  assert.equal((await get("bom", "format=pdf")).status, 400);
});
