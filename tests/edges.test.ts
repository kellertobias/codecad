import { test } from "node:test";
import assert from "node:assert/strict";
import { Vector3 } from "three";
import {
  Part,
  Project,
  Shapes,
  SolidShape,
  WorldAxes,
  cad,
  recipeBounds,
} from "../src/index.js";
import { OpenCascadeEngine } from "../src/engine.js";

const cube = (id: string, size = 100) =>
  new Part({
    id,
    shape: new Shapes.Box({ width: size, depth: size, height: size }),
  });
/** A 1 mm probe cube intersected with the part, to prove where material sits. */
const probe = (id: string, part: Part, at: Vector3) =>
  new Part({
    id,
    shape: new SolidShape({
      kind: "intersect",
      left: structuredClone(part.recipe),
      right: new Shapes.Box({ width: 1, depth: 1, height: 1 }).move({
        x: at.x - 0.5,
        y: at.y - 0.5,
        z: at.z - 0.5,
      }).recipe,
    }),
  });
async function volumes(project: Project) {
  const engine = new OpenCascadeEngine();
  try {
    const built = await engine.evaluate({ root: project, revision: 1 });
    return {
      diagnostics: built.diagnostics,
      volume: (path: string) =>
        built.meshes.find((mesh) => mesh.componentPath.endsWith("/" + path))
          ?.volume,
    };
  } finally {
    engine.dispose();
  }
}

@cad.project({ id: "symmetric", units: "mm" })
class Symmetric extends Project {
  constructor() {
    super({ id: "symmetric" });
    cube("chamfered").getEdge("top", "left").chamfer(10);
    cube("filleted").getEdge("top", "left").fillet(10);
    cube("corner").getCorner("top", "left", "front").chamfer(10);
    cube("tapered").getEdge("top", "left").taperedFillet(20, 10);
  }
}
test("named face directions select the edge where those faces meet", async () => {
  const built = await volumes(new Symmetric());
  assert.deepEqual(built.diagnostics, []);
  // A 45 degree bevel removes a triangular prism the length of the edge.
  assert.ok(Math.abs(built.volume("chamfered")! - (1e6 - 5000)) < 0.01);
  // A round leaves the square corner minus a quarter circle.
  assert.ok(
    Math.abs(built.volume("filleted")! - (1e6 - (1 - Math.PI / 4) * 1e4)) <
      0.01,
  );
  // A corner bevels all three edges meeting there, and they overlap at the tip:
  // three 5000 prisms less the 2000/3 they share.
  assert.ok(Math.abs(built.volume("corner")! - (1e6 - 43000 / 3)) < 0.5);
  // A round growing from R20 to R10 removes what the swept radius sweeps:
  // between a constant R10 and a constant R20, near the linear estimate.
  const round = (r: number) => (1 - Math.PI / 4) * 100 * r;
  const tapered = 1e6 - built.volume("tapered")!;
  assert.ok(tapered > round(10 * 10) && tapered < round(20 * 20));
  assert.ok(Math.abs(tapered / round((400 + 200 + 100) / 3) - 1) < 0.02);
});

@cad.project({ id: "asymmetric", units: "mm" })
class Asymmetric extends Project {
  constructor() {
    super({ id: "asymmetric" });
    // 20 mm back from the edge along the top face, 30 mm down the left face.
    const block = cube("block");
    block.getEdge("top", "left").chamfer(20, 30);
    // Inside the 20/30 wedge's remaining material, outside the swapped 30/20 one.
    probe("kept", block, new Vector3(18, 50, 94));
  }
}
test("two chamfer distances set back the first and second named faces in order", async () => {
  const built = await volumes(new Asymmetric());
  assert.deepEqual(built.diagnostics, []);
  assert.ok(Math.abs(built.volume("block")! - (1e6 - 30000)) < 0.01);
  assert.ok(
    Math.abs(built.volume("kept")! - 1) < 1e-6,
    `expected the 20/30 wedge to keep the probe, got ${built.volume("kept")}`,
  );
});

@cad.project({ id: "placement", units: "mm" })
class Placement extends Project {
  readonly anchor = cube("anchor", 50);
  readonly follower = cube("follower", 30);
  constructor(turned = false) {
    super({ id: "placement" });
    // A turned project proves the landing is solved in the parent's frame.
    if (turned) this.place({ x: 200, z: 5, rotate: { z: 90 } });
    this.follower.rotate({ axis: WorldAxes.Z, rotation: 90 });
    this.follower.place(
      this.follower.getCorner("top", "left", "back").point(),
      this.anchor.getCorner("top", "right", "front").point(),
    );
  }
}
test("corners give world points, and place lands one point on another", () => {
  const project = new Placement();
  const target = project.anchor.getCorner("top", "right", "front").point();
  assert.deepEqual(target, { x: 50, y: 0, z: 50 });
  const landed = project.follower.getCorner("top", "left", "back").point();
  for (const axis of ["x", "y", "z"] as const)
    assert.ok(Math.abs(landed[axis] - target[axis]) < 1e-9);
  // The quarter turn about world Z is kept: local +X now points along world +Y.
  const corner = new Vector3(30, 0, 0)
    .applyMatrix4(project.follower.worldMatrix())
    .sub(new Vector3(0, 0, 0).applyMatrix4(project.follower.worldMatrix()));
  assert.ok(corner.distanceTo(new Vector3(0, 30, 0)) < 1e-9);
});

test("corner placement solves in the parent frame, not the world axes", () => {
  const project = new Placement(true);
  const target = project.anchor.getCorner("top", "right", "front").point();
  const landed = project.follower.getCorner("top", "left", "back").point();
  assert.ok(Math.abs(target.x - 200) < 1e-9 && Math.abs(target.z - 55) < 1e-9);
  for (const axis of ["x", "y", "z"] as const)
    assert.ok(Math.abs(landed[axis] - target[axis]) < 1e-9);
});

