import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { editorService } from "../src/editor-service.js";

test("TypeScript completion inserts and merges imports", async () => {
  const service = await editorService(
    process.cwd(),
    resolve("examples/kitchen-cabinet.ts"),
  );
  for (const source of [
    "const tool = new Dri",
    'import { CounterSink } from "../src/tools.js";\nconst tool = new Dri',
  ]) {
    const items = service.complete(source, source.length),
      drill = items.find((item) => item.name === "Drill");
    assert.ok(drill);
    let updated = source.slice(0, -3) + "Drill";
    for (const edit of [...drill.edits].sort(
      (a, b) => b.span.start - a.span.start,
    ))
      updated =
        updated.slice(0, edit.span.start) +
        edit.newText +
        updated.slice(edit.span.start + edit.span.length);
    assert.match(updated, /import.*Drill/);
    assert.equal(
      (updated.match(/from "\.\.\/src\/tools.js"/g) ?? []).length,
      1,
    );
    assert.match(updated, /new Drill$/);
  }
});
