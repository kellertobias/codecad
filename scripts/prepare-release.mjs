import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const version = process.argv[2];
if (!version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("Usage: node scripts/prepare-release.mjs <semver>");
}

const packageVersion = JSON.parse(await readFile("package.json", "utf8")).version;
if (packageVersion !== version) {
  throw new Error(`npm prepare must set package.json to ${version} first (found ${packageVersion})`);
}

const tauriPath = "src-tauri/tauri.conf.json";
const tauri = JSON.parse(await readFile(tauriPath, "utf8"));
tauri.version = version;
await writeFile(tauriPath, `${JSON.stringify(tauri, null, 2)}\n`);

const cargoPath = "src-tauri/Cargo.toml";
const cargo = await readFile(cargoPath, "utf8");
const updated = cargo.replace(/(\[package\][\s\S]*?\nversion = ")[^"]+("\n)/, (_match, before, after) => `${before}${version}${after}`);
if (updated === cargo && !cargo.includes(`version = "${version}"`)) {
  throw new Error("Could not update desktop Cargo package version");
}
await writeFile(cargoPath, updated);
execFileSync("cargo", ["update", "--manifest-path", cargoPath, "-p", "codecad-desktop"], { stdio: "inherit" });
