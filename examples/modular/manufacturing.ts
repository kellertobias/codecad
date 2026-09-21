import { CutList, ManufacturingDxf, StepModel, cad } from "../../src/index.js";
import { ModularOutputs } from "./project.js";

/** Cut list, CAM DXF and STEP, kept away from the drawing sheets. */
@cad.outputsFor(() => ModularOutputs)
export class ModularManufacturing {
  constructor(private readonly project: ModularOutputs) {}
  @cad.output.cutList({ fileName: "cut-list" })
  cutList(): CutList {
    return new CutList({ includeLayouts: true });
  }
  @cad.output.manufacturingDxf({ fileName: "cnc-parts.zip" })
  dxf(): ManufacturingDxf {
    return new ManufacturingDxf({ parts: "all", layout: "one-file-per-part" });
  }
  @cad.output.step({ fileName: "modular-outputs.step" })
  step(): StepModel {
    return new StepModel({ of: this.project });
  }
}
