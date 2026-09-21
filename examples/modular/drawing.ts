import { TechnicalDrawing, cad } from "../../src/index.js";
import { ModularOutputs } from "./project.js";

/** Drawing sheets only. `() => ModularOutputs` defers reading the class until
 * the build matches providers, so this module and the project may import each
 * other. */
@cad.outputsFor(() => ModularOutputs)
export class ModularDrawings {
  constructor(private readonly project: ModularOutputs) {}
  @cad.output.technicalDrawing()
  drawing(): TechnicalDrawing {
    return new TechnicalDrawing({ title: "Modular outputs" }).standardViews(
      this.project,
    );
  }
}
