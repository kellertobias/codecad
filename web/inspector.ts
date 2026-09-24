import type { Inspection } from "../src/inspection.js";

/** Grams read as grams up to a kilo, and as kilos above it. */
export function formatMass(grams: number) {
  return grams < 1000
    ? `${grams < 100 ? grams.toFixed(1) : Math.round(grams)} g`
    : `${(grams / 1000).toFixed(grams < 10000 ? 2 : 1)} kg`;
}

export function inspectorDetails(inspection: Inspection) {
  const mm = (value: number) => `${value.toFixed(1)} mm`;
  const dimensions = inspection.dimensions;
  const rows: [string, string][] = [
    ["Volume", `${(inspection.volume / 1000).toFixed(1)} cm³`],
    [
      "Weight",
      inspection.mass === undefined
        ? "No material density"
        : formatMass(inspection.mass) +
          (inspection.massPartial ? " · parts with a density only" : ""),
    ],
  ];
  if (inspection.kind === "part") {
    rows.push(
      ["Outer width", dimensions ? mm(dimensions[0]) : "—"],
      ["Outer height", dimensions ? mm(dimensions[1]) : "—"],
      ["Outer thickness", dimensions ? mm(dimensions[2]) : "—"],
      ["Material", inspection.material ?? "Not defined"],
    );
  } else {
    rows.push(
      ["Parts", String(inspection.partCount)],
      ["Overall X", dimensions ? mm(dimensions[0]) : "—"],
      ["Overall Y", dimensions ? mm(dimensions[1]) : "—"],
      ["Overall Z", dimensions ? mm(dimensions[2]) : "—"],
    );
  }
  const operations = inspection.operations.map((operation) =>
    [
      operation.toolId ?? operation.kind,
      operation.diameter === undefined ? "" : `Ø${mm(operation.diameter)}`,
      operation.depth === undefined ? "" : `depth ${mm(operation.depth)}`,
      operation.angle === undefined ? "" : `${operation.angle.toFixed(1)}°`,
    ]
      .filter(Boolean)
      .join(" · "),
  );
  return { rows, operations };
}
