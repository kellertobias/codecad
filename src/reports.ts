import {
  encodeDxf,
  escapeXml,
  outlineBounds,
  type DxfEntity,
  type CutRow,
  type SheetLayout,
} from "./manufacturing.js";

export interface ReportDownload {
  title: string;
  kind: "drawing" | "nesting" | "cutList";
  preview: string;
  formats: { pdf: string; dxf: string; csv?: string };
  rows?: CutRow[];
}

/** Vector reports use millimetres with the origin at the top left of the page. */
export interface ReportPage {
  width: number;
  height: number;
  entities: DxfEntity[];
}
export function text(
  page: ReportPage,
  value: string,
  x: number,
  y: number,
  height = 3.2,
  layer = "TEXT",
) {
  page.entities.push({ kind: "text", text: value, x, y, height, layer });
}
export function line(
  page: ReportPage,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  layer = "LINES",
) {
  page.entities.push({
    kind: "polyline",
    layer,
    points: [
      { x: x1, y: y1 },
      { x: x2, y: y2 },
    ],
    closed: false,
  });
}
export function rectangle(
  page: ReportPage,
  x: number,
  y: number,
  width: number,
  height: number,
  layer = "LINES",
) {
  page.entities.push({
    kind: "polyline",
    layer,
    points: [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ],
    closed: true,
  });
}
export function pageSvg(page: ReportPage): Uint8Array {
  const elements = page.entities
    .map((e) => {
      if (e.kind === "text")
        return `<text x="${e.x}" y="${e.y}" font-size="${e.height}" fill="#20303a">${escapeXml(e.text)}</text>`;
      if (e.kind === "circle")
        return `<circle cx="${e.x}" cy="${e.y}" r="${e.radius}" fill="none" stroke="#53616a" stroke-width="0.2"/>`;
      return `<path d="${e.points.map((p, i) => (i ? "L" : "M") + p.x + "," + p.y).join("")}${e.closed ? "Z" : ""}" fill="none" stroke="#53616a" stroke-width="0.2"/>`;
    })
    .join("");
  return new TextEncoder().encode(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${page.width}mm" height="${page.height}mm" viewBox="0 0 ${page.width} ${page.height}"><rect width="${page.width}" height="${page.height}" fill="white"/><g font-family="sans-serif">${elements}</g></svg>`,
  );
}
export function pagesDxf(pages: ReportPage[]): Uint8Array {
  let offset = 0;
  const all: DxfEntity[] = [];
  for (const page of pages) {
    for (const entity of page.entities) {
      if (entity.kind === "polyline")
        all.push({
          ...entity,
          points: entity.points.map((p) => ({
            x: p.x + offset,
            y: page.height - p.y,
          })),
        });
      else
        all.push({
          ...entity,
          x: entity.x + offset,
          y: page.height - entity.y,
        });
    }
    offset += page.width + 20;
  }
  return encodeDxf(all);
}
function wrap(value: string, limit: number): string[] {
  const result: string[] = [];
  let remaining = value;
  while (remaining.length > limit) {
    let at = remaining.lastIndexOf(" ", limit);
    if (at < limit / 2) at = limit;
    result.push(remaining.slice(0, at));
    remaining = remaining.slice(at).trimStart();
  }
  result.push(remaining);
  return result;
}
/** Tables paginate instead of shrinking or truncating long part/material names. */
export function cutListPages(rows: CutRow[], title = "Cut list"): ReportPage[] {
  const pages: ReportPage[] = [],
    columns = [12, 111, 194, 215, 237, 261, 285];
  let page: ReportPage = { width: 297, height: 210, entities: [] },
    y = 0;
  const next = () => {
    page = { width: 297, height: 210, entities: [] };
    pages.push(page);
    text(page, title, 12, 16, 5);
    text(
      page,
      "Blank dimensions in mm · W × H × T · quantities include copies",
      12,
      23,
      3,
    );
    ["Part / label", "Material", "W", "H", "T", "Qty"].forEach((name, i) =>
      text(page, name, columns[i]! + 2, 33, 3.2, "TABLE_HEADER"),
    );
    line(page, 12, 37, 285, 37, "TABLE");
    y = 37;
  };
  next();
  for (const row of rows) {
    const names = wrap(
        row.path +
          (row.label !== row.path.split("/").at(-1) ? " · " + row.label : ""),
        49,
      ),
      materials = wrap(row.material, 40);
    const rowHeight = Math.max(names.length, materials.length) * 4.5 + 4;
    if (y + rowHeight > 190) next();
    const cells = [
      names,
      materials,
      [String(row.width)],
      [String(row.height)],
      [String(row.thickness)],
      [String(row.quantity)],
    ];
    cells.forEach((lines, i) =>
      lines.forEach((value, j) =>
        text(page, value, columns[i]! + 2, y + 5 + j * 4.5, 3, "TABLE_TEXT"),
      ),
    );
    y += rowHeight;
    line(page, 12, y, 285, y, "TABLE");
  }
  if (!rows.length) text(page!, "No manufactured parts.", 14, 45);
  pages.forEach((page, i) =>
    text(
      page,
      `Page ${i + 1} / ${pages.length} · ${rows.length} entries · ${rows.reduce((sum, r) => sum + r.quantity, 0)} pieces`,
      12,
      201,
      3,
    ),
  );
  return pages;
}
/** Scaled A4 layout overview plus a legible numbered part legend. DXF stays 1:1. */
export function sheetLayoutPages(layout: SheetLayout): ReportPage[] {
  const page: ReportPage = { width: 210, height: 297, entities: [] },
    w = layout.material.width!,
    h = layout.material.height!;
  const scale = Math.min(186 / w, 237 / h),
    x = 12,
    y = 40;
  text(page, `Sheet ${layout.number} · ${layout.material.name}`, 12, 16, 4);
  text(
    page,
    `${w} × ${h} × ${layout.material.thickness} mm · ${layout.parts.length} blanks`,
    12,
    24,
    3.2,
  );
  text(
    page,
    `Overview scale 1:${(1 / scale).toFixed(2)} · DXF is full size in mm`,
    12,
    31,
    3,
  );
  rectangle(page, x, y, w * scale, h * scale, "STOCK_BOUNDARY");
  layout.parts.forEach((part, i) => {
    rectangle(
      page,
      x + part.x * scale,
      y + part.y * scale,
      part.width * scale,
      part.height * scale,
      "BLANKS",
    );
    text(
      page,
      String(i + 1),
      x + (part.x + part.width / 2) * scale - 1,
      y + (part.y + part.height / 2) * scale + 1,
      3.5,
      "PART_NUMBERS",
    );
  });
  text(
    page,
    "Numbers refer to the part legend on the following page(s).",
    12,
    288,
    3,
  );
  const rows = layout.parts.map((n, i) => ({
    path: `${i + 1}. ${n.part.path}`,
    label: `${n.part.label} (rotation ${n.rotation}°)`,
    material: layout.material.name,
    ...outlineBounds(n.part),
    thickness: layout.material.thickness,
    quantity: 1,
  }));
  return [page, ...cutListPages(rows, `Sheet ${layout.number} · part legend`)];
}
