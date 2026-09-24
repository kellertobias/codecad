import { viewAngles, type ViewAngle } from "./view-basis.js";

/** Editable drawing instructions. Sheet coordinates are millimetres on an A3
 * landscape page. Dimension points are stored in the view's projected model
 * millimetres (paper-right, paper-up), so they follow the view when it is
 * moved or rescaled and stay attached to the geometry they measure.
 *
 * A `flat` view draws one sheet part as it is cut, from the same outline the
 * 2D geometry tab shows; its points are the part's developed local XY. */
export type PlanAngle = ViewAngle | "flat";
export const planSheet = { width: 420, height: 297 } as const;
export type PlanItem =
  | {
      id: string;
      kind: "view";
      subject: string;
      angle: PlanAngle;
      x: number;
      y: number;
      width: number;
      height: number;
      /** Denominator: 10 draws the model at 1:10. */
      scale: number;
      /** Degrees the projection is turned counter-clockwise on the paper.
       * Dimension points are stored in the turned frame, so they stay put. */
      rotate?: number;
      /** Empty for an automatic "Front · 1:10" caption. */
      label: string;
      hiddenLines?: boolean;
      /** Components left out of this view; their children go with them. */
      hiddenParts?: string[];
    }
  | {
      id: string;
      kind: "dimension";
      view: string;
      u1: number;
      v1: number;
      u2: number;
      v2: number;
      /** Paper millimetres from the measured points to the dimension line. */
      offset: number;
      label: string;
    }
  | {
      id: string;
      kind: "text";
      x: number;
      y: number;
      text: string;
      size: number;
    };
/** One page of the plan; every sheet becomes a page of the PDF and DXF. */
export interface PlanSheet {
  id: string;
  title: string;
  items: PlanItem[];
}
export interface DrawingPlan {
  version: 2;
  sheets: PlanSheet[];
}
export const emptyDrawingPlan = (): DrawingPlan => ({
  version: 2,
  sheets: [{ id: "sheet_1", title: "", items: [] }],
});
/** Where a project keeps the sheet composed in Studio. An `index.ts` entry
 * names it after its folder, so the file is not called `index.drawings.json`. */
export function drawingPlanFile(entry: string) {
  const stem = entry.replace(/\.[^.\\/]+$/, "");
  return /(^|[\\/])index$/.test(stem)
    ? stem.replace(/index$/, "drawings.json")
    : stem + ".drawings.json";
}
const angles = new Set<PlanAngle>([...viewAngles, "flat"]);
export const planViewLabel = (view: { angle: PlanAngle; scale: number }) =>
  `${view.angle[0]!.toUpperCase()}${view.angle.slice(1)} · ${
    view.scale >= 1
      ? `1:${Number(view.scale.toFixed(3))}`
      : `${Number((1 / view.scale).toFixed(3))}:1`
  }`;
/** Identifies the geometry of a plan view independent of its sheet placement,
 * so the Studio can tell a built view from one it must draw as a wireframe. */
export const planViewKey = (view: {
  subject: string;
  angle: string;
  rotate?: number;
  hiddenLines?: boolean;
  hiddenParts?: readonly string[];
}) =>
  `${view.subject}|${view.angle}${view.rotate ? `@${view.rotate}` : ""}|${
    view.hiddenLines ? "hidden" : "visible"
  }` +
  (view.hiddenParts?.length
    ? `|-${[...view.hiddenParts].sort().join(",")}`
    : "");
const finite = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value);
const idPattern = /^[a-zA-Z0-9_-]{1,80}$/;
/** Validates a saved plan; a single-sheet plan from before sheets existed is
 * read as the first sheet of the new format. */
export function validateDrawingPlan(value: unknown): DrawingPlan {
  if (!value || typeof value !== "object")
    throw new Error("Invalid drawing plan");
  const input = value as { version?: unknown };
  const plan: DrawingPlan =
    input.version === 1
      ? (() => {
          const legacy = value as { title?: unknown; items?: unknown };
          return {
            version: 2,
            sheets: [
              {
                id: "sheet_1",
                title: legacy.title as string,
                items: legacy.items as PlanItem[],
              },
            ],
          };
        })()
      : (value as DrawingPlan);
  if (
    plan.version !== 2 ||
    !Array.isArray(plan.sheets) ||
    plan.sheets.length < 1 ||
    plan.sheets.length > 50
  )
    throw new Error("Unsupported drawing plan");
  const ids = new Set<string>();
  for (const sheet of plan.sheets) {
    if (
      !sheet ||
      typeof sheet.id !== "string" ||
      !idPattern.test(sheet.id) ||
      ids.has(sheet.id) ||
      typeof sheet.title !== "string" ||
      sheet.title.length > 200 ||
      !Array.isArray(sheet.items) ||
      sheet.items.length > 300
    )
      throw new Error("Invalid drawing sheet");
    ids.add(sheet.id);
    validateItems(sheet.items, ids);
  }
  return plan;
}
function validateItems(items: PlanItem[], ids: Set<string>) {
  for (const item of items) {
    if (
      !item ||
      typeof item.id !== "string" ||
      !idPattern.test(item.id) ||
      ids.has(item.id)
    )
      throw new Error("Invalid or duplicate drawing item ID");
    ids.add(item.id);
    if (item.kind === "view") {
      if (
        typeof item.subject !== "string" ||
        item.subject.length > 500 ||
        !angles.has(item.angle) ||
        // A flat pattern is of one named part, never of the whole model.
        (item.angle === "flat" && item.subject === "*") ||
        ![item.x, item.y, item.width, item.height, item.scale].every(finite) ||
        item.width <= 0 ||
        item.height <= 0 ||
        item.scale <= 0 ||
        (item.rotate !== undefined &&
          (!finite(item.rotate) || Math.abs(item.rotate) > 360)) ||
        typeof item.label !== "string" ||
        item.label.length > 200 ||
        (item.hiddenLines !== undefined &&
          typeof item.hiddenLines !== "boolean") ||
        (item.hiddenParts !== undefined &&
          (!Array.isArray(item.hiddenParts) ||
            item.hiddenParts.length > 300 ||
            !item.hiddenParts.every(
              (path) => typeof path === "string" && path.length <= 500,
            )))
      )
        throw new Error("Invalid model view");
    } else if (item.kind === "dimension") {
      if (
        typeof item.view !== "string" ||
        ![item.u1, item.v1, item.u2, item.v2, item.offset].every(finite) ||
        typeof item.label !== "string" ||
        item.label.length > 200
      )
        throw new Error("Invalid dimension");
    } else if (item.kind === "text") {
      if (
        typeof item.text !== "string" ||
        item.text.length > 2000 ||
        ![item.x, item.y, item.size].every(finite) ||
        item.size <= 0
      )
        throw new Error("Invalid text");
    } else throw new Error("Unknown drawing item");
  }
  // A dimension is drawn on its view's page, so both live on the same sheet.
  for (const item of items)
    if (
      item.kind === "dimension" &&
      !items.some((view) => view.kind === "view" && view.id === item.view)
    )
      throw new Error("Dimension refers to a missing view");
}
