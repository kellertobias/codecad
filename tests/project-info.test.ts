import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateProjectInfo } from "../src/project-info.js";
import { drawingPlanFile } from "../src/drawing-plan.js";
import { buildProject } from "../src/worker.js";

test("a project entry is named and signed by its PROJECTINFO", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codecad-info-"));
  try {
    const manifest = await buildProject(
      resolve("examples/welded-table-base/index.ts"),
      directory,
    );
    // index.ts names the project; the class keeps titling its own drawing.
    assert.equal(manifest.title, "Welded table base");
    assert.equal(manifest.info?.author, "CodeCAD");
    assert.equal(manifest.info?.revision, "A");
    const sheet = await readFile(join(directory, "drawing.svg"), "utf8");
    assert.match(sheet, />Welded steel table base</);
    assert.match(sheet, />Welded table base</);
    assert.match(sheet, />CodeCAD</);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an entry without PROJECTINFO keeps the project label", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codecad-info-"));
  try {
    const manifest = await buildProject(
      resolve("examples/welded-table-base/project.ts"),
      directory,
    );
    assert.equal(manifest.info, null);
    assert.equal(manifest.title, "Welded steel table base");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("PROJECTINFO needs a name and plain text fields", () => {
  const info = { name: "Shelf", author: "A", description: "B", revision: "C" };
  assert.deepEqual(validateProjectInfo({ ...info }), info);
  assert.deepEqual(validateProjectInfo({ name: "Shelf" }), { name: "Shelf" });
  assert.throws(() => validateProjectInfo({ name: "  " }), /needs a name/);
  assert.throws(() => validateProjectInfo("Shelf"), /must be an object/);
  assert.throws(
    () => validateProjectInfo({ name: "Shelf", revision: 3 }),
    /revision must be text/,
  );
});

test("an index entry keeps its sheet under the project folder", () => {
  assert.equal(
    drawingPlanFile("examples/welded-table-base/index.ts"),
    "examples/welded-table-base/drawings.json",
  );
  assert.equal(
    drawingPlanFile("/projects/desk/table.mts"),
    "/projects/desk/table.drawings.json",
  );
});
