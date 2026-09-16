import { mkdir, writeFile, realpath } from "node:fs/promises";
import { resolve, join, basename, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { zipSync } from "fflate";
import { sourceLinks } from "./source-links.js";
import { Project, Part, descendants } from "./model.js";
import { SheetMetalPart } from "./stock.js";
import { outputRegistry } from "./decorators.js";
import {
  OpenCascadeEngine,
  type EngineDiagnostic,
  type MeshData,
} from "./engine.js";
import {
  CutList,
  ManufacturingDxf,
  StepModel,
  TechnicalDrawing,
} from "./outputs.js";
import { MotionStudy } from "./motion.js";
import { cutRows, csv, nest, layoutDxf, sheetParts } from "./manufacturing.js";
import { renderDrawingFormats, renderDrawingPreviews } from "./drawing.js";
import {
  cutListPages,
  sheetLayoutPages,
  pageSvg,
  pagesDxf,
  type ReportDownload,
} from "./reports.js";
import {
  pdfPages,
  glb,
  motionFrames,
  clearanceResults,
  type MotionFrame,
} from "./exporters.js";

const serializeMesh = (mesh: MeshData) => ({
  ...mesh,
  positions: Array.from(mesh.positions),
  normals: Array.from(mesh.normals),
  indices: Array.from(mesh.indices),
  edges: Array.from(mesh.edges),
});

export async function buildProject(
  entry: string,
  directory: string,
  options: { lazyExports?: boolean; exportOnly?: string | undefined } = {},
) {
  entry = await realpath(entry);
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
  const files: { name: string; kind: string; size: number; ready: boolean }[] =
      [],
    diagnostics: EngineDiagnostic[] = [];
  const reports: ReportDownload[] = [];
  const pending = (name: string, kind: string) => {
    if (basename(name) !== name || name.startsWith("."))
      throw new Error("Output filename must be a plain filename");
    files.push({ name, kind, size: 0, ready: false });
  };
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
      ready: true,
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
      animations: {
        id: string;
        title: string;
        duration: number;
        frames: MotionFrame[];
      }[] = [],
      clearances: ReturnType<typeof clearanceResults> = [];
    const outputs = outputRegistry.get(project) ?? [];
    for (const output of outputs) {
      try {
        const value = (project as any)[output.name](),
          requested = output.options.fileName;
        if (value instanceof TechnicalDrawing) {
          const stem = (requested ?? output.name).replace(
            /\.(svg|pdf|dxf)$/i,
            "",
          );
          if (
            options.exportOnly &&
            !options.exportOnly.startsWith(stem + ".") &&
            !options.exportOnly.startsWith(stem + "-page-")
          )
            continue;
          const rendered = options.lazyExports
            ? {
                pages: await renderDrawingPreviews(engine, value),
                dxf: undefined,
              }
            : await renderDrawingFormats(engine, value);
          const { pages } = rendered,
            svg = pages[0]!;
          await save(stem + ".svg", "drawing", svg);
          const previews = [stem + ".svg"];
          for (let i = 1; i < pages.length; i++) {
            const name = `${stem}-page-${i + 1}.svg`;
            await save(name, "drawing", pages[i]!);
            previews.push(name);
          }
          if (options.lazyExports) {
            pending(stem + ".pdf", "pdf");
            pending(stem + ".dxf", "drawing-dxf");
          } else {
            await save(stem + ".pdf", "pdf", await pdfPages(pages));
            await save(stem + ".dxf", "drawing-dxf", rendered.dxf!);
          }
          reports.push({
            title: stem,
            kind: "drawing",
            preview: stem + ".svg",
            previews,
            formats: { pdf: stem + ".pdf", dxf: stem + ".dxf" },
          });
        } else if (value instanceof CutList) {
          const stem = (requested ?? output.name).replace(
            /\.(svg|pdf|dxf|csv)$/i,
            "",
          );
          if (
            options.exportOnly &&
            !options.exportOnly.startsWith(stem + ".") &&
            !options.exportOnly.startsWith(stem + "-")
          )
            continue;
          const rows = cutRows(project, value),
            pages = cutListPages(rows, stem, value.options.mmPrecision);
          if (options.lazyExports) pending(stem + ".csv", "cutList");
          else
            await save(
              stem + ".csv",
              "cutList",
              csv(rows, value.options.mmPrecision),
            );
          await save(stem + ".svg", "cutList-preview", pageSvg(pages[0]!));
          if (options.lazyExports) {
            pending(stem + ".pdf", "pdf");
            pending(stem + ".dxf", "cutList-dxf");
          } else {
            await save(
              stem + ".pdf",
              "pdf",
              await pdfPages(pages.map(pageSvg)),
            );
            await save(stem + ".dxf", "cutList-dxf", pagesDxf(pages));
          }
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
              const pages = sheetLayoutPages(layout, value.options.mmPrecision);
              await save(layoutStem + ".svg", "nesting", pageSvg(pages[0]!));
              if (options.lazyExports) {
                pending(layoutStem + ".pdf", "pdf");
                pending(layoutStem + ".dxf", "nesting-dxf");
              } else {
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
              }
              reports.push({
                title: `${layout.material.name} · Sheet ${layout.number}`,
                kind: "nesting",
                preview: layoutStem + ".svg",
                formats: { pdf: layoutStem + ".pdf", dxf: layoutStem + ".dxf" },
              });
            }
          }
        } else if (value instanceof ManufacturingDxf) {
          const name = requested ?? "manufacturing.zip";
          if (options.exportOnly && options.exportOnly !== name) continue;
          if (options.lazyExports) {
            pending(name, "dxf");
            continue;
          }
          const exports = await engine.exportDxf(value);
          await save(name, "dxf", zipSync(Object.fromEntries(exports)));
          for (const [name, data] of exports)
            await save(name, "dxf-part", data);
        } else if (value instanceof StepModel) {
          const name = requested ?? "model.step";
          if (options.exportOnly && options.exportOnly !== name) continue;
          if (Array.isArray(value.options.of) || value.options.placement)
            throw new Error(
              "STEP output currently takes a placed component or assembly",
            );
          if (options.lazyExports) pending(name, "step");
          else
            await save(
              name,
              "step",
              await engine.exportStep(value.options.of as Project),
            );
        } else if (value instanceof MotionStudy) {
          const name = requested ?? "motion.glb";
          if (options.exportOnly && options.exportOnly !== name) continue;
          const parts = descendants(project).filter(
            (p): p is Part => p instanceof Part,
          );
          const currentFrames = motionFrames(value, parts);
          animations.push({
            id: output.options.id ?? output.name,
            title: output.options.title ?? output.name,
            duration: value.duration,
            frames: currentFrames,
          });
          if (animations.length === 1) {
            duration = value.duration;
            frames = currentFrames;
          }
          const results = clearanceResults(engine, value);
          clearances.push(...results);
          for (const r of results)
            if (!r.passed)
              diagnostics.push({
                severity: "warning",
                code: "CLEARANCE",
                message: `${r.between.join(" / ")}: ${r.measured.toFixed(2)} mm; requested ${r.minimum} mm (sampled)`,
              });
          if (options.lazyExports) pending(name, "motion");
          else
            await save(
              name,
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
    if (options.lazyExports) pending("preview.glb", "model");
    else if (!options.exportOnly || options.exportOnly === "preview.glb")
      await save("preview.glb", "model", await glb(model.meshes));
    const unfolds: {
      path: string;
      label: string;
      frames: ReturnType<typeof serializeMesh>[];
    }[] = [];
    for (const part of (options.exportOnly ? [] : descendants(project)).filter(
      (component): component is SheetMetalPart =>
        component instanceof SheetMetalPart,
    )) {
      try {
        unfolds.push({
          path: part.path,
          label: part.label,
          frames: (await engine.unfoldFrames(part)).map(serializeMesh),
        });
      } catch (error) {
        diagnostics.push({
          severity: "warning",
          code: "UNFOLD_ANIMATION",
          componentPath: part.path,
          message: `Could not animate unfolding: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    const links = sourceLinks(resolve(entry));
    const manifest = {
      title: project.label,
      id: project.id,
      parameters: project.parameterState ?? null,
      engine: engine.capabilities,
      files,
      reports,
      diagnostics,
      clearances,
      frames,
      duration,
      animations,
      unfolds,
      cutList: cutRows(project),
      view2D: project.view2D.primitives,
      components: [project, ...project.registry.all].map((c) => ({
        path: c.path,
        id: c.id,
        label: c.label,
        type: c.constructor.name,
        parent: c.parent?.path,
        source: links(c.sourceTraces),
      })),
      meshes: model.meshes.map(serializeMesh),
    };
    if (!options.exportOnly)
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
  buildProject(process.argv[2]!, process.argv[3]!, {
    lazyExports: process.env.CODECAD_LAZY_EXPORTS === "1",
    exportOnly: process.env.CODECAD_EXPORT_ONLY,
  })
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
