import type { Inspection } from "../src/inspection.js";

export function inspectorDetails(inspection: Inspection) {
  const mm = (value: number) => `${value.toFixed(1)} mm`;
  const dimensions = inspection.dimensions;
  const rows: [string, string][] = [
    ["Volume", `${(inspection.volume / 1000).toFixed(1)} cm³`],
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
