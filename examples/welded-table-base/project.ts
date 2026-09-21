import {
  CodeCadParameters,
  MetalStockMaterial,
  Project,
  cad,
  type MetalStockPart,
  type ParametersOf,
} from "../../src/index.js";

/** Outside dimensions and cut lengths are in millimetres. */
export const tableBase = {
  width: 1200,
  depth: 600,
  height: 700,
  tube: 40,
  wall: 3,
  lowerRailTop: 180,
} as const;

/** Change these in Studio, or use `params.with(...)` for another default size. */
export const params = new CodeCadParameters({
  width: cad.parameter(tableBase.width, {
    label: "Outside width",
    unit: "mm",
    range: [500, 3000],
    step: 10,
  }),
  depth: cad.parameter(tableBase.depth, {
    label: "Outside depth",
    unit: "mm",
    range: [300, 1500],
    step: 10,
  }),
  height: cad.parameter(tableBase.height, {
    label: "Outside height",
    unit: "mm",
    range: [400, 1200],
    step: 10,
  }),
  tube: cad.parameter(tableBase.tube, {
    label: "Square tube outside size",
    unit: "mm",
    range: [30, 80],
    step: 5,
  }),
  wall: cad.parameter(tableBase.wall, {
    label: "Tube wall thickness",
    unit: "mm",
    range: [1, 8],
    step: 0.5,
  }),
  lowerRailTop: cad.parameter(tableBase.lowerRailTop, {
    label: "Lower rail top height",
    unit: "mm",
    range: [120, 300],
    step: 10,
  }),
});

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
  readonly settings: ParametersOf<typeof params>;

  // The id and label come from @cad.project; defaults let other projects reuse
  // this base at another size while Studio's parameter panel still wins.
  constructor(defaults: Partial<ParametersOf<typeof params>> = {}) {
    super();
    this.settings = this.configureParameters(params, defaults);
    const { width, depth, height, tube, wall, lowerRailTop } = this.settings;
    const steelTube = new MetalStockMaterial({
      id: `square-steel-tube-${tube}x${tube}x${wall}`,
      name: `Steel square tube ${tube} × ${tube} × ${wall}`,
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

    // Rotation around Y points stock Z along +X. Its tube-sized X section then
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

  // No @cad.output methods: the build adds the standard drawing (front, top,
  // right and isometric views with overall dimensions), cut list and STEP.
}
