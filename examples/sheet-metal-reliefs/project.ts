import {
  Project,
  SheetMaterial,
  Shapes,
  Bend,
  TechnicalDrawing,
  ManufacturingDxf,
  StepModel,
  cad,
} from "../../src/index.js";

/** Open this example to compare actual relief cuts and a folded-first Z profile. */
@cad.project({
  id: "sheet-metal-reliefs",
  units: "mm",
  title: "Reliefs and profile development",
})
export class SheetMetalReliefs extends Project {
  readonly round;
  readonly rectangular;
  readonly profile;
  constructor() {
    super({ id: "sheet-metal-reliefs" });
    const steel = new SheetMaterial({
      name: "Steel 1.5 mm",
      thickness: 1.5,
      color: "#8aaab8",
    });
    const bendRules = {
      kFactor: 0.42,
      minimumInsideRadius: 2,
      defaultRelief: "round" as const,
    };
    const tab = (relief: "round" | "rectangular", x: number) => {
      const part = steel.makeSheetMetalPart({
        id: relief,
        outline: new Shapes.Rectangle({ width: 100, height: 80 }),
        bendRules,
      });
      part.bend(
        new Bend({
          id: "partial-flange",
          start: { x: 20, y: 35 },
          end: { x: 80, y: 35 },
          movingSide: "left",
          direction: "up",
          angle: 90,
          insideRadius: 2,
          autoRelief: true,
          relief,
          reliefWidth: 2,
          reliefDepth: 4,
        }),
      );
      part.subtract(
        new Shapes.Cylinder({ diameter: 5, length: 4, x: 50, y: 60, z: 1 }),
      );
      return part.place({ x });
    };
    this.round = tab("round", 0);
    this.rectangular = tab("rectangular", 125);
    this.profile = steel
      .makeBentProfile({
        id: "z-profile",
        width: 60,
        lengths: [30, 80, 25],
        bendRules,
        bends: [
          { id: "first", direction: "up", angle: 90, insideRadius: 2 },
          { id: "second", direction: "down", angle: 60, insideRadius: 2 },
        ],
      })
      .place({ x: 260 });
    // An unregistered independent development snapshot, including cuts and bend marks.
    const development = this.round.unfold();
    console.assert(development.bends[0]!.allowance > 0);
  }
  @cad.output.technicalDrawing({ fileName: "relief-comparison.pdf" })
  drawing() {
    return new TechnicalDrawing({
      title: "Sheet metal - reliefs and Z profile",
      project: "CodeCAD examples",
      drawingNumber: "SM-002",
      material: "Steel 1.5 mm",
      paper: "A3",
    })
      .view({
        id: "formed",
        of: this,
        kind: "isometric",
        at: { x: 25, y: 35 },
        scale: 0.7,
      })
      .note({
        at: { x: 25, y: 220 },
        text: "Partial flanges: 2 mm wide x 4 mm root relief, R2 bends. Confirm material/tooling values.",
      })
      .page(
        new TechnicalDrawing({
          title: "Relief comparison - developed blanks",
          project: "CodeCAD examples",
          drawingNumber: "SM-002",
          material: "Steel 1.5 mm",
          paper: "A3",
        })
          .view({
            id: "round",
            of: this.round,
            kind: "flat",
            at: { x: 25, y: 40 },
            scale: 1,
          })
          .view({
            id: "rectangular",
            of: this.rectangular,
            kind: "flat",
            at: { x: 175, y: 40 },
            scale: 1,
          })
          .view({
            id: "profile",
            of: this.profile,
            kind: "flat",
            at: { x: 325, y: 40 },
            scale: 1,
          }),
      );
  }
  @cad.output.manufacturingDxf({ fileName: "reliefs-cnc.zip" })
  dxf() {
    return new ManufacturingDxf({ parts: "all", layout: "one-file-per-part" });
  }
  @cad.output.step({ fileName: "reliefs.step" })
  step() {
    return new StepModel({ of: this });
  }
}
