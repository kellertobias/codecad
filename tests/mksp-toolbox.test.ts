import { test } from "node:test";
import assert from "node:assert/strict";
import { Box3, Vector3 } from "three";
import { MakerspaceToolbox } from "../examples/mksp-toolbox.js";
import { SheetPart } from "../src/stock.js";
import { OpenCascadeEngine } from "../src/engine.js";
import { motionFrames } from "../src/exporters.js";
import * as b from "brepjs/quick";
import { partEntities } from "../src/manufacturing.js";

test("MKSP port preserves Python dimensions, all sheets, handle holes and rail motion", async () => {
  const project = new MakerspaceToolbox(),
    engine = new OpenCascadeEngine();
  try {
    const result = await engine.evaluate({ root: project, revision: 1 });
    assert.deepEqual(result.diagnostics, []);
    assert.equal(
      project.parts.all.filter((p) => p instanceof SheetPart).length,
      16,
    );
    assert.equal(project.drawers.length, 2);
    assert.equal(project.rails.length, 4);
    const left = project.parts.all.find(
      (p) => p.id === "left-sidewall",
    ) as SheetPart;
    const shelf = project.parts.all.find(
      (p) => p.id === "drawer-shelf",
    ) as SheetPart;
    const overlap = engine.own(
      b.unwrap(b.intersect(engine.subject(left), engine.subject(shelf))),
    );
    assert.ok(
      Math.abs(b.unwrap(b.measureVolume(overlap))) < 1e-5,
      "protected joint ends must not interpenetrate",
    );
    const entities = await partEntities(engine, left);
    const screwHoles = entities
      .filter((e) => e.kind === "circle")
      .filter((e) => Math.abs(e.radius - 2.25) < 1e-5);
    assert.equal(screwHoles.length, 4, "two round screw holes per fixed rail");
    for (const z of [31, 80]) {
      assert.ok(
        screwHoles.some(
          (e) => Math.abs(e.x - 157.5) < 1e-5 && Math.abs(e.y - z) < 1e-5,
        ),
      );
      assert.ok(
        screwHoles.some(
          (e) => Math.abs(e.x - 16.25) < 1e-5 && Math.abs(e.y - z) < 1e-5,
        ),
      );
    }
    const bounds = new Box3();
    for (const part of project.parts.all)
      bounds.union(engine.bounds(engine.subject(part)));
    assert.ok(bounds.min.distanceTo(new Vector3(0, 0, 0)) < 0.02);
    assert.ok(bounds.max.distanceTo(new Vector3(360, 220, 300)) < 0.02);
    const study = project.motion(),
      frames = motionFrames(study, [...project.parts.all]);
    assert.ok(frames.length > 30);
    const end = frames.at(-1)!;
    const middle = project.rails[0]!.middle,
      inner = project.rails[0]!.inner;
    const middleY = end.matrices[middle.path]![13]!;
    const innerY = end.matrices[inner.path]![13]!;
    assert.ok(
      Math.abs(middleY - (middle.worldMatrix().elements[13]! - 80)) < 1e-6,
    );
    assert.ok(
      Math.abs(innerY - (inner.worldMatrix().elements[13]! - 160)) < 1e-6,
    );
  } finally {
    engine.dispose();
  }
});
