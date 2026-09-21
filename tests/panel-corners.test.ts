import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Part,
  Project,
  SheetMaterial,
  Shapes,
  cad,
  type PanelAnchor,
  type PanelFaceAnchor,
} from "../src/index.js";
import { Matrix4, Vector3 } from "three";
import { OpenCascadeEngine } from "../src/engine.js";
import { cutRows } from "../src/manufacturing.js";
import { ManufacturingDxf } from "../src/outputs.js";

const hpl = new SheetMaterial({ id: "hpl6", name: "6 mm HPL", thickness: 6 });
/** Material a quarter-round takes out of a blank of this thickness. */
const quarter = (radius: number) => (1 - Math.PI / 4) * radius * radius * 6;

@cad.project({ id: "panels", units: "mm" })
class Panels extends Project {
  constructor() {
    super({ id: "panels" });
    hpl.makePart({ id: "square", width: 220, height: 300 });
    hpl.makePart({
      id: "all-round",
      width: 220,
      height: 300,
      cornerRadius: 10,
    });
    hpl.makePart({
      id: "top-only",
      width: 220,
      height: 300,
      cornerRadius: { "north-west": 10, "north-east": 10 },
    });
    hpl.makePart({
      id: "mixed",
      width: 220,
      height: 300,
      cornerRadius: { "north-west": 20, "north-east": 5 },
    });
  }
}
test("panel corner radii shape the blank itself", async () => {
  const project = new Panels();
  const engine = new OpenCascadeEngine();
  try {
    const built = await engine.evaluate({ root: project, revision: 1 });
    assert.deepEqual(built.diagnostics, []);
    const volume = (id: string) =>
      built.meshes.find((mesh) => mesh.componentPath.endsWith("/" + id))!
        .volume;
    const blank = 220 * 300 * 6;
    assert.ok(Math.abs(volume("square") - blank) < 0.01);
    assert.ok(Math.abs(volume("all-round") - (blank - 4 * quarter(10))) < 0.5);
    assert.ok(Math.abs(volume("top-only") - (blank - 2 * quarter(10))) < 0.5);
    assert.ok(
      Math.abs(volume("mixed") - (blank - quarter(20) - quarter(5))) < 0.5,
    );
  } finally {
    engine.dispose();
  }
});

