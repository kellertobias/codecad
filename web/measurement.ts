import { Vector3 } from "three";

export type PointPick =
  | { kind: "point"; point: Vector3 }
  | { kind: "hole"; point: Vector3; diameter: number };
export type EdgePick = { kind: "edge"; a: Vector3; b: Vector3 };
export type FacePick = { kind: "face"; point: Vector3; normal: Vector3 };
export type MeasurePick = PointPick | EdgePick | FacePick;
export type MeasureResult = {
  description: string;
  distance: number;
  angle?: number;
  intersection?: Vector3;
  guides: readonly [Vector3, Vector3][];
  labelAt: Vector3;
};
const epsilon = 1e-7;
const pointLike = (pick: MeasurePick): pick is PointPick =>
  pick.kind === "point" || pick.kind === "hole";
const mm = (value: number) => `${value.toFixed(2)} mm`;
const deg = (value: number) => `${value.toFixed(1)}°`;
const midpoint = (a: Vector3, b: Vector3) =>
  a.clone().add(b).multiplyScalar(0.5);
const acute = (a: Vector3, b: Vector3) =>
  (Math.acos(
    Math.min(
      1,
      Math.max(0, Math.abs(a.clone().normalize().dot(b.clone().normalize()))),
    ),
  ) *
    180) /
  Math.PI;
