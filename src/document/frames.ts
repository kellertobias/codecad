// Where a sketch lies in space. A sketch is drawn in its own x/y
// coordinates; its frame places that drawing in the model: an origin, the
// directions of the sketch's x and y axes, and the normal (x × y) that
// extrudes run along.
import type { Axis, Plane } from "./schema.js";

export type Vec3 = readonly [number, number, number];

export interface Frame {
  readonly origin: Vec3;
  readonly x: Vec3;
  readonly y: Vec3;
  readonly normal: Vec3;
}

export const add = (a: Vec3, b: Vec3): Vec3 => [
  a[0] + b[0],
  a[1] + b[1],
  a[2] + b[2],
];
export const sub = (a: Vec3, b: Vec3): Vec3 => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];
export const scale = (a: Vec3, s: number): Vec3 => [
  a[0] * s,
  a[1] * s,
  a[2] * s,
];
export const dot = (a: Vec3, b: Vec3) =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const normalize = (a: Vec3): Vec3 => scale(a, 1 / (length(a) || 1));

const planes: Record<Plane, Frame> = {
  XY: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], normal: [0, 0, 1] },
  // Seen from the front (-Y): x to the right, z up.
  XZ: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 0, 1], normal: [0, -1, 0] },
  // Seen from the right (+X): y to the right, z up.
  YZ: { origin: [0, 0, 0], x: [0, 1, 0], y: [0, 0, 1], normal: [1, 0, 0] },
};

export const planeFrame = (plane: Plane): Frame => planes[plane];

export const axisVector = (axis: Axis): Vec3 =>
  axis === "X" ? [1, 0, 0] : axis === "Y" ? [0, 1, 0] : [0, 0, 1];

/** The frame of a sketch on a planar face with outward `normal` through
 * `point`. Its axes do not depend on the face's outline, so a sketch stays
 * put when the face grows: y points as nearly up (+Z) as the plane allows,
 * and on horizontal faces x follows +X. The origin is the world origin
 * dropped onto the plane, so on the top of a box the sketch coordinates are
 * the world's x and y. */
export function faceFrame(normal: Vec3, point: Vec3): Frame {
  const n = normalize(normal);
  const origin = scale(n, dot(point, n));
  if (Math.abs(n[2]) < 0.999) {
    const y = normalize(sub([0, 0, 1], scale(n, n[2])));
    return { origin, x: cross(y, n), y, normal: n };
  }
  const x = normalize(sub([1, 0, 0], scale(n, n[0])));
  return { origin, x, y: cross(n, x), normal: n };
}

/** A sketch point in the model. */
export const toWorld = (frame: Frame, x: number, y: number, z = 0): Vec3 =>
  add(
    frame.origin,
    add(scale(frame.x, x), add(scale(frame.y, y), scale(frame.normal, z))),
  );

/** A model point in sketch coordinates; the third value is its height
 * above the sketch plane. */
export function toLocal(frame: Frame, p: Vec3): Vec3 {
  const d = sub(p, frame.origin);
  return [dot(d, frame.x), dot(d, frame.y), dot(d, frame.normal)];
}

/** The frame moved `distance` along its normal. */
export const offsetFrame = (frame: Frame, distance: number): Frame => ({
  ...frame,
  origin: add(frame.origin, scale(frame.normal, distance)),
});

/** Column-major 4×4 matrix (three.js `Matrix4.fromArray` order) taking
 * sketch coordinates to the model. */
export const frameMatrix = (frame: Frame): number[] => [
  ...frame.x,
  0,
  ...frame.y,
  0,
  ...frame.normal,
  0,
  ...frame.origin,
  1,
];
