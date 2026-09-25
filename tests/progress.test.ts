import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROGRESS_PREFIX,
  progressReader,
  type Progress,
} from "../src/progress.js";

test("build output splits into progress reports and log text", () => {
  const reports: Progress[] = [];
  let log = "";
  const read = progressReader(
    (report) => reports.push(report),
    (text) => (log += text),
  );
  const line =
    PROGRESS_PREFIX + JSON.stringify({ fraction: 0.5, message: "Half" });
  // Output arrives in arbitrary chunks, even mid-line.
  read("TypeScript 7 emit: 12 ms\n" + line.slice(0, 20));
  read(line.slice(20) + "\nwarning: thin\n");
  read(PROGRESS_PREFIX + "not json\n");
  assert.deepEqual(reports, [{ fraction: 0.5, message: "Half" }]);
  assert.equal(
    log,
    "TypeScript 7 emit: 12 ms\nwarning: thin\n" +
      PROGRESS_PREFIX +
      "not json\n",
  );
});

test("a partial line that is not a report is logged straight away", () => {
  let log = "";
  const read = progressReader(
    () => assert.fail("no report expected"),
    (text) => (log += text),
  );
  read("Compiling");
  assert.equal(log, "Compiling");
});
