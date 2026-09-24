import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeDxf } from "../src/manufacturing.js";

test("DXF carries the structure AutoCAD requires from R2000 on", () => {
  const text = new TextDecoder().decode(
    encodeDxf([
      {
        kind: "polyline",
        layer: "PART:OUTLINE",
        points: [
          { x: 0, y: 0, bulge: 1 },
          { x: 10, y: 0 },
        ],
        closed: true,
      },
      { kind: "circle", layer: "DRILL", x: 5, y: 5, radius: 2 },
      { kind: "text", layer: "LABEL", x: 1, y: 1, height: 3, text: "Ø 5" },
    ]),
  );
  const pairs: [string, string][] = [];
  const lines = text.trimEnd().split("\n");
  for (let i = 0; i < lines.length; i += 2)
    pairs.push([lines[i]!.trim(), lines[i + 1]!]);
  const sections = pairs
    .filter(([code], i) => code === "2" && pairs[i - 1]?.[1] === "SECTION")
    .map(([, name]) => name);
  assert.deepEqual(sections, [
    "HEADER",
    "CLASSES",
    "TABLES",
    "BLOCKS",
    "ENTITIES",
    "OBJECTS",
  ]);
  const entities = text.split("\nENTITIES\n")[1]!.split("\nENDSEC\n")[0]!;
  for (const [type, subclass] of [
    ["LWPOLYLINE", "AcDbPolyline"],
    ["CIRCLE", "AcDbCircle"],
    ["TEXT", "AcDbText"],
  ])
    assert.match(
      entities,
      new RegExp(
        `0\\n${type}\\n5\\n[0-9A-F]+\\n330\\n[0-9A-F]+\\n100\\nAcDbEntity\\n8\\n[^\\n]+\\n100\\n${subclass}\\n`,
      ),
    );
  // Handles are unique, and the seed lies beyond every one of them.
  const handles = pairs
    .filter(([code], i) => (code === "5" || code === "105") && i > 8)
    .map(([, h]) => Number.parseInt(h, 16));
  assert.equal(new Set(handles).size, handles.length);
  const seed = Number.parseInt(
    text.match(/\$HANDSEED\n5\n([0-9A-F]+)/)![1]!,
    16,
  );
  assert.ok(handles.every((h) => h < seed));
  assert.match(text, /\nLAYER\n[^]*\n2\n0\n/);
  assert.match(text, /\n2\nPART_OUTLINE\n/);
  assert.doesNotMatch(text, /PART:OUTLINE/);
  assert.match(text, /\n2\n\*Model_Space\n/);
  assert.match(text, /\n3\nACAD_GROUP\n/);
  assert.match(text, /\n1\n\\U\+00D8 5\n/);
});
