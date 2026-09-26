import { test } from "node:test";
import assert from "node:assert/strict";
import * as sdk from "../src/code-part/sdk.js";
import { sdkTypes } from "../app/src/code/sdk-types.js";

// The code editor's declarations of "codecad/part" are written by hand;
// they have to name everything the part API exports.
test("the editor knows every export of the part API", () => {
  const exported = Object.keys(sdk).filter((name) => name !== "runPart");
  for (const name of exported)
    assert.match(
      sdkTypes,
      new RegExp(`export (function|namespace|interface|type) ${name}\\b`),
      `${name} is missing from app/src/code/sdk-types.ts`,
    );
  for (const shape of Object.keys(sdk.Shapes).filter(
    (n) => n !== "ImportedStep",
  ))
    assert.match(sdkTypes, new RegExp(`class ${shape}\\b`));
});
