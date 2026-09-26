// The CAD kernel in a Web Worker: one long-lived OpenCascade session that
// evaluates documents (keeping every feature's result for the next edit)
// and recipes, and sends back meshes without copying them.
import * as b from "brepjs/quick";
import { OpenCascadeEngine, setRecipeFileReader } from "../../src/engine.js";
import {
  bodyMeshTransferables,
  meshBody,
  meshShape,
  meshTransferables,
  type BodyMesh,
} from "../../src/kernel/mesh.js";
import {
  DocumentEvaluator,
  referenceEdge,
  referenceFace,
  type Evaluation,
} from "../../src/kernel/evaluator.js";
import { describeParts } from "../../src/kernel/parts.js";
import { SketchSolver } from "../../src/document/sketch-solver.js";
import { renderSheet } from "../../src/kernel/drawings.js";
import { autoNest } from "../../src/kernel/layouts.js";
import { pageSvg } from "../../src/reports.js";
import {
  contact,
  describeContact,
  jointsFor,
  panelOf,
} from "../../src/kernel/joints.js";
import { buildCodeResult, CodeResults } from "../../src/kernel/code-parts.js";
import type { KernelRequest, KernelResponse } from "./protocol.js";

// Only the browser-bundled "brepjs/quick" (src/kernel/browser-brepjs.ts)
// exports this; it is read dynamically so the Node typings stay unaware.
const initMs = (b as unknown as { kernelInitMs?: number }).kernelInitMs ?? 0;

