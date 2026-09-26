import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as b from "brepjs/quick";
import { SketchSolver } from "../src/document/sketch-solver.js";
import type {
  CadDocument,
  InstanceFeature,
  JointFeature,
} from "../src/document/schema.js";
import {
  checkCodeOutput,
  codeInstances,
  readCodeResult,
} from "../src/document/code-part.js";
import { DocumentEvaluator } from "../src/kernel/evaluator.js";
import { buildCodeResult, CodeResults } from "../src/kernel/code-parts.js";
import { describeParts, sheetProject } from "../src/kernel/parts.js";
import { partEntities } from "../src/manufacturing.js";
import { OpenCascadeEngine } from "../src/engine.js";
import { openLibrary } from "../src/library.js";
import { insertInstance } from "../src/document/library.js";
import { extrude, rectangle, solvedDocument } from "./support/documents.js";
import { codePart, plateSource, runCode } from "./support/code.js";

let solver: SketchSolver;
before(async () => {
  solver = await SketchSolver.create();
});
after(() => solver.dispose());

const door = () =>
  solvedDocument(solver, {}, [
    rectangle("d", "XY", "0", "0", "400", "600"),
    extrude("door", "d"),
  ]);

/** Generates every missing result of a document, as the editor does. */
async function generate(document: CadDocument, store: CodeResults) {
  for (const need of codeInstances(document)) {
    assert.equal(need.problem, undefined);
    if (store.has(need.key!)) continue;
    const output = await runCode(need.pinned.code.source, need.values);
    // Uploaded and read back, as the server would store it.
    const result = readCodeResult(
      JSON.parse(JSON.stringify(await buildCodeResult(output, need.key!))),
    );
    store.add(result);
  }
}

test("a code part from the library is mated onto a door and drills it", async () => {
  const library = openLibrary(":memory:");
  const code = await codePart(plateSource);
  assert.deepEqual(
    code.parameters.map((p) => [p.name, p.default]),
    [
      ["w", 60],
      ["t", 3],
    ],
  );
  const item = library.create({ name: "Plate" }, { code, exposed: ["w", "t"] });
  assert.equal(library.list()[0]!.kind, "code");
  const inserted = insertInstance(
    door(),
    { id: item.id, name: item.name },
    library.version(item.id, 1),
  );
  const document: CadDocument = {
    ...inserted.document,
    features: inserted.document.features.map((f) =>
      f.id === inserted.id
        ? ({
            ...f,
            values: { w: "90" },
            mate: {
              interface: "mount",
              target: { body: "door:0", origin: "door", role: "end" },
              at: ["100", "200"],
            },
          } as InstanceFeature)
        : f,
    ),
  };
  const store = new CodeResults();
  const evaluator = new DocumentEvaluator({ codeResults: store });

  // Nothing has run the code yet: the evaluator says so, and builds the rest.
  const before = evaluator.evaluate(document);
  const status = before.status.get(inserted.id)!;
  assert.equal(status.state, "error");
  assert.ok(status.state === "error" && status.regenerate);
  assert.match(
    status.state === "error" ? status.message : "",
    /needs regeneration in the editor/,
  );
  assert.equal(before.bodies.length, 1);

  await generate(document, store);
  const result = evaluator.evaluate(document);
  for (const [f, s] of result.status)
    assert.equal(s.state, "ok", `${f}: ${JSON.stringify(s)}`);
  const plate = result.bodies.find((body) => body.id === `${inserted.id}:b0`)!;
  const bb = b.getBounds(plate.shape);
  assert.ok(Math.abs(bb.xMax - bb.xMin - 90) < 1e-6);
  assert.ok(Math.abs(bb.zMin - 18) < 1e-6 && Math.abs(bb.zMax - 21) < 1e-6);
  const doorBody = result.bodies.find((body) => body.id === "door:0")!;
  assert.equal(doorBody.machining.length, 2);
  const hole = Math.PI * 1.5 ** 2 * 10;
  assert.ok(
    Math.abs(
      b.unwrap(b.measureVolume(doorBody.shape)) - (400 * 600 * 18 - 2 * hole),
    ) < 1e-3,
  );
  assert.deepEqual(
    result.hardware.map((h) => [h.kind, h.count]),
    [["screw", 2]],
  );
  // Its faces have names a sketch or mate can refer to.
  assert.ok(plate.roles.get(`${inserted.id}#code`)?.has("+z"));
  evaluator.dispose();
  store.dispose();
  library.close();
});

