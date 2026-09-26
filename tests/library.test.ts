import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as b from "brepjs/quick";
import { SketchSolver } from "../src/document/sketch-solver.js";
import type {
  CadDocument,
  InstanceFeature,
  SketchFeature,
} from "../src/document/schema.js";
import { DocumentEvaluator } from "../src/kernel/evaluator.js";
import { openLibrary, type Library } from "../src/library.js";
import { handleLibrary } from "../src/library-api.js";
import {
  insertInstance,
  updateInstance,
  updatesAvailable,
} from "../src/document/library.js";
import { extrude, rectangle, solvedDocument } from "./support/documents.js";

let solver: SketchSolver;
before(async () => {
  solver = await SketchSolver.create();
});
after(() => solver.dispose());

/** A hinge plate, `w` wide (exposed), 40 deep and `t` thick, with two
 * screw positions on its underside 10 mm in from its ends. */
function hingePlate(t = "3"): CadDocument {
  const underside = {
    body: "plate:0",
    origin: "plate",
    role: "start",
  } as const;
  // On the underside (normal -Z) the sketch's x runs along +X and its y
  // along -Y (see faceFrame).
  const screws: SketchFeature = {
    id: "screws",
    type: "sketch",
    name: "Screws",
    plane: "XY",
    face: underside,
    entities: [
      { id: "s1", type: "point", x: 0, y: 0 },
      { id: "s2", type: "point", x: 0, y: 0 },
    ],
    constraints: [
      { id: "f1", type: "fix", point: "s1", x: "10", y: "-20" },
      { id: "f2", type: "fix", point: "s2", x: "w - 10", y: "-20" },
    ],
  };
  return {
    ...solvedDocument(solver, { w: "60", t }, [
      rectangle("p", "XY", "0", "0", "w", "40"),
      extrude("plate", "p", { distance: "t" }),
      screws,
    ]),
    interfaces: [
      {
        id: "mount",
        name: "Mounting face",
        sketch: "screws",
        kind: "screw",
        diameter: "3",
        depth: "10",
      },
    ],
  };
}

/** An 18 mm door, 400 × 600, lying on the XY plane. */
const door = () =>
  solvedDocument(solver, {}, [
    rectangle("d", "XY", "0", "0", "400", "600"),
    extrude("door", "d"),
  ]);

const top = { body: "door:0", origin: "door", role: "end" } as const;

function withInstance(
  project: CadDocument,
  library: Library,
  itemId: string,
  version: number,
  change: Partial<InstanceFeature> = {},
) {
  const item = library.get(itemId);
  const inserted = insertInstance(
    project,
    { id: item.id, name: item.name },
    library.version(itemId, version),
  );
  return {
    id: inserted.id,
    document: {
      ...inserted.document,
      features: inserted.document.features.map((f) =>
        f.id === inserted.id ? ({ ...f, ...change } as InstanceFeature) : f,
      ),
    },
  };
}

const volume = (shape: b.Shape3D) => b.unwrap(b.measureVolume(shape));

test("a part with screw positions goes into the library and onto a door", () => {
  const library = openLibrary(":memory:");
  const item = library.create(
    { name: "Hinge plate", tags: ["hardware"] },
    { document: hingePlate(), exposed: ["w"] },
  );
  assert.equal(item.latest, 1);
  const { id, document } = withInstance(door(), library, item.id, 1, {
    mate: { interface: "mount", target: top, at: ["100", "200"] },
  });
  const evaluator = new DocumentEvaluator({ solver });
  const result = evaluator.evaluate(document);
  for (const [f, status] of result.status)
    assert.equal(status.state, "ok", `${f}: ${JSON.stringify(status)}`);
  const plate = result.bodies.find((body) => body.id === `${id}:plate:0`)!;
  const doorBody = result.bodies.find((body) => body.id === "door:0")!;
  // The plate lies on the door with its underside down.
  const bb = b.getBounds(plate.shape);
  assert.ok(Math.abs(bb.zMin - 18) < 1e-6 && Math.abs(bb.zMax - 21) < 1e-6);
  // The door is drilled where the plate's screws are, 3 mm × 10 mm.
  assert.equal(doorBody.machining.length, 2);
  const hole = Math.PI * 1.5 ** 2 * 10;
  assert.ok(
    Math.abs(volume(doorBody.shape) - (400 * 600 * 18 - 2 * hole)) < 1e-3,
  );
  assert.deepEqual(
    result.hardware.map((h) => [h.kind, h.count]),
    [["screw", 2]],
  );
  evaluator.dispose();
  library.close();
});

