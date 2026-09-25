import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as b from "brepjs/quick";
import { SketchSolver } from "../src/document/sketch-solver.js";
import type {
  CadDocument,
  ExtrudeFeature,
  Feature,
  SketchFeature,
} from "../src/document/schema.js";
import {
  extrude,
  points,
  rectangle,
  solvedDocument,
} from "./support/documents.js";
import {
  DocumentEvaluator,
  referenceEdge,
  referenceFace,
  type Body,
  type Evaluation,
} from "../src/kernel/evaluator.js";

let solver: SketchSolver;
before(async () => {
  solver = await SketchSolver.create();
});
after(() => solver.dispose());

const document = (
  variables: Record<string, string>,
  features: Feature[],
): CadDocument => solvedDocument(solver, variables, features);

const volume = (body: Body) => b.unwrap(b.measureVolume(body.shape));
const near = (actual: number, expected: number, tolerance = 1e-3) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)),
    `${actual} ≈ ${expected}`,
  );
const ok = (evaluation: Evaluation) => {
  for (const [id, status] of evaluation.status)
    assert.ok(
      status.state === "ok",
      `${id}: ${status.state === "error" ? status.message : status.state}`,
    );
};
const bounds = (body: Body) => b.getBounds(body.shape);

/** A panel with a pocket cut into its top from a sketch on that face. */
function pocketed(
  width: string,
  pocketX: string,
): [SketchFeature, ExtrudeFeature, SketchFeature, ExtrudeFeature] {
  const plate = rectangle("plate", "XY", "0", "0", width, "400");
  return [
    plate,
    extrude("panel", "plate", { distance: "t" }),
    rectangle("pocket", "XY", pocketX, "100", "50", "30", {
      face: { body: "panel:0", origin: "panel", role: "end" },
    }),
    extrude("cut", "pocket", {
      operation: "cut",
      distance: "6",
      reverse: true,
    }),
  ];
}

test("an extruded rectangle is one body named after the extrude", () => {
  const evaluator = new DocumentEvaluator();
  const result = evaluator.evaluate(
    document({ t: "18" }, [
      rectangle("s", "XY", "0", "0", "600", "400"),
      extrude("e", "s", { distance: "t" }),
    ]),
  );
  ok(result);
  assert.equal(result.bodies.length, 1);
  const [body] = result.bodies;
  assert.equal(body!.id, "e:0");
  assert.equal(body!.name, "e");
  near(volume(body!), 600 * 400 * 18);
  assert.deepEqual([...body!.roles.get("e")!.keys()].sort(), [
    "end",
    "side:s.bottom",
    "side:s.left",
    "side:s.right",
    "side:s.top",
    "start",
  ]);
  assert.equal(body!.blank?.depth, 18);
  evaluator.dispose();
});

test("one extrude of several regions makes several named bodies", () => {
  const two = rectangle("s", "XY", "0", "0", "100", "50");
  const other = rectangle("o", "XY", "200", "0", "80", "50");
  const sketch: SketchFeature = {
    ...two,
    entities: [...two.entities, ...other.entities],
    constraints: [...two.constraints, ...other.constraints],
  };
  const evaluator = new DocumentEvaluator();
  const result = evaluator.evaluate(
    document({}, [sketch, extrude("e", "s", { name: "Leg" })]),
  );
  ok(result);
  assert.deepEqual(
    result.bodies.map((body) => body.name),
    ["Leg (1)", "Leg (2)"],
  );
  const volumes = result.bodies.map((body) => Math.round(volume(body))).sort();
  assert.deepEqual(volumes, [72000, 90000]);
  evaluator.dispose();
});

