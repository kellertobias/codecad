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
