#!/usr/bin/env node
import { createWriteStream } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const packageDirectory = new URL("..", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("package.json", packageDirectory), "utf8"));
const version = manifest.version;
const sourceRoot = join(homedir(), "Library", "Caches", "CodeCAD", "source", `v${version}`);
const appBundle = join(sourceRoot, "src-tauri", "target", "release", "bundle", "macos", "CodeCAD.app");

const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: "inherit", ...options });
  child.on("error", reject);
  child.on("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} ${signal ? `stopped by ${signal}` : `exited ${code}`}`)));
});

const exists = async (path) => access(path).then(() => true).catch(() => false);

async function downloadSource() {
  const tag = `v${version}`;
  const url = `https://github.com/kellertobias/codecad/archive/refs/tags/${encodeURIComponent(tag)}.tar.gz`;
  const staging = await mkdtemp(join(tmpdir(), "codecad-source-"));
  const archive = join(staging, "source.tar.gz");
  try {
    process.stdout.write(`Downloading CodeCAD ${tag} source from GitHub...\n`);
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok || !response.body) throw new Error(`Could not download ${url} (${response.status}). A matching Git tag is required.`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
    await run("/usr/bin/tar", ["-xzf", archive, "-C", staging]);
    const sourceDirectory = (await readdir(staging, { withFileTypes: true })).find(entry => entry.isDirectory() && entry.name.startsWith("codecad-"));
    if (!sourceDirectory) throw new Error("Downloaded source archive did not contain a CodeCAD source directory.");
    await mkdir(join(sourceRoot, ".."), { recursive: true });
    await rename(join(staging, sourceDirectory.name), sourceRoot);
  } catch (error) {
    await rm(sourceRoot, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function app() {
  if (process.platform !== "darwin") throw new Error("`codecad app` currently builds the macOS Tauri application only.");
  const rebuild = process.argv.includes("--rebuild");
  if (!rebuild && await exists(appBundle)) {
    process.stdout.write(`Starting cached CodeCAD ${version}: ${appBundle}\n`);
    await run("/usr/bin/open", [appBundle]);
    return;
  }
  if (!await exists(join(sourceRoot, "build"))) await downloadSource();
  process.stdout.write(`Building CodeCAD ${version} locally from ${sourceRoot}...\n`);
  await run("/bin/bash", ["./build", "open"], { cwd: sourceRoot });
}

const command = process.argv[2];
if (command === "app") app().catch(error => { console.error(`CodeCAD: ${error.message}`); process.exitCode = 1; });
else console.log(`Usage: ${basename(process.argv[1])} app [--rebuild]\n\nBuild the matching CodeCAD GitHub source locally, then open the macOS app.`);
