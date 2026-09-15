import { Matrix4, Vector3 as V3 } from "three";
import {
  Component,
  PartInterface,
  positive,
  type Axis,
  type Vector3,
} from "./model.js";
export interface JointLimits {
  readonly min: number;
  readonly max: number;
}
export interface JointOptions {
  readonly id: string;
  readonly fixed: Component | PartInterface;
  readonly moving: Component | PartInterface;
  readonly axis: Axis | Vector3;
  readonly limits: JointLimits;
}
export abstract class Joint {
  readonly id: string;
  readonly fixed: Component | PartInterface;
  readonly moving: Component | PartInterface;
  constructor(readonly options: JointOptions) {
    this.id = options.id;
    this.fixed = options.fixed;
    this.moving = options.moving;
    if (options.limits.min > options.limits.max)
      throw new Error("Joint limits are reversed");
    if (
      !Number.isFinite(options.limits.min) ||
      !Number.isFinite(options.limits.max) ||
      !this.axis().length()
    )
      throw new Error(
        "Joint limits and axis must be finite and the axis nonzero",
      );
  }
  axis(): V3 {
    const a = this.options.axis;
    return typeof a === "string"
      ? new V3(a === "x" ? 1 : 0, a === "y" ? 1 : 0, a === "z" ? 1 : 0)
      : new V3(a.x, a.y, a.z).normalize();
  }
  abstract local(value: number): Matrix4;
  delta(value: number): Matrix4 {
    if (!Number.isFinite(value)) throw new Error("Joint value must be finite");
    if (value < this.options.limits.min || value > this.options.limits.max)
      throw new Error(`Joint ${this.id} exceeds its limits`);
    const f = this.fixed.worldMatrix();
    return f.clone().multiply(this.local(value)).multiply(f.invert());
  }
}
export class RevoluteJoint extends Joint {
  local(value: number): Matrix4 {
    return new Matrix4().makeRotationAxis(this.axis(), (value * Math.PI) / 180);
  }
}
export class LinearJoint extends Joint {
  local(value: number): Matrix4 {
    const a = this.axis().multiplyScalar(value);
    return new Matrix4().makeTranslation(a.x, a.y, a.z);
  }
}
export interface Animation {
  readonly joint: Joint;
  readonly from: number;
  readonly to: number;
  readonly durationSeconds: number;
  readonly delaySeconds?: number;
  readonly easing?: "linear" | "ease-in-out";
}
export interface ClearanceCheck {
  readonly between: readonly [
    Component | PartInterface,
    Component | PartInterface,
  ];
  readonly minimum: number;
  readonly samples?: number;
}
export class MotionStudy {
  readonly animations: Animation[] = [];
  readonly clearances: ClearanceCheck[] = [];
  constructor(
    readonly options: {
      readonly of: Component;
      readonly framesPerSecond?: number;
    },
  ) {
    positive(options.framesPerSecond ?? 30, "frames per second");
  }
  animate(o: Animation): this {
    if (!Number.isFinite(o.delaySeconds ?? 0) || (o.delaySeconds ?? 0) < 0)
      throw new Error("Animation delay must be finite and nonnegative");
    positive(o.durationSeconds, "duration");
    o.joint.delta(o.from);
    o.joint.delta(o.to);
    this.animations.push(o);
    return this;
  }
  checkClearance(o: ClearanceCheck): this {
    if (o.minimum < 0) throw new Error("Clearance must be nonnegative");
    if (
      o.samples !== undefined &&
      (!Number.isInteger(o.samples) || o.samples < 2)
    )
      throw new Error("At least two samples required");
    this.clearances.push(o);
    return this;
  }
  pose(component: Component, t: number): Matrix4 {
    let m = component.worldMatrix();
    const owner = (a: Animation) =>
      a.joint.moving instanceof PartInterface
        ? a.joint.moving.owner
        : a.joint.moving;
    const ordered = [...this.animations].sort(
      (a, b) =>
        (owner(b)?.path.split("/").length ?? 0) -
        (owner(a)?.path.split("/").length ?? 0),
    );
    for (const a of ordered) {
      const moving =
        a.joint.moving instanceof PartInterface
          ? a.joint.moving.owner
          : a.joint.moving;
      if (!moving) throw new Error("Joint interface has no owner");
      if (
        component === moving ||
        component.path.startsWith(moving.path + "/")
      ) {
        const u = Math.max(
            0,
            Math.min(
              1,
              (t * this.duration - (a.delaySeconds ?? 0)) / a.durationSeconds,
            ),
          ),
          e = a.easing === "ease-in-out" ? u * u * (3 - 2 * u) : u;
        m = a.joint.delta(a.from + (a.to - a.from) * e).multiply(m);
      }
    }
    return m;
  }
  get duration(): number {
    return this.animations.length
      ? Math.max(
          ...this.animations.map(
            (a) => (a.delaySeconds ?? 0) + a.durationSeconds,
          ),
        )
      : 1;
  }
}
