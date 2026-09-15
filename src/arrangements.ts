import type { Point2 } from "./model.js";
export interface LinearArrangementOptions {
  readonly start: Point2;
  readonly end: Point2;
  readonly steps: number;
}
export class Arrangement<P> {
  constructor(readonly values: readonly P[]) {}
  static linear(o: LinearArrangementOptions): Arrangement<Point2> {
    if (!Number.isInteger(o.steps) || o.steps < 2)
      throw new Error("steps must be an integer of at least two");
    return new Arrangement(
      Array.from({ length: o.steps }, (_, i) => ({
        x: o.start.x + ((o.end.x - o.start.x) * i) / (o.steps - 1),
        y: o.start.y + ((o.end.y - o.start.y) * i) / (o.steps - 1),
      })),
    );
  }
  execute(callback: (position: P, index: number) => void): this {
    this.values.forEach(callback);
    return this;
  }
  map<T>(callback: (position: P, index: number) => T): readonly T[] {
    return this.values.map(callback);
  }
}
