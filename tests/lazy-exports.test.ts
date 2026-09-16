import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildProject } from "../src/worker.js";

test("lazy build advertises exports without generating them until requested", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codecad-lazy-"));
  const entry = resolve("examples/sheet-metal-project.ts");
  try {
    const manifest = await buildProject(entry, directory, {
      lazyExports: true,
    });
    assert.equal(
      manifest.files.find((file) => file.name === "bracket.pdf")?.ready,
      false,
    );
    assert.equal(
      manifest.files.find((file) => file.name === "preview.glb")?.ready,
      false,
    );
    await assert.rejects(stat(join(directory, "bracket.pdf")));
    await stat(join(directory, "bracket.svg"));
    const before = await readFile(join(directory, "model.json"));
    await buildProject(entry, directory, { exportOnly: "bracket.pdf" });
    const pdf = await readFile(join(directory, "bracket.pdf"));
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
    assert.deepEqual(await readFile(join(directory, "model.json")), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
