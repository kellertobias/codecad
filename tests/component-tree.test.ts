import { test } from "node:test";
import assert from "node:assert/strict";
import { initiallyExpandedPaths } from "../web/component-tree.js";

test("initial component tree exposes drawers and their nested rails", () => {
  assert.deepEqual(
    initiallyExpandedPaths([
      { path: "cabinet" },
      { path: "cabinet/drawer", parent: "cabinet" },
      { path: "cabinet/drawer/rail", parent: "cabinet/drawer" },
      { path: "cabinet/drawer/rail/inner", parent: "cabinet/drawer/rail" },
    ]),
    ["cabinet", "cabinet/drawer"],
  );
});
