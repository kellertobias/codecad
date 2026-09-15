import {
  Assembly,
  Bend,
  SheetMaterial,
  SheetMetalPart,
  Shapes,
  cad,
} from "../src/index.js";

const galvanizedSteel15 = new SheetMaterial({
  id: "galvanized-steel-1.5",
  name: "1.5 mm galvanized steel",
  width: 1000,
  height: 2000,
  thickness: 1.5,
  kerf: 0.2,
});

@cad.part({ id: "folded-mounting-bracket", revision: "1" })
export class FoldedMountingBracket extends Assembly {
  public readonly body: SheetMetalPart;

  public constructor() {
    super({ id: "folded-mounting-bracket" });

    this.body = this.add(
      galvanizedSteel15.makeSheetMetalPart({
        id: "bracket-blank",
        outline: new Shapes.Rectangle({ width: 160, height: 80 }),
        bendRules: {
          kFactor: 0.42,
          minimumInsideRadius: 1.5,
          defaultRelief: "rectangular",
        },
      }),
    );

    this.body
      .subtract(
        new Shapes.Cylinder({
          diameter: 6.5,
          length: 1.5,
          x: 20,
          y: 40,
          z: 0.75,
        }),
      )
      .bend(
        new Bend({
          id: "flange-left",
          start: { x: 30, y: 0 },
          end: { x: 30, y: 80 },
          direction: "up",
          movingSide: "left",
          angle: 90,
          insideRadius: 1.5,
        }),
      )
      .bend(
        new Bend({
          id: "flange-right",
          start: { x: 130, y: 0 },
          end: { x: 130, y: 80 },
          direction: "up",
          angle: 90,
          insideRadius: 1.5,
        }),
      );
  }
}
