import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Project, cad } from "../src/index.js";
import { projectTypeOf } from "../src/decorators.js";
import { buildProject } from "../src/worker.js";

test("outputs declared in their own modules all reach the build", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codecad-modules-"));
  try {
    const manifest = await buildProject(
      resolve("examples/modular/index.ts"),
      directory,
    );
    assert.deepEqual(manifest.diagnostics, []);
    const names = manifest.files.map((file) => file.name);
    for (const name of [
      "drawing.svg",
      "cut-list.csv",
      "cnc-parts.zip",
      "modular-outputs.step",
    ])
      assert.ok(
        names.includes(name),
        `${name} missing from ${names.join(", ")}`,
      );
    // One file per motion study, named after its method.
    assert.ok(names.includes("trayOpens.glb"));
    assert.ok(names.includes("trayCracksOpen.glb"));
    await stat(join(directory, "trayCracksOpen.glb"));
    assert.deepEqual(
      manifest.animations.map((animation) => animation.title),
      ["Tray · full travel", "Tray · service gap"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a project reference may be a class or a lazy function, and nothing else", () => {
  @cad.project({ id: "reference-test", units: "mm" })
  class Referenced extends Project {}
  assert.equal(projectTypeOf(Referenced), Referenced);
  assert.equal(
    projectTypeOf(() => Referenced),
    Referenced,
  );
  assert.equal(projectTypeOf(Project), Project);
  class NotAProject {}
  assert.throws(
    () => projectTypeOf(NotAProject, NotAProject),
    /NotAProject is not bound to a Project class/,
  );
});
