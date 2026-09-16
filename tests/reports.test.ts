import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cutListPages,
  pageSvg,
  pagesDxf,
  sheetLayoutPages,
} from "../src/reports.js";
import { csv, nest } from "../src/manufacturing.js";
import { SheetMaterial } from "../src/stock.js";
import { pdfPages } from "../src/exporters.js";

test("cut-list reports paginate and keep complete labels across all formats", async () => {
  const rows = Array.from({ length: 80 }, (_, i) => ({
    path: `cabinet/part-${i}`,
    label: `Long descriptive label for cabinet component ${i}`,
    material: "Birch plywood",
    width: 600,
    height: 950,
    thickness: 18,
    quantity: 1,
  }));
  const pages = cutListPages(rows);
  assert.ok(pages.length > 3);
  const texts = pages
    .flatMap((p) =>
      p.entities.filter((e) => e.kind === "text").map((e) => e.text),
    )
    .join(" ");
  assert.match(texts, /cabinet\/part-79/);
  for (const page of pages) {
    assert.deepEqual([page.width, page.height], [297, 210]);
    for (const entity of page.entities)
      if (entity.kind === "text") assert.ok(entity.y < 210);
  }
  const dxf = new TextDecoder().decode(pagesDxf(pages));
  assert.match(dxf, /TABLE_TEXT/);
  assert.match(dxf, /cabinet\/part-79/);
  const pdf = Buffer.from(await pdfPages(pages.map(pageSvg)));
  assert.match(pdf.toString("latin1"), new RegExp(`/Count ${pages.length}\\b`));
});

test("configured millimetre precision reaches cut-list legends and CSV", () => {
  const rows = [
    {
      path: "panel",
      label: "Panel",
      material: "Plywood",
      width: 125.678,
      height: 80,
      thickness: 18.25,
      quantity: 1,
    },
  ];
  const svg = new TextDecoder().decode(
    pageSvg(cutListPages(rows, "Cut list", 1)[0]!),
  );
  assert.match(svg, />125\.7</);
  assert.match(svg, />80\.0</);
  assert.match(svg, />18\.3</);
  const output = csv(rows, 1);
  assert.match(output, /"125\.7","80\.0","18\.3"/);
  const material = new SheetMaterial({
    id: "plywood",
    thickness: 18.25,
    width: 1250,
    height: 2500,
  });
  const part = material.makePart({ id: "panel", width: 125.678, height: 80 });
  const layout = sheetLayoutPages(nest([part])[0]!, 1);
  assert.match(
    new TextDecoder().decode(pageSvg(layout[0]!)),
    /1250\.0 × 2500\.0 × 18\.3 mm/,
  );
  assert.match(new TextDecoder().decode(pageSvg(layout[1]!)), />125\.7</);
  const planText = layout
    .slice(2)
    .flatMap((page) => page.entities)
    .filter((entity) => entity.kind === "text")
    .map((entity) => entity.text)
    .join("\n");
  assert.match(planText, /Guillotine cut order/);
  assert.match(planText, /Cut 1/);
  assert.match(planText, /Reusable off-cuts/);
  assert.match(planText, /Saw kerf 0\.0 mm/);
});
