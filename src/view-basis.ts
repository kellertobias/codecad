/** Drawing-view axes shared by the PDF/DXF renderer and the Studio plan editor.
 * World Z is up and the front of a model faces -Y. A view is named after the
 * side the observer stands on: `right` looks from +X toward the model. */
export type ViewAngle =
  "front" | "back" | "left" | "right" | "top" | "bottom" | "isometric";
export type Triple = readonly [number, number, number];
export interface ViewBasis {
  /** Paper-right in world coordinates. */
  readonly x: Triple;
  /** Paper-up in world coordinates. */
  readonly y: Triple;
  /** From the model toward the observer (x × y). */
  readonly toward: Triple;
}
const s2 = Math.SQRT1_2,
  s3 = 1 / Math.sqrt(3),
  s6 = 1 / Math.sqrt(6);
const bases: Record<ViewAngle, ViewBasis> = {
  front: { x: [1, 0, 0], y: [0, 0, 1], toward: [0, -1, 0] },
  back: { x: [-1, 0, 0], y: [0, 0, 1], toward: [0, 1, 0] },
  left: { x: [0, -1, 0], y: [0, 0, 1], toward: [-1, 0, 0] },
  right: { x: [0, 1, 0], y: [0, 0, 1], toward: [1, 0, 0] },
  top: { x: [1, 0, 0], y: [0, 1, 0], toward: [0, 0, 1] },
  bottom: { x: [1, 0, 0], y: [0, -1, 0], toward: [0, 0, -1] },
  // Observer at +X, -Y, +Z: the same corner as Studio's default 3D camera.
  isometric: {
    x: [s2, s2, 0],
    y: [-s6, s6, 2 * s6],
    toward: [s3, -s3, s3],
  },
};
export const viewAngles = Object.keys(bases) as ViewAngle[];
/**
 * The same view turned in the paper plane. Positive degrees turn the drawing
 * counter-clockwise on the page, which is what turning the axes the other way
 * does to every projected point.
 */
export function rotatedBasis(basis: ViewBasis, degrees: number): ViewBasis {
  if (!degrees) return basis;
  if (!Number.isFinite(degrees))
    throw new Error("View rotation must be finite degrees");
  const radians = (degrees * Math.PI) / 180,
    cos = Math.cos(radians),
    sin = Math.sin(radians);
  const mix = (a: number, b: number): Triple => [
    basis.x[0] * a + basis.y[0] * b,
    basis.x[1] * a + basis.y[1] * b,
    basis.x[2] * a + basis.y[2] * b,
  ];
  return { x: mix(cos, -sin), y: mix(sin, cos), toward: basis.toward };
}
/** Rotate a point already in paper coordinates (x right, y up) to match. */
export function rotatePaper<T extends { x: number; y: number }>(
  point: T,
  degrees: number,
): { x: number; y: number } {
  if (!degrees) return { x: point.x, y: point.y };
  const radians = (degrees * Math.PI) / 180,
    cos = Math.cos(radians),
    sin = Math.sin(radians);
  return {
    x: point.x * cos - point.y * sin,
    y: point.x * sin + point.y * cos,
  };
}
export function viewBasis(angle: ViewAngle, rotate = 0): ViewBasis {
  const basis = bases[angle];
  if (!basis) throw new Error(`Unknown view angle: ${String(angle)}`);
  return rotatedBasis(basis, rotate);
}
/** Conventional drawing scales, largest first. */
export const standardScales = [
  10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.04, 0.02, 0.01, 0.005, 0.002, 0.001,
] as const;
