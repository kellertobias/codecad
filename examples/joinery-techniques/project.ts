import {
  Project,
  DominoJoint,
  FingerJoint,
  Groove,
  MiterJoint,
  PartInterface,
  SheetMaterial,
  Shapes,
  ManufacturingDxf,
  StepModel,
  TechnicalDrawing,
  cad,
} from "../../src/index.js";

@cad.technique({ id: "cabinet-joinery", revision: "1" })
export class CabinetJoinery {
  readonly backGroove = new Groove({ toolDiameter: 6 });
  readonly dominoes = new DominoJoint({
    width: 20,
    thickness: 6,
    depthPerSide: 10,
  });
  readonly fingers = new FingerJoint({ fingerWidth: 12, clearance: 0.1 });
  readonly miter = new MiterJoint({ angle: 45 });
}
@cad.project({ id: "joinery-demo", units: "mm" })
export class JoineryDemo extends Project {
  constructor() {
    super({ id: "joinery-demo" });
    const material = new SheetMaterial({
      name: "18 mm multiplex",
      width: 1250,
      height: 2500,
      thickness: 18,
    });
    const techniques = new CabinetJoinery();
    for (const [index, kind] of ["dominoes", "fingers", "miter"].entries()) {
      const a = material
        .makePart({ id: kind + "-a", width: 180, height: 100 })
        .place({ x: index * 220 });
      const c = material
        .makePart({ id: kind + "-b", width: 180, height: 100 })
        .place({ x: index * 220, y: 130 });
      const port = new PartInterface({
        outline: new Shapes.Rectangle({ width: 180, height: 18 }),
        frame: {
          origin: { x: 0, y: kind === "dominoes" ? 50 : 0, z: 18 },
          xAxis: { x: 1, y: 0, z: 0 },
          yAxis: { x: 0, y: 1, z: 0 },
        },
      });
      a.addInterface("joint", port);
      c.addInterface("joint", port);
      const first = a.interface("joint"),
        second = c.interface("joint");
      if (kind === "dominoes")
        techniques.dominoes.connect({
          first,
          second,
          count: 4,
          edgeOffset: 25,
        });
      else if (kind === "fingers")
        techniques.fingers.connect({ first, second });
      else techniques.miter.connect({ first, second });
    }
  }
  @cad.output.manufacturingDxf()
  dxf() {
    return new ManufacturingDxf({ parts: "all", layout: "one-file-per-part" });
  }
  @cad.output.step()
  step() {
    return new StepModel({ of: this });
  }
  @cad.output.technicalDrawing()
  drawing() {
    return new TechnicalDrawing({ title: "Joinery samples", paper: "A3" }).view(
      { id: "top", of: this, kind: "top", at: { x: 20, y: 20 }, scale: 0.5 },
    );
  }
}
