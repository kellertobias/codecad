// Builds what the mobile viewer shows of a saved document: the model as
// GLB, every drawing and part sheet as SVG and PDF, the cut list, and the
// layouts as outlines. Runs on the server, as a job after each save.
import { OpenCascadeEngine } from "../engine.js";
import { glb, pdf, pdfPages } from "../exporters.js";
import { csv, cutRows } from "../manufacturing.js";
import { cutListPages, pageSvg } from "../reports.js";
import type { CadDocument, DrawingSheet } from "../document/schema.js";
import { placedOutline } from "../document/layout.js";
import {
  viewerFormatVersion,
  type ViewerDrawing,
  type ViewerLayout,
  type ViewerManifest,
} from "../document/viewer.js";
import { SketchSolver } from "../document/sketch-solver.js";
import { DocumentEvaluator } from "./evaluator.js";
import type { CodeResultSource } from "./code-parts.js";
import { describeParts, sheetProject } from "./parts.js";
import { layoutParts } from "./layouts.js";
import { partSheets, renderSheet } from "./drawings.js";
import { meshShape } from "./mesh.js";

export interface ViewerFile {
  readonly bytes: Uint8Array;
  readonly type: string;
}

export interface ViewerBundle {
  readonly manifest: ViewerManifest;
  readonly files: ReadonlyMap<string, ViewerFile>;
}

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const defaultColor = { sheet: "#c9a878", solid: "#9aa6b0" } as const;
/** Part sheets beyond this many are left out: the viewer is for a
 * workshop, not for a catalogue. */
const maxPartSheets = 60;

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export async function viewerBundle(
  document: CadDocument,
  project: { readonly id: string; readonly name: string; revision: number },
  report: (fraction: number, message: string) => void = () => {},
  codeResults?: CodeResultSource,
): Promise<ViewerBundle> {
  const files = new Map<string, ViewerFile>();
  const problems: string[] = [];
  const solver = document.features.some(
    (f) => f.type === "instance" && f.values && Object.keys(f.values).length,
  )
    ? await SketchSolver.create()
    : undefined;
  const evaluator = new DocumentEvaluator({
    ...(solver ? { solver } : {}),
    ...(codeResults ? { codeResults } : {}),
  });
  const engine = new OpenCascadeEngine();
  try {
    report(0.05, "Building the model");
    const { bodies, hardware, status } = evaluator.evaluate(document);
    const needsRegeneration = [...status.values()].some(
      (s) => s.state === "error" && s.regenerate,
    );
    for (const [id, state] of status)
      if (state.state === "error")
        problems.push(
          `${document.features.find((f) => f.id === id)?.name ?? id}: ${state.message}`,
        );
    const info = describeParts(document, bodies);
    const byBody = new Map(info.map((part) => [part.body, part]));

    report(0.15, "Meshing the model");
    if (bodies.length) {
      const meshes = bodies.map((body) => {
        const mesh = meshShape(body.shape);
        const part = byBody.get(body.id);
        return {
          componentPath: body.id,
          ...mesh,
          matrix: identity,
          color: part?.material?.color ?? defaultColor[part?.stock ?? "solid"],
          opacity: 1,
          reflectivity: 0.1,
          holes: [],
          volume: 0,
        };
      });
      files.set("model.glb", {
        bytes: await glb(meshes),
        type: "model/gltf-binary",
      });
    }

    const sheets: { sheet: DrawingSheet; kind: ViewerDrawing["kind"] }[] = [
      ...(document.drawings ?? []).map((sheet) => ({
        sheet,
        kind: "drawing" as const,
      })),
      ...partSheets(info)
        .slice(0, maxPartSheets)
        .map((sheet) => ({ sheet, kind: "part" as const })),
    ];
    const drawings: ViewerDrawing[] = [];
    for (const [i, { sheet, kind }] of sheets.entries()) {
      report(
        0.25 + (0.6 * i) / Math.max(1, sheets.length),
        `Drawing ${sheet.name}`,
      );
      try {
        const page = await renderSheet(engine, document, bodies, info, sheet);
        const svg = pageSvg(page);
        const name = `drawing-${i + 1}`;
        files.set(`${name}.svg`, { bytes: svg, type: "image/svg+xml" });
        files.set(`${name}.pdf`, {
          bytes: await pdf(svg),
          type: "application/pdf",
        });
        drawings.push({
          id: sheet.id,
          name: sheet.name,
          kind,
          width: page.width,
          height: page.height,
          svg: `${name}.svg`,
          pdf: `${name}.pdf`,
        });
      } catch (error) {
        problems.push(`Drawing ${sheet.name}: ${message(error)}`);
      }
    }

    report(0.88, "Cut list");
    let cutList: ViewerManifest["cutList"];
    try {
      const rows = cutRows(sheetProject(document, bodies, info).root);
      if (rows.length) {
        files.set("cut-list.csv", {
          bytes: new TextEncoder().encode(csv(rows)),
          type: "text/csv; charset=utf-8",
        });
        files.set("cut-list.pdf", {
          bytes: await pdfPages(
            cutListPages(rows).map((page) => pageSvg(page)),
          ),
          type: "application/pdf",
        });
        cutList = { pdf: "cut-list.pdf", csv: "cut-list.csv" };
      }
    } catch (error) {
      problems.push(`Cut list: ${message(error)}`);
    }

    const layouts: ViewerLayout[] = [];
    for (const layout of document.layouts ?? []) {
      const stock = document.stock?.find((s) => s.id === layout.stock);
      if (!stock) {
        problems.push(`Layout ${layout.name}: its stock is gone`);
        continue;
      }
      const parts = new Map(
        layoutParts(info, stock.material).map((p) => [p.id, p]),
      );
      const copies = new Map<string, number>();
      layouts.push({
        id: layout.id,
        name: layout.name,
        stock: { name: stock.name, outline: stock.outline },
        placements: layout.placements.flatMap((placement) => {
          const part = parts.get(placement.part);
          if (!part) return [];
          const copy = placement.copy ?? copies.get(placement.part) ?? 0;
          copies.set(placement.part, copy + 1);
          return [
            {
              part: placement.part,
              copy,
              outline: placedOutline(part, placement),
            },
          ];
        }),
      });
    }

    report(1, "Done");
    return {
      manifest: {
        format: viewerFormatVersion,
        project: project.id,
        name: project.name,
        revision: project.revision,
        builtAt: new Date().toISOString(),
        ...(files.has("model.glb") ? { model: "model.glb" } : {}),
        ...(cutList ? { cutList } : {}),
        parts: info.map((part) => ({
          body: part.body,
          name: part.name,
          material: part.material?.name ?? "",
          ...(part.material?.color ? { color: part.material.color } : {}),
          stock: part.stock,
          ...(part.width !== undefined ? { width: part.width } : {}),
          ...(part.height !== undefined ? { height: part.height } : {}),
          ...(part.thickness !== undefined
            ? { thickness: part.thickness }
            : {}),
          quantity: part.quantity,
        })),
        hardware: hardware.map((h) => ({
          kind: h.kind,
          size: h.size,
          count: h.count,
        })),
        drawings,
        layouts,
        problems,
        ...(needsRegeneration ? { needsRegeneration } : {}),
      },
      files,
    };
  } finally {
    engine.dispose();
    evaluator.dispose();
    solver?.dispose();
  }
}
