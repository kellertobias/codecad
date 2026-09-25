// Where constraints are drawn: a small glyph beside each entity a geometric
// constraint joins, and a label with a leader for each dimension.
import type {
  SketchConstraint,
  SketchFeature,
} from "../../../src/document/schema.ts";
import {
  evaluateWith,
  type VariableValues,
} from "../../../src/document/variables.ts";
import {
  pointsOf,
  projectOnSegment,
  toScreen,
  type Vec,
  type View,
} from "./geometry.ts";

export const glyphs: Partial<Record<SketchConstraint["type"], string>> = {
  horizontal: "H",
  vertical: "V",
  parallel: "∥",
  perpendicular: "⊥",
  equal: "=",
  tangent: "T",
  coincident: "●",
  onEntity: "∈",
  midpoint: "M",
  symmetric: "⇆",
  fix: "⚓",
};

export interface Glyph {
  readonly constraint: string;
  readonly symbol: string;
  /** Screen position. */
  readonly at: Vec;
}

export interface Dimension {
  readonly constraint: string;
  readonly label: string;
  /** Screen position of the label, and the leader's two ends. */
  readonly at: Vec;
  readonly from: Vec;
  readonly to: Vec;
}

const dimensionTypes = new Set(["distance", "angle", "radius", "diameter"]);
export const isDimension = (c: SketchConstraint) => dimensionTypes.has(c.type);

/** Screen anchor beside an entity, stacked by how many glyphs it has. */
function anchor(
  sketch: SketchFeature,
  view: View,
  id: string,
  slot: number,
): Vec | undefined {
  const points = pointsOf(sketch);
  const entity = sketch.entities.find((e) => e.id === id);
  if (!entity) return undefined;
  const step = 15 * slot;
  if (entity.type === "point") {
    const p = toScreen(view, entity);
    return { x: p.x + 10 + step, y: p.y - 10 };
  }
  if (entity.type === "line") {
    const a = toScreen(view, points.get(entity.start)!);
    const b = toScreen(view, points.get(entity.end)!);
    const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    // Beside the middle of the line, on its left, along the line per slot.
    const ux = (b.x - a.x) / length;
    const uy = (b.y - a.y) / length;
    return {
      x: (a.x + b.x) / 2 + uy * 11 + ux * (step - 7),
      y: (a.y + b.y) / 2 - ux * 11 + uy * (step - 7),
    };
  }
  const c = points.get(entity.center)!;
  const r =
    entity.type === "circle"
      ? entity.radius
      : Math.hypot(
          points.get(entity.start)!.x - c.x,
          points.get(entity.start)!.y - c.y,
        );
  const top = toScreen(view, { x: c.x, y: c.y + r });
  return { x: top.x + step, y: top.y - 10 };
}

export function layoutGlyphs(sketch: SketchFeature, view: View): Glyph[] {
  const used = new Map<string, number>();
  const glyphsOut: Glyph[] = [];
  for (const constraint of sketch.constraints) {
    const symbol = glyphs[constraint.type];
    if (!symbol) continue;
    const targets =
      constraint.type === "horizontal" || constraint.type === "vertical"
        ? [constraint.line]
        : constraint.type === "fix"
          ? [constraint.point]
          : constraint.type === "onEntity"
            ? [constraint.point]
            : constraint.type === "midpoint"
              ? [constraint.point]
              : constraint.type === "symmetric"
                ? [constraint.a, constraint.b]
                : "a" in constraint
                  ? [constraint.a, constraint.b]
                  : [];
    for (const target of targets) {
      const slot = used.get(target) ?? 0;
      used.set(target, slot + 1);
      const at = anchor(sketch, view, target, slot);
      if (at) glyphsOut.push({ constraint: constraint.id, symbol, at });
    }
  }
  return glyphsOut;
}

/** The label a dimension shows: its value, and the expression when it is
 * more than a plain number. */
export function dimensionLabel(
  constraint: SketchConstraint,
  variables: VariableValues,
): string {
  if (!("value" in constraint)) return "";
  const prefix =
    constraint.type === "diameter"
      ? "⌀"
      : constraint.type === "radius"
        ? "R"
        : "";
  const suffix = constraint.type === "angle" ? "°" : "";
  let value: number | undefined;
  try {
    value = evaluateWith(constraint.value, variables);
  } catch {
    value = undefined;
  }
  const shown =
    value === undefined ? "?" : String(Math.round(value * 100) / 100);
  const plain = /^\s*-?\d+(\.\d+)?\s*$/.test(constraint.value);
  return plain
    ? `${prefix}${shown}${suffix}`
    : `${prefix}${constraint.value} = ${shown}${suffix}`;
}

export function layoutDimensions(
  sketch: SketchFeature,
  view: View,
  variables: VariableValues,
): Dimension[] {
  const points = pointsOf(sketch);
  const entity = (id: string) => sketch.entities.find((e) => e.id === id);
  const out: Dimension[] = [];
  for (const constraint of sketch.constraints) {
    if (!isDimension(constraint)) continue;
    const label = dimensionLabel(constraint, variables);
    let from: Vec | undefined;
    let to: Vec | undefined;
    if (constraint.type === "distance") {
      const a = entity(constraint.a);
      const b = entity(constraint.b);
      const pa =
        a?.type === "point"
          ? a
          : a?.type === "line"
            ? points.get(a.start)
            : undefined;
      if (b?.type === "point" && pa) {
        from = pa;
        to =
          constraint.direction === "horizontal"
            ? { x: b.x, y: pa.y }
            : constraint.direction === "vertical"
              ? { x: pa.x, y: b.y }
              : b;
      } else if (b?.type === "line" && pa)
        [from, to] = [
          pa,
          projectOnSegment(pa, points.get(b.start)!, points.get(b.end)!),
        ];
      else if (a?.type === "line" && b?.type === "point")
        [from, to] = [
          b,
          projectOnSegment(b, points.get(a.start)!, points.get(a.end)!),
        ];
    } else if (constraint.type === "angle") {
      const a = entity(constraint.a);
      const b = entity(constraint.b);
      if (a?.type === "line" && b?.type === "line") {
        from = points.get(a.end)!;
        to = points.get(b.start)!;
      }
    } else if (constraint.type === "radius" || constraint.type === "diameter") {
      const target = entity(constraint.entity);
      if (target?.type === "circle" || target?.type === "arc") {
        const c = points.get(target.center)!;
        const r =
          target.type === "circle"
            ? target.radius
            : Math.hypot(
                points.get(target.start)!.x - c.x,
                points.get(target.start)!.y - c.y,
              );
        from =
          constraint.type === "diameter"
            ? { x: c.x - r * Math.SQRT1_2, y: c.y - r * Math.SQRT1_2 }
            : c;
        to = { x: c.x + r * Math.SQRT1_2, y: c.y + r * Math.SQRT1_2 };
      }
    }
    if (!from || !to) continue;
    const sf = toScreen(view, from);
    const st = toScreen(view, to);
    // Beside the middle of the leader, pushed off it so it does not sit on
    // the geometry it measures: to its right, where glyphs (which sit on
    // the left of lines) are not.
    const length = Math.hypot(st.x - sf.x, st.y - sf.y) || 1;
    const offset =
      constraint.type === "radius" || constraint.type === "diameter" ? 0 : -16;
    out.push({
      constraint: constraint.id,
      label,
      from: sf,
      to: st,
      at: {
        x: (sf.x + st.x) / 2 + ((st.y - sf.y) / length) * offset,
        y: (sf.y + st.y) / 2 - ((st.x - sf.x) / length) * offset,
      },
    });
  }
  return out;
}
