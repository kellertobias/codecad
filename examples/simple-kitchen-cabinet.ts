import {
  Arrangement,
  CutList,
  Drill,
  ManufacturingDxf,
  MotionStudy,
  Project,
  SheetMaterial,
  SheetPart,
  Shapes,
  StepModel,
  TechnicalDrawing,
  cad,
} from "../src/index.js";
import { MyCustomHinge } from "./my-custom-hinge.js";

@cad.project({
  id: "simple-kitchen-cabinet",
  title: "Simple kitchen cabinet",
  units: "mm",
})
export class SimpleKitchenCabinet extends Project {
  private readonly tools = {
    d8: new Drill({ size: 8, tip: "brad-point" }),
  };

  private readonly mdf18 = new SheetMaterial({
    id: "mdf-18",
    name: "18 mm MDF",
    width: 1250,
    height: 2550,
    thickness: 18,
    kerf: 3.2,
    partSpacing: 8,
    sheetMargin: 10,
  });

  public constructor() {
    super({ id: "cabinet" });

    const sidePanelLeft = this.mdf18.makePart({
      id: "side-panel-left",
      width: 600,
      height: 900,
    });

    // Component placement may be global...
    sidePanelLeft.place({ relativeTo: "world", x: 100, y: 100, z: 0 });

    Arrangement.linear({
      start: { x: 50, y: 100 },
      end: { x: 50, y: 600 },
      steps: 10,
    }).execute((position) => {
      // ...while operations use the panel's own coordinates by default.
      // [18, -6] enters at local z=18 and drills 6 mm toward negative z.
      this.tools.d8.drill(sidePanelLeft, { ...position, z: [18, -6] });
    });

    // copy() is a detached snapshot. Later changes to the left panel do not
    // mutate this right panel. It remains associated with the same stock type.
    sidePanelLeft
      .copy({ id: "side-panel-right" })
      .mirror({ axis: "z" })
      .place({ relativeTo: sidePanelLeft, x: 600 });

    const hinge = new MyCustomHinge().place({
      relativeTo: sidePanelLeft,
      x: 50,
      y: 720,
      z: 18,
    });

    // Consume geometry and mounting metadata exposed by reusable hardware.
    sidePanelLeft.subtract(hinge.stationaryMount().withClearance(0.5), {
      x: 50,
      y: 720,
      z: 18,
    });

    // The lower-level boolean form is available when a named tool is not useful.
    sidePanelLeft.subtract(
      new Shapes.Cylinder({
        diameter: 8,
        length: 6,
        x: 100,
        y: 80,
        z: 15, // centered halfway through a 6 mm cut entering at z=18
        axis: "z",
      }),
    );
  }

  @cad.output.technicalDrawing({ fileName: "cabinet-plan.pdf" })
  public technicalDrawing(): TechnicalDrawing {
    return new TechnicalDrawing({
      title: "Simple kitchen cabinet",
      paper: "A3",
    })
      .view({
        id: "front",
        of: this,
        kind: "top",
        at: { x: 20, y: 20 },
        scale: 0.1,
      })
      .view({
        id: "exploded",
        of: this,
        kind: "exploded",
        at: { x: 220, y: 20 },
        scale: 0.1,
        explode: 80,
      })
      .dimension({
        from: { x: 0, y: 0, z: 0 },
        to: { x: 0, y: 900, z: 0 },
        offset: 30,
        label: "900 mm",
      });
  }

  @cad.output.cutList({ fileName: "cabinet-cut-list.csv" })
  public cutList(): CutList {
    return new CutList({
      materials: [this.mdf18],
      nesting: "automatic",
      includeLayouts: true,
    });
  }

  @cad.output.manufacturingDxf({ fileName: "cabinet-parts.zip" })
  public manufacturingDxf(): ManufacturingDxf {
    return new ManufacturingDxf({ parts: "all", layout: "one-file-per-part" });
  }

  @cad.output.step({ fileName: "cabinet.step" })
  public stepModel(): StepModel {
    return new StepModel({ of: this });
  }

  @cad.output.motion({ fileName: "hinge-clearance.glb" })
  public hingeMotion(): MotionStudy {
    const hinge = this.registry.require("hinge", MyCustomHinge);
    const sidePanelLeft = this.parts.require("side-panel-left", SheetPart);

    return new MotionStudy({ of: this, framesPerSecond: 30 })
      .animate({ joint: hinge.joint, from: 0, to: 110, durationSeconds: 2 })
      .checkClearance({
        between: [hinge.movingSide, sidePanelLeft],
        minimum: 2,
        samples: 60,
      });
  }
}
