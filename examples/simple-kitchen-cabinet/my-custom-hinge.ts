import {
  Assembly,
  HardwarePart,
  PartInterface,
  RevoluteJoint,
  Shapes,
  cad,
} from "../../src/index.js";

const stationaryMount = new PartInterface({
  name: "stationary-mount",
  shape: new Shapes.Box({ width: 42, depth: 16, height: 8 }),
  outline: new Shapes.Rectangle({ width: 42, height: 16, center: true }),
  defaultClearance: 0.5,
  features: {
    screwTop: { kind: "hole", x: 0, y: 5, diameter: 4, source: "provisional" },
    screwBottom: {
      kind: "hole",
      x: 0,
      y: -5,
      diameter: 4,
      source: "provisional",
    },
  },
} as const);

const movingMount = new PartInterface({
  name: "moving-mount",
  shape: new Shapes.Cylinder({ diameter: 35, length: 12 }),
  features: {
    cup: { kind: "hole", x: 0, y: 0, diameter: 35, source: "supplier-drawing" },
    screwLeft: {
      kind: "hole",
      x: -22.5,
      y: 0,
      diameter: 4,
      source: "supplier-drawing",
    },
    screwRight: {
      kind: "hole",
      x: 22.5,
      y: 0,
      diameter: 4,
      source: "supplier-drawing",
    },
  },
} as const);

@cad.part({ id: "my-custom-hinge", revision: "1" })
export class MyCustomHinge extends Assembly {
  public readonly stationarySide: HardwarePart;
  public readonly movingSide: HardwarePart;
  public readonly joint: RevoluteJoint;

  public constructor() {
    super({ id: "hinge", label: "110 degree concealed hinge" });

    this.stationarySide = this.add(
      new HardwarePart({
        id: "stationary-side",
        shape: new Shapes.Box({ width: 42, depth: 16, height: 8 }),
        manufacturer: "Example Hardware",
        supplierPartNumber: "HINGE-110",
        measurementStatus: "supplier-drawing",
        interfaces: { default: stationaryMount },
      }),
    );

    this.movingSide = this.add(
      new HardwarePart({
        id: "moving-side",
        shape: new Shapes.Cylinder({ diameter: 35, length: 12 }),
        measurementStatus: "supplier-drawing",
        interfaces: { default: movingMount },
      }),
    );

    this.joint = new RevoluteJoint({
      id: "hinge-axis",
      fixed: this.stationarySide,
      moving: this.movingSide,
      axis: "y",
      limits: { min: 0, max: 110 },
    });

    this.exposeInterface("stationary", stationaryMount);
    this.exposeInterface("moving", movingMount);
  }

  @cad.interface({ name: "stationary", default: true })
  public stationaryMount(): PartInterface<typeof stationaryMount.features> {
    return stationaryMount;
  }

  @cad.interface({ name: "moving" })
  public movingMount(): PartInterface<typeof movingMount.features> {
    return movingMount;
  }
}
