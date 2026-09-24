import { mkdir, writeFile, realpath, readFile } from "node:fs/promises";
import { resolve, join, basename, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { zipSync } from "fflate";
import { sourceLinks } from "./source-links.js";
import { inspectComponent } from "./inspection.js";
import { Project, Part, descendants } from "./model.js";
import { validateProjectInfo, type ProjectInfo } from "./project-info.js";
import { SheetMetalPart } from "./stock.js";
import {
  outputProviders,
  projectTypeOf,
  outputRegistry,
  type OutputDecoratorOptions,
} from "./decorators.js";
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
import {
  cutRows,
  csv,
  drawManufacturing,
  entitySegments,
  nest,
  layoutDxf,
  sheetParts,
} from "./manufacturing.js";
import {
  renderDrawingFormats,
  renderDrawingPreviews,
  type ViewObserver,
} from "./drawing.js";
import { drawingPlanFile, validateDrawingPlan } from "./drawing-plan.js";
import { planDrawing, planViewKey } from "./drawing-plan-render.js";
import {
  cutListPages,
  layoutSummary,
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

/** Title-block fields a project's identity fills in for drawings the build
 * composes itself; drawings written in project code keep their own. */
export const titleBlockFrom = (info?: ProjectInfo) => ({
  ...(info?.name ? { project: info.name } : {}),
  ...(info?.author ? { author: info.author } : {}),
  ...(info?.revision ? { revision: info.revision } : {}),
});

/** Drawing, cut list, CNC DXF and STEP for projects without `@cad.output` methods. */
function standardOutputs(project: Project, info?: ProjectInfo) {
  const sheets = sheetParts(project),
    hasParts = descendants(project).some((c) => c instanceof Part);
  const owner: Record<string, () => unknown> = {};
  if (hasParts) {
    owner.drawing = () =>
      new TechnicalDrawing({
        title: project.label,
        ...titleBlockFrom(info),
      }).standardViews(project);
    owner[project.id.replace(/[^a-zA-Z0-9_.-]+/g, "_") + ".step"] = () =>
      new StepModel({ of: project });
  }
  if (cutRows(project).length)
    owner["cut-list"] = () =>
      new CutList({
        includeLayouts: sheets.every(
          (p) =>
            p.material.width !== undefined && p.material.height !== undefined,
        ),
      });
  if (sheets.length)
    owner["cnc-parts.zip"] = () =>
      new ManufacturingDxf({ parts: "all", layout: "one-file-per-part" });
  return Object.keys(owner).map((name) => ({
    kind: "standard",
    name,
    options: { fileName: name } as OutputDecoratorOptions,
    owner,
  }));
}

export async function buildProject(
  entry: string,
  directory: string,
  options: { lazyExports?: boolean; exportOnly?: string | undefined } = {},
) {
  entry = await realpath(entry);
  const module = await import(pathToFileURL(resolve(entry)).href);
  // An index.ts names its project before any geometry is evaluated.
  const info =
    module.PROJECTINFO === undefined
      ? undefined
      : validateProjectInfo(module.PROJECTINFO);
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
  // Outputs may be declared across several modules, so two of them writing the
  // same file is a mistake worth naming rather than a silent overwrite.
  const claim = (name: string) => {
    if (basename(name) !== name || name.startsWith("."))
      throw new Error("Output filename must be a plain filename");
    if (files.some((file) => file.name === name))
      throw new Error(
        `Another output already writes ${name}; give one of them its own fileName`,
      );
  };
  const pending = (name: string, kind: string) => {
    claim(name);
    files.push({ name, kind, size: 0, ready: false });
  };
  const save = async (
    name: string,
    kind: string,
    data: Uint8Array | string,
  ) => {
    claim(name);
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
    const flatParts = new Map<
      string,
      { path: string; label: string; lines: number[] }
    >();
    const emitDrawing = async (
      value: TechnicalDrawing,
      name: string,
      onView?: ViewObserver,
    ) => {
      const stem = name.replace(/\.(svg|pdf|dxf)$/i, "");
      if (
        options.exportOnly &&
        !options.exportOnly.startsWith(stem + ".") &&
        !options.exportOnly.startsWith(stem + "-page-")
      )
        return;
      const rendered = options.lazyExports
        ? {
            pages: await renderDrawingPreviews(engine, value, onView),
            dxf: undefined,
          }
        : await renderDrawingFormats(engine, value, onView);
      const { pages } = rendered;
      await save(stem + ".svg", "drawing", pages[0]!);
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
        title: value.options.title || stem,
        kind: "drawing",
        preview: stem + ".svg",
        previews,
        formats: { pdf: stem + ".pdf", dxf: stem + ".dxf" },
      });
    };
    const outputOwners = [
      project,
      ...outputProviders
        .filter(
          ({ projectType, providerType }) =>
            project instanceof projectTypeOf(projectType, providerType),
        )
        .map(({ providerType }) => new providerType(project)),
    ];
    const declared = outputOwners.flatMap((owner) =>
      (outputRegistry.get(owner) ?? []).map((output) => ({ ...output, owner })),
    );
    // A project that declares no outputs still gets the usual deliverables.
    const outputs = declared.length ? declared : standardOutputs(project, info);
    for (const output of outputs) {
      try {
        const value = (output.owner as any)[output.name](),
          requested = output.options.fileName;
        if (value instanceof TechnicalDrawing) {
          await emitDrawing(value, requested ?? output.name);
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
                summary: layoutSummary(layout, value.options.mmPrecision),
                kind: "nesting",
                preview: layoutStem + ".svg",
                formats: { pdf: layoutStem + ".pdf", dxf: layoutStem + ".dxf" },
              });
            }
          }
        } else if (value instanceof ManufacturingDxf) {
          const name = requested ?? "manufacturing.zip";
          // The Drawings plane is part of the model, not an export, so it is
          // drawn even when the files themselves are left for later.
          if (value.options.showInDrawings)
            for (const [part, entities] of await drawManufacturing(
              engine,
              value,
              project.view2D,
            ))
              // The Sheet editor places these parts as flat views.
              flatParts.set(part.path, {
                path: part.path,
                label: part.label,
                lines: entitySegments(entities),
              });
          if (options.exportOnly && options.exportOnly !== name) continue;
          if (options.lazyExports) {
            pending(name, "dxf");
            continue;
          }
          const exports = await engine.exportDxf(value, (part, finding) =>
            diagnostics.push({
              severity: "warning",
              code: "THIN_MATERIAL",
              componentPath: part.path,
              message: `${finding.mm.toFixed(2)} mm of material between ${finding.between.join(" and ")} at ${finding.at.x.toFixed(1)}, ${finding.at.y.toFixed(1)} on the blank; ${value.options.minimumMaterial} mm wanted (sampled)`,
            }),
          );
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
          // One study per file, named after the method, so a project can hold
          // several of them in separate modules.
          const name = requested ?? `${output.name}.glb`;
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
          severity: declared.length ? "error" : "warning",
          code: "OUTPUT",
          message: `${output.name}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    // Studio's plan editor saves its sheet beside the project source.
    const planViews: Record<
      string,
      { key: string; visible: number[]; hidden: number[] }
    > = {};
    try {
      const plan = validateDrawingPlan(
        JSON.parse(await readFile(drawingPlanFile(entry), "utf8")),
      );
      const items = plan.sheets.flatMap((sheet) => sheet.items);
      if (items.some((item) => item.kind === "view")) {
        const { drawing, warnings } = planDrawing(plan, project, info);
        for (const message of warnings)
          diagnostics.push({
            severity: "warning",
            code: "DRAWING_PLAN",
            message,
          });
        const flatten = (lines: number[]) => {
          const result: number[] = [];
          for (let i = 0; i < lines.length; i += 6)
            for (const j of [0, 1, 3, 4])
              result.push(Math.round(lines[i + j]! * 1000) / 1000);
          return result;
        };
        const views = new Map(
          items.flatMap((item) =>
            item.kind === "view" ? [[item.id, item] as const] : [],
          ),
        );
        if (drawing.views.length)
          await emitDrawing(drawing, "drawing-plan", ({ view, linework }) => {
            const item = views.get(view.id);
            if (item && linework)
              planViews[view.id] = {
                key: planViewKey(item),
                visible: flatten(linework.visible),
                hidden: flatten(linework.hidden),
              };
          });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        diagnostics.push({
          severity: "warning",
          code: "DRAWING_PLAN",
          message: `Drawing plan: ${error instanceof Error ? error.message : String(error)}`,
        });
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
      title: info?.name || project.label,
      info: info ?? null,
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
      flatParts: [...flatParts.values()],
      planViews,
      components: [project, ...project.registry.all].map((c) => ({
        path: c.path,
        id: c.id,
        label: c.label,
        type: c.constructor.name,
        parent: c.parent?.path,
        inspection: inspectComponent(c, model.meshes),
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
