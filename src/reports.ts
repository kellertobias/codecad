import {
  encodeDxf,
  escapeXml,
  outlineBounds,
  type DxfEntity,
  type CutRow,
  type SheetLayout,
} from "./manufacturing.js";
import { formatMm } from "./precision.js";

export interface ReportDownload {
  title: string;
  kind: "drawing" | "nesting" | "cutList";
  preview: string;
  previews?: string[];
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
        return `<text x="${e.x}" y="${e.y}" font-size="${e.height}" fill="#20252a" text-anchor="${e.align ?? "start"}" transform="rotate(${e.rotation ?? 0},${e.x},${e.y})">${escapeXml(e.text)}</text>`;
      if (e.kind === "circle")
        return `<circle cx="${e.x}" cy="${e.y}" r="${e.radius}" fill="none" stroke="#53616a" stroke-width="0.2"/>`;
      const dashed = /HIDDEN|BEND_|TANGENT/.test(e.layer);
      const weight =
        e.style?.lineWidth ??
        (/BORDER|VISIBLE|BLANK_OUTLINE/.test(e.layer) ? 0.35 : 0.18);
      const fill =
        e.layer === "SCALE_DARK"
          ? "#20252a"
          : e.layer === "SCALE_LIGHT"
            ? "white"
            : "none";
      return `<path d="${e.points.map((p, i) => (i ? "L" : "M") + p.x + "," + p.y).join("")}${e.closed ? "Z" : ""}" fill="${fill}" stroke="${escapeXml(e.style?.stroke ?? "#20252a")}" stroke-width="${weight}" ${dashed ? 'stroke-dasharray="3,1,0.5,1"' : ""}/>`;
    })
    .join("");
  return new TextEncoder().encode(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${page.width}mm" height="${page.height}mm" viewBox="0 0 ${page.width} ${page.height}"><rect width="${page.width}" height="${page.height}" fill="white"/><g font-family="sans-serif" stroke-linecap="round" stroke-linejoin="round">${elements}</g></svg>`,
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
export function cutListPages(
  rows: CutRow[],
  title = "Cut list",
  mmPrecision?: number,
): ReportPage[] {
  const pages: ReportPage[] = [],
    columns = [12, 103, 173, 193, 213, 238, 260, 278];
  let page: ReportPage = { width: 297, height: 210, entities: [] },
    y = 0;
  const next = () => {
    page = { width: 297, height: 210, entities: [] };
    pages.push(page);
    text(page, title, 12, 16, 5);
    text(
      page,
      "Blank dimensions in mm · W × H × T (or profile L) · quantities include copies",
      12,
      23,
      3,
    );
    ["Part / label", "Material", "W", "H", "T / L", "Wall", "R", "Qty"].forEach(
      (name, i) => text(page, name, columns[i]! + 2, 33, 3.2, "TABLE_HEADER"),
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
      [formatMm(row.width, mmPrecision)],
      [formatMm(row.height, mmPrecision)],
      [formatMm(row.length ?? row.thickness ?? 0, mmPrecision)],
      [
        row.wallThickness == null
          ? ""
          : formatMm(row.wallThickness, mmPrecision),
      ],
      [
        row.cornerRadius === undefined
          ? ""
          : formatMm(row.cornerRadius, mmPrecision),
      ],
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
export function sheetLayoutPages(
  layout: SheetLayout,
  mmPrecision?: number,
): ReportPage[] {
  const page: ReportPage = { width: 210, height: 297, entities: [] },
    w = layout.material.width!,
    h = layout.material.height!;
  const scale = Math.min(186 / w, 237 / h),
    x = 12,
    y = 40;
  text(page, `Sheet ${layout.number} · ${layout.material.name}`, 12, 16, 4);
  text(
    page,
    `${formatMm(w, mmPrecision)} × ${formatMm(h, mmPrecision)} × ${formatMm(layout.material.thickness, mmPrecision)} mm · ${layout.parts.length} blanks`,
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
  layout.offcuts.forEach((offcut, i) => {
    rectangle(
      page,
      x + offcut.x * scale,
      y + offcut.y * scale,
      offcut.width * scale,
      offcut.height * scale,
      "OFFCUTS",
    );
    text(
      page,
      `O${i + 1}`,
      x + (offcut.x + offcut.width / 2) * scale - 1,
      y + (offcut.y + offcut.height / 2) * scale + 1,
      3,
      "OFFCUT_NUMBERS",
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
  const cutRows = layout.cuts.map(
    (cut) =>
      `Cut ${cut.sequence} (${cut.source}): ${cut.axis.toUpperCase()}=${formatMm(cut.at, mmPrecision)} mm, ${formatMm(cut.from, mmPrecision)}–${formatMm(cut.to, mmPrecision)} mm`,
  );
  const offcutRows = layout.offcuts.map(
    (offcut, i) =>
      `O${i + 1}: ${formatMm(offcut.width, mmPrecision)} × ${formatMm(offcut.height, mmPrecision)} mm at (${formatMm(offcut.x, mmPrecision)}, ${formatMm(offcut.y, mmPrecision)})`,
  );
  const planRows = [
    `Saw kerf ${formatMm(layout.material.options.kerf ?? 0, mmPrecision)} mm · minimum spacing ${formatMm(Math.max(layout.material.options.kerf ?? 0, layout.material.options.partSpacing ?? 0), mmPrecision)} mm · edge margin ${formatMm(layout.material.options.sheetMargin ?? 0, mmPrecision)} mm`,
    `Blanks ${formatMm(layout.usedArea, mmPrecision)} mm² · reusable off-cuts ${formatMm(layout.offcutArea, mmPrecision)} mm² · margins/kerf/spacing ${formatMm(layout.wasteArea, mmPrecision)} mm²`,
    "Guillotine cut order (each cut spans its named source rectangle):",
    ...cutRows,
    "Reusable off-cuts (coordinates from stock top-left):",
    ...offcutRows,
  ].flatMap((row) => wrap(row, 100));
  const planPages: ReportPage[] = [];
  for (let first = 0; first < planRows.length; first += 37) {
    const plan: ReportPage = { width: 210, height: 297, entities: [] };
    text(plan, `Sheet ${layout.number} · cuts and off-cuts`, 12, 16, 4);
    planRows
      .slice(first, first + 37)
      .forEach((row, i) => text(plan, row, 12, 30 + i * 6, 2.8));
    planPages.push(plan);
  }
  return [
    page,
    ...cutListPages(rows, `Sheet ${layout.number} · part legend`, mmPrecision),
    ...planPages,
  ];
}
