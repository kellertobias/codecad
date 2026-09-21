import { Assembly, HardwarePart, Shapes, cad } from "../../src/index.js";

/** Three kinematic envelopes, not a manufacturer-qualified hardware model. */
@cad.part({ id: "three-stage-slide", revision: "1" })
export class DrawerSlide extends Assembly {
  readonly fixed: HardwarePart;
  readonly middle: HardwarePart;
  readonly inner: HardwarePart;
  constructor(id: string) {
    super({ id, label: "Three-stage drawer slide (provisional)" });
    this.fixed = new HardwarePart({
      id: "fixed",
      shape: new Shapes.Box({ width: 3, depth: 440, height: 30 }),
      measurementStatus: "provisional",
    });
    this.middle = new HardwarePart({
      id: "middle",
      shape: new Shapes.Box({ width: 3, depth: 440, height: 22 }),
      measurementStatus: "provisional",
    }).place({ x: 4, z: 4 });
    this.inner = new HardwarePart({
      id: "inner",
      shape: new Shapes.Box({ width: 3, depth: 440, height: 14 }),
      measurementStatus: "provisional",
    }).place({ x: 8, z: 8 });
  }
}
