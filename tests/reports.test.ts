import { test } from "node:test";
import assert from "node:assert/strict";
import { cutListPages, pageSvg, pagesDxf } from "../src/reports.js";
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
