import { test } from "node:test";
import assert from "node:assert/strict";
import * as b from "brepjs/quick";
import {
  FingerJoint,
  Project,
  SheetMaterial,
  cad,
  type SheetPart,
} from "../src/index.js";
import { OpenCascadeEngine } from "../src/engine.js";
import { partEntities } from "../src/manufacturing.js";

const t = 6;
const hpl = new SheetMaterial({ id: "hpl6", name: "6 mm HPL", thickness: t });
const width = 360,
  depth = 220,
  height = 300;

@cad.project({ id: "carcass", units: "mm" })
class Carcass extends Project {
  readonly floor: SheetPart;
  readonly left: SheetPart;
  readonly right: SheetPart;
  readonly shelf: SheetPart;
  readonly joined: number;
  constructor() {
    super({ id: "carcass" });
    this.floor = hpl
      .makePart({ id: "floor", width, height: depth })
      .orient("XY", { x: 0, y: 0, z: 0 }, { origin: "middle" });
    this.left = hpl
      .makePart({ id: "left", width: depth, height })
      .orient("YZ", { x: -width / 2, y: 0, z: 0 }, { origin: "south" });
    this.right = hpl
      .makePart({ id: "right", width: depth, height })
      .orient("YZ", { x: width / 2 - t, y: 0, z: 0 }, { origin: "south" });
    // A shelf crossing both sides partway up: it enters their faces.
    this.shelf = hpl
      .makePart({ id: "shelf", width, height: depth })
      .orient("XY", { x: 0, y: 0, z: 150 }, { origin: "middle" });
    this.joined = FingerJoint.joinAll(
      [this.floor, this.left, this.right, this.shelf],
      { fingerWidth: 30, clearance: 0.15, edgeMargin: 30 },
    );
  }
}

test("intersecting panels are found, and parallel ones are left alone", () => {
  const project = new Carcass();
  const pairs = FingerJoint.intersecting([
    project.floor,
    project.left,
    project.right,
    project.shelf,
  ]).map(([first, second]) => `${first.id}+${second.id}`);
  // The floor and the shelf are parallel, so they share no joint.
  assert.deepEqual(pairs, [
    "floor+left",
    "floor+right",
    "left+shelf",
    "right+shelf",
  ]);
  assert.equal(project.joined, 4);
});

test("automatic finger joints interlock without colliding or leaving gaps", async () => {
  const project = new Carcass();
  const engine = new OpenCascadeEngine();
  try {
    const built = await engine.evaluate({ root: project, revision: 1 });
    assert.deepEqual(built.diagnostics, []);
    for (const [first, second] of [
      [project.floor, project.left],
      [project.floor, project.right],
      [project.left, project.shelf],
      [project.right, project.shelf],
    ] as const) {
      const a = engine.subject(first),
        c = engine.subject(second);
      // Fingers of one fill the slots of the other: no shared material...
      const shared = b.unwrap(b.measureVolume(b.unwrap(b.intersect(a, c))));
      assert.ok(
        shared < 1e-6,
        `${first.id} and ${second.id} still collide by ${shared} mm3`,
      );
      // ...and no void either, bar the clearance cut at each finger edge.
      const boxA = engine.bounds(a),
        boxC = engine.bounds(c);
      const low = boxA.min.clone().max(boxC.min),
        high = boxA.max.clone().min(boxC.max);
      const size = high.clone().sub(low);
      const region = engine.own(
        b.box(size.x, size.y, size.z, {
          at: low.clone().add(high).multiplyScalar(0.5).toArray(),
          centered: true,
        }),
      );
      const overlap = size.x * size.y * size.z;
      assert.ok(Math.abs(overlap - t * t * depth) < 1e-6);
      const filled = b.unwrap(
        b.measureVolume(b.unwrap(b.intersect(b.unwrap(b.fuse(a, c)), region))),
      );
      assert.ok(
        filled > overlap * 0.99 && filled <= overlap + 1e-6,
        `${first.id}/${second.id} joint is ${filled} of ${overlap} mm3`,
      );
    }
  } finally {
    engine.dispose();
  }
});

/** A toolbox carcass: a mirrored side pair, two shelves and two walls, which
 * is the arrangement that first showed corners being cut away twice. */