test("blind, reversed, symmetric, through-all and up-to extents", () => {
  const evaluator = new DocumentEvaluator();
  const base = [
    rectangle("s", "XY", "0", "0", "100", "100"),
    extrude("block", "s", { distance: "50" }),
  ];
  const zOf = (features: Feature[], id: string) => {
    const result = evaluator.evaluate(document({}, [...base, ...features]));
    ok(result);
    const body = result.bodies.find((body) => body.id === id)!;
    const bb = bounds(body);
    return [
      Math.round(bb.zMin * 1000) / 1000,
      Math.round(bb.zMax * 1000) / 1000,
    ];
  };
  assert.deepEqual(zOf([], "block:0"), [0, 50]);
  assert.deepEqual(
    zOf(
      [
        rectangle("r", "XY", "200", "0", "10", "10"),
        extrude("x", "r", { reverse: true, distance: "5" }),
      ],
      "x:0",
    ),
    [-5, 0],
  );
  assert.deepEqual(
    zOf(
      [
        rectangle("r", "XY", "200", "0", "10", "10"),
        extrude("x", "r", { extent: "symmetric", distance: "10" }),
      ],
      "x:0",
    ),
    [-5, 5],
  );
  assert.deepEqual(
    zOf(
      [
        rectangle("r", "XY", "200", "0", "10", "10"),
        extrude("x", "r", {
          extent: "upTo",
          upTo: { body: "block:0", origin: "block", role: "end" },
        }),
      ],
      "x:0",
    ),
    [0, 50],
  );
  // Through all cuts a slot right through the block.
  const result = evaluator.evaluate(
    document({}, [
      ...base,
      rectangle("r", "XY", "40", "0", "20", "100", {
        face: { body: "block:0", origin: "block", role: "end" },
      }),
      extrude("x", "r", {
        operation: "cut",
        extent: "throughAll",
        reverse: true,
      }),
    ]),
  );
  ok(result);
  assert.equal(result.bodies.length, 1);
  near(volume(result.bodies[0]!), 80 * 100 * 50);
  evaluator.dispose();
});

test("a pocket on a face stays on that face when the panel changes", () => {
  const evaluator = new DocumentEvaluator();
  const first = evaluator.evaluate(
    document({ t: "18" }, pocketed("600", "100")),
  );
  ok(first);
  near(volume(first.bodies[0]!), 600 * 400 * 18 - 50 * 30 * 6);
  assert.equal(first.frames.get("pocket")!.origin[2], 18);
  // Thicker, narrower panel; the pocket moves along it.
  const second = evaluator.evaluate(
    document({ t: "25" }, pocketed("500", "300")),
  );
  ok(second);
  near(second.frames.get("pocket")!.origin[2], 25);
  const panel = second.bodies[0]!;
  near(volume(panel), 500 * 400 * 25 - 50 * 30 * 6);
  // The pocket floor sits 6 mm below the new top.
  const floor = panel.roles.get("cut")!.get("start")!;
  const face = b
    .getFaces(panel.shape)
    .find((f) => b.getHashCode(f) === floor[0])!;
  near(b.faceCenter(face)[2]!, 19);
  near(b.faceCenter(face)[0]!, 325);
  evaluator.dispose();
});

test("a face keeps its name when a pocket starts on it", () => {
  // The pocket's tool starts exactly on the top face. OCCT's record of the
  // cut then calls the top deleted; the name is recovered from geometry.
  const evaluator = new DocumentEvaluator();
  const result = evaluator.evaluate(
    document({ t: "18" }, [
      ...pocketed("600", "100"),
      rectangle("again", "XY", "400", "100", "20", "20", {
        face: { body: "panel:0", origin: "panel", role: "end" },
      }),
    ]),
  );
  ok(result);
  near(result.frames.get("again")!.origin[2], 18);
  evaluator.dispose();
});

