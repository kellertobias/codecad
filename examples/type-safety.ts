import { PartInterface, Shapes, cad } from "../src/index.js";

const mount = new PartInterface({
  features: {
    leftScrew: { kind: "hole", x: 0, y: 0, diameter: 4, source: "measured" },
    rightScrew: { kind: "hole", x: 32, y: 0, diameter: 4, source: "measured" },
  },
} as const);

mount.select("leftScrew");

// @ts-expect-error Feature names are checked when the concrete interface is retained.
mount.select("centerScrew");

class BadOutputs {
  // @ts-expect-error The decorator requires a TechnicalDrawing return value.
  @cad.output.technicalDrawing()
  public drawing(): string {
    return "not a drawing";
  }

  // @ts-expect-error An exposed interface must return PartInterface.
  @cad.interface()
  public mount(): Shapes.Box {
    return new Shapes.Box({ width: 1, depth: 1, height: 1 });
  }
}

void BadOutputs;
