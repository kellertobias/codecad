import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { build } from "esbuild";
import { kernelBundleOptions } from "../scripts/web-bundles.mjs";

const root = resolve(import.meta.dirname, "..");

// The CAD core has to run in a browser worker as well as in Node: the editor
// evaluates models in the browser, the server evaluates them for exports.
// This bundles the core for the browser and fails if any of our own modules
// reaches for a Node built-in. (The kernel's Emscripten loader mentions Node
// modules on a path browsers never take; that is outside our sources.)
test("the CAD core bundles for the browser without Node built-ins", async () => {
  const kernel = kernelBundleOptions(root, "unused");
  const result = await build({
    ...kernel,
    entryPoints: [
      "src/index.ts",
      "src/engine.ts",
      "src/drawing.ts",
      "src/manufacturing.ts",
      "src/nesting.ts",
      "src/cut-rows.ts",
      "src/kernel/mesh.ts",
      "src/kernel/roles.ts",
      "src/document/schema.ts",
      "src/document/variables.ts",
      "src/document/sketch-solver.ts",
      "src/document/profiles.ts",
      "src/document/code-part.ts",
      "src/kernel/code-parts.ts",
      "src/code-part/sdk.ts",
    ].map((file) => resolve(root, file)),
    outdir: "unused",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  const offenders = Object.entries(result.metafile.inputs).flatMap(
    ([file, input]) =>
      file.includes("node_modules/")
        ? []
        : input.imports
            .filter((imported) => imported.path.startsWith("node:"))
            .map((imported) => `${file} imports ${imported.path}`),
  );
  assert.deepEqual(offenders, []);
});

// The sandbox starts the part API as a classic worker from a blob (module
// workers do not start in an origin-less document), so its bundle must be
// a plain script: no imports, no exports.
test("the code-part sandbox bundles as a plain script", async () => {
  const kernel = kernelBundleOptions(root, "unused");
  const entry = (kernel.entryPoints as Record<string, string>)["code-sandbox"];
  assert.ok(entry, "the kernel bundles include the code sandbox");
  const result = await build({
    ...kernel,
    entryPoints: [entry],
    outdir: "unused",
    write: false,
    sourcemap: false,
    logLevel: "silent",
  });
  const text = result.outputFiles[0]!.text;
  assert.doesNotMatch(text, /^\s*(import|export)\b/m);
  assert.doesNotMatch(text, /import\.meta/);
});