setRecipeFileReader(async (path) => {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Could not load ${path}`);
  return new Uint8Array(await response.arrayBuffer());
});

const post = (message: KernelResponse, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(message, transfer);

post({ type: "ready", initMs, ...heap() });

const codeResults = new CodeResults();
let solver: SketchSolver | undefined;
const evaluator = new DocumentEvaluator({ codeResults });
let last: Evaluation | undefined;
/** Meshes of shapes an earlier evaluation already sent, so bodies an edit
 * did not touch are not tessellated again. */
const meshes = new WeakMap<b.Shape3D, { mesh: BodyMesh; volume: number }>();

self.onmessage = async (event: MessageEvent<KernelRequest>) => {
  const request = event.data;
  try {
    if (request.type === "evaluate") await evaluate(request);
    else if (request.type === "document") document(request);
    else if (request.type === "pick-face") pickFace(request);
    else if (request.type === "pick-edge") pickEdge(request);
    else if (request.type === "drawing") await drawing(request);
    else if (request.type === "solver") {
      solver = await SketchSolver.create({ wasm: request.wasm });
      evaluator.useSolver(solver);
      post({ id: request.id, type: "solver" });
    } else if (request.type === "code-build")
      post({
        id: request.id,
        type: "code-build",
        result: await buildCodeResult(
          request.output,
          request.key,
          request.files ?? {},
        ),
      });
    else if (request.type === "code-results") {
      for (const result of request.results) codeResults.add(result);
      post({
        id: request.id,
        type: "code-results",
        keys: request.results.map((r) => r.key),
      });
    } else if (request.type === "nest")
      post({
        id: request.id,
        type: "nest",
        ...autoNest(
          request.layout,
          request.piece,
          request.parts,
          request.others,
        ),
      });
    else meet(request);
  } catch (error) {
    post({
      id: request.id,
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

async function evaluate(request: Extract<KernelRequest, { type: "evaluate" }>) {
  // A fresh engine per recipe, disposed afterwards, so kernel memory does
  // not grow with every build.
  const engine = new OpenCascadeEngine();
  try {
    const started = performance.now();
    const shape = await engine.recipe(request.recipe);
    const built = performance.now();
    const mesh = meshShape(shape);
    const volume = b.unwrap(b.measureVolume(shape));
    post(
      {
        id: request.id,
        type: "mesh",
        mesh,
        volume,
        buildMs: built - started,
        meshMs: performance.now() - built,
      },
      meshTransferables(mesh),
    );
  } finally {
    engine.dispose();
  }
}

function document(request: Extract<KernelRequest, { type: "document" }>) {
  const evaluation = evaluator.evaluate(
    request.document,
    request.until === undefined ? {} : { until: request.until },
  );
  last = evaluation;
  const started = performance.now();
  const transfer: ArrayBuffer[] = [];
  const bodies = evaluation.bodies.map((body) => {
    let cached = meshes.get(body.shape);
    if (!cached) {
      cached = {
        mesh: meshBody(body.shape),
        volume: b.unwrap(b.measureVolume(body.shape)),
      };
      meshes.set(body.shape, cached);
    }
    // The cache keeps its arrays; the page gets copies it can own.
    const mesh = copy(cached.mesh);
    transfer.push(...bodyMeshTransferables(mesh));
    return {
      id: body.id,
      name: body.name,
      feature: body.feature,
      mesh,
      volume: cached.volume,
    };
  });
  const projections = [...evaluation.projections].map(
    ([id, lines]) => [id, lines.slice()] as const,
  );
  transfer.push(...projections.map(([, lines]) => lines.buffer as ArrayBuffer));
  post(
    {
      id: request.id,
      type: "model",
      bodies,
      status: [...evaluation.status],
      frames: [...evaluation.frames],
      projections,
      parts: describeParts(request.document, evaluation.bodies),
      hardware: evaluation.hardware,
      ms: evaluation.ms,
      meshMs: performance.now() - started,
      rerunFrom: evaluation.rerunFrom,
    },
    transfer,
  );
}

const copy = (mesh: BodyMesh): BodyMesh => ({
  positions: mesh.positions.slice(),
  normals: mesh.normals.slice(),
  indices: mesh.indices.slice(),
  faces: mesh.faces.slice(),
  edges: mesh.edges.slice(),
  edgeGroups: mesh.edgeGroups.slice(),
});

function bodyOf(id: string) {
  const body = last?.bodies.find((candidate) => candidate.id === id);
  if (!body) throw new Error(`The body ${id} is not in the current model`);
  return body;
}

function pickFace(request: Extract<KernelRequest, { type: "pick-face" }>) {
  const body = bodyOf(request.body);
  const face = b
    .getFaces(body.shape)
    .find((candidate) => b.getHashCode(candidate) === request.face);
  if (!face) throw new Error("That face is not in the current model");
  const ref = referenceFace(body, face);
  post({
    id: request.id,
    type: "face",
    planar: b.faceGeomType(face) === "PLANE",
    ...(ref
      ? { ref }
      : {
          reason:
            "This face has no stable name (it was made by a fillet, chamfer or shell); pick a face an extrude or cut made",
        }),
  });
}

function pickEdge(request: Extract<KernelRequest, { type: "pick-edge" }>) {
  const body = bodyOf(request.body);
  const edge = b
    .getEdges(body.shape)
    .find((candidate) => b.getHashCode(candidate) === request.edge);
  if (!edge) throw new Error("That edge is not in the current model");
  const ref = referenceEdge(body, edge);
  post({
    id: request.id,
    type: "edge",
    ...(ref
      ? { ref }
      : {
          reason:
            "This edge does not join two named faces; pick an edge between faces an extrude or cut made",
        }),
  });
}

function meet(request: Extract<KernelRequest, { type: "contact" }>) {
  // The cache keeps the later features, so this costs little and leaves
  // the full model ready for the next evaluation.
  const before = evaluator.evaluate(
    request.document,
    request.until === undefined ? {} : { until: request.until },
  );
  const find = (id: string) => {
    const body = before.bodies.find((candidate) => candidate.id === id);
    if (!body) throw new Error(`The body ${id} is not in the model`);
    return body;
  };
  const [a, c] = [find(request.a), find(request.b)].map(panelOf);
  if (typeof a === "string" || typeof c === "string") {
    post({
      id: request.id,
      type: "contact",
      description: typeof a === "string" ? a : (c as string),
      joints: [],
    });
    return;
  }
  const found = contact(a!, c!);
  post({
    id: request.id,
    type: "contact",
    description: describeContact(found),
    joints: jointsFor(found),
  });
}

async function drawing(request: Extract<KernelRequest, { type: "drawing" }>) {
  // The evaluator's cache makes this cheap for the document on screen; a
  // scratch document (a preview) gets an evaluator of its own, so that
  // cache stays the open document's.
  const own = request.scratch
    ? new DocumentEvaluator({
        codeResults,
        ...(solver ? { solver } : {}),
      })
    : evaluator;
  const { bodies, status } = own.evaluate(request.document);
  const engine = new OpenCascadeEngine();
  try {
    const failed = [...status.values()].find((s) => s.state === "error");
    if (request.scratch && failed?.state === "error")
      throw new Error(failed.message);
    const page = await renderSheet(
      engine,
      request.document,
      bodies,
      describeParts(request.document, bodies),
      request.sheet,
    );
    post({
      id: request.id,
      type: "drawing",
      svg: new TextDecoder().decode(pageSvg(page)),
    });
  } finally {
    engine.dispose();
    if (own !== evaluator) own.dispose();
  }
}

function heap(): { heapBytes?: number } {
  const memory = (performance as { memory?: { usedJSHeapSize: number } })
    .memory;
  return memory ? { heapBytes: memory.usedJSHeapSize } : {};
}
