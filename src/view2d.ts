import type { Point2 } from "./model.js";

export type View2DStyle = { label?: string; color?: string };
export type View2DPrimitive =
  | {
      kind: "path";
      points: Point2[];
      closed: boolean;
      label?: string;
      color: string;
    }
  | {
      kind: "circle";
      center: Point2;
      radius: number;
      label?: string;
      color: string;
    };

function point(value: Point2): Point2 {
  if (!Number.isFinite(value.x) || !Number.isFinite(value.y))
    throw new Error("2D coordinates must be finite");
  return { x: value.x, y: value.y };
}
function style(options: View2DStyle): { label?: string; color: string } {
  const color = options.color ?? "#69d2ba";
  if (!/^#[0-9a-fA-F]{6}$/.test(color))
    throw new Error("2D color must be a six-digit hex color");
  return { ...(options.label ? { label: options.label } : {}), color };
}

/** Interactive Studio geometry in millimetres, independent of export drawings. */
export class View2D {
  private readonly entries: View2DPrimitive[] = [];

  get primitives(): readonly View2DPrimitive[] {
    return this.entries;
  }

  path(
    points: readonly Point2[],
    options: View2DStyle & { closed?: boolean } = {},
  ): this {
    if (points.length < 2)
      throw new Error("A 2D path needs at least two points");
    const closed = options.closed ?? false;
    if (closed && points.length < 3)
      throw new Error("A closed 2D outline needs at least three points");
    this.entries.push({
      kind: "path",
      points: points.map(point),
      closed,
      ...style(options),
    });
    return this;
  }

  line(from: Point2, to: Point2, options: View2DStyle = {}): this {
    return this.path([from, to], options);
  }

  circle(center: Point2, radius: number, options: View2DStyle = {}): this {
    if (!Number.isFinite(radius) || radius <= 0)
      throw new Error("A 2D circle needs a positive finite radius");
    this.entries.push({
      kind: "circle",
      center: point(center),
      radius,
      ...style(options),
    });
    return this;
  }
}
