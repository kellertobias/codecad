import { MotionStudy, cad } from "../src/index.js";
import { ModularOutputs } from "./modular-project.js";

/** Two studies of the same tray. Each output method writes its own GLB, named
 * after the method, so a project can hold several studies — here in one module,
 * but a module each works the same way. */
@cad.outputsFor(() => ModularOutputs)
export class ModularMotion {
  constructor(private readonly project: ModularOutputs) {}
  @cad.output.motion({ title: "Tray · full travel" })
  trayOpens(): MotionStudy {
    return new MotionStudy({ of: this.project }).animate({
      joint: this.project.slide(),
      from: 0,
      to: this.project.travel,
      durationSeconds: 2,
    });
  }
  @cad.output.motion({ title: "Tray · service gap" })
  trayCracksOpen(): MotionStudy {
    return new MotionStudy({ of: this.project }).animate({
      joint: this.project.slide(),
      from: 0,
      to: 40,
      durationSeconds: 1,
    });
  }
}
