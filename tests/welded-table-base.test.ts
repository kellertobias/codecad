import { test } from "node:test";
import assert from "node:assert/strict";
import { Box3, Matrix4, Vector3 } from "three";
import { WeldedTableBase, tableBase } from "../examples/welded-table-base.js";
import { OpenCascadeEngine } from "../src/engine.js";
import { cutRows } from "../src/manufacturing.js";

test("welded table base keeps butt-fit tube cut lengths and outside bounds", async () => {
  const project = new WeldedTableBase();
  assert.equal(project.members.length, 10);
  assert.equal(project.parts.all.length, 10);
  assert.deepEqual(
    project.members.map((part) => part.length).sort((a, b) => a - b),
    [520, 520, 700, 700, 700, 700, 1120, 1120, 1120, 1120],
  );
  assert.ok(
    project.members.every(
      (part) =>
        part.material.width === 40 &&
        part.material.height === 40 &&
        part.material.wallThickness === 3,
    ),
  );
  const rows = cutRows(project);
  assert.equal(rows.length, 10);
  assert.ok(
    rows.every((row) => row.wallThickness === 3 && row.thickness === undefined),
  );

  const engine = new OpenCascadeEngine();
  try {
    const result = await engine.evaluate({ root: project, revision: 1 });
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.meshes.length, 10);
    const bounds = new Box3();
    const memberBounds = new Map<string, Box3>();
    for (const mesh of result.meshes) {
      const box = new Box3()
        .setFromArray(mesh.positions)
        .applyMatrix4(new Matrix4().fromArray(mesh.matrix));
      bounds.union(box);
      memberBounds.set(mesh.componentPath.split("/").at(-1)!, box);
    }
    const frontRail = memberBounds.get("front-top-rail")!;
    const frontLeftLeg = memberBounds.get("front-left-leg")!;
    assert.ok(Math.abs(frontRail.min.x - frontLeftLeg.max.x) < 0.01);
    assert.ok(Math.abs(frontRail.max.z - tableBase.height) < 0.01);
    const allBoxes = [...memberBounds.values()];
    for (let first = 0; first < allBoxes.length; first++)
      for (let second = first + 1; second < allBoxes.length; second++) {
        const overlap = allBoxes[first]!.clone().intersect(allBoxes[second]!);
        const size = overlap.getSize(new Vector3());
        assert.ok(
          size.x * size.y * size.z < 0.01,
          "cut members must not overlap",
        );
      }
    assert.ok(bounds.min.distanceTo(new Vector3(0, 0, 0)) < 0.01);
    assert.ok(
      bounds.max.distanceTo(
        new Vector3(tableBase.width, tableBase.depth, tableBase.height),
      ) < 0.01,
    );
    const expectedVolume =
      (40 * 40 - 34 * 34) *
      project.members.reduce((sum, part) => sum + part.length, 0);
    assert.ok(
      Math.abs(
        result.meshes.reduce((sum, mesh) => sum + mesh.volume, 0) -
          expectedVolume,
      ) < 0.1,
    );
  } finally {
    engine.dispose();
  }
});