const sideSource = `
import { definePart, Shapes, cut } from "codecad/part";

export default definePart({
  parameters: { depth: { default: 300 }, height: { default: 400 } },
  build({ depth, height }) {
    const panel = new Shapes.Box({ width: 18, depth, height });
    const hole = new Shapes.Cylinder({ diameter: 5, length: 40, x: 9, y: 50, z: 300, axis: "z" });
    const shelfPin = new Shapes.Cylinder({ diameter: 5, length: 12, x: 12, y: 60, z: 200, axis: "x" });
    return { bodies: [{ name: "Side", shape: cut(panel, shelfPin, hole) }] };
  },
});
`;

test("a code panel is joined to a drawn one and exported like one", async () => {
  const library = openLibrary(":memory:");
  const item = library.create(
    { name: "Side" },
    { code: await codePart(sideSource), exposed: [] },
  );
  const ply = { id: "ply", name: "Ply 18", kind: "sheet", thickness: "18" };
  const base = solvedDocument(
    solver,
    {},
    [
      rectangle("bottom-s", "XY", "18", "0", "400", "300"),
      extrude("bottom", "bottom-s", { name: "Bottom" }),
    ],
    { materials: [ply as never] },
  );
  const inserted = insertInstance(
    base,
    { id: item.id, name: item.name },
    library.version(item.id, 1),
  );
  const side = `${inserted.id}:b0`;
  const joint: JointFeature = {
    id: "j",
    type: "joint",
    name: "Dominos",
    kind: "domino",
    a: "bottom:0",
    b: side,
  };
  const document: CadDocument = {
    ...inserted.document,
    features: [...inserted.document.features, joint],
    parts: [
      { body: side, material: "ply" },
      { body: "bottom:0", material: "ply" },
    ],
  };
  const store = new CodeResults();
  await generate(document, store);
  const evaluator = new DocumentEvaluator({ codeResults: store });
  const result = evaluator.evaluate(document);
  for (const [f, s] of result.status)
    assert.equal(s.state, "ok", `${f}: ${JSON.stringify(s)}`);
  const code = result.bodies.find((body) => body.id === side)!;
  // The shelf pin hole, square to the panel's face, became a drilling; the
  // hole into its top edge cannot be one, so the part says it is more than
  // a blank.
  assert.ok(code.blank);
  assert.ok(code.irregular);
  assert.ok(code.machining.some((m) => m.kind === "domino"));
  assert.deepEqual(
    code.machining
      .filter((m) => m.kind === "drill")
      .map((m) => [m.diameter, m.depth]),
    [[5, 12]],
  );
  assert.deepEqual(
    result.hardware.map((h) => [h.kind, h.count]),
    [["domino", 2]],
  );
  const info = describeParts(document, result.bodies);
  const part = info.find((p) => p.body === side)!;
  assert.equal(part.stock, "sheet");
  assert.deepEqual([part.width, part.height].sort(), [300, 400]);
  const { parts } = sheetProject(document, result.bodies, info);
  const engine = new OpenCascadeEngine();
  try {
    const entities = await partEntities(engine, parts.get(side)!);
    assert.ok(entities.some((e) => e.layer.startsWith("DOMINO")));
  } finally {
    engine.dispose();
  }
  evaluator.dispose();
  store.dispose();
  library.close();
});

test("changing a parameter needs a new result; the same values reuse one", async () => {
  const library = openLibrary(":memory:");
  const item = library.create(
    { name: "Plate" },
    { code: await codePart(plateSource), exposed: ["w"] },
  );
  const inserted = insertInstance(
    door(),
    { id: item.id, name: item.name },
    library.version(item.id, 1),
  );
  const withWidth = (w: string): CadDocument => ({
    ...inserted.document,
    features: inserted.document.features.map((f) =>
      f.id === inserted.id ? ({ ...f, values: { w } } as InstanceFeature) : f,
    ),
  });
  const [first] = codeInstances(withWidth("80"));
  const [same] = codeInstances(withWidth("40 * 2"));
  const [other] = codeInstances(withWidth("81"));
  assert.equal(first!.key, same!.key);
  assert.notEqual(first!.key, other!.key);
  // Out of the part's range: said plainly, no key.
  const [bad] = codeInstances(withWidth("1000"));
  assert.match(bad!.problem!, /at most 400/);
  library.close();
});

test("code that returns something other than solids is refused", async () => {
  await assert.rejects(
    runCode(`export default { parameters: {}, build: () => ({}) }`),
    /bodies/,
  );
  assert.throws(
    () =>
      checkCodeOutput({
        bodies: [{ name: "x", recipe: { kind: "step", path: "/etc/passwd" } }],
      }),
    /part's .step files/,
  );
  assert.throws(
    () =>
      checkCodeOutput({
        bodies: [
          {
            name: "x",
            recipe: { kind: "box", width: -1, depth: 1, height: 1 },
          },
        ],
      }),
    /more than 0/,
  );
});

