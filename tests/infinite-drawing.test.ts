import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildProject } from "../src/worker.js";

test("infinite drawing example exposes geometry and a downloadable plan", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codecad-drawing-"));
  const entry = resolve("examples/infinite-drawing.ts");
  try {
    const manifest = await buildProject(entry, directory, {
      lazyExports: true,
    });
    assert.equal(manifest.view2D.length, 6);
    assert.equal(manifest.view2D[0]?.kind, "path");
    assert.equal(
      manifest.files.find((file) => file.name === "panel-plan.pdf")?.ready,
      false,
    );
    await assert.rejects(stat(join(directory, "panel-plan.pdf")));
    await buildProject(entry, directory, { exportOnly: "panel-plan.pdf" });
    const pdf = await readFile(join(directory, "panel-plan.pdf"));
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