test("a broken face reference fails visibly instead of moving", () => {
  const evaluator = new DocumentEvaluator();
  // Sketch on the plate's right wall, then swap the plate's rectangle for
  // one whose lines have other ids: the wall it named is gone.
  const onWall = (plate: SketchFeature) => [
    plate,
    extrude("panel", "plate"),
    rectangle("mark", "YZ", "10", "2", "20", "5", {
      face: { body: "panel:0", origin: "panel", role: "side:plate.right" },
    }),
    extrude("notch", "mark", {
      operation: "cut",
      distance: "3",
      reverse: true,
    }),
  ];
  ok(
    evaluator.evaluate(
      document({}, onWall(rectangle("plate", "XY", "0", "0", "100", "60"))),
    ),
  );
  const renamed = rectangle("other", "XY", "0", "0", "100", "60");
  const result = evaluator.evaluate(
    document({}, onWall({ ...renamed, id: "plate", name: "plate" })),
  );
  const mark = result.status.get("mark")!;
  assert.equal(mark.state, "error");
  assert.ok(mark.state === "error" && mark.broken);
  assert.match(mark.state === "error" ? mark.message : "", /no longer exists/);
  assert.equal(result.status.get("notch")!.state, "error");
  // The panel itself is fine and uncut.
  near(volume(result.bodies[0]!), 100 * 60 * 18);
  evaluator.dispose();
});

test("fillets, chamfers and shells keep the faces they did not touch", () => {
  const evaluator = new DocumentEvaluator();
  const box = [
    rectangle("s", "XY", "0", "0", "100", "60"),
    extrude("box", "s", { distance: "40" }),
  ];
  const first = evaluator.evaluate(document({}, box));
  const body = first.bodies[0]!;
  const face = (role: string) => {
    const hash = body.roles.get("box")!.get(role)![0];
    return b.getFaces(body.shape).find((f) => b.getHashCode(f) === hash)!;
  };
  const [vertical] = b.sharedEdges(face("side:s.bottom"), face("side:s.right"));
  const [upper] = b.sharedEdges(face("end"), face("side:s.left"));
  const round = referenceEdge(body, vertical!)!;
  const bevel = referenceEdge(body, upper!)!;
  assert.deepEqual([round.a.role, round.b.role].sort(), [
    "side:s.bottom",
    "side:s.right",
  ]);
  const result = evaluator.evaluate(
    document({}, [
      ...box,
      { id: "f", type: "fillet", name: "f", edges: [round], radius: "10" },
      { id: "c", type: "chamfer", name: "c", edges: [bevel], distance: "5" },
      rectangle("top", "XY", "20", "20", "10", "10", {
        face: { body: "box:0", origin: "box", role: "end" },
      }),
      extrude("post", "top", { operation: "add", distance: "10" }),
    ]),
  );
  ok(result);
  const solid = result.bodies[0]!;
  const rounded = 100 * 60 * 40 - (100 - 25 * Math.PI) * 40 - 12.5 * 60 + 1000;
  near(volume(solid), rounded, 1e-2);
  // The shell opens the top of the finished box.
  const shelled = evaluator.evaluate(
    document({}, [
      ...box,
      {
        id: "sh",
        type: "shell",
        name: "sh",
        faces: [{ body: "box:0", origin: "box", role: "end" }],
        thickness: "5",
      },
    ]),
  );
  ok(shelled);
  const walls = volume(shelled.bodies[0]!);
  near(walls, 100 * 60 * 40 - 90 * 50 * 35, 1e-2);
  evaluator.dispose();
});

