import {
  mkdir,
  cp,
  readdir,
  readFile,
  writeFile,
  chmod,
  rm,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, ".."),
  out = join(root, ".codecad/desktop-runtime");
await mkdir(out, { recursive: true });
// Official standalone Node; verify the archive against its HTTPS checksum manifest.
const platform = process.platform,
  arch = process.arch;
if (!["darwin", "linux"].includes(platform))
  throw new Error(
    "Desktop runtime packaging currently supports macOS and Linux hosts",
  );
const base = "https://nodejs.org/dist/latest-v22.x/";
const cache = join(root, ".codecad/node-download");
await mkdir(cache, { recursive: true });
if (!existsSync(join(out, "node"))) {
  const sums = await (await fetch(base + "SHASUMS256.txt")).text();
  const line = sums
    .split("\n")
    .find((l) => l.endsWith(`-${platform}-${arch}.tar.gz`));
  if (!line) throw new Error("No official Node runtime for this platform");
  const [checksum, filename] = line.trim().split(/\s+/);
  const bytes = Buffer.from(await (await fetch(base + filename)).arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== checksum)
    throw new Error("Node archive checksum mismatch");
  const archive = join(cache, filename);
  await writeFile(archive, bytes);
  execFileSync("tar", ["-xzf", archive, "-C", cache]);
  await cp(
    join(cache, filename.replace(/\.tar\.gz$/, ""), "bin/node"),
    join(out, "node"),
  );
  await chmod(join(out, "node"), 0o755);
  await writeFile(
    join(out, "NODE-RUNTIME.txt"),
    `${filename}\nSHA256 ${checksum}\nhttps://nodejs.org/\n`,
  );
  await cp(
    join(cache, filename.replace(/\.tar\.gz$/, ""), "LICENSE"),
    join(out, "NODE-LICENSE"),
  );
}
// Recreate generated inputs so removed files/dependencies cannot leak into a bundle.
for (const name of ["src", "web", "examples", "desktop", "node_modules", "ui"])
  await rm(join(out, name), { recursive: true, force: true });
for (const name of ["src", "web", "examples", "package.json", "tsconfig.json"])
  await cp(join(root, name), join(out, name), {
    recursive: true,
    dereference: true,
  });
await cp(join(root, "desktop/previews"), join(out, "desktop/previews"), {
  recursive: true,
});
await cp(join(root, "desktop/icon.png"), join(out, "desktop/icon.png"));
await mkdir(join(out, "node_modules"), { recursive: true });
for (const name of await readdir(join(root, "node_modules"))) {
  if (name.startsWith(".") || name === "@tauri-apps") continue;
  await cp(join(root, "node_modules", name), join(out, "node_modules", name), {
    recursive: true,
    dereference: true,
  });
}
// The home screen shares the project tab strip with the studio UI.
await build({
  entryPoints: [join(root, "web/project-tabs.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: join(root, "desktop/project-tabs.js"),
});
await cp(
  join(root, "web/project-tabs.css"),
  join(root, "desktop/project-tabs.css"),
);
const ui = join(out, "ui");
await build({
  entryPoints: [join(root, "web/app.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: join(ui, "app.js"),
  sourcemap: true,
  loader: { ".ttf": "dataurl" },
});
await build({
  entryPoints: {
    "ts.worker": join(
      root,
      "node_modules/monaco-editor/esm/vs/language/typescript/ts.worker.js",
    ),
    "editor.worker": join(
      root,
      "node_modules/monaco-editor/esm/vs/editor/editor.worker.js",
    ),
  },
  outdir: ui,
  bundle: true,
  format: "esm",
  platform: "browser",
});
console.log(`Desktop runtime prepared: ${out}`);