test("the rounded contour reaches the cut list and the cut DXF", async () => {
  const project = new Panels();
  const engine = new OpenCascadeEngine();
  try {
    const rows = cutRows(project);
    const row = (id: string) => rows.find((r) => r.path.endsWith("/" + id))!;
    assert.equal(row("square").cornerRadius, undefined);
    assert.equal(row("all-round").cornerRadius, 10);
    assert.equal(row("top-only").cornerRadius, 10);
    // Two different radii are not one number; the contour still carries them.
    assert.equal(row("mixed").cornerRadius, undefined);
    // The cut contour itself must lose the square corners, not just the model.
    await engine.evaluate({ root: project, revision: 1 });
    const files = await engine.exportDxf(
      new ManufacturingDxf({ parts: "all", layout: "one-file-per-part" }),
    );
    type Vertex = { x: number; y: number; bulge: number };
    const contour = (id: string): Vertex[] => {
      const text = new TextDecoder().decode(
        [...files].find(([name]) => name.includes(id))![1],
      );
      return [
        ...text.matchAll(
          /^10\n(-?[\d.e-]+)\n20\n(-?[\d.e-]+)(?:\n42\n(-?[\d.e-]+))?$/gm,
        ),
      ].map((m) => ({
        x: Number(m[1]),
        y: Number(m[2]),
        bulge: m[3] ? Number(m[3]) : 0,
      }));
    };
    const has = (points: { x: number; y: number }[], x: number, y: number) =>
      points.some((p) => Math.hypot(p.x - x, p.y - y) < 0.01);
    // Four corners, stated twice: as the blank and as the finished contour.
    assert.equal(contour("square").length, 8);
    assert.ok(
      has(contour("square"), 0, 300) && has(contour("square"), 220, 300),
    );
    const rounded = contour("top-only");
    // Both south corners stay sharp; both north ones are gone, swept by arcs.
    assert.ok(has(rounded, 0, 0) && has(rounded, 220, 0));
    assert.equal(has(rounded, 0, 300), false);
    assert.equal(has(rounded, 220, 300), false);
    // The arcs start and end exactly one radius back from where they were.
    assert.ok(has(rounded, 0, 290) && has(rounded, 10, 300));
    assert.ok(has(rounded, 210, 300) && has(rounded, 220, 290));
    // Six vertices per contour, not a tessellated fan: the two corners are
    // real arcs, on the blank and on the finished contour alike.
    assert.equal(rounded.length, 12);
    const arcs = rounded.filter((vertex) => vertex.bulge !== 0);
    assert.equal(arcs.length, 4);
    for (const arc of arcs)
      // tan(90 degrees / 4) is the exact bulge of a quarter turn.
      assert.ok(Math.abs(Math.abs(arc.bulge) - Math.tan(Math.PI / 8)) < 1e-9);
    // Reconstruct each arc the way a DXF reader does and check it bows around
    // the corner centre at exactly the radius.
    for (const [index, vertex] of rounded.entries()) {
      if (!vertex.bulge) continue;
      const to: Vertex = rounded[(index + 1) % rounded.length]!;
      const dx = to.x - vertex.x,
        dy = to.y - vertex.y,
        chord = Math.hypot(dx, dy);
      const shift = (-vertex.bulge * chord) / 2;
      const apex: { x: number; y: number } = {
        x: (vertex.x + to.x) / 2 + (-dy / chord) * shift,
        y: (vertex.y + to.y) / 2 + (dx / chord) * shift,
      };
      const centre = { x: vertex.x < 110 ? 10 : 210, y: 290 };
      assert.ok(
        Math.abs(Math.hypot(apex.x - centre.x, apex.y - centre.y) - 10) < 1e-9,
        `arc at ${vertex.x},${vertex.y} does not sweep the R10 corner`,
      );
    }
    assert.ok(contour("square").every((vertex) => vertex.bulge === 0));
  } finally {
    engine.dispose();
  }
});

test("corner radii are checked against the edges they sit on", () => {
  const bad = (cornerRadius: object | number) => () =>
    hpl.makePart({ id: "bad", width: 220, height: 300, cornerRadius });
  assert.throws(bad({ "north-west": 200, "north-east": 100 }), /north edge/);
  assert.throws(bad({ "north-west": -1 }), /nonnegative/);
  assert.throws(bad({ "top-left": 10 }), /Unknown panel corner/);
  assert.throws(bad(200), /south edge exceed/);
});

@cad.project({ id: "standing", units: "mm" })
class Standing extends Project {
  constructor() {
    super({ id: "standing" });
    // The same call on the same blank, placed three different ways.
    const flat = hpl.makePart({ id: "flat", width: 220, height: 300 });
    const upright = hpl.makePart({ id: "upright", width: 220, height: 300 });
    upright.orient("YZ", { x: 0, y: 0, z: 0 });
    const tilted = hpl.makePart({ id: "tilted", width: 220, height: 300 });
    tilted.place({ rotate: { x: 30, y: 20, z: 40 } });
    for (const panel of [flat, upright, tilted])
      panel.getEdge("top", "left").fillet(10);
    // Breaking a face edge along the top of the panel, not its corner.
    hpl
      .makePart({ id: "broken", width: 220, height: 300 })
      .getEdge("front", "top")
      .chamfer(2);
  }
}
test("a panel's named edges are the panel's, however it is placed", async () => {
  const engine = new OpenCascadeEngine();
  try {
    const built = await engine.evaluate({ root: new Standing(), revision: 1 });
    assert.deepEqual(built.diagnostics, []);
    const volume = (id: string) =>
      built.meshes.find((mesh) => mesh.componentPath.endsWith("/" + id))!
        .volume;
    const blank = 220 * 300 * 6;
    // top/left is the upright panel's top-left corner, through its thickness.
    for (const id of ["flat", "upright", "tilted"])
      assert.ok(
        Math.abs(volume(id) - (blank - quarter(10))) < 0.5,
        `${id} did not round its own top-left corner`,
      );
    // front/top breaks the face edge across the panel's full 220 mm width.
    assert.ok(Math.abs(volume("broken") - (blank - ((2 * 2) / 2) * 220)) < 1);
  } finally {
    engine.dispose();
  }
});

