import {
  Assembly,
  Project,
  BlockMaterial,
  SheetMaterial,
  Shapes,
  TechnicalDrawing,
  StepModel,
  cad,
  type Point2,
  type BlockPart,
} from "../src/index.js";

/** Concept layout, millimetres. Not a permit, structural or code-compliance plan. */
export const apartment = {
  width: 8000,
  depth: 6400,
  height: 2600,
  exteriorWall: 200,
  partition: 150,
  planCut: 1400,
};
const plaster = new BlockMaterial({
  name: "Plastered wall",
  color: "#e5e0d7",
  drawingStyle: {
    regular: { stroke: "#555555", lineWidth: 0.18 },
    cutaway: {
      stroke: "#202020",
      lineWidth: 0.5,
      hatch: { angle: 45, spacing: 1.8, stroke: "#777777", lineWidth: 0.13 },
    },
  },
});
const joinery = new BlockMaterial({ name: "Painted frames", color: "#d3dedc" });
const glass = new BlockMaterial({ name: "Glazing envelope", color: "#98c9d1" });
const timber = new BlockMaterial({
  name: "Timber / furniture",
  color: "#bd966d",
});
const fabric = new BlockMaterial({ name: "Upholstery", color: "#91aaa4" });
const ceramic = new BlockMaterial({
  name: "Sanitary fixtures",
  color: "#e2e8eb",
});
function box(
  material: BlockMaterial,
  id: string,
  x: number,
  y: number,
  width: number,
  depth: number,
  height: number,
  z = 0,
) {
  return material.makePart({ id, width, depth, height }).place({ x, y, z });
}
export interface Opening {
  x: number;
  y: number;
  width: number;
  depth: number;
  sill: number;
  height: number;
}
function wall(
  id: string,
  x: number,
  y: number,
  width: number,
  depth: number,
  openings: Opening[] = [],
) {
  const part = box(plaster, id, x, y, width, depth, apartment.height);
  for (const o of openings)
    part.subtract(
      new Shapes.Box({ width: o.width, depth: o.depth, height: o.height }),
      { x: o.x - x, y: o.y - y, z: o.sill },
    );
  return part;
}
function floor(id: string, points: Point2[], color: `#${string}`) {
  return new SheetMaterial({ name: id, thickness: 80, color })
    .makePart({ id: "floor", outline: new Shapes.Polygon({ points }) })
    .place({ z: -80 });
}
function rect(x: number, y: number, w: number, d: number): Point2[] {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + d },
    { x, y: y + d },
  ];
}

@cad.part({ id: "room", revision: "1" })
class Room extends Assembly {
  constructor(id: string, label: string, build: () => void) {
    super({ id, label });
    build();
  }
}
@cad.part({ id: "window", revision: "1" })
class Window extends Assembly {
  constructor(
    id: string,
    x: number,
    y: number,
    width: number,
    sill = 900,
    height = 1300,
    rotation = 0,
  ) {
    super({ id, label: `Window ${width} x ${height}, sill ${sill}` });
    box(joinery, "sill", 0, 40, width, 120, 50, sill);
    box(joinery, "head", 0, 60, width, 80, 50, sill + height - 50);
    box(joinery, "jamb-left", 0, 60, 50, 80, height - 100, sill + 50);
    box(joinery, "jamb-right", width - 50, 60, 50, 80, height - 100, sill + 50);
    box(
      joinery,
      "mullion",
      width / 2 - 20,
      60,
      40,
      80,
      height - 100,
      sill + 50,
    );
    box(glass, "glass", 50, 95, width - 100, 10, height - 100, sill + 50);
    this.place({ x, y, rotate: { z: rotation } });
  }
}
@cad.part({ id: "door", revision: "1" })
class Door extends Assembly {
  constructor(
    id: string,
    x: number,
    y: number,
    width: number,
    rotation: number,
  ) {
    super({ id, label: `${width} mm door - open` });
    box(timber, "leaf", 0, 0, width, 40, 2100);
    box(joinery, "handle", width - 100, -25, 90, 90, 25, 1000);
    this.place({ x, y, rotate: { z: rotation } });
  }
}

