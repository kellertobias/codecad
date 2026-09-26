// Sheets every document has without being told: one manufacturing sheet per
// sheet part. Pure data, so the editor can list them.
import type { DrawingSheet } from "./schema.js";

/** What a manufacturing sheet needs to know about a part. */
export interface SheetPartInfo {
  readonly body: string;
  readonly name: string;
  readonly stock: "sheet" | "solid";
  readonly quantity: number;
  readonly thickness?: number;
  readonly material?: { readonly name: string };
}

/** A manufacturing sheet for every sheet part: its blank as cut, the part
 * itself from the front and in isometric, and what to cut it from. */
export function partSheets(info: readonly SheetPartInfo[]): DrawingSheet[] {
  return info
    .filter((part) => part.stock === "sheet")
    .map((part) => ({
      id: `part:${part.body}`,
      name: `${part.name} — ${part.material?.name ?? ""} ${part.thickness} mm, ${part.quantity}×`,
      size: "A4" as const,
      views: [
        {
          id: "flat",
          kind: "flat" as const,
          part: part.body,
          label: "Blank as cut",
        },
        {
          id: "iso",
          kind: "view" as const,
          angle: "isometric" as const,
          bodies: [part.body],
          label: "Part",
        },
      ],
    }));
}
