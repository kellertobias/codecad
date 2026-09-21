import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildProject } from "../src/worker.js";

test("active parameters rebuild geometry, drawing, cut list, layouts, and exports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codecad-parameters-"));
  const entry = resolve("examples/parameterized-shelf/index.ts");
  const previous = process.env.CODECAD_PARAMETER_VALUES;
  try {
    delete process.env.CODECAD_PARAMETER_VALUES;
    const defaults = await buildProject(entry, join(directory, "default"), {
      lazyExports: true,
    });
    process.env.CODECAD_PARAMETER_VALUES = JSON.stringify({
      width: 1000,
      height: 1100,
      depth: 400,
      thickness: "12",
      backPanel: false,
    });
    const changedDirectory = join(directory, "changed");
    const changed = await buildProject(entry, changedDirectory, {
      lazyExports: true,
    });
    assert.equal(defaults.parameters?.values.width, 800);
    assert.equal(changed.parameters?.values.width, 1000);
    assert.equal(defaults.cutList.length, 6);
    assert.equal(changed.cutList.length, 5);
    assert.notDeepEqual(defaults.cutList, changed.cutList);
    assert.notDeepEqual(
      defaults.meshes.map((mesh) => mesh.volume),
      changed.meshes.map((mesh) => mesh.volume),
    );
    assert.notDeepEqual(
      defaults.reports.map((report) => report.title),
      changed.reports.map((report) => report.title),
    );
    const svg = await readFile(
      join(changedDirectory, "shelf-drawing.svg"),
      "utf8",
    );
    assert.match(svg, /Depth 400 mm; board 12 mm/);
    await buildProject(entry, changedDirectory, {
      exportOnly: "shelf-cut-list.csv",
    });
    const csv = await readFile(
      join(changedDirectory, "shelf-cut-list.csv"),
      "utf8",
    );
    assert.match(csv, /"976","400","12"/);
    assert.doesNotMatch(csv, /"back"/);
  } finally {
    if (previous === undefined) delete process.env.CODECAD_PARAMETER_VALUES;
    else process.env.CODECAD_PARAMETER_VALUES = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
