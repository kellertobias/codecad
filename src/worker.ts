import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join, basename, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { zipSync } from "fflate";
import { sourceLinks } from "./source-links.js";
import { Project, Part, descendants } from "./model.js";
import { outputRegistry } from "./decorators.js";
import { OpenCascadeEngine, type EngineDiagnostic } from "./engine.js";
import {
  CutList,
  ManufacturingDxf,
  StepModel,
  TechnicalDrawing,
} from "./outputs.js";
import { MotionStudy } from "./motion.js";
import { cutRows, csv, nest, layoutDxf, sheetParts } from "./manufacturing.js";
import { renderDrawingFormats } from "./drawing.js";
import {
  cutListPages,
  sheetLayoutPages,
  pageSvg,
  pagesDxf,
  type ReportDownload,
} from "./reports.js";
import {
  pdf,
  pdfPages,
  glb,
  motionFrames,
  clearanceResults,
  type MotionFrame,
} from "./exporters.js";

export async function buildProject(entry: string, directory: string) {
  const module = await import(pathToFileURL(resolve(entry)).href);
  const constructors = Object.values(module).filter(
    (value): value is new () => Project =>
      typeof value === "function" && value.prototype instanceof Project,
  );
  if (constructors.length !== 1)
    throw new Error(
      "Project file must export exactly one decorated Project class",
    );
  const project = new constructors[0]!(),
    engine = new OpenCascadeEngine();
  await mkdir(directory, { recursive: true });
  const files: { name: string; kind: string; size: number }[] = [],
    diagnostics: EngineDiagnostic[] = [];
  const reports: ReportDownload[] = [];
  const save = async (
    name: string,
    kind: string,
    data: Uint8Array | string,
  ) => {
    if (basename(name) !== name || name.startsWith("."))
      throw new Error("Output filename must be a plain filename");
    await writeFile(join(directory, name), data);
    files.push({
      name,
      kind,
      size: typeof data === "string" ? Buffer.byteLength(data) : data.length,
    });
  };
  try {
    const model = await engine.evaluate({
      root: project,
      revision: Date.now(),
    });
    diagnostics.push(...model.diagnostics);
    if (diagnostics.some((d) => d.severity === "error"))
      throw new Error(
        diagnostics.map((d) => d.componentPath + ": " + d.message).join("\n"),
      );
    let duration = 3;
    let frames: MotionFrame[] = [],
      clearances: ReturnType<typeof clearanceResults> = [];
    const outputs = outputRegistry.get(project) ?? [];
    for (const output of outputs) {
      try {
        const value = (project as any)[output.name](),
          requested = output.options.fileName;
        if (value instanceof TechnicalDrawing) {
          const { svg, dxf } = await renderDrawingFormats(engine, value);
          const stem = (requested ?? output.name).replace(
            /\.(svg|pdf|dxf)$/i,
            "",
          );
          await save(stem + ".svg", "drawing", svg);
          await save(stem + ".pdf", "pdf", await pdf(svg));
          await save(stem + ".dxf", "drawing-dxf", dxf);
          reports.push({
            title: stem,
            kind: "drawing",
            preview: stem + ".svg",
            formats: { pdf: stem + ".pdf", dxf: stem + ".dxf" },
          });
        } else if (value instanceof CutList) {
          const stem = (requested ?? output.name).replace(
            /\.(svg|pdf|dxf|csv)$/i,
            "",
          );
          const rows = cutRows(project, value),
            pages = cutListPages(rows, stem);
          await save(stem + ".csv", "cutList", csv(rows));
          await save(stem + ".svg", "cutList-preview", pageSvg(pages[0]!));
          await save(stem + ".pdf", "pdf", await pdfPages(pages.map(pageSvg)));
          await save(stem + ".dxf", "cutList-dxf", pagesDxf(pages));
          reports.push({
            title: stem,
            kind: "cutList",
            preview: stem + ".svg",
            formats: {
              pdf: stem + ".pdf",
              dxf: stem + ".dxf",
              csv: stem + ".csv",
            },
            rows,
          });
          if (
            value.options.includeLayouts &&
            value.options.nesting !== "none"
          ) {
            const selected = sheetParts(project).filter(
              (p) =>
                !value.options.materials ||
                value.options.materials.includes(p.material),
            );
            for (const layout of nest(selected)) {
              const layoutStem =
                stem + "-" + layout.material.id + "-sheet-" + layout.number;
              const pages = sheetLayoutPages(layout);
              await save(layoutStem + ".svg", "nesting", pageSvg(pages[0]!));
              await save(
                layoutStem + ".pdf",
                "pdf",
                await pdfPages(pages.map(pageSvg)),
              );
              await save(
                layoutStem + ".dxf",
                "nesting-dxf",
                await layoutDxf(engine, layout),
              );
              reports.push({
                title: `${layout.material.name} · Sheet ${layout.number}`,
                kind: "nesting",
                preview: layoutStem + ".svg",
                formats: { pdf: layoutStem + ".pdf", dxf: layoutStem + ".dxf" },
              });
            }
          }
        } else if (value instanceof ManufacturingDxf) {
          const exports = await engine.exportDxf(value);
          await save(
            requested ?? "manufacturing.zip",
            "dxf",
            zipSync(Object.fromEntries(exports)),
          );
          for (const [name, data] of exports)
            await save(name, "dxf-part", data);
        } else if (value instanceof StepModel) {
          if (Array.isArray(value.options.of) || value.options.placement)
            throw new Error(
              "STEP output currently takes a placed component or assembly",
            );
          await save(
            requested ?? "model.step",
            "step",
            await engine.exportStep(value.options.of as Project),
          );
        } else if (value instanceof MotionStudy) {
          const parts = descendants(project).filter(
            (p): p is Part => p instanceof Part,
          );
          const currentFrames = motionFrames(value, parts);
          duration = value.duration;
          frames = currentFrames;
          const results = clearanceResults(engine, value);
          clearances.push(...results);
          for (const r of results)
            if (!r.passed)
              diagnostics.push({
                severity: "warning",
                code: "CLEARANCE",
                message: `${r.between.join(" / ")}: ${r.measured.toFixed(2)} mm; requested ${r.minimum} mm (sampled)`,
              });
          await save(
            requested ?? "motion.glb",
            "motion",
            await glb(model.meshes, currentFrames, value.duration),
          );
        } else throw new Error("Output method returned the wrong output type");
      } catch (error) {
        diagnostics.push({
          severity: "error",
          code: "OUTPUT",
          message: `${output.name}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    await save("preview.glb", "model", await glb(model.meshes));
    const links = sourceLinks(resolve(entry));
    const manifest = {
      title: project.label,
      id: project.id,
      engine: engine.capabilities,
      files,
      reports,
      diagnostics,
      clearances,
      frames,
      duration,
      cutList: cutRows(project),
      components: [project, ...project.registry.all].map((c) => ({
        path: c.path,
        id: c.id,
        label: c.label,
        type: c.constructor.name,
        parent: c.parent?.path,
        source: links(c.sourceTraces),
      })),
      meshes: model.meshes.map((m) => ({
        ...m,
        positions: Array.from(m.positions),
        normals: Array.from(m.normals),
        indices: Array.from(m.indices),
        edges: Array.from(m.edges),
      })),
    };
    await writeFile(join(directory, "model.json"), JSON.stringify(manifest));
    return manifest;
  } finally {
    engine.dispose();
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)
) {
  buildProject(process.argv[2]!, process.argv[3]!)
    .then((result) => {
      console.log(
        JSON.stringify({
          built: result.id,
          parts: result.meshes.length,
          files: result.files.length,
          diagnostics: result.diagnostics,
        }),
      );
      if (result.diagnostics.some((d) => d.severity === "error"))
        process.exitCode = 2;
    })
    .catch((error) => {
      console.error(error.stack ?? String(error));
      process.exitCode = 1;
    });
}
