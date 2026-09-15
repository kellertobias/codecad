/** Drawing widths and hatch spacing are paper millimetres, independent of view scale. */
export interface DrawingLineStyle {
  readonly stroke?: `#${string}`;
  readonly lineWidth?: number;
}
export interface MaterialDrawingStyle {
  readonly regular?: DrawingLineStyle;
  readonly cutaway?: DrawingLineStyle & {
    readonly hatch?:
      | false
      | {
          readonly angle?: number;
          readonly spacing?: number;
          readonly stroke?: `#${string}`;
          readonly lineWidth?: number;
          readonly cross?: boolean;
        };
  };
}
export function validateDrawingStyle(style: MaterialDrawingStyle) {
  const validate = (line: DrawingLineStyle | undefined) => {
    if (line?.stroke !== undefined && !/^#[\da-f]{6}$/i.test(line.stroke))
      throw new Error("Drawing stroke must be a six-digit hex colour");
    if (
      line?.lineWidth !== undefined &&
      (!Number.isFinite(line.lineWidth) ||
        line.lineWidth <= 0 ||
        line.lineWidth > 2.11)
    )
      throw new Error(
        "Drawing lineWidth must be positive and at most 2.11 paper mm",
      );
  };
  validate(style.regular);
  validate(style.cutaway);
  const hatch = style.cutaway?.hatch;
  if (hatch) {
    validate(hatch);
    if (
      hatch.spacing !== undefined &&
      (!Number.isFinite(hatch.spacing) || hatch.spacing < 0.2)
    )
      throw new Error("Hatch spacing must be at least 0.2 paper mm");
    if (hatch.angle !== undefined && !Number.isFinite(hatch.angle))
      throw new Error("Hatch angle must be finite");
  }
}

type Point = { x: number; y: number };
/** Clip parallel hatch lines against triangulated faces. Holes remain empty. */
export function hatchTriangles(
  triangles: readonly (readonly Point[])[],
  spacing: number,
  angle: number,
): [Point, Point][] {
  const a = (angle * Math.PI) / 180,
    c = Math.cos(a),
    s = Math.sin(a);
  const rows = new Map<number, [number, number][]>();
  for (const triangle of triangles) {
    const points = triangle.map((p) => ({
      x: p.x * c + p.y * s,
      y: -p.x * s + p.y * c,
    }));
    const low = Math.ceil(Math.min(...points.map((p) => p.y)) / spacing);
    const high = Math.floor(Math.max(...points.map((p) => p.y)) / spacing);
    if (high - low > 100000)
      throw new Error("Hatch exceeds drawing complexity limit");
    for (let row = low; row <= high; row++) {
      const y = row * spacing,
        xs: number[] = [];
      for (let i = 0; i < points.length; i++) {
        const p = points[i]!,
          q = points[(i + 1) % points.length]!;
        if ((p.y <= y && q.y > y) || (q.y <= y && p.y > y))
          xs.push(p.x + ((q.x - p.x) * (y - p.y)) / (q.y - p.y));
      }
      if (xs.length >= 2) {
        const intervals = rows.get(row) ?? [];
        intervals.push([Math.min(...xs), Math.max(...xs)]);
        rows.set(row, intervals);
      }
    }
  }
  const result: [Point, Point][] = [];
  for (const [row, intervals] of rows) {
    intervals.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const interval of intervals) {
      const last = merged.at(-1);
      if (last && interval[0] <= last[1] + 1e-7)
        last[1] = Math.max(last[1], interval[1]);
      else merged.push([...interval]);
    }
    const point = (x: number) => ({
      x: x * c - row * spacing * s,
      y: x * s + row * spacing * c,
    });
    for (const [start, end] of merged)
      if (end - start > 1e-7) result.push([point(start), point(end)]);
  }
  return result;
}
