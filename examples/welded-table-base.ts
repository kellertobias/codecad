import {
  CutList,
  MetalStockMaterial,
  Project,
  StepModel,
  cad,
  type MetalStockPart,
} from "../src/index.js";

/** Outside dimensions and cut lengths are in millimetres. */
export const tableBase = {
  width: 1200,
  depth: 600,
  height: 700,
  tube: 40,
  wall: 3,
  lowerRailTop: 180,
} as const;

/**
 * Square-tube table base with butt-fitted members intended for welding.
 * Parts stay separate so the cut list describes each saw-cut length. Touching
 * faces mark weld locations; weld beads and strength are not simulated.
 */
@cad.project({
  id: "welded-table-base",
  title: "Welded steel table base",
  units: "mm",
})
export class WeldedTableBase extends Project {
  readonly members: MetalStockPart[] = [];

  constructor() {
    super({ id: "welded-table-base", label: "Welded steel table base" });
    const { width, depth, height, tube, wall, lowerRailTop } = tableBase;
    const steelTube = new MetalStockMaterial({
      id: "square-steel-tube-40x40x3",
      name: "Steel square tube 40 × 40 × 3",
      color: "#727d86",
      width: tube,
      height: tube,
      cornerRadius: "none",
      wallThickness: wall,
      densityKgPerM3: 7850,
    });
    const member = (id: string, length: number) => {
      const part = steelTube.makePart({ id, length });
      this.members.push(part);
      return part;
    };

    // Four legs are full height. X/Y describe the outside corner of each tube.
    for (const [id, x, y] of [
      ["front-left-leg", 0, 0],
      ["front-right-leg", width - tube, 0],
      ["back-left-leg", 0, depth - tube],
      ["back-right-leg", width - tube, depth - tube],
    ] as const) {
      member(id, height).place({ x, y });
    }

    // Rotation around Y points stock Z along +X. Its 40 mm X section then
    // occupies world Z=height-tube..height, flush with the leg tops.
    for (const [id, y] of [
      ["front-top-rail", 0],
      ["back-top-rail", depth - tube],
    ] as const) {
      member(id, width - 2 * tube).place({
        x: tube,
        y,
        z: height,
        rotate: { y: 90 },
      });
    }

    // Rotation around X points stock Z along +Y. These rails butt against
    // the inside faces of the front and back legs without overlapping them.
    for (const [id, x] of [
      ["left-top-rail", 0],
      ["right-top-rail", width - tube],
    ] as const) {
      member(id, depth - 2 * tube).place({
        x,
        y: tube,
        z: height,
        rotate: { x: -90 },
      });
    }

    // Lower long-side stretchers tie the legs together while leaving the
    // middle open for seating or storage.
    for (const [id, y] of [
      ["front-lower-rail", 0],
      ["back-lower-rail", depth - tube],
    ] as const) {
      member(id, width - 2 * tube).place({
        x: tube,
        y,
        z: lowerRailTop,
        rotate: { y: 90 },
      });
    }
  }

  @cad.output.cutList()
  cutList() {
    return new CutList();
  }

  @cad.output.step()
  step() {
    return new StepModel({ of: this });
  }
}