test("setting an instance's variable rebuilds only that instance", () => {
  const library = openLibrary(":memory:");
  const item = library.create(
    { name: "Plate" },
    { document: hingePlate(), exposed: ["w"] },
  );
  let project = withInstance(door(), library, item.id, 1).document;
  const first = project.features.at(-1)!.id;
  project = withInstance(project, library, item.id, 1, {
    placement: { translate: ["0", "0", "100"] },
  }).document;
  const second = project.features.at(-1)!.id;
  const evaluator = new DocumentEvaluator({ solver });
  evaluator.evaluate(project);
  const wider = {
    ...project,
    features: project.features.map((f) =>
      f.id === first ? { ...f, values: { w: "90" } } : f,
    ),
  };
  const result = evaluator.evaluate(wider);
  // The first was rebuilt from its start; the second came from its cache.
  assert.equal(result.instances.get(first)!.rerunFrom, 0);
  assert.equal(result.instances.get(second)!.rerunFrom, 3);
  const plate = result.bodies.find((body) => body.id === `${first}:plate:0`)!;
  const bb = b.getBounds(plate.shape);
  assert.ok(Math.abs(bb.xMax - bb.xMin - 90) < 1e-6);
  evaluator.dispose();
  library.close();
});

test("a project keeps its version until the instance is updated", () => {
  const library = openLibrary(":memory:");
  const item = library.create(
    { name: "Plate" },
    { document: hingePlate(), exposed: ["w"] },
  );
  const { id, document } = withInstance(door(), library, item.id, 1);
  library.addVersion(item.id, {
    document: hingePlate("5"),
    exposed: ["w"],
    note: "thicker",
  });
  const thickness = (doc: CadDocument) => {
    const evaluator = new DocumentEvaluator({ solver });
    const plate = evaluator
      .evaluate(doc)
      .bodies.find((body) => body.id === `${id}:plate:0`)!;
    const bb = b.getBounds(plate.shape);
    evaluator.dispose();
    return Math.round(bb.zMax - bb.zMin);
  };
  assert.equal(thickness(document), 3);
  assert.deepEqual(
    [
      ...updatesAvailable(
        document,
        new Map([[item.id, library.get(item.id).latest]]),
      ),
    ],
    [[id, 2]],
  );
  const updated = updateInstance(
    document,
    id,
    { id: item.id, name: item.name },
    library.version(item.id, 2),
  );
  assert.equal(thickness(updated), 5);
  // Only the version in use is kept.
  assert.deepEqual(
    updated.library!.map((p) => p.version),
    [2],
  );
  library.close();
});

test("library items round-trip through their file", () => {
  const library = openLibrary(":memory:");
  const item = library.create(
    {
      name: "Plate",
      description: "A hinge plate",
      tags: ["hardware", "hinge"],
    },
    { document: hingePlate(), exposed: ["w"], thumbnail: "<svg/>" },
  );
  library.addVersion(item.id, { document: hingePlate("5"), exposed: [] });
  const file = JSON.parse(JSON.stringify(library.exportFile(item.id)));
  const other = openLibrary(":memory:");
  const copy = other.importFile(file);
  assert.notEqual(copy.id, item.id);
  assert.deepEqual(
    [copy.name, copy.description, copy.tags, copy.latest, copy.thumbnail],
    ["Plate", "A hinge plate", ["hardware", "hinge"], 2, "<svg/>"],
  );
  for (const version of [1, 2])
    assert.deepEqual(
      other.version(copy.id, version).document,
      library.version(item.id, version).document,
    );
  assert.throws(
    () => other.importFile({ format: "something else" }),
    /not a CodeCAD library/,
  );
  library.close();
  other.close();
});

test("the library is served over HTTP", async () => {
  const library = openLibrary(":memory:");
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!(await handleLibrary(req, res, url, library, () => true)))
      res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, method = "GET", body?: unknown) =>
    fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    const created = await call("/api/library", "POST", {
      name: "Plate",
      document: hingePlate(),
      exposed: ["w"],
    });
    assert.equal(created.status, 201);
    const { id } = (await created.json()) as { id: string };
    assert.equal(
      ((await (await call("/api/library")).json()) as { items: unknown[] })
        .items.length,
      1,
    );
    assert.equal(
      (
        await call(`/api/library/${id}/versions`, "POST", {
          document: hingePlate("5"),
          exposed: [],
        })
      ).status,
      201,
    );
    const second = (await (
      await call(`/api/library/${id}/versions/2`)
    ).json()) as { version: number };
    assert.equal(second.version, 2);
    const file = await (await call(`/api/library/${id}/file`)).json();
    const imported = await call("/api/library/import", "POST", file);
    assert.equal(imported.status, 201);
    const bad = await call("/api/library", "POST", {
      name: "X",
      document: hingePlate(),
      exposed: ["nope"],
    });
    assert.equal(bad.status, 400);
    assert.match(
      ((await bad.json()) as { error: string }).error,
      /no variable nope/,
    );
  } finally {
    server.close();
    library.close();
  }
});
