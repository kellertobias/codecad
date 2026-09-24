import type { Component, Project } from "./model.js";
import { TechnicalDrawing } from "./outputs.js";
import type { DrawingPlan, PlanSheet } from "./drawing-plan.js";
import type { ProjectInfo } from "./project-info.js";
import { SheetPart } from "./stock.js";
import { rotatePaper, viewBasis } from "./view-basis.js";

export { planViewKey } from "./drawing-plan.js";

/** Turn Studio's saved plan into a regular drawing of the built project, so it
 * gets the same hidden-line projection and PDF/DXF export as coded drawings.
 * Each non-empty sheet becomes one page; the first is the drawing itself. */
export function planDrawing(
  plan: DrawingPlan,
  project: Project,
  info?: ProjectInfo,
): { drawing: TechnicalDrawing; warnings: string[] } {
  const warnings: string[] = [];
  const pages = plan.sheets
    .filter((sheet) => sheet.items.length)
    .map((sheet, index) => sheetDrawing(sheet, index, project, warnings, info));
  const [drawing = sheetDrawing(plan.sheets[0]!, 0, project, warnings, info)] =
    pages;
  drawing.additionalPages.push(...pages.slice(1));
  return { drawing, warnings };
}
function sheetDrawing(
  sheet: PlanSheet,
  index: number,
  project: Project,
  warnings: string[],
  info?: ProjectInfo,
) {
  const drawing = new TechnicalDrawing({
      title:
        sheet.title ||
        (index ? `${project.label} · ${index + 1}` : project.label),
      paper: "A3",
      project: info?.name ?? project.label,
      ...(info?.author ? { author: info.author } : {}),
      ...(info?.revision ? { revision: info.revision } : {}),
    }),
    drawn = new Set<string>();
  for (const item of sheet.items) {
    if (item.kind === "view") {
      const subject: Component | undefined =
        item.subject === "*" ? project : project.registry.get(item.subject);
      if (!subject) {
        warnings.push(
          `Plan view "${item.label || item.id}" refers to missing component ${item.subject}`,
        );
        continue;
      }
      const flat = item.angle === "flat";
      if (flat && !(subject instanceof SheetPart)) {
        warnings.push(
          `Plan view "${item.label || item.id}" shows ${item.subject} flat, but it is not a sheet part`,
        );
        continue;
      }
      const omitted = flat
        ? []
        : (item.hiddenParts ?? [])
            .map((path) => project.registry.get(path))
            .filter((part): part is Component => part !== undefined);
      if (!flat)
        for (const path of item.hiddenParts ?? [])
          if (!project.registry.get(path))
            warnings.push(
              `Plan view "${item.label || item.id}" hides missing component ${path}`,
            );
      drawn.add(item.id);
      drawing.view({
        id: item.id,
        of: subject,
        ...(omitted.length ? { without: omitted } : {}),
        kind: item.angle,
        at: { x: item.x, y: item.y },
        box: { width: item.width, height: item.height },
        scale: 1 / item.scale,
        ...(item.rotate ? { rotate: item.rotate } : {}),
        // The renderer appends the scale to every caption.
        label:
          item.label ||
          (flat
            ? subject.label
            : item.angle[0]!.toUpperCase() + item.angle.slice(1)),
        ...(item.hiddenLines && !flat ? { hiddenLines: true } : {}),
      });
    } else if (item.kind === "text")
      drawing.note({
        at: { x: item.x, y: item.y },
        text: item.text,
        height: item.size,
      });
  }
  for (const item of sheet.items) {
    if (item.kind !== "dimension" || !drawn.has(item.view)) continue;
    const view = sheet.items.find((entry) => entry.id === item.view);
    if (view?.kind !== "view") continue;
    // Dimension points are stored in the turned frame, so read them back with
    // the same basis the view is drawn with. A flat pattern turns on the paper
    // instead, so its points are turned back into the part's own XY.
    const turn = view.rotate ?? 0;
    const world =
      view.angle === "flat"
        ? (u: number, v: number) => ({
            ...rotatePaper({ x: u, y: v }, -turn),
            z: 0,
          })
        : (() => {
            const { x, y } = viewBasis(view.angle, turn);
            return (u: number, v: number) => ({
              x: u * x[0] + v * y[0],
              y: u * x[1] + v * y[1],
              z: u * x[2] + v * y[2],
            });
          })();
    drawing.dimension({
      view: item.view,
      from: world(item.u1, item.v1),
      to: world(item.u2, item.v2),
      offset: 0,
      paperOffset: item.offset,
      ...(item.label ? { label: item.label } : {}),
    });
  }
  return drawing;
}
