import {
  Project,
  StepModel,
  TechnicalDrawing,
  ManufacturingDxf,
  CutList,
  cad,
} from "../src/index.js";
import { FoldedMountingBracket } from "./sheet-metal-bracket.js";

@cad.project({
  id: "sheet-metal-demo",
  title: "Folded mounting bracket",
  units: "mm",
})
export class SheetMetalDemo extends Project {
  constructor() {
    super({ id: "sheet-metal-demo", label: "Folded mounting bracket" });
    new FoldedMountingBracket();
  }
  @cad.output.technicalDrawing({ fileName: "bracket.pdf" })
  drawing() {
    return new TechnicalDrawing({
      title: "1.5 mm galvanized steel · folded bracket",
      paper: "A4",
      orientation: "landscape",
    })
      .view({
        id: "iso",
        of: this,
        kind: "isometric",
        at: { x: 30, y: 30 },
        scale: 1,
      })
      .view({
        id: "front",
        of: this,
        kind: "front",
        at: { x: 30, y: 145 },
        scale: 1,
      });
  }
  @cad.output.cutList()
  cutList() {
    return new CutList({ includeLayouts: true });
  }
  @cad.output.manufacturingDxf()
  dxf() {
    return new ManufacturingDxf({ parts: "all", layout: "one-file-per-part" });
  }
  @cad.output.step()
  step() {
    return new StepModel({ of: this });
  }
}
