import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bodyFeature,
  dependencies,
  insertFeature,
  moveFeature,
  nextName,
  whyNotMove,
} from "../src/document/features.js";
import {
  emptyDocument,
  type CadDocument,
  type Feature,
} from "../src/document/schema.js";

const sketch = (id: string, face?: string): Feature => ({
  id,
  type: "sketch",
  name: id,
  plane: "XY",
  entities: [],
  constraints: [],
  ...(face ? { face: { body: `${face}:0`, origin: face, role: "end" } } : {}),
});
const extrude = (id: string, from: string): Feature => ({
  id,
  type: "extrude",
  name: id,
  sketch: from,
  operation: "new",
  extent: "blind",
  distance: "10",
});
const doc = (...features: Feature[]): CadDocument => ({
  ...emptyDocument(),
  features,
});

test("bodies name the feature that made them", () => {
  assert.equal(bodyFeature("panel:0"), "panel");
  assert.equal(bodyFeature("ring#3:legs:0"), "ring");
});

test("a feature depends on its sketch and on the faces it refers to", () => {
  assert.deepEqual([...dependencies(extrude("e", "s"))], ["s"]);
  assert.deepEqual([...dependencies(sketch("s2", "e"))], ["e"]);
  assert.deepEqual(
    [
      ...dependencies({
        id: "p",
        type: "pattern",
        name: "p",
        kind: "linear",
        axis: "X",
        count: "3",
        spacing: "10",
        features: ["h"],
        bodies: ["m#1:e:0"],
      }),
    ].sort(),
    ["h", "m"],
  );
});

test("a feature cannot move before what it uses or after what uses it", () => {
  const document = doc(
    sketch("s"),
    extrude("e", "s"),
    sketch("s2", "e"),
    extrude("e2", "s2"),
    sketch("free"),
  );
  assert.match(
    whyNotMove(document, "e", 0)!,
    /e uses s, which would come after it/,
  );
  assert.match(whyNotMove(document, "e", 3)!, /s2 uses e/);
  assert.equal(whyNotMove(document, "free", 0), undefined);
  assert.deepEqual(
    moveFeature(document, "free", 0).features.map((f) => f.id),
    ["free", "s", "e", "s2", "e2"],
  );
});

test("new features go after the rollback bar and get the next free name", () => {
  const document = doc(sketch("s"), extrude("e", "s"));
  const added = insertFeature(
    document,
    { ...sketch("n"), name: nextName(document, "sketch") },
    0,
  );
  assert.deepEqual(
    added.features.map((f) => f.id),
    ["s", "n", "e"],
  );
  assert.equal(added.features[1]!.name, "Sketch 2");
  assert.equal(nextName(added, "extrude"), "Extrude 2");
});
