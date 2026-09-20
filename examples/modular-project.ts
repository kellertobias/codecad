import {
  LinearJoint,
  Project,
  SheetMaterial,
  type SheetPart,
  cad,
} from "../src/index.js";
// Outputs live in their own modules. Importing them here is what registers
// them; each one imports this project back through a lazy reference, so the
// cycle is harmless.
import "./modular-drawing.js";
import "./modular-manufacturing.js";
import "./modular-motion.js";

const ply = new SheetMaterial({
  id: "ply12",
  name: "12 mm plywood",
  thickness: 12,
  width: 1250,
  height: 2500,
  color: "#d8b98a",
});

/** A carcass with one sliding tray, assembled here and nowhere else. The
 * drawing, manufacturing and motion outputs each live in their own file. */
@cad.project({ id: "modular-outputs", units: "mm", title: "Modular outputs" })
export class ModularOutputs extends Project {
  readonly tray: SheetPart;
  readonly travel = 260;
  constructor() {
    super({ id: "modular-outputs", label: "Modular outputs" });
    const panel = (id: string, width: number, height: number) =>
      ply.makePart({ id, width, height });
    panel("floor", 400, 300).orient("XY", { x: 0, y: 0, z: 0 });
    panel("left", 300, 200).orient("YZ", { x: 0, y: 0, z: 12 });
    panel("right", 300, 200).orient("YZ", { x: 388, y: 0, z: 12 });
    this.tray = panel("tray", 364, 280).orient("XY", { x: 12, y: 10, z: 30 });
  }
  /** The joint the motion modules animate. */
  slide(): LinearJoint {
    return new LinearJoint({
      id: "tray-slide",
      fixed: this,
      moving: this.tray,
      axis: { x: 0, y: -1, z: 0 },
      limits: { min: 0, max: this.travel },
    });
  }
}
