import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { unzipSync } from "fflate";
import * as b from "brepjs/quick";
import { buildProject } from "../src/worker.js";

test("cabinet builds manufacturing outputs, PDF, STEP and animated glTF", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codecad-integration-"));
  const result = await buildProject(
    resolve("examples/kitchen-cabinet.ts"),
    directory,
  );
  assert.equal(result.meshes.length, 53);
  const drawer = result.components.find(
    (c) => c.path === "kitchen-cabinet/drawer-1",
  );
  assert.equal(drawer?.parent, "kitchen-cabinet");
  assert.ok(
    result.components.some(
      (c) => c.parent === drawer?.path && c.id === "handle",
    ),
  );
  for (let number = 1; number <= 4; number++)
    for (const side of ["left", "right"])
      assert.equal(
        result.components.find((c) => c.id === `rail-${side}-${number}`)
          ?.parent,
        `kitchen-cabinet/drawer-${number}`,
      );
  const cabinetLeft = result.components.find(
    (c) => c.path === "kitchen-cabinet/left",
  )!;
  const drawerLeft = result.components.find(
    (c) => c.path === "kitchen-cabinet/drawer-1/left",
  )!;
  assert.ok(cabinetLeft.source.length > 10);
  assert.ok(drawerLeft.source.length > 0);
  assert.ok(
    cabinetLeft.source.some(
      (a) => !drawerLeft.source.some((b) => a.line === b.line),
    ),
  );
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.cutList.length, 25);
  assert.ok(result.clearances.every((c) => c.passed));
  const pdf = await readFile(join(directory, "cabinet-plan.pdf"));
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.ok(result.reports.some((r) => r.kind === "nesting"));
  for (const report of result.reports) {
    const pdf = await readFile(join(directory, report.formats.pdf));
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
    const dxf = await readFile(join(directory, report.formats.dxf), "utf8");
    assert.match(dxf, /\$INSUNITS\n70\n4/);
    assert.match(dxf, /EOF/);
    if (report.kind === "nesting") {
      assert.match(dxf, /STOCK_BOUNDARY/);
      assert.match(pdf.toString("latin1"), /\/Count [2-9]/);
    } else assert.match(dxf, /TEXT/);
    if (report.kind === "drawing") assert.match(dxf, /DIMENSION_TEXT/);
    if (report.kind === "cutList") {
      assert.ok(report.formats.csv);
      const csv = await readFile(join(directory, report.formats.csv), "utf8");
      assert.match(csv, /"material"/);
      assert.equal(report.rows?.length, 25);
    } else assert.equal(report.formats.csv, undefined);
  }
  const zip = unzipSync(await readFile(join(directory, "cnc-parts.zip")));
  assert.equal(Object.keys(zip).length, 37);
  const edge = new TextDecoder().decode(
    zip["kitchen-cabinet_bottom-edge-X_MIN.dxf"],
  );
  assert.match(edge, /DOMINO_EDGE_X_MIN_D10.000/);
  assert.match(edge, /EDGE_BLANK/);
  const bottom = new TextDecoder().decode(zip["kitchen-cabinet_bottom.dxf"]);
  assert.match(bottom, /REFERENCE_EDGE_SETUP/);
  assert.equal(result.duration, 5.25);
  assert.deepEqual(
    result.animations.map((animation) => animation.title),
    ["Drawers · staggered", "Drawers · together"],
  );
  assert.equal(result.animations[1]?.duration, 3);
  for (const frame of result.frames) {
    const seconds: number = frame.t * result.duration;
    for (let drawer = 1; drawer <= 4; drawer++) {
      const expected: number =
        -380 * Math.max(0, Math.min(1, (seconds - (drawer - 1) * 0.75) / 3));
      assert.ok(
        Math.abs(
          frame.matrices[`kitchen-cabinet/drawer-${drawer}/floor`]![13]! -
            20 -
            expected,
        ) < 1e-6,
      );
      for (const side of ["left", "right"]) {
        const prefix = `kitchen-cabinet/drawer-${drawer}/rail-${side}-${drawer}`;
        assert.ok(
          Math.abs(frame.matrices[prefix + "/fixed"]![13]! - 20) < 1e-6,
        );
        assert.ok(
          Math.abs(
            frame.matrices[prefix + "/middle"]![13]! - 20 - expected / 2,
          ) < 1e-6,
        );
        assert.ok(
          Math.abs(frame.matrices[prefix + "/inner"]![13]! - 20 - expected) <
            1e-6,
        );
      }
    }
  }
  const front = new TextDecoder().decode(
    zip["kitchen-cabinet_drawer-1_front.dxf"],
  );
  assert.match(front, /CIRCLE/);
  assert.match(front, /COUNTERSINK_BOTTOM_D4.000/);
  assert.match(front, /\$INSUNITS\n70\n4/);
  const glb = await readFile(join(directory, "drawer-motion.glb"));
  assert.equal(glb.subarray(0, 4).toString(), "glTF");
  assert.equal(glb.readUInt32LE(8), glb.length);
  const json = JSON.parse(
    glb.subarray(20, 20 + glb.readUInt32LE(12)).toString(),
  );
  assert.equal(json.meshes.length, 53);
  assert.ok(json.animations[0].channels.length > 0);
  const step = await readFile(join(directory, "cabinet.step"));
  const imported = b.unwrap(
    await b.importSTEP(new Blob([new Uint8Array(step)])),
  );
  try {
    assert.ok(b.isValid(imported));
  } finally {
    imported[Symbol.dispose]();
  }
});
test("sheet-metal project exports folded solids and bend lines", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codecad-metal-"));
  const result = await buildProject(
    resolve("examples/sheet-metal-project.ts"),
    directory,
  );
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.meshes.length, 1);
  assert.equal(result.unfolds.length, 1);
  assert.equal(result.unfolds[0]?.frames.length, 9);
  assert.notDeepEqual(
    result.unfolds[0]?.frames[0]?.positions,
    result.unfolds[0]?.frames.at(-1)?.positions,
  );
  const zip = unzipSync(await readFile(join(directory, "manufacturing.zip")));
  assert.match(
    new TextDecoder().decode(Object.values(zip)[0]),
    /BEND_UP_90_R1.5/,
  );
});