test("holes drill at a sketch's points, and patterns repeat them", () => {
  const evaluator = new DocumentEvaluator();
  const top = { body: "panel:0", origin: "panel", role: "end" } as const;
  const base = [
    rectangle("s", "XY", "0", "0", "300", "100"),
    extrude("panel", "s"),
    points("at", [["20", "50"]], { face: top }),
  ];
  const result = evaluator.evaluate(
    document({}, [
      ...base,
      {
        id: "h",
        type: "hole",
        name: "h",
        sketch: "at",
        kind: "counterbore",
        diameter: "5",
        headDiameter: "10",
        headDepth: "3",
      },
      {
        id: "p",
        type: "pattern",
        name: "p",
        kind: "linear",
        features: ["h"],
        axis: "X",
        count: "4",
        spacing: "32",
      },
    ]),
  );
  ok(result);
  const panel = result.bodies[0]!;
  const each = Math.PI * (2.5 ** 2 * 18 + (5 ** 2 - 2.5 ** 2) * 3);
  near(volume(panel), 300 * 100 * 18 - 4 * each, 1e-3);
  assert.deepEqual(
    panel.machining.map((m) => m.kind),
    Array.from({ length: 4 }, () => ["drill", "counterbore"]).flat(),
  );
  // A countersink: a 90° cone 10 mm across at the surface, 5 mm deep.
  const sunk = evaluator.evaluate(
    document({}, [
      ...base,
      {
        id: "h",
        type: "hole",
        name: "h",
        sketch: "at",
        kind: "countersink",
        diameter: "4",
        headDiameter: "10",
        depth: "15",
      },
    ]),
  );
  ok(sunk);
  // The cone overlaps the drill where it is wider than it: a 3 mm
  // cylinder and the cone's 2 mm tip.
  const cone = (Math.PI * 25 * 5) / 3;
  const overlap = Math.PI * 4 * 3 + (Math.PI * 4 * 2) / 3;
  near(
    volume(sunk.bodies[0]!),
    300 * 100 * 18 - (Math.PI * 4 * 15 + cone - overlap),
    1e-7,
  );
  evaluator.dispose();
});

test("patterns and mirrors copy bodies with their names", () => {
  const evaluator = new DocumentEvaluator();
  const result = evaluator.evaluate(
    document({}, [
      rectangle("s", "YZ", "0", "0", "400", "700"),
      extrude("side", "s", { reverse: true }),
      {
        id: "m",
        type: "mirror",
        name: "m",
        bodies: ["side:0"],
        plane: "YZ",
        offset: "300",
      },
      rectangle("leg", "XY", "0", "-100", "40", "40"),
      extrude("legs", "leg", { distance: "100" }),
      {
        id: "ring",
        type: "pattern",
        name: "ring",
        kind: "circular",
        bodies: ["legs:0"],
        axis: "Z",
        center: ["300", "200", "0"],
        count: "4",
      },
    ]),
  );
  ok(result);
  assert.equal(result.bodies.length, 1 + 1 + 1 + 3);
  const mirrored = result.bodies.find((body) => body.id === "m#1:side:0")!;
  const bb = bounds(mirrored);
  near(bb.xMin, 600);
  near(bb.xMax, 618);
  assert.ok(mirrored.roles.get("side")!.has("end"));
  // The mirrored blank is still a flat 18 mm panel of the same outline.
  assert.equal(mirrored.blank?.depth, 18);
  near(volume(mirrored), 400 * 700 * 18);
  evaluator.dispose();
});

test("only features after an edit are re-run", () => {
  const evaluator = new DocumentEvaluator();
  const features = (width: string, pocket: string) =>
    document({ t: "18" }, pocketed(width, pocket));
  const first = evaluator.evaluate(features("600", "100"));
  assert.equal(first.rerunFrom, 0);
  const again = evaluator.evaluate(features("600", "100"));
  assert.equal(again.rerunFrom, 4);
  const moved = evaluator.evaluate(features("600", "200"));
  assert.equal(moved.rerunFrom, 2);
  near(volume(moved.bodies[0]!), 600 * 400 * 18 - 50 * 30 * 6);
  evaluator.dispose();
});

