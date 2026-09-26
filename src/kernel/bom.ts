// The bill of materials: every part, and the hardware its joints need.
import type { PartInfo } from "./parts.js";

export interface BomRow {
  readonly kind: "part" | "hardware";
  readonly name: string;
  readonly material: string;
  /** Blank size for sheet parts, hardware size such as "5x30". */
  readonly size: string;
  readonly quantity: number;
}

const hardwareNames = { domino: "Domino", dowel: "Dowel", screw: "Screw" };

/** Every part and every piece of joint hardware: the parts as they are,
 * the hardware added up by kind and size. */
export function billOfMaterials(
  parts: readonly PartInfo[],
  hardware: readonly {
    readonly kind: keyof typeof hardwareNames;
    readonly size: string;
    readonly count: number;
  }[],
): BomRow[] {
  const rows: BomRow[] = parts.map((part) => ({
    kind: "part",
    name: part.name,
    material: part.material?.name ?? "",
    size:
      part.stock === "sheet"
        ? `${part.width} × ${part.height} × ${part.thickness}`
        : "",
    quantity: part.quantity,
  }));
  const totals = new Map<string, BomRow>();
  for (const item of hardware) {
    const key = `${item.kind}:${item.size}`;
    const row = totals.get(key);
    totals.set(key, {
      kind: "hardware",
      name: hardwareNames[item.kind],
      material: "",
      size: item.size,
      quantity: (row?.quantity ?? 0) + item.count,
    });
  }
  return [
    ...rows,
    ...[...totals.values()].sort((p, q) =>
      p.name === q.name ? (p.size < q.size ? -1 : 1) : p.name < q.name ? -1 : 1,
    ),
  ];
}

export function bomCsv(rows: readonly BomRow[]): string {
  const quote = (value: string | number) =>
    `"${String(value).replaceAll('"', '""')}"`;
  return [
    ["Kind", "Name", "Material", "Size", "Quantity"],
    ...rows.map((row) => [
      row.kind,
      row.name,
      row.material,
      row.size,
      row.quantity,
    ]),
  ]
    .map((cells) => cells.map(quote).join(","))
    .join("\n");
}
