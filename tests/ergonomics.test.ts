import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CodeCadParameters, SheetMaterial, cad } from "../src/index.js";
import { buildProject } from "../src/worker.js";

test("parameters infer their label from the key", () => {
  const params = new CodeCadParameters({
    lowerRailTop: cad.parameter(180, { unit: "mm", range: [120, 300] }),
    doors: cad.parameter(true),
    width: cad.parameter(600, { label: "Outside width" }),
  });
  assert.equal(params.definitions.lowerRailTop.label, "Lower rail top");
  assert.equal(params.definitions.doors.label, "Doors");
  assert.equal(params.definitions.width.label, "Outside width");
  assert.equal(
    params.with({ width: 700 }).lowerRailTop.label,
    "Lower rail top",
  );
});

test("material variants inherit stock settings and regenerate plies", () => {
  const plywood = new SheetMaterial({
    id: "birch-18",
    name: "Birch 18",
    thickness: 18,
    plies: 9,
    width: 1250,
    height: 2500,
    kerf: 3.2,
  });
  assert.equal(plywood.options.layers?.length, 9);
  assert.deepEqual(
    plywood.options.layers!.slice(0, 2).map((layer) => layer.direction),
    ["height", "width"],
  );
  const thin = plywood.with({ id: "birch-12", thickness: 12, plies: 7 });
  assert.ok(thin instanceof SheetMaterial);
  assert.equal(thin.id, "birch-12");
  assert.equal(thin.name, "birch-12");
  assert.equal(thin.width, 1250);
  assert.equal(thin.options.kerf, 3.2);
  assert.equal(thin.options.layers?.length, 7);
  assert.ok(Math.abs(thin.options.layers![0]!.thickness - 12 / 7) < 1e-9);
  assert.throws(() => plywood.with({ thickness: 12 }), /layer thicknesses/);
  assert.throws(
    () => new SheetMaterial({ thickness: 18, plies: 1 }),
    /at least 2/,
  );
});

test("a project without output methods gets the standard deliverables and its saved sheet", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codecad-standard-"));
  // The plan lives beside the entry, so build a private copy of the example.
  const entry = resolve("examples/.standard-outputs-test.ts");
  const planFile = entry.replace(/\.ts$/, ".drawings.json");
  try {
    await copyFile(resolve("examples/welded-table-base.ts"), entry);
    await writeFile(
      planFile,
      JSON.stringify({
        version: 1,
        title: "Table base sheet",
        items: [
          {
            id: "side",
            kind: "view",
            subject: "*",
            angle: "right",
            x: 20,
            y: 20,
            width: 180,
            height: 100,
            scale: 10,
            label: "",
          },
          {
            id: "depth",
            kind: "dimension",
            view: "side",
            u1: 0,
            v1: 0,
            u2: 600,
            v2: 0,
            offset: 8,
            label: "",
          },
        ],
      }),
    );
    const manifest = await buildProject(entry, directory, {
      lazyExports: true,
    });
    assert.deepEqual(manifest.diagnostics, []);
    assert.deepEqual(
      manifest.reports.map((report) => [report.kind, report.title]),
      [
        ["drawing", "Welded steel table base"],
        ["cutList", "cut-list"],
        ["drawing", "Table base sheet"],
      ],
    );
    for (const name of [
      "drawing.pdf",
      "cut-list.csv",
      "welded-table-base.step",
      "drawing-plan.pdf",
    ])
      assert.ok(
        manifest.files.some((file) => file.name === name),
        name,
      );
    const side = manifest.planViews.side!;
    assert.equal(side.key, "*|right|visible");
    assert.equal(side.visible.length % 4, 0);
    assert.equal(Math.min(...side.visible.filter((_, i) => i % 2 === 0)), 0);
    assert.equal(Math.max(...side.visible.filter((_, i) => i % 2 === 0)), 600);
    assert.match(
      await readFile(join(directory, "drawing-plan.svg"), "utf8"),
      />600</,
    );
    await buildProject(entry, directory, { exportOnly: "drawing-plan.pdf" });
    const pdf = await readFile(join(directory, "drawing-plan.pdf"));
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(entry, { force: true });
    await rm(planFile, { force: true });
  }
});
