// Runs the Studio server and restarts it when src/server.ts changes.
//
// Node's own watch mode would do this, but it restarts on any event for the
// path, and some launchers feed it a stream of them. This supervisor only
// restarts when the file's content hash actually changes, and hands the
// server's exit code and signals through, so it can stand in for the
// server wherever `npm run dev` is used.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, watch } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverFile = join(root, "src/server.ts");
const digest = () =>
  createHash("sha256").update(readFileSync(serverFile)).digest("hex");

let running = digest();
let child;
let restarting = false;
let timer;

function start() {
  child = spawn(
    process.execPath,
    ["--import", "tsx", serverFile, ...process.argv.slice(2)],
    { cwd: root, stdio: "inherit" },
  );
  child.on("exit", (code, signal) => {
    if (restarting) {
      restarting = false;
      start();
    } else process.exit(code ?? (signal ? 1 : 0));
  });
}
function restart() {
  if (restarting) return;
  restarting = true;
  console.log("Restarting the server: src/server.ts changed");
  const current = child;
  current.kill("SIGTERM");
  setTimeout(() => current.kill("SIGKILL"), 3000).unref();
}
// Watch the directory: editors that write a new file and rename it over the
// old one would otherwise drop a watch set on the file itself.
watch(dirname(serverFile), (_event, file) => {
  if (file !== "server.ts") return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    let next;
    try {
      next = digest();
    } catch {
      return; // Mid-write; the next event will read it.
    }
    if (next === running) return;
    running = next;
    restart();
  }, 200);
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    child?.kill(signal);
    setTimeout(() => process.exit(0), 3000).unref();
  });
start();