test("orient anchors the blank by a named point on it", () => {
  const at = (origin: PanelAnchor | undefined, plane: "XY" | "YZ" = "XY") => {
    const panel = hpl.makePart({ id: "anchored", width: 220, height: 300 });
    panel.orient(plane, { x: 0, y: 0, z: 0 }, origin ? { origin } : {});
    const matrix = panel.worldMatrix();
    return (x: number, y: number) => {
      const p = new Vector3(x, y, 0).applyMatrix4(matrix);
      return [+p.x.toFixed(6), +p.y.toFixed(6), +p.z.toFixed(6)];
    };
  };
  // The blank's south-west corner stays the default, as it always was.
  assert.deepEqual(at(undefined)(0, 0), [0, 0, 0]);
  assert.deepEqual(at("south-west")(0, 0), [0, 0, 0]);
  assert.deepEqual(at("north-east")(220, 300), [0, 0, 0]);
  assert.deepEqual(at("north-west")(0, 300), [0, 0, 0]);
  // A single compass point centres the other axis.
  assert.deepEqual(at("south")(110, 0), [0, 0, 0]);
  assert.deepEqual(at("east")(220, 150), [0, 0, 0]);
  assert.deepEqual(at("middle")(110, 150), [0, 0, 0]);
  // The anchor is a point on the blank, so it turns with the panel.
  assert.deepEqual(at("north-east", "YZ")(220, 300), [0, 0, 0]);
  assert.deepEqual(at("middle", "YZ")(0, 0), [0, -110, -150]);
  assert.throws(
    () =>
      hpl.makePart({ id: "bad", width: 10, height: 10 }).orient(
        "XY",
        { x: 0, y: 0, z: 0 },
        {
          origin: "top-left" as PanelAnchor,
        },
      ),
    /Unknown panel origin/,
  );
});

test("orient also picks which side through the thickness is seated", () => {
  const at = (face: PanelFaceAnchor | undefined, plane: "XY" | "YZ" = "XY") => {
    const panel = hpl.makePart({ id: "seated", width: 220, height: 300 });
    panel.orient(
      plane,
      { x: 0, y: 0, z: 0 },
      { origin: "middle", ...(face ? { face } : {}) },
    );
    const matrix = panel.worldMatrix();
    // The blank's back face is local z=0 and its front face z=thickness.
    return (z: number) => {
      const p = new Vector3(110, 150, z).applyMatrix4(matrix);
      return [+p.x.toFixed(6), +p.y.toFixed(6), +p.z.toFixed(6)];
    };
  };
  // The back face stays the default, as it always was.
  assert.deepEqual(at(undefined)(0), [0, 0, 0]);
  assert.deepEqual(at("back")(0), [0, 0, 0]);
  assert.deepEqual(at("front")(6), [0, 0, 0]);
  assert.deepEqual(at("middle")(3), [0, 0, 0]);
  // Seating the front face puts the whole panel behind the point.
  assert.deepEqual(at("front")(0), [0, 0, -6]);
  // The thickness turns with the panel: upright, it runs along world X.
  assert.deepEqual(at("front", "YZ")(6), [0, 0, 0]);
  assert.deepEqual(at("middle", "YZ")(0), [-3, 0, 0]);
  assert.throws(
    () =>
      hpl
        .makePart({ id: "bad", width: 10, height: 10 })
        .orient("XY", { x: 0, y: 0, z: 0 }, { face: "top" as PanelFaceAnchor }),
    /Unknown panel face/,
  );
});

