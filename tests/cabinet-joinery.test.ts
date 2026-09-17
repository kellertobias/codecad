import { test } from "node:test";
import assert from "node:assert/strict";
import * as b from "brepjs/quick";
import {
  CabinetMotionOutputs,
  KitchenCabinet,
} from "../examples/kitchen-cabinet.js";
import { SheetPart, Shapes } from "../src/index.js";
import { OpenCascadeEngine } from "../src/engine.js";
import { outlineBounds } from "../src/manufacturing.js";

test("paired cabinet and drawer domino cutters enter the stock to their full intended depth", async () => {
  const cabinet = new KitchenCabinet(),
    engine = new OpenCascadeEngine();
  try {
    for (const path of [
      "kitchen-cabinet/left",
      "kitchen-cabinet/bottom",
      "kitchen-cabinet/drawer-1/left",
      "kitchen-cabinet/drawer-1/back",
    ]) {
      const part = cabinet.parts.require(path, SheetPart),
        bounds = outlineBounds(part);
      const blank = new Shapes.Box({
        width: bounds.width,
        depth: bounds.height,
        height: part.material.thickness,
      });
      const ops = part.operations.filter((op) => op.kind === "domino");
      assert.ok(ops.length >= 2);
      for (const op of ops) {
        const width = path.includes("drawer") ? 16 : 20,
          thickness = path.includes("drawer") ? 4 : 6;
        const expected =
          ((width - thickness) * thickness +
            (Math.PI * thickness * thickness) / 4) *
          op.depth!;
        const intersection = await engine.recipe({
          kind: "intersect",
          left: blank.recipe,
          right: op.recipe,
        });
        assert.ok(
          Math.abs(b.unwrap(b.measureVolume(intersection)) - expected) < 0.05,
          `Mortise must enter ${path} fully`,
        );
      }
    }
  } finally {
    engine.dispose();
  }
});

test("motion delays reject negative and non-finite values", () => {
  const study = new CabinetMotionOutputs(new KitchenCabinet()).motion(),
    animation = study.animations[0]!;
  for (const delaySeconds of [-1, Infinity, NaN])
    assert.throws(() => study.animate({ ...animation, delaySeconds }), /delay/);
});
