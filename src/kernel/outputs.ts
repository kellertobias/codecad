// Files made from a stored document: drawing sheets (SVG, PDF, DXF), a
// layout or a part as DXF, the cut list (CSV, PDF) and the bill of
// materials (CSV). The server makes them as jobs, from the saved document,
// evaluated headless.
import { OpenCascadeEngine } from "../engine.js";
import { pdf, pdfPages } from "../exporters.js";
import { csv, cutRows } from "../manufacturing.js";
import { cutListPages, pageSvg, pagesDxf } from "../reports.js";
import type { CadDocument } from "../document/schema.js";
import { SketchSolver } from "../document/sketch-solver.js";
import { DocumentEvaluator } from "./evaluator.js";
import { describeParts, sheetProject } from "./parts.js";
import { billOfMaterials, bomCsv } from "./bom.js";
import { layoutDxf, partDxf } from "./layouts.js";
import { partSheets, renderSheet } from "./drawings.js";

export type OutputKind = "drawing" | "layout" | "part" | "cutlist" | "bom";
export type OutputFormat = "svg" | "pdf" | "dxf" | "csv";

export interface OutputRequest {
  readonly kind: OutputKind;
  /** The sheet, layout or part; drawings also take `part:<body>` for a
   * part's manufacturing sheet. */
  readonly target?: string;
  readonly format: OutputFormat;
}

export interface OutputFile {
  readonly bytes: Uint8Array;
  readonly type: string;
  readonly name: string;
}

export class OutputError extends Error {}

const types: Record<OutputFormat, string> = {
  svg: "image/svg+xml",
  pdf: "application/pdf",
  dxf: "application/dxf",
  csv: "text/csv; charset=utf-8",
};

const allowed: Record<OutputKind, readonly OutputFormat[]> = {
  drawing: ["svg", "pdf", "dxf"],
  layout: ["dxf"],
  part: ["dxf"],
  cutlist: ["csv", "pdf"],
  bom: ["csv"],
};

const fileName = (value: string) =>
  value.replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "") || "output";

export async function documentOutput(
  document: CadDocument,
  request: OutputRequest,
): Promise<OutputFile> {
  if (!allowed[request.kind]?.includes(request.format))
    throw new OutputError(
      `A ${request.kind} comes as ${allowed[request.kind]?.join(", ") ?? "nothing"}`,
    );
  // Library instances with values of their own need their sketches solved.
  const solver = document.features.some(
    (f) => f.type === "instance" && f.values && Object.keys(f.values).length,
  )
    ? await SketchSolver.create()
    : undefined;
  const evaluator = new DocumentEvaluator(solver ? { solver } : {});
  const engine = new OpenCascadeEngine();
  try {
    const { bodies, hardware } = evaluator.evaluate(document);
    const info = describeParts(document, bodies);
    const done = (bytes: Uint8Array, name: string): OutputFile => ({
      bytes,
      type: types[request.format],
      name: `${fileName(name)}.${request.format}`,
    });
    switch (request.kind) {
      case "drawing": {
        const sheet = [...(document.drawings ?? []), ...partSheets(info)].find(
          (s) => s.id === request.target,
        );
        if (!sheet)
          throw new OutputError(`There is no drawing ${request.target}`);
        const page = await renderSheet(engine, document, bodies, info, sheet);
        const svg = pageSvg(page);
        return done(
          request.format === "svg"
            ? svg
            : request.format === "pdf"
              ? await pdf(svg)
              : pagesDxf([page]),
          sheet.name,
        );
      }
      case "layout": {
        const layout = document.layouts?.find((l) => l.id === request.target);
        if (!layout)
          throw new OutputError(`There is no layout ${request.target}`);
        return done(
          await layoutDxf(engine, document, bodies, info, layout),
          layout.name,
        );
      }
      case "part": {
        const part = info.find((p) => p.body === request.target);
        if (!part) throw new OutputError(`There is no part ${request.target}`);
        return done(
          await partDxf(engine, document, bodies, info, part.body),
          part.name,
        );
      }
      case "cutlist": {
        const rows = cutRows(sheetProject(document, bodies, info).root);
        return request.format === "csv"
          ? done(new TextEncoder().encode(csv(rows)), "cut-list")
          : done(
              await pdfPages(cutListPages(rows).map((page) => pageSvg(page))),
              "cut-list",
            );
      }
      case "bom":
        return done(
          new TextEncoder().encode(bomCsv(billOfMaterials(info, hardware))),
          "bill-of-materials",
        );
      default:
        throw new OutputError(`There is no ${String(request.kind)} output`);
    }
  } finally {
    engine.dispose();
    evaluator.dispose();
    solver?.dispose();
  }
}
