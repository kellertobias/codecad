import type { Component, Project } from "./model.js";
import { TechnicalDrawing } from "./outputs.js";
import type { DrawingPlan } from "./drawing-plan.js";
import type { ProjectInfo } from "./project-info.js";
import { viewBasis } from "./view-basis.js";

export { planViewKey } from "./drawing-plan.js";

/** Turn Studio's saved plan into a regular drawing of the built project, so it
 * gets the same hidden-line projection and PDF/DXF export as coded drawings. */
export function planDrawing(
  plan: DrawingPlan,
  project: Project,
  info?: ProjectInfo,
): { drawing: TechnicalDrawing; warnings: string[] } {
  const drawing = new TechnicalDrawing({
      title: plan.title || project.label,
      paper: "A3",
      project: info?.name ?? project.label,
      ...(info?.author ? { author: info.author } : {}),
      ...(info?.revision ? { revision: info.revision } : {}),
    }),
    warnings: string[] = [],
    drawn = new Set<string>();
  for (const item of plan.items) {
    if (item.kind === "view") {
      const subject: Component | undefined =
        item.subject === "*" ? project : project.registry.get(item.subject);
      if (!subject) {
        warnings.push(
          `Plan view "${item.label || item.id}" refers to missing component ${item.subject}`,
        );
        continue;
      }
      const omitted = (item.hiddenParts ?? [])
        .map((path) => project.registry.get(path))
        .filter((part): part is Component => part !== undefined);
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
        // The renderer appends the scale to every caption.
        label: item.label || item.angle[0]!.toUpperCase() + item.angle.slice(1),
        ...(item.hiddenLines ? { hiddenLines: true } : {}),
      });
    } else if (item.kind === "text")
      drawing.note({
        at: { x: item.x, y: item.y },
        text: item.text,
        height: item.size,
      });
  }
  for (const item of plan.items) {
    if (item.kind !== "dimension" || !drawn.has(item.view)) continue;
    const view = plan.items.find((entry) => entry.id === item.view);
    if (view?.kind !== "view") continue;
    const { x, y } = viewBasis(view.angle);
    const world = (u: number, v: number) => ({
      x: u * x[0] + v * y[0],
      y: u * x[1] + v * y[1],
      z: u * x[2] + v * y[2],
    });
    drawing.dimension({
      view: item.view,
      from: world(item.u1, item.v1),
      to: world(item.u2, item.v2),
      offset: 0,
      paperOffset: item.offset,
      ...(item.label ? { label: item.label } : {}),
    });
  }
  return { drawing, warnings };
}
