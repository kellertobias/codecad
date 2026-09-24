/** Cut-list rows: plain data Studio can import without the CAD engine. */
export interface CutRow {
  path: string;
  label: string;
  material: string;
  width: number;
  height: number;
  thickness?: number;
  /** Metal profile cut length along local Z. */
  length?: number;
  wallThickness?: number | null;
  cornerRadius?: number;
  quantity: number;
}
/** One row per blank size: rows that share material and every dimension are
 * merged, their quantities added and their part paths listed, so eight drawer
 * sides read as one line to cut eight times. Order follows the first row of
 * each group. */
export function groupCutRows(
  rows: readonly CutRow[],
): (CutRow & { paths: string[] })[] {
  const groups = new Map<string, CutRow & { paths: string[] }>();
  for (const row of rows) {
    const key = [
      row.material,
      row.width,
      row.height,
      row.thickness,
      row.length,
      row.wallThickness,
      row.cornerRadius,
    ]
      .map((v) => (v == null ? "" : String(v)))
      .join("|");
    const group = groups.get(key);
    if (group) {
      group.quantity += row.quantity;
      group.paths.push(row.path);
    } else groups.set(key, { ...row, paths: [row.path] });
  }
  return [...groups.values()];
}
