import { test } from "node:test";
import assert from "node:assert/strict";
import { availableViews } from "../web/available-views.js";

test("Drawings is always available while other views follow configured outputs", () => {
  assert.deepEqual(availableViews({ files: [], reports: [], cutList: [] }), {
    drawing: true,
    nesting: false,
    cuts: false,
    exports: false,
  });
  assert.deepEqual(
    availableViews({ files: [{ kind: "drawing" }], reports: [], cutList: [] }),
    {
      drawing: true,
      nesting: false,
      cuts: false,
      exports: true,
    },
  );
  assert.deepEqual(
    availableViews({
      files: [],
      reports: [{ kind: "nesting" }],
      cutList: [{}],
    }),
    {
      drawing: true,
      nesting: true,
      cuts: true,
      exports: true,
    },
  );
});