@cad.project({
  id: "small-apartment",
  title: "Small apartment - four rooms",
  units: "mm",
})
export class SmallApartment extends Project {
  readonly walls: BlockPart[] = [];
  readonly hallway;
  readonly living;
  readonly bedroom;
  readonly bathroom;
  constructor() {
    super({
      id: "small-apartment",
      label: "Small apartment - approx. 44 m2 internal",
    });
    new Room("exterior", "Exterior walls - 200 mm", () => {
      this.walls.push(
        wall("south", 0, 0, 8000, 200, [
          { x: 550, y: -1, width: 900, depth: 202, sill: 0, height: 2150 },
        ]),
      );
      this.walls.push(
        wall("north", 0, 6200, 8000, 200, [
          {
            x: 1100,
            y: 6199,
            width: 2200,
            depth: 202,
            sill: 900,
            height: 1300,
          },
          {
            x: 5700,
            y: 6199,
            width: 1400,
            depth: 202,
            sill: 900,
            height: 1300,
          },
        ]),
      );
      this.walls.push(
        wall("west", 0, 200, 200, 6000, [
          { x: -1, y: 900, width: 202, depth: 800, sill: 900, height: 1300 },
        ]),
      );
      this.walls.push(
        wall("east", 7800, 200, 200, 6000, [
          { x: 7799, y: 900, width: 202, depth: 800, sill: 1100, height: 1100 },
        ]),
      );
    });
    this.hallway = new Room("hallway", "Hallway - 3.60 m2", () => {
      floor("Hall tiles", rect(200, 200, 1800, 2000), "#d5cdbb")
        .union(new Shapes.Box({ width: 1000, depth: 150, height: 80 }), {
          x: 700,
          y: 2200,
        })
        .union(new Shapes.Box({ width: 900, depth: 200, height: 80 }), {
          x: 550,
          y: 0,
        });
      this.walls.push(wall("east-partition", 2000, 200, 150, 2000));
      this.walls.push(
        wall("open-doorway", 200, 2200, 1950, 150, [
          { x: 700, y: 2199, width: 1000, depth: 152, sill: 0, height: 2200 },
        ]),
      );
      new Window("west-window", 200, 900, 800, 900, 1300, 90);
      new Door("entrance-door", 550, 200, 900, 90);
      box(timber, "shoe-bench", 1580, 350, 350, 900, 450);
    });
    this.living = new Room(
      "living-room",
      "Living / kitchenette - 24.01 m2",
      () => {
        floor(
          "Living oak",
          [
            { x: 2150, y: 200 },
            { x: 4900, y: 200 },
            { x: 4900, y: 6200 },
            { x: 200, y: 6200 },
            { x: 200, y: 2350 },
            { x: 2150, y: 2350 },
          ],
          "#d5b98d",
        );
        this.walls.push(
          wall("bed-bath-partition", 4900, 200, 150, 6000, [
            { x: 4899, y: 700, width: 152, depth: 800, sill: 0, height: 2150 },
            { x: 4899, y: 3400, width: 152, depth: 900, sill: 0, height: 2150 },
          ]),
        );
        new Window("north-window", 1100, 6200, 2200);
        box(fabric, "sofa", 350, 3500, 900, 2000, 450);
        box(fabric, "sofa-back", 350, 3500, 220, 2000, 850);
        box(timber, "coffee-table", 1550, 4050, 800, 650, 420);
        box(timber, "dining-table", 3050, 2500, 1050, 650, 740);
        box(timber, "dining-chair-1", 3350, 1950, 450, 450, 450);
        box(timber, "dining-chair-2", 3350, 3250, 450, 450, 450);
        box(timber, "kitchen-base", 2550, 200, 2100, 600, 900);
        box(ceramic, "sink", 2800, 300, 500, 400, 30, 900);
        box(fabric, "hob", 3900, 300, 500, 400, 30, 900);
      },
    );
    this.bedroom = new Room("bedroom", "Bedroom - 9.21 m2", () => {
      floor("Bedroom oak", rect(5050, 2850, 2750, 3350), "#d7c29e").union(
        new Shapes.Box({ width: 150, depth: 900, height: 80 }),
        { x: 4900, y: 3400 },
      );
      new Window("north-window", 5700, 6200, 1400);
      new Door("bedroom-door", 5050, 3400, 900, 0);
      box(timber, "bed-base", 5800, 4000, 1600, 2000, 300);
      box(ceramic, "mattress", 5800, 4000, 1600, 2000, 200, 300);
      box(fabric, "pillow-left", 5900, 5600, 600, 300, 100, 500);
      box(fabric, "pillow-right", 6700, 5600, 600, 300, 100, 500);
      box(timber, "wardrobe", 7150, 2900, 600, 800, 2200);
    });
    this.bathroom = new Room("bathroom", "Bathroom - 6.88 m2", () => {
      floor("Bathroom tiles", rect(5050, 200, 2750, 2500), "#b9cbd0").union(
        new Shapes.Box({ width: 150, depth: 800, height: 80 }),
        { x: 4900, y: 700 },
      );
      this.walls.push(wall("bedroom-partition", 5050, 2700, 2750, 150));
      new Window("east-window", 8000, 900, 800, 1100, 1100, 90);
      new Door("bathroom-door", 5050, 700, 800, 0);
      box(ceramic, "shower-tray", 6700, 1600, 1000, 1000, 100);
      box(glass, "shower-screen", 6700, 1600, 1000, 20, 1900, 100);
      box(ceramic, "vanity", 5350, 2200, 800, 450, 850);
      box(ceramic, "basin", 5450, 2225, 600, 400, 100, 850);
      box(ceramic, "toilet", 6900, 300, 400, 700, 430);
    });
  }

