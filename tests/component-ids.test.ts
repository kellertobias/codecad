import { test } from "node:test";
import assert from "node:assert/strict";
import { Assembly, Part, Project, Shapes, cad } from "../src/index.js";

const box = () => new Shapes.Box({ width: 10, depth: 10, height: 10 });

@cad.part({ id: "shelf", revision: "1" })
class Shelf extends Assembly {
  constructor(id: string) {
    super({ id });
    new Part({ id: "panel left", shape: box() });
    new Part({ id: "panel right", shape: box() });
  }
}

@cad.project({ id: "id-test", units: "mm" })
class Fixture extends Project {
  constructor() {
    super({ id: "id test" });
    new Shelf("shelf one");
    new Shelf("shelf two");
  }
}

test("ids only have to tell siblings apart, so spaces and reuse across parts are fine", () => {
  const project = new Fixture();
  assert.deepEqual(
    project.children.map((c) => c.path),
    ["id test/shelf one", "id test/shelf two"],
  );
  assert.deepEqual(
    (project.children[0] as Assembly).children.map((c) => c.path),
    ["id test/shelf one/panel left", "id test/shelf one/panel right"],
  );
  // The same id under a different parent stays a distinct component.
  assert.deepEqual(
    (project.children[1] as Assembly).children.map((c) => c.id),
    ["panel left", "panel right"],
  );
});

test("siblings still may not share an id", () => {
  @cad.project({ id: "clash-test", units: "mm" })
  class Clash extends Project {
    constructor() {
      super({ id: "clash" });
      new Part({ id: "panel", shape: box() });
      new Part({ id: "panel", shape: box() });
    }
  }
  assert.throws(() => new Clash(), /Duplicate component id panel in clash/);
});

test("ids may not be empty, padded, traversal segments or contain separators", () => {
  for (const id of ["", "  ", " panel", "panel ", ".", "..", "a/b", "a\\b"])
    assert.throws(
      () => new Part({ id, shape: box() }),
      /Invalid component id/,
      `expected ${JSON.stringify(id)} to be rejected`,
    );
});
