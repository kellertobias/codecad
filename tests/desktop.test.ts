import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test("desktop projects share SDK identities across external workspace imports", () => {
  const external = mkdtempSync(join(tmpdir(), "codecad-sdk-"));
  try {
    mkdirSync(join(external, "src"));
    cpSync("package.json", join(external, "package.json"));
    cpSync("src/model.ts", join(external, "src/model.ts"));
    const imported = pathToFileURL(join(external, "src/model.ts")).href;
    const result = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        "./src/desktop-loader.ts",
        "--input-type=module",
        "-e",
        `import { Project as local } from './src/model.ts';
       import { Project as external } from ${JSON.stringify(imported)};
       import { Project as publicSDK } from '@tobisk/codecad';
       if (local !== external || local !== publicSDK) throw new Error('Split SDK identity');
       console.log('shared');`,
      ],
      { encoding: "utf8" },
    );
    assert.match(result, /shared/);
  } finally {
    rmSync(external, { recursive: true, force: true });
  }
});
