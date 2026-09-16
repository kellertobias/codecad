import { test } from "node:test";
import assert from "node:assert/strict";
import * as b from "brepjs/quick";
import { Matrix4 } from "three";
import {
  SmallApartment,
  Window,
  Door,
  apartment,
} from "../examples/small-apartment.js";
import { OpenCascadeEngine } from "../src/engine.js";
import { renderDrawingFormats } from "../src/drawing.js";
import { descendants } from "../src/model.js";

test("apartment has four windowed rooms, actual openings and a north-up cut floor plan", async () => {
  const project = new SmallApartment(),
    engine = new OpenCascadeEngine();
  try {
    for (const room of [
      project.hallway,
      project.living,
      project.bedroom,
      project.bathroom,
    ]) {
      assert.equal(
        room.children.filter((c) => c.id.endsWith("window")).length,
        1,
      );
      assert.ok(room.children.some((c) => c.id === "floor"));
    }
    assert.equal(
      descendants(project.hallway).filter((c) => c.id.endsWith("door")).length,
      1,
      "only the entrance has a door; the living doorway is open",
    );
    const result = await engine.evaluate({ root: project, revision: 1 });
    assert.deepEqual(result.diagnostics, []);
    assert.equal(
      result.meshes.length,
      60,
      "two pairs of inner walls are fused",
    );
    assert.equal(project.walls.length, 6);
    for (const id of ["hallway-partition", "bed-bath-partition"])
      assert.equal(
        project.walls.find((wall) => wall.id === id)?.drawingMaterial?.name,
        "Plastered wall",
      );
    assert.equal(
      project.openings.filter((opening) => opening instanceof Window).length,
      4,
    );
    assert.equal(
      project.openings.filter((opening) => opening instanceof Door).length,
      3,
    );
    const motion = project.openingMotion();
    assert.equal(motion.animations.length, 7);
    for (const opening of project.openings) {
      const moving = opening instanceof Door ? opening.leaf : opening.sash;
      assert.ok(moving.children.length > 0);
      assert.notDeepEqual(
        motion.pose(moving, 0).elements,
        motion.pose(moving, 1).elements,
      );
    }
    const walls = engine.own(
      b.compound(project.walls.map((p) => engine.subject(p))),
    );
    for (const [x, y, z, w, d, h] of [
      [560, 0, 0, 880, 200, 2100],
      [710, 2200, 0, 980, 150, 2100],
      [4900, 710, 0, 150, 780, 2100],
      [4900, 3410, 0, 150, 880, 2100],
      [1110, 6200, 910, 2180, 200, 1280],
      [5710, 6200, 910, 1380, 200, 1280],
      [0, 910, 910, 200, 780, 1280],
      [7800, 910, 1110, 200, 780, 1080],
    ]) {
      const sample = engine.transform(
        engine.own(b.box(w!, d!, h!)),
        new Matrix4().makeTranslation(x!, y!, z!),
      );
      const overlap = engine.own(b.unwrap(b.intersect(walls, sample)));
      assert.ok(
        Math.abs(b.unwrap(b.measureVolume(overlap))) < 0.001,
        "door/window opening must be cut from the wall",
      );
    }
    const drawing = await renderDrawingFormats(engine, project.drawing());
    assert.equal(drawing.pages.length, 2);
    const svg = new TextDecoder().decode(drawing.pages[0]);
    assert.match(svg, /x="61.25" y="153.75"[^>]*>01 HALL/);
    assert.match(svg, /1000 mm opening, NO door/);
    assert.ok(
      (svg.match(/<path/g) ?? []).length > 150,
      "floor must not occlude furniture and window edges",
    );
    assert.match(new TextDecoder().decode(drawing.dxf), /DOOR_SWING/);
    assert.match(new TextDecoder().decode(drawing.dxf), /WINDOW_FRAME/);
    assert.match(
      svg,
      /stroke="#777777"/,
      "sectioned plaster walls retain hatching",
    );
    assert.equal(
      engine.bounds(engine.subject(project.walls[0]!)).max.z,
      apartment.height,
      "drawing section must not cut the model itself",
    );
  } finally {
    engine.dispose();
  }
});
