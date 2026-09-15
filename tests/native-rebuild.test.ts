import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  realpath,
  mkdir,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { compileCad } from "../src/native-rebuild.js";

test("native CAD rebuild preserves decorators, external helpers, assets, SDK identities and source lines", async () => {
  const temp = await mkdtemp(join(tmpdir(), "codecad-native-"));
  try {
    const entry = join(temp, "project.mts"),
      output = join(temp, "output");
    await mkdir(join(temp, "sdk/src"), { recursive: true });
    await writeFile(
      join(temp, "sdk/package.json"),
      JSON.stringify({ name: "@codecad/studio", type: "module" }),
    );
    await writeFile(
      join(temp, "sdk/src/index.ts"),
      "export class Project {} export class SheetMaterial {} export const cad: any = {};",
    );
    await writeFile(join(temp, "size.txt"), "24");
    await writeFile(
      join(temp, "helper.ts"),
      'import { readFileSync } from "node:fs"; export const size = Number(readFileSync(new URL("./size.txt", import.meta.url), "utf8"));',
    );
    await writeFile(
      entry,
      `import { Project, SheetMaterial, cad } from "./sdk/src/index.js";
import { size } from "./helper.ts";
@cad.project({ id: "native-test", units: "mm" })
export class NativeTest extends Project {
  constructor() {
    super({ id: "native-test" });
    const material = new SheetMaterial({ thickness: 6 });
    const panel = material.makePart({ id: "panel", width: size, height: 30 });
    panel.place({ x: 12 });
  }
}
`,
    );
    const emitted = await compileCad(entry, output);
    const result = await promisify(execFile)(
      process.execPath,
      [
        "--enable-source-maps",
        "--import",
        resolve("src/native-loader.mjs"),
        resolve("src/worker.ts"),
        entry,
        output,
      ],
      {
        env: { ...process.env, CODECAD_NATIVE_OUTPUT: emitted },
        timeout: 30000,
      },
    );
    assert.match(result.stdout, /"parts":1/);
    const model = JSON.parse(
      await readFile(join(output, "model.json"), "utf8"),
    );
    assert.ok(
      JSON.stringify(model).includes(await realpath(entry)),
      "source links retain original source paths",
    );
    assert.ok(
      JSON.stringify(model).includes('"line":8'),
      "construction traces map back from decorated emitted JS",
    );
    await writeFile(entry, "export class { broken = ;");
    await assert.rejects(compileCad(entry, join(temp, "invalid")));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