test("a code part rounds and bevels edges, and still exports as a sheet part", async () => {
  const source = `
import { definePart, Shapes, fillet, chamfer } from "codecad/part";
export default definePart({
  parameters: { r: { default: 5 } },
  build({ r }) {
    let top = new Shapes.Box({ width: 600, depth: 300, height: 18 });
    top = fillet(top, r, ["top", "back"]);
    top = chamfer(top, 2, ["top", "front"]);
    return { bodies: [{ name: "Top", shape: top }] };
  },
});`;
  const output = await runCode(source);
  const result = readCodeResult(
    JSON.parse(JSON.stringify(await buildCodeResult(output, "a".repeat(28)))),
  );
  const store = new CodeResults();
  store.add(result);
  const [body] = store.get(result.key)!.bodies;
  // A quarter-circle strip less along the back, a small triangle at the front.
  const expected =
    600 * 300 * 18 - 600 * (5 * 5 - (Math.PI * 25) / 4) - 600 * 2;
  assert.ok(
    Math.abs(b.unwrap(b.measureVolume(body!.shape)) - expected) < 1,
    `volume ${b.unwrap(b.measureVolume(body!.shape))}`,
  );
  assert.ok(body!.blank);
  assert.match(body!.irregular!, /rounds/);
  // Edge selections are checked data too.
  assert.throws(
    () =>
      checkCodeOutput({
        bodies: [
          {
            name: "x",
            recipe: {
              kind: "fillet",
              source: { kind: "box", width: 1, depth: 1, height: 1 },
              edges: {
                directions: [{ x: 2, y: 0, z: 0 }],
                labels: ["?"],
                tolerance: 45,
              },
              radius: 1,
            },
          },
        ],
      }),
    /length 1/,
  );
  store.dispose();
});

test("a code part places an imported STEP file, kept once in the library file", async () => {
  const step = new Uint8Array(
    await (
      b.unwrap((b as any).exportSTEP(b.cylinder(10, 40))) as Blob
    ).arrayBuffer(),
  );
  const files = { "knob.step": Buffer.from(step).toString("base64") };
  const source = `
import { definePart, Shapes, union } from "codecad/part";
export default definePart({
  parameters: {},
  build() {
    const plate = new Shapes.Box({ width: 60, depth: 60, height: 5 });
    const knob = new Shapes.ImportedStep({ path: "knob.step" }).move({ x: 30, y: 30, z: 5 });
    return { bodies: [{ name: "Plate", shape: plate }, { name: "Knob", shape: knob }] };
  },
});`;
  const output = await runCode(source);
  const result = await buildCodeResult(output, "b".repeat(28), files);
  const store = new CodeResults();
  store.add(readCodeResult(JSON.parse(JSON.stringify(result))));
  const knob = store.get(result.key)!.bodies[1]!;
  assert.ok(
    Math.abs(b.unwrap(b.measureVolume(knob.shape)) - Math.PI * 100 * 40) < 1,
  );
  assert.ok(Math.abs(b.getBounds(knob.shape).zMin - 5) < 1e-6);
  store.dispose();

  // Only the part's own files, never paths, and never in stored results.
  await assert.rejects(
    buildCodeResult(output, "b".repeat(28), {}),
    /does not have/,
  );
  assert.throws(
    () =>
      checkCodeOutput({
        bodies: [
          { name: "x", recipe: { kind: "step", path: "../../etc/x.step" } },
        ],
      }),
    /part's .step files/,
  );
  assert.throws(
    () =>
      readCodeResult({
        ...result,
        bodies: [
          {
            ...result.bodies[0],
            machining: [
              {
                kind: "drill",
                recipe: { kind: "step", path: "a.step" },
                diameter: 1,
                depth: 1,
              },
            ],
          },
        ],
      }),
    /may not import files/,
  );

  // Two versions with the same file: the library file carries it once,
  // and reads back whole.
  const library = openLibrary(":memory:");
  const code = { ...(await codePart(source)), files };
  const item = library.create({ name: "Knob plate" }, { code, exposed: [] });
  library.addVersion(item.id, { code, exposed: [] });
  const file = JSON.parse(JSON.stringify(library.exportFile(item.id)));
  assert.equal(Object.keys(file.files).length, 1);
  assert.match(file.versions[0].code.files["knob.step"], /^@/);
  const other = openLibrary(":memory:");
  const copy = other.importFile(file);
  assert.deepEqual(other.version(copy.id, 2).code!.files, files);
  library.close();
  other.close();
});