@cad.project({ id: "aligned", units: "mm" })
class Aligned extends Project {
  readonly floor = hpl
    .makePart({ id: "floor", width: 360, height: 220 })
    .orient("XY", { x: 0, y: 0, z: 0 }, { origin: "middle" });
  readonly back = hpl.makePart({ id: "back", width: 360, height: 300 });
  constructor() {
    super({ id: "aligned" });
    // Stand the back panel on the floor's far edge, its back face against it.
    this.back.orient("XZ", this.floor.getEdge("top", "front"), {
      origin: "south",
      face: "back",
    });
  }
}
test("an edge gives points to align another part against", async () => {
  const project = new Aligned();
  const edge = project.floor.getEdge("top", "front");
  assert.deepEqual(edge.point(), { x: 0, y: 110, z: 6 });
  assert.deepEqual(edge.point("left"), { x: -180, y: 110, z: 6 });
  assert.deepEqual(edge.point("right"), { x: 180, y: 110, z: 6 });
  // A single named face has no free pair of corners either: its centre.
  assert.deepEqual(project.floor.getEdge("front").point(), {
    x: 0,
    y: 0,
    z: 6,
  });
  // The panel meets the edge it was given, by its own back face.
  assert.deepEqual(project.back.getEdge("bottom", "back").point(), {
    x: 0,
    y: 110,
    z: 6,
  });
  const engine = new OpenCascadeEngine();
  try {
    const built = await engine.evaluate({ root: project, revision: 1 });
    assert.deepEqual(built.diagnostics, []);
    const bounds = (id: string) => {
      const mesh = built.meshes.find((m) =>
        m.componentPath.endsWith("/" + id),
      )!;
      const matrix = new Matrix4().fromArray(mesh.matrix);
      const min = new Vector3(Infinity, Infinity, Infinity),
        max = new Vector3(-Infinity, -Infinity, -Infinity);
      for (let i = 0; i < mesh.positions.length; i += 3) {
        const v = new Vector3(
          mesh.positions[i]!,
          mesh.positions[i + 1]!,
          mesh.positions[i + 2]!,
        ).applyMatrix4(matrix);
        min.min(v);
        max.max(v);
      }
      return [min.toArray(), max.toArray()].flat().map((n) => +n.toFixed(3));
    };
    // Full width, standing on the floor, its 6 mm thickness inside the edge.
    assert.deepEqual(bounds("back"), [-180, 104, 6, 180, 110, 306]);
  } finally {
    engine.dispose();
  }
});

test("sheet parts answer to the panel compass as well as the face names", () => {
  const panel = hpl
    .makePart({ id: "compass", width: 220, height: 300 })
    .orient("YZ", { x: 0, y: 0, z: 0 }, { origin: "south" });
  // The compass and the standing-panel names are the same four edges.
  for (const [compass, face] of [
    ["north", "top"],
    ["south", "bottom"],
    ["east", "right"],
    ["west", "left"],
  ] as const)
    assert.deepEqual(
      panel.getEdge(compass, "front").point(),
      panel.getEdge(face, "front").point(),
    );
  assert.deepEqual(
    panel.getCorner("north", "west", "front").point(),
    panel.getCorner("top", "left", "front").point(),
  );
  // Mixing the two vocabularies still catches an impossible pair.
  assert.throws(
    () => panel.getEdge("north", "bottom"),
    /opposite faces and share no edge/,
  );
  // A solid has no compass; only panels do.
  assert.throws(
    () =>
      new Part({
        id: "solid",
        shape: new Shapes.Box({ width: 10, depth: 10, height: 10 }),
      }).getEdge("north", "front"),
    /has no north face/,
  );
});

@cad.project({ id: "origin", units: "mm" })
class Origin extends Project {
  readonly bare = new Part({
    id: "bare",
    shape: new Shapes.Box({ width: 10, depth: 10, height: 10 }),
  });
  readonly panel = hpl.makePart({ id: "panel", width: 20, height: 30 });
  constructor() {
    super({ id: "origin" });
  }
}
test("a component that was never placed sits at its parent's origin", () => {
  const project = new Origin();
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  assert.deepEqual(project.bare.worldMatrix().toArray(), identity);
  assert.deepEqual(project.panel.worldMatrix().toArray(), identity);
  assert.deepEqual(project.bare.getCorner("bottom", "left", "front").point(), {
    x: 0,
    y: 0,
    z: 0,
  });
});