function segmentPoint(edge: EdgePick, point: Vector3): Vector3 {
  const direction = edge.b.clone().sub(edge.a);
  const lengthSquared = direction.lengthSq();
  if (lengthSquared <= epsilon)
    throw new Error("A measurable edge needs length");
  const t = Math.max(
    0,
    Math.min(1, point.clone().sub(edge.a).dot(direction) / lengthSquared),
  );
  return edge.a.clone().addScaledVector(direction, t);
}
function segmentPair(first: EdgePick, second: EdgePick): [Vector3, Vector3] {
  const u = first.b.clone().sub(first.a),
    v = second.b.clone().sub(second.a),
    w = first.a.clone().sub(second.a);
  const a = u.dot(u),
    b = u.dot(v),
    c = v.dot(v),
    d = u.dot(w),
    e = v.dot(w);
  if (a <= epsilon || c <= epsilon)
    throw new Error("A measurable edge needs length");
  const denominator = a * c - b * b;
  let sN = denominator,
    tN = denominator,
    sD = denominator,
    tD = denominator;
  if (denominator < epsilon) {
    sN = 0;
    sD = 1;
    tN = e;
    tD = c;
  } else {
    sN = b * e - c * d;
    tN = a * e - b * d;
    if (sN < 0) {
      sN = 0;
      tN = e;
      tD = c;
    } else if (sN > sD) {
      sN = sD;
      tN = e + b;
      tD = c;
    }
  }
  if (tN < 0) {
    tN = 0;
    if (-d < 0) sN = 0;
    else if (-d > a) sN = sD;
    else {
      sN = -d;
      sD = a;
    }
  } else if (tN > tD) {
    tN = tD;
    if (-d + b < 0) sN = 0;
    else if (-d + b > a) sN = sD;
    else {
      sN = -d + b;
      sD = a;
    }
  }
  const s = Math.abs(sN) < epsilon ? 0 : sN / sD;
  const t = Math.abs(tN) < epsilon ? 0 : tN / tD;
  return [
    first.a.clone().addScaledVector(u, s),
    second.a.clone().addScaledVector(v, t),
  ];
}
function result(
  description: string,
  a: Vector3,
  b: Vector3,
  angle?: number,
  intersection?: Vector3,
): MeasureResult {
  return {
    description,
    distance: a.distanceTo(b),
    ...(angle === undefined ? {} : { angle }),
    ...(intersection ? { intersection } : {}),
    guides: [[a, b]],
    labelAt: midpoint(a, b),
  };
}
export function measure(
  first: MeasurePick,
  second: MeasurePick,
): MeasureResult {
  if (pointLike(first) && pointLike(second)) {
    const distance = first.point.distanceTo(second.point);
    const holes = first.kind === "hole" || second.kind === "hole";
    return result(
      `${holes ? "Centre distance" : "Point distance"} ${mm(distance)}`,
      first.point,
      second.point,
    );
  }
  if (pointLike(second)) return measure(second, first);
  if (pointLike(first) && second.kind === "edge") {
    const foot = segmentPoint(second, first.point);
    return result(
      `Point-to-edge ${mm(first.point.distanceTo(foot))}`,
      first.point,
      foot,
    );
  }
  if (pointLike(first) && second.kind === "face") {
    const normal = second.normal.clone().normalize();
    if (normal.lengthSq() <= epsilon)
      throw new Error("A measurable face needs a normal");
    const signed = first.point.clone().sub(second.point).dot(normal);
    const foot = first.point.clone().addScaledVector(normal, -signed);
    return result(`Point-to-face ${mm(Math.abs(signed))}`, first.point, foot);
  }
  if (first.kind === "edge" && second.kind === "edge") {
    const [a, b] = segmentPair(first, second);
    const angle = acute(
      first.b.clone().sub(first.a),
      second.b.clone().sub(second.a),
    );
    const distance = a.distanceTo(b);
    return result(
      distance < epsilon
        ? `Edges intersect · ${deg(angle)}`
        : `Edge gap ${mm(distance)} · ${deg(angle)}`,
      a,
      b,
      angle,
      distance < epsilon ? a : undefined,
    );
  }
  if (first.kind === "face" && second.kind === "edge")
    return measure(second, first);
  if (first.kind === "edge" && second.kind === "face") {
    const normal = second.normal.clone().normalize();
    if (normal.lengthSq() <= epsilon)
      throw new Error("A measurable face needs a normal");
    const direction = first.b.clone().sub(first.a);
    if (direction.lengthSq() <= epsilon)
      throw new Error("A measurable edge needs length");
    const denominator = normal.dot(direction);
    const angle = 90 - acute(direction, normal);
    if (Math.abs(denominator) > epsilon) {
      const t = normal.dot(second.point.clone().sub(first.a)) / denominator;
      if (t >= 0 && t <= 1) {
        const crossing = first.a.clone().addScaledVector(direction, t);
        return result(
          `Edge intersects face plane · ${deg(angle)}`,
          crossing,
          crossing,
          angle,
          crossing,
        );
      }
    }
    const nearer =
      Math.abs(normal.dot(first.a.clone().sub(second.point))) <
      Math.abs(normal.dot(first.b.clone().sub(second.point)))
        ? first.a
        : first.b;
    const foot = nearer
      .clone()
      .addScaledVector(normal, -normal.dot(nearer.clone().sub(second.point)));
    return result(
      `Edge-to-face ${mm(nearer.distanceTo(foot))} · ${deg(angle)}`,
      nearer,
      foot,
      angle,
    );
  }
  if (first.kind === "face" && second.kind === "face") {
    const n1 = first.normal.clone().normalize(),
      n2 = second.normal.clone().normalize();
    if (n1.lengthSq() <= epsilon || n2.lengthSq() <= epsilon)
      throw new Error("A measurable face needs a normal");
    const angle = acute(n1, n2);
    const direction = n1.clone().cross(n2);
    if (direction.lengthSq() > epsilon) {
      const c1 = n1.dot(first.point),
        c2 = n2.dot(second.point);
      const crossing = n2
        .clone()
        .cross(direction)
        .multiplyScalar(c1)
        .add(direction.clone().cross(n1).multiplyScalar(c2))
        .divideScalar(direction.lengthSq());
      return result(
        `Face planes intersect · ${deg(angle)}`,
        crossing,
        crossing,
        angle,
        crossing,
      );
    }
    const separation = Math.abs(n1.dot(second.point.clone().sub(first.point)));
    const foot = second.point
      .clone()
      .addScaledVector(n1, -n1.dot(second.point.clone().sub(first.point)));
    return result(`Parallel faces ${mm(separation)}`, second.point, foot, 0);
  }
  throw new Error("Unsupported measurement picks");
}
