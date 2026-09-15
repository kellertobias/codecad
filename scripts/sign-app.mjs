import { open, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const app = resolve(process.argv[2]);
if (!app.endsWith("/CodeCAD.app"))
  throw new Error("Expected a CodeCAD.app bundle");
const identity = process.env.CODECAD_SIGN_IDENTITY ?? "-";
const magic = new Set([
  0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca,
  0xcafebabf, 0xbfbafeca,
]);
async function signBinaries(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) await signBinaries(file);
    else if (entry.isFile() && (await stat(file)).size >= 4) {
      const handle = await open(file),
        bytes = Buffer.alloc(4);
      try {
        await handle.read(bytes, 0, 4, 0);
      } finally {
        await handle.close();
      }
      if (magic.has(bytes.readUInt32BE())) {
        execFileSync("codesign", ["--force", "--sign", identity, file], {
          stdio: "inherit",
        });
      }
    }
  }
}
await signBinaries(join(app, "Contents"));
execFileSync("codesign", ["--force", "--sign", identity, app], {
  stdio: "inherit",
});
execFileSync("codesign", ["--verify", "--deep", "--strict", app], {
  stdio: "inherit",
});
console.log(
  identity === "-"
    ? "Ad-hoc signed for local installation (not notarized)."
    : `Signed using ${identity} (not notarized).`,
);