  @cad.output.technicalDrawing({ fileName: "apartment-plan.pdf" })
  drawing() {
    const drawing = new TechnicalDrawing({
      title: "Small apartment - floor plan",
      project: "Room planning concept",
      drawingNumber: "APT-001",
      revision: "A",
      material: "Walls 200 / 150 mm",
      paper: "A3",
    })
      .view({
        id: "plan",
        label: "FLOOR PLAN - CUT +1400",
        labelAt: { x: 40, y: 16 },
        of: this,
        kind: "top",
        cutHeight: apartment.planCut,
        at: { x: 40, y: 40 },
        scale: 1 / 40,
      })
      .dimension({
        view: "plan",
        from: { x: 0, y: 0, z: 0 },
        to: { x: 8000, y: 0, z: 0 },
        offset: 0,
        paperOffset: 12,
        label: "8000",
      })
      .dimension({
        view: "plan",
        from: { x: 0, y: 0, z: 0 },
        to: { x: 0, y: 6400, z: 0 },
        offset: 0,
        paperOffset: -12,
        label: "6400",
      })
      .dimension({
        view: "plan",
        from: { x: 200, y: 6200, z: 0 },
        to: { x: 4900, y: 6200, z: 0 },
        offset: 0,
        paperOffset: -23,
        label: "4700 clear",
      })
      .dimension({
        view: "plan",
        from: { x: 5050, y: 6200, z: 0 },
        to: { x: 7800, y: 6200, z: 0 },
        offset: 0,
        paperOffset: -23,
        label: "2750 clear",
      })
      .note({ at: { x: 270, y: 45 }, text: "SMALL APARTMENT" })
      .note({
        at: { x: 270, y: 57 },
        text: "01  Hallway                  3.60 m2",
      })
      .note({
        at: { x: 270, y: 65 },
        text: "02  Living / kitchen     24.01 m2",
      })
      .note({
        at: { x: 270, y: 73 },
        text: "03  Bedroom                9.21 m2",
      })
      .note({
        at: { x: 270, y: 81 },
        text: "04  Bathroom               6.88 m2",
      })
      .note({
        at: { x: 270, y: 94 },
        text: "Approx. 43.70 m2 clear room floor area.",
      })
      .note({
        at: { x: 270, y: 111 },
        text: "Entrance: 900 mm door, inward opening.",
      })
      .note({
        at: { x: 270, y: 119 },
        text: "Hall to living: 1000 mm opening, NO door.",
      })
      .note({
        at: { x: 270, y: 127 },
        text: "Bedroom door 900 / bathroom door 800.",
      })
      .note({
        at: { x: 270, y: 135 },
        text: "Every room has an exterior window.",
      })
      .note({
        at: { x: 270, y: 153 },
        text: "Ceiling height: 2600. North is up.",
      })
      .note({
        at: { x: 270, y: 161 },
        text: "Window sills: 900; bathroom 1100.",
      })
      .note({
        at: { x: 270, y: 185 },
        text: "Concept only - dimensions in mm.",
      })
      .note({
        at: { x: 270, y: 193 },
        text: "Not a construction or permit drawing.",
      });
    for (const [x, y, text] of [
      [850, 1850, "01 HALL"],
      [2750, 5350, "02 LIVING"],
      [5350, 4750, "03 BED"],
      [5350, 1700, "04 BATH"],
    ] as const)
      drawing.label({ view: "plan", at: { x, y, z: 0 }, text, height: 3 });
    const swing = (x: number, y: number, r: number, from: number, to: number) =>
      drawing.path({
        view: "plan",
        layer: "DOOR_SWING",
        points: Array.from({ length: 33 }, (_, i) => {
          const a = ((from + ((to - from) * i) / 32) * Math.PI) / 180;
          return { x: x + r * Math.cos(a), y: y + r * Math.sin(a), z: 0 };
        }),
      });
    swing(550, 200, 900, 0, 90);
    swing(5050, 3400, 900, 0, 90);
    swing(5050, 700, 800, 0, 90);
    drawing.label({
      view: "plan",
      at: { x: 740, y: 2440, z: 0 },
      text: "OPEN",
      height: 2.5,
    });
    return drawing.page(
      new TechnicalDrawing({
        title: "Apartment - cutaway overview",
        project: "Room planning concept",
        drawingNumber: "APT-001",
        revision: "A",
        material: "Concept furniture / fixtures",
        paper: "A3",
      })
        .view({
          id: "cutaway",
          of: this,
          kind: "isometric",
          cutHeight: 1400,
          at: { x: 30, y: 35 },
          scale: 1 / 45,
        })
        .note({
          at: { x: 25, y: 235 },
          text: "Walls cut at 1400 for visibility. The interactive 3D model retains the full 2600 mm wall height.",
        }),
    );
  }
  @cad.output.step({ fileName: "apartment.step" })
  step() {
    return new StepModel({ of: this });
  }
}