@cad.project({ id: "corner", units: "mm" })
class Carcass3Way extends Project {
  readonly panels: SheetPart[];
  constructor() {
    super({ id: "corner" });
    const shelfZ = 105;
    const left = hpl
      .makePart({ id: "side-left", width: depth, height })
      .orient(
        "YZ",
        { x: -width / 2 + t, y: 0, z: 0 },
        { origin: "south", face: "front" },
      );
    // Mirrored, so its joints run the opposite way along the shared axis.
    const right = left
      .copy({ id: "side-right" })
      .orient("YZ", { x: width / 2 - t, y: 0, z: 0 }, { origin: "south" });
    const floor = hpl
      .makePart({ id: "floor", width, height: depth })
      .orient("XY", { x: 0, y: 0, z: 0 }, { origin: "middle" });
    const shelf = floor
      .copy({ id: "shelf" })
      .orient("XY", { x: 0, y: 0, z: shelfZ }, { origin: "middle" });
    const front = hpl
      .makePart({ id: "front", width, height: height - shelfZ })
      .orient("XZ", shelf.getEdge("south", "back"), {
        origin: "south",
        face: "front",
      });
    const back = hpl
      .makePart({ id: "back", width, height })
      .orient("XZ", floor.getEdge("north", "back"), {
        origin: "south",
        face: "back",
      });
    this.panels = [left, right, floor, shelf, front, back];
    FingerJoint.joinAll(this.panels, {
      fingerWidth: 30,
      clearance: 0.15,
      edgeMargin: 30,
    });
  }
}
test("every corner where three panels meet is filled once, not cut twice", async () => {
  const project = new Carcass3Way();
  const engine = new OpenCascadeEngine();
  try {
    const built = await engine.evaluate({ root: project, revision: 1 });
    assert.deepEqual(built.diagnostics, []);
    const solids = project.panels.map((part) => engine.subject(part));
    // Nothing in the carcass shares material with anything else.
    const fused = solids.reduce((all, solid) =>
      engine.own(b.unwrap(b.fuse(all, solid))),
    );
    const separate = solids.reduce(
      (total, solid) => total + b.unwrap(b.measureVolume(solid)),
      0,
    );
    assert.ok(
      Math.abs(b.unwrap(b.measureVolume(fused)) - separate) < 1e-6,
      "panels overlap each other",
    );
    // Wherever three panels reach into the same cube, one of them has to fill
    // it. Left to themselves the two joints crossing there both cut it out.
    const boxes = solids.map((solid) => engine.bounds(solid));
    let corners = 0;
    for (let i = 0; i < solids.length; i++)
      for (let j = i + 1; j < solids.length; j++)
        for (let k = j + 1; k < solids.length; k++) {
          const low = boxes[i]!.min.clone()
            .max(boxes[j]!.min)
            .max(boxes[k]!.min);
          const high = boxes[i]!.max.clone()
            .min(boxes[j]!.max)
            .min(boxes[k]!.max);
          const size = high.clone().sub(low);
          if (Math.min(size.x, size.y, size.z) < 1e-6) continue;
          corners++;
          const probe = engine.own(
            b.box(size.x, size.y, size.z, {
              at: low.clone().add(high).multiplyScalar(0.5).toArray(),
              centered: true,
            }),
          );
          const filled = b.unwrap(
            b.measureVolume(b.unwrap(b.intersect(fused, probe))),
          );
          const volume = size.x * size.y * size.z;
          // Only the clearance may bite into it.
          assert.ok(
            filled > volume - 0.15 * t * t && filled <= volume + 1e-6,
            `${project.panels[i]!.id}/${project.panels[j]!.id}/${project.panels[k]!.id} corner is ${filled.toFixed(2)} of ${volume.toFixed(2)} mm3`,
          );
        }
    assert.equal(corners, 6);
  } finally {
    engine.dispose();
  }
});

@cad.project({ id: "refused", units: "mm" })
class Refused extends Project {
  readonly floor = hpl
    .makePart({ id: "floor", width, height: depth })
    .orient("XY", { x: 0, y: 0, z: 0 }, { origin: "middle" });
  readonly lid = hpl
    .makePart({ id: "lid", width, height: depth })
    .orient("XY", { x: 0, y: 0, z: height }, { origin: "middle" });
  readonly apart = hpl
    .makePart({ id: "apart", width: depth, height })
    .orient("YZ", { x: width, y: 0, z: 0 }, { origin: "south" });
  constructor() {
    super({ id: "refused" });
  }
}
test("panels that cannot share a finger joint say why", () => {
  const project = new Refused();
  const options = { fingerWidth: 30 };
  assert.throws(
    () => new FingerJoint(project.floor, project.lid, options),
    /parallel/,
  );
  assert.throws(
    () => new FingerJoint(project.floor, project.apart, options),
    /do not overlap/,
  );
  // Nothing in the set meets anything else.
  assert.deepEqual(
    FingerJoint.intersecting([project.floor, project.lid, project.apart]),
    [],
  );
});

test("an internal joint keeps a fifth of its ends unless the margin is stated", () => {
  // A slot through a panel's face protects a fifth of the overlap at each end,
  // so the receiving panel is not left hanging on its edges.
  assert.deepEqual(FingerJoint.interval(100, { internal: true }), {
    start: 20,
    end: 80,
  });
  assert.deepEqual(
    FingerJoint.interval(100, { internal: true, edgeMargin: 5 }),
    {
      start: 20,
      end: 80,
    },
  );
  // An exact margin is taken as given, including none at all.
  assert.deepEqual(
    FingerJoint.interval(100, { internal: true, exactEdgeMargin: 0 }),
    { start: 0, end: 100 },
  );
  assert.deepEqual(
    FingerJoint.interval(100, { internal: true, exactEdgeMargin: 5 }),
    { start: 5, end: 95 },
  );
  // It wins over the automatic floor even when a plain margin is also given.
  assert.deepEqual(
    FingerJoint.interval(100, {
      internal: true,
      edgeMargin: 30,
      exactEdgeMargin: 12,
    }),
    { start: 12, end: 88 },
  );
  // A corner joint fingers the whole overlap either way.
  assert.deepEqual(FingerJoint.interval(100, { internal: false }), {
    start: 0,
    end: 100,
  });
});

