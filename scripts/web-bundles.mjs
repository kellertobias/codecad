// Browser bundles that carry the CAD kernel. Shared by the dev server
// (src/server.ts) and the desktop build (scripts/prepare-desktop.mjs) so both
// serve the same files.
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

/** Sends every "brepjs/quick" import to the browser shim, which loads the
 * kernel from the served WASM file instead of resolving it at runtime. */
const browserKernel = (root) => ({
  name: "browser-kernel",
  setup(build) {
    build.onResolve({ filter: /^brepjs\/quick$/ }, () => ({
      path: join(root, "src/kernel/browser-brepjs.ts"),
    }));
  },
});

/** esbuild options for the kernel worker and the pages that use it. */
export function kernelBundleOptions(root, outdir) {
  return {
    entryPoints: {
      "kernel.worker": join(root, "web/kernel/worker.ts"),
      "kernel-probe": join(root, "web/kernel-probe.ts"),
    },
    outdir,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    sourcemap: true,
    // The Emscripten loaders of the kernel and the sketch solver require
    // Node modules on a path a browser never takes; leaving them external
    // keeps the bundle resolvable.
    external: ["node:*", "module", "fs", "path", "url"],
    plugins: [browserKernel(root)],
  };
}

/** Puts the kernel's WASM binary next to the bundles. */
export async function copyKernelWasm(root, outdir) {
  await mkdir(outdir, { recursive: true });
  await copyFile(
    join(root, "node_modules/occt-wasm/dist/occt-wasm.wasm"),
    join(outdir, "occt-wasm.wasm"),
  );
}
