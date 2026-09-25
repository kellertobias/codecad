import { test } from "node:test";
import assert from "node:assert/strict";
import { JobQueue } from "../src/jobs.js";

/** A job body that waits until released, so tests control the order. */
function gate<T>(value: T) {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => (release = resolve));
  return { release, work: async () => (await opened, value) };
}

test("asking for a key that is already in progress joins that job", async () => {
  const queue = new JobQueue({ concurrency: 2 });
  let runs = 0;
  const slow = gate("pdf");
  const work = async () => (runs++, slow.work());
  const first = queue.run({ key: "rev-3/plan.pdf", label: "Plan", work });
  const second = queue.run({ key: "rev-3/plan.pdf", label: "Plan", work });
  slow.release();
  assert.deepEqual(await Promise.all([first, second]), ["pdf", "pdf"]);
  assert.equal(runs, 1);
});

test("jobs in one lane run one after another, other lanes run alongside", async () => {
  const queue = new JobQueue({ concurrency: 4 });
  const a = gate(1);
  const b = gate(2);
  const c = gate(3);
  const results = [
    queue.run({ key: "a", lane: "run-1", label: "A", work: a.work }),
    queue.run({ key: "b", lane: "run-1", label: "B", work: b.work }),
    queue.run({ key: "c", lane: "run-2", label: "C", work: c.work }),
  ];
  const states = () =>
    Object.fromEntries(queue.snapshot().map((job) => [job.key, job.state]));
  assert.deepEqual(states(), { a: "running", b: "queued", c: "running" });
  a.release();
  await results[0];
  assert.deepEqual(states(), { b: "running", c: "running" });
  b.release();
  c.release();
  assert.deepEqual(await Promise.all(results), [1, 2, 3]);
  assert.deepEqual(queue.snapshot(), []);
});

test("no more than `concurrency` jobs run at once", async () => {
  const queue = new JobQueue({ concurrency: 2 });
  const gates = [gate(0), gate(1), gate(2)];
  const results = gates.map((g, i) =>
    queue.run({ key: `job-${i}`, label: `Job ${i}`, work: g.work }),
  );
  assert.deepEqual(
    queue.snapshot().map((job) => job.state),
    ["running", "running", "queued"],
  );
  gates[1]!.release();
  await results[1];
  assert.deepEqual(
    queue.snapshot().map((job) => [job.key, job.state]),
    [
      ["job-0", "running"],
      ["job-2", "running"],
    ],
  );
  gates[0]!.release();
  gates[2]!.release();
  await Promise.all(results);
});

test("progress reaches the listener and a failure does not stop the queue", async () => {
  const seen: string[] = [];
  const queue = new JobQueue({
    concurrency: 1,
    onChange: () => {
      for (const job of queue.snapshot()) seen.push(job.progress.message);
    },
  });
  const failed = queue.run({
    key: "broken",
    label: "Broken export",
    work: async (report) => {
      report({ fraction: 0.5, message: "Half way" });
      throw new Error("kernel refused");
    },
  });
  const next = queue.run({
    key: "fine",
    label: "Fine export",
    work: async () => "ok",
  });
  await assert.rejects(failed, /kernel refused/);
  assert.equal(await next, "ok");
  assert.ok(seen.includes("Half way"));
  assert.ok(seen.includes("Waiting · Fine export"));
});
