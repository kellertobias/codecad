import { test } from "node:test";
import assert from "node:assert/strict";
import { Project, Assembly, Part, Shapes, cad } from "../src/index.js";
import { getSolids } from "brepjs";
import { OpenCascadeEngine } from "../src/engine.js";
import { JoinedSolids } from "../examples/joined-solids.js";

@cad.project({ id: "join-test", units: "mm" })
class Fixture extends Project {
  a: Part;
  b: Part;
  constructor() {
    super({ id: "join-test" });
    this.place({ x: 200, rotate: { z: 90 } });
    this.a = new Part({
      id: "a",
      shape: new Shapes.Box({ width: 10, depth: 10, height: 10 }),
    });
    this.b = new Part({
      id: "b",
      shape: new Shapes.Box({ width: 10, depth: 10, height: 10 }),
    }).place({ x: 5 });
  }
}
test("joinSolids fuses world placements without duplicate exports and snapshots sources", async () => {
  const project = new Fixture(),
    engine = new OpenCascadeEngine();
  const before = project.b.worldMatrix().toArray();
  const result = project.joinSolids([project.a, project.b, project.a], {
    id: "body",
  });
  assert.deepEqual(project.parts.all, [result]);
  assert.deepEqual(project.b.worldMatrix().toArray(), before);
  project.b.union(new Shapes.Box({ width: 100, depth: 100, height: 100 }));
  try {
    const built = await engine.evaluate({ root: project, revision: 1 });
    assert.deepEqual(built.diagnostics, []);
    assert.equal(built.meshes.length, 1);
    assert.ok(Math.abs(built.meshes[0]!.volume - 1500) < 0.001);
    assert.equal(getSolids(engine.shapes.get(result)!).length, 1);
  } finally {
    engine.dispose();
  }
});

@cad.part({ id: "group", revision: "1" })
class Group extends Assembly {
  constructor() {
    super({ id: "group" });
    new Part({
      id: "cube",
      shape: new Shapes.Box({ width: 10, depth: 10, height: 10 }),
    });
  }
}
@cad.project({ id: "nested-join", units: "mm" })
class Nested extends Project {
  constructor() {
    super({ id: "nested-join" });
    const group = new Group().place({ x: 10 });
    const cube = new Part({
      id: "cube",
      shape: new Shapes.Box({ width: 10, depth: 10, height: 10 }),
    });
    this.joinSolids([group, group.children[0]!, cube], { id: "shell" });
  }
}
test("nested assembly and face-touching solids are consumed exactly once", async () => {
  const project = new Nested(),
    engine = new OpenCascadeEngine();
  try {
    const built = await engine.evaluate({ root: project, revision: 1 });
    assert.deepEqual(built.diagnostics, []);
    assert.equal(project.registry.all.length, 1);
    assert.ok(Math.abs(built.meshes[0]!.volume - 2000) < 0.001);
    assert.equal(
      getSolids(engine.shapes.get(project.parts.all[0]!)!).length,
      1,
    );
  } finally {
    engine.dispose();
  }
});
test("join validation is nonmutating and source retention is explicit", () => {
  const project = new Fixture();
  assert.throws(() => project.joinSolids([]), /requires/);
  assert.throws(() => project.joinSolids([project]), /belonging/);
  assert.throws(
    () => project.joinSolids([project.a], { id: "b" }),
    /Duplicate/,
  );
  assert.equal(project.parts.all.length, 2);
  project.joinSolids([project.a, project.b], { keepSources: true });
  assert.equal(project.parts.all.length, 3);
});
test("architecture union example builds as one exported part", async () => {
  const engine = new OpenCascadeEngine();
  try {
    const built = await engine.evaluate({
      root: new JoinedSolids(),
      revision: 1,
    });
    assert.deepEqual(built.diagnostics, []);
    assert.equal(built.meshes.length, 1);
  } finally {
    engine.dispose();
  }
});
