import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { SketchSolver } from "../src/document/sketch-solver.js";
import { JobLimitExceeded, outputJob, viewerJob } from "../src/kernel-jobs.js";
import { JobQueue, JobsBusy, ownerLane } from "../src/jobs.js";
import { shop } from "./support/documents.js";

let solver: SketchSolver;
before(async () => {
  solver = await SketchSolver.create();
});
after(() => solver.dispose());

const generous = { timeoutMs: 120_000, memoryMb: 4096 };

test("kernel jobs run in a worker and come back whole", async () => {
  const file = await outputJob(
    shop(solver),
    { kind: "bom", format: "csv" },
    [],
    generous,
  );
  assert.match(new TextDecoder().decode(file.bytes), /Domino/);
  const bundle = await viewerJob(
    shop(solver),
    { id: "p", name: "Shop", revision: 1 },
    [],
    undefined,
    generous,
  );
  assert.equal(bundle.manifest.parts.length, 2);
  assert.ok(bundle.files.get("model.glb")!.bytes.byteLength > 1000);
});

test("a job past its time or memory is stopped, and the next one runs", async () => {
  await assert.rejects(
    outputJob(
      shop(solver),
      { kind: "drawing", target: "d1", format: "pdf" },
      [],
      {
        timeoutMs: 50,
        memoryMb: 4096,
      },
    ),
    (error: Error) =>
      error instanceof JobLimitExceeded && /stopped after/.test(error.message),
  );
  // The kernel alone needs more than this.
  await assert.rejects(
    outputJob(shop(solver), { kind: "bom", format: "csv" }, [], {
      timeoutMs: 120_000,
      memoryMb: 40,
    }),
    (error: Error) =>
      error instanceof JobLimitExceeded &&
      /more than 40 MB/.test(error.message),
  );
  const file = await outputJob(
    shop(solver),
    { kind: "cutlist", format: "csv" },
    [],
    generous,
  );
  assert.match(new TextDecoder().decode(file.bytes), /Bottom/);
});

test("one owner cannot queue more than their share of jobs", async () => {
  const jobs = new JobQueue({ concurrency: 1, maxPerLane: 2 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const work = () => gate.then(() => "done");
  const a = jobs.run({ key: "a1", lane: ownerLane("a"), label: "", work });
  const b = jobs.run({ key: "a2", lane: ownerLane("a"), label: "", work });
  await assert.rejects(
    jobs.run({ key: "a3", lane: ownerLane("a"), label: "", work }),
    JobsBusy,
  );
  // Asking for a job already queued joins it; another owner still gets in.
  const again = jobs.run({ key: "a1", lane: ownerLane("a"), label: "", work });
  const other = jobs.run({ key: "b1", lane: ownerLane("b"), label: "", work });
  release();
  assert.deepEqual(await Promise.all([a, b, again, other]), [
    "done",
    "done",
    "done",
    "done",
  ]);
});