test("rotation accepts a world axis or a line through two points", () => {
  const first = cube("a", 10).rotate({ axis: WorldAxes.Z, angle: 90 });
  const second = cube("b", 10).rotate({
    from: { x: 0, y: 0, z: 0 },
    to: { x: 0, y: 0, z: 5 },
    angle: 90,
  });
  const at = (part: Part) =>
    new Vector3(10, 0, 0).applyMatrix4(part.worldMatrix());
  assert.ok(at(first).distanceTo(new Vector3(0, 10, 0)) < 1e-9);
  assert.ok(at(second).distanceTo(at(first)) < 1e-9);
  assert.throws(() => cube("c").rotate({ angle: 90 }), /axis/);
  assert.throws(
    () => cube("d").rotate({ axis: { x: 0, y: 0, z: 0 }, angle: 90 }),
    /zero length/,
  );
});

test("named directions stay in the part's own frame unless world is asked for", () => {
  const part = cube("turned").place({ rotate: { z: 90 } });
  // The default frame is the material one, so turning the part changes nothing.
  const material = part.getEdge("top", "left").query.directions[1]!;
  assert.ok(Math.abs(material.x + 1) < 1e-9 && Math.abs(material.y) < 1e-9);
  assert.deepEqual(part.getCorner("top", "left", "front").local(), {
    x: 0,
    y: 0,
    z: 100,
  });
  // World "left" (-X) is the part's own +Y once it has turned a quarter turn.
  const world = part.getEdge("top", "left", { frame: "world" }).query
    .directions[1]!;
  assert.ok(Math.abs(world.x) < 1e-9 && Math.abs(world.y - 1) < 1e-9);
  assert.deepEqual(
    part.getCorner("top", "left", "front", { frame: "world" }).local(),
    { x: 0, y: 100, z: 100 },
  );
});

test("edge and corner selections are validated before geometry runs", () => {
  assert.throws(() => cube("x").getEdge(), /one or two/);
  assert.throws(() => cube("x").getEdge("top", "bottom", "left"), /one or two/);
  assert.throws(() => cube("x").getCorner("top", "left"), /three/);
  assert.throws(() => cube("x").getEdge("top", "top"), /Repeated direction/);
  assert.throws(
    () => cube("x").getEdge("top", "left").chamfer(-1),
    /must be positive/,
  );
  assert.throws(
    () => cube("x").getEdge("top").chamfer(2, 3),
    /exactly two face directions/,
  );
  assert.throws(
    () => cube("x").getEdge("top", "left").taperedFillet(5, 0),
    /must be positive/,
  );
});

@cad.project({ id: "machined", units: "mm" })
class Machined extends Project {
  constructor() {
    super({ id: "machined" });
    // A drilled blank is still one body, though the boolean no longer types it
    // as a solid; its edges must stay roundable.
    const plate = cube("plate");
    plate.subtract(
      new Shapes.Cylinder({ diameter: 20, length: 200, x: 50, y: 50, z: 50 }),
    );
    plate.getEdge("top", "front").fillet(8);
    // A radius that cannot fit the face it has to cross is refused. The plate
    // is wide, but a blend on its top edge has to land inside the 6 mm side.
    new Part({
      id: "oversized",
      shape: new Shapes.Box({ width: 360, depth: 220, height: 6 }),
    })
      .getEdge("top", "left")
      .fillet(10);
  }
}
test("cut bodies stay roundable, and an impossible radius names its selection", async () => {
  const built = await volumes(new Machined());
  assert.ok(built.volume("plate")! < 1e6);
  assert.equal(built.diagnostics.length, 1);
  assert.equal(built.diagnostics[0]!.componentPath, "machined/oversized");
  assert.match(built.diagnostics[0]!.message, /Fillet R10 on the top\/left/);
  // The message must name the face that actually sets the limit, and its size.
  assert.match(
    built.diagnostics[0]!.message,
    /left face is only 6 mm across here/,
  );
});

@cad.project({ id: "missing", units: "mm" })
class Missing extends Project {
  constructor() {
    super({ id: "missing" });
    // The bevel separates the two faces. Its own normal sits 45 degrees from
    // both, so the selection has to be tightened before it stops matching.
    const block = cube("block");
    block.getEdge("top", "front").chamfer(10);
    block.getEdge("top", "front", { tolerance: 20 }).fillet(2);
  }
}
test("an edge selection that matches nothing reports the part it came from", async () => {
  const built = await volumes(new Missing());
  assert.equal(built.diagnostics.length, 1);
  assert.match(built.diagnostics[0]!.message, /No top\/front edge/);
  assert.match(built.diagnostics[0]!.componentPath!, /block/);
});
test("opposite faces are rejected as they are written, not at build time", () => {
  assert.throws(
    () => cube("x").getEdge("top", "bottom"),
    /opposite faces and share no edge/,
  );
  assert.throws(
    () => cube("x").getCorner("left", "right", "top"),
    /opposite faces and share no edge/,
  );
});

test("recipe bounds stay analytic through transforms and cuts", () => {
  const box = new Shapes.Box({ width: 10, depth: 20, height: 30 });
  const moved = box.copy().move({ x: 5, rotate: { z: 90 } });
  const bounds = recipeBounds(moved.recipe);
  assert.ok(Math.abs(bounds.min.x - -15) < 1e-9);
  assert.ok(Math.abs(bounds.max.x - 5) < 1e-9);
  assert.ok(Math.abs(bounds.max.y - 10) < 1e-9);
  assert.ok(Math.abs(bounds.max.z - 30) < 1e-9);
});
