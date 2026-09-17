import { test } from "node:test";
import assert from "node:assert/strict";
import { SheetMaterial } from "../src/stock.js";
import { woodFragmentCode } from "../web/wood-material.js";

test("multiplex validates ordered veneer thickness and direction", () => {
  const stock = new SheetMaterial({
    thickness: 6,
    grain: "height",
    layers: [
      { thickness: 2, direction: "height" },
      { thickness: 2, direction: "width" },
      { thickness: 2, direction: "height" },
    ],
  });
  assert.deepEqual(
    stock.options.layers?.map((layer) => layer.direction),
    ["height", "width", "height"],
  );
  assert.throws(
    () =>
      new SheetMaterial({
        thickness: 6,
        layers: [
          { thickness: 2, direction: "height" },
          { thickness: 3, direction: "width" },
        ],
      }),
    /must equal sheet thickness/,
  );
});

test("wood shader uses local sheet axes and every ordered layer boundary", () => {
  const code = woodFragmentCode({
    direction: "height",
    layers: [
      { thickness: 2, direction: "height" },
      { thickness: 3, direction: "width" },
      { thickness: 1, direction: "height" },
    ],
  });
  assert.match(code, /vWoodLocalPosition\.x/);
  assert.match(code, /woodDepth <= 2\.00000/);
  assert.match(code, /woodDepth <= 5\.00000/);
  assert.match(code, /woodDepth <= 6\.00000/);
  assert.ok(code.indexOf("2.00000") < code.indexOf("5.00000"));
});