test("a shelf given an exact margin keeps exactly that much at its ends", async () => {
  @cad.project({ id: "reaching-carcass", units: "mm" })
  class Reaching extends Project {
    readonly left: SheetPart;
    readonly shelf: SheetPart;
    constructor(exactEdgeMargin: number | undefined) {
      super({ id: "reaching-carcass" });
      this.left = hpl
        .makePart({ id: "left", width: depth, height })
        .orient("YZ", { x: -width / 2, y: 0, z: 0 }, { origin: "south" });
      this.shelf = hpl
        .makePart({ id: "shelf", width, height: depth })
        .orient("XY", { x: 0, y: 0, z: 150 }, { origin: "middle" });
      new FingerJoint(this.left, this.shelf, {
        fingerWidth: 30,
        clearance: 0.15,
        startWith: "first",
        ...(exactEdgeMargin === undefined ? {} : { exactEdgeMargin }),
      });
    }
  }
  const engine = new OpenCascadeEngine();
  try {
    const band = async (exactEdgeMargin: number | undefined) => {
      const project = new Reaching(exactEdgeMargin);
      const built = await engine.evaluate({ root: project, revision: 1 });
      assert.deepEqual(built.diagnostics, []);
      const entities = await partEntities(engine, project.left);
      return entities.flatMap((entity) =>
        entity.kind === "polyline" && entity.layer !== "BLANK_OUTLINE"
          ? entity.points
              .filter((point) => point.y > 149 && point.y < 157)
              .map((point) => point.x)
          : [],
      );
    };
    // By default the slot stops a fifth of the way in, at 44 of the 220 overlap.
    const kept = await band(undefined);
    assert.ok(Math.min(...kept) > 43, kept.join(" "));
    // A stated 20 mm margin is exactly that, whatever the overlap measures.
    const stated = await band(20);
    assert.ok(
      Math.min(...stated) > 19.9 && Math.min(...stated) < 20.1,
      stated.join(" "),
    );
    // None at all cuts the panel's own end, so it joins the cut contour.
    const reaching = await band(0);
    assert.ok(Math.min(...reaching) < 1e-6, reaching.join(" "));
  } finally {
    engine.dispose();
  }
});

test("a slot through a face can keep wider webs than the fingers take", async () => {
  @cad.project({ id: "webbed-carcass", units: "mm" })
  class Webbed extends Project {
    readonly left: SheetPart;
    readonly shelf: SheetPart;
    constructor(minimumWeb: number | undefined) {
      super({ id: "webbed-carcass" });
      this.left = hpl
        .makePart({ id: "left", width: depth, height })
        .orient("YZ", { x: -width / 2, y: 0, z: 0 }, { origin: "south" });
      this.shelf = hpl
        .makePart({ id: "shelf", width, height: depth })
        .orient("XY", { x: 0, y: 0, z: 150 }, { origin: "middle" });
      new FingerJoint(this.left, this.shelf, {
        fingerWidth: 20,
        clearance: 0,
        startWith: "first",
        ...(minimumWeb === undefined ? {} : { minimumWeb }),
      });
    }
  }
  const engine = new OpenCascadeEngine();
  try {
    // Slots cut into the receiving panel, as [width, gap to the next one].
    const pattern = async (minimumWeb: number | undefined) => {
      const project = new Webbed(minimumWeb);
      await engine.evaluate({ root: project, revision: 1 });
      const spans = (await partEntities(engine, project.left))
        .flatMap((entity) =>
          entity.kind === "polyline" && entity.layer.startsWith("CUT")
            ? [entity.points.map((point) => point.x)]
            : [],
        )
        .map((xs) => [Math.min(...xs), Math.max(...xs)] as const)
        .sort((a, c) => a[0] - c[0]);
      return {
        slots: spans.map(([from, to]) => Math.round(to - from)),
        webs: spans
          .slice(1)
          .map(([from], index) => Math.round(from - spans[index]![1])),
      };
    };
    // The pattern runs out at the end of the overlap, so the last slot may be
    // a partial one; the ones before it, and every web, are full width.
    const full = (values: number[]) => new Set(values.slice(0, -1));
    // Evenly alternating by default: the webs are as wide as the fingers.
    const even = await pattern(undefined);
    assert.deepEqual(full(even.slots), new Set([20]));
    assert.deepEqual(new Set(even.webs), new Set([20]));
    // Asked for 30, the receiving panel keeps 30 between 20 mm slots.
    const webbed = await pattern(30);
    assert.deepEqual(full(webbed.slots), new Set([20]));
    assert.deepEqual(new Set(webbed.webs), new Set([30]));
  } finally {
    engine.dispose();
  }
});