test("suppressed and rolled-back features are skipped", () => {
  const evaluator = new DocumentEvaluator();
  const [plate, panel, pocket, cut] = pocketed("600", "100");
  const doc = document({ t: "18" }, [
    plate,
    panel,
    pocket,
    { ...cut, suppressed: true },
  ]);
  const suppressed = evaluator.evaluate(doc);
  assert.equal(suppressed.status.get("cut")!.state, "suppressed");
  near(volume(suppressed.bodies[0]!), 600 * 400 * 18);
  const rolled = evaluator.evaluate(
    document({ t: "18" }, [plate, panel, pocket, cut]),
    { until: 1 },
  );
  assert.equal(rolled.status.get("pocket")!.state, "rolled-back");
  assert.equal(rolled.status.get("cut")!.state, "rolled-back");
  evaluator.dispose();
});

test("picked faces are named by the feature that made them", () => {
  const evaluator = new DocumentEvaluator();
  const result = evaluator.evaluate(
    document({ t: "18" }, pocketed("600", "100")),
  );
  const panel = result.bodies[0]!;
  const floor = b
    .getFaces(panel.shape)
    .find((f) => Math.abs(b.faceCenter(f)[2]! - 12) < 1e-6)!;
  const ref = referenceFace(panel, floor)!;
  assert.equal(ref.origin, "cut");
  assert.equal(ref.role, "start");
  assert.equal(ref.body, "panel:0");
  evaluator.dispose();
});

/** A carcass: a side mirrored into the other side, bottom, top and a
 * shelf reaching from one side to the other, a back, and rows of
 * shelf-pin holes in the left side. */
function cabinet(shelf: string): CadDocument {
  const inner = { body: "left:0", origin: "left", role: "end" } as const;
  const across = (id: string, y: string): Feature[] => [
    rectangle(`${id}-s`, "YZ", "0", y, id === "shelf" ? "d - 20" : "d", "t", {
      face: inner,
    }),
    extrude(id, `${id}-s`, {
      extent: "upTo",
      upTo: { body: "right#1:left:0", origin: "left", role: "end" },
    }),
  ];
  return document({ w: "600", h: "720", d: "560", t: "19", shelf }, [
    rectangle("left-s", "YZ", "0", "0", "d", "h"),
    extrude("left", "left-s", { distance: "t" }),
    {
      id: "right",
      type: "mirror",
      name: "right",
      bodies: ["left:0"],
      plane: "YZ",
      offset: "w / 2",
    },
    ...across("bottom", "0"),
    ...across("top", "h - t"),
    ...across("shelf", "shelf"),
    rectangle("back-s", "XZ", "0", "0", "w", "h"),
    extrude("back", "back-s", { distance: "6" }),
    points(
      "pins",
      [
        ["40", "shelf - 32"],
        ["d - 40", "shelf - 32"],
      ],
      { plane: "YZ", face: inner },
    ),
    {
      id: "pin-holes",
      type: "hole",
      name: "pin-holes",
      sketch: "pins",
      kind: "simple",
      diameter: "5",
      depth: "12",
    },
    {
      id: "pin-rows",
      type: "pattern",
      name: "pin-rows",
      kind: "linear",
      features: ["pin-holes"],
      axis: "Z",
      count: "5",
      spacing: "32",
    },
  ]);
}

test("a single edit on a cabinet regenerates in under 300 ms", () => {
  const evaluator = new DocumentEvaluator();
  const first = evaluator.evaluate(cabinet("200"));
  ok(first);
  assert.equal(first.bodies.length, 6);
  // Two holes per row, five rows, all in the left side.
  const left = first.bodies.find((body) => body.id === "left:0")!;
  assert.equal(left.machining.length, 10);
  near(volume(left), 560 * 720 * 19 - 10 * Math.PI * 2.5 ** 2 * 12);
  const times: number[] = [];
  for (const shelf of ["232", "264", "200"]) {
    const result = evaluator.evaluate(cabinet(shelf));
    ok(result);
    times.push(result.ms);
  }
  times.sort((p, q) => p - q);
  if (process.env.CODECAD_TIMINGS) console.log("cabinet edits (ms)", times);
  assert.ok(times[1]! < 300, `median ${times[1]} ms`);
  evaluator.dispose();
});
