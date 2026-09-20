import {
  Assembly,
  Project,
  SheetMaterial,
  SheetPart,
  Shapes,
  HardwarePart,
  PartInterface,
  Drill,
  CounterSink,
  Arrangement,
  LinearJoint,
  MotionStudy,
  TechnicalDrawing,
  CutList,
  ManufacturingDxf,
  StepModel,
  Groove,
  DominoJoint,
  cad,
} from "../src/index.js";
import { Vector3 } from "three";
import { DrawerSlide } from "./drawer-slide.js";
import { pairedDominoes } from "./paired-dominoes.js";

// Edit dimensions and save: the application rebuilds this project in a fresh process.
const WIDTH = 600;
const DEPTH = 500;
const HEIGHT = 900;
const DRAWERS = 4;
const plywood = new SheetMaterial({
  id: "birch-18",
  name: "Birch multiplex 18 mm",
  thickness: 18,
  plies: 9,
  width: 1250,
  height: 2500,
  color: "#c6a77d",
  grain: "height",
  kerf: 3.2,
  partSpacing: 8,
  sheetMargin: 10,
});
// Same sheet size, kerf and margins; only what differs is restated.
const drawerStock = plywood.with({
  id: "birch-12",
  name: "Birch multiplex 12 mm",
  thickness: 12,
  plies: 7,
  color: "#dfca9e",
});
const backStock = plywood.with({
  id: "birch-6",
  name: "Birch plywood 6 mm",
  thickness: 6,
  plies: 3,
  color: "#b79d75",
});

@cad.part({ id: "cabinet-drawer", revision: "1" })
export class CabinetDrawer extends Assembly {
  attachSlide(slide: DrawerSlide): void {
    this.add(slide);
  }
  constructor(id: string) {
    super({ id, label: "Drawer" });
    const width = WIDTH - 60,
      depth = DEPTH - 60,
      height = 150;
    drawerStock.makePart({ id: "floor", width, height: depth });
    const left = drawerStock
      .makePart({ id: "left", width: depth, height })
      .place({ z: 12, rotate: { y: 90, z: 90 } });
    const right = left
      .copy({ id: "right" })
      .place({ x: width - 12, z: 12, rotate: { y: 90, z: 90 } });
    const back = drawerStock
      .makePart({ id: "back", width: width - 24, height })
      .place({ x: 12, y: depth, z: 12, rotate: { x: 90 } });
    const drawerDominoes = new DominoJoint({
      width: 16,
      thickness: 4,
      depthPerSide: 6,
    });
    pairedDominoes(
      left,
      back,
      new Vector3(12, depth - 6, 12),
      new Vector3(0, 0, 1),
      new Vector3(1, 0, 0),
      height,
      drawerDominoes,
      2,
    );
    pairedDominoes(
      right,
      back,
      new Vector3(width - 12, depth - 6, 12),
      new Vector3(0, 0, 1),
      new Vector3(-1, 0, 0),
      height,
      drawerDominoes,
      2,
    );
    const front = plywood
      .makePart({ id: "front", width: WIDTH - 4, height: 190 })
      .place({ x: -28, y: -22, z: -6, rotate: { x: 90 } });

    const mount = new PartInterface({
      features: {
        left: {
          kind: "hole",
          x: (WIDTH - 4) / 2 - 48,
          y: 95,
          diameter: 4,
          source: "provisional",
        },
        right: {
          kind: "hole",
          x: (WIDTH - 4) / 2 + 48,
          y: 95,
          diameter: 4,
          source: "provisional",
        },
      },
    } as const);
    const handle = new HardwarePart({
      id: "handle",
      label: "Handle · 96 mm mounting centers",
      shape: new Shapes.Box({ width: 128, depth: 22, height: 12 }),
      measurementStatus: "provisional",
      interfaces: { default: mount },
    }).place({ x: (width - 128) / 2, y: -62, z: 83 });
    const drill = new Drill({ size: 4 });
    drill.pattern(front, handle.interface(), { z: [18, -18] });
    const countersink = new CounterSink({ diameter: 8, angle: 90 });
    for (const hole of Object.values(mount.features)) {
      countersink.cut(front, { x: hole.x, y: hole.y, z: [0, 4] });
    }
  }
}

@cad.project({
  id: "kitchen-cabinet",
  title: "Four-drawer kitchen cabinet",
  units: "mm",
})
export class KitchenCabinet extends Project {
  readonly drawerMotion: {
    joint: LinearJoint;
    to: number;
    delaySeconds: number;
  }[] = [];

  constructor() {
    super(); // id and label come from @cad.project
    // Interactive front-elevation sketch, separate from printable drawings.
    this.view2D.path(
      [
        { x: 0, y: 0 },
        { x: WIDTH, y: 0 },
        { x: WIDTH, y: HEIGHT },
        { x: 0, y: HEIGHT },
      ],
      { closed: true, label: "Cabinet outline" },
    );
    for (let drawer = 1; drawer <= DRAWERS; drawer++) {
      if (drawer < DRAWERS)
        this.view2D.line(
          { x: 0, y: (HEIGHT * drawer) / DRAWERS },
          { x: WIDTH, y: (HEIGHT * drawer) / DRAWERS },
        );
      this.view2D.circle(
        { x: WIDTH / 2, y: (HEIGHT * (drawer - 0.5)) / DRAWERS },
        12,
        { label: `Drawer ${drawer} pull` },
      );
    }
    const left = plywood
      .makePart({ id: "left", width: DEPTH, height: HEIGHT })
      .place({ rotate: { y: 90, z: 90 } });
    const right = left
      .copy({ id: "right" })
      .place({ x: WIDTH - 18, rotate: { y: 90, z: 90 } });
    const bottom = plywood
      .makePart({ id: "bottom", width: WIDTH - 36, height: DEPTH })
      .place({ x: 18 });
    const top = plywood
      .makePart({ id: "top", width: WIDTH - 36, height: DEPTH })
      .place({ x: 18, z: HEIGHT - 18 });
    const corpusDominoes = new DominoJoint({
      width: 20,
      thickness: 6,
      depthPerSide: 10,
    });
    for (const [panel, z] of [
      [bottom, 9],
      [top, HEIGHT - 9],
    ] as const) {
      pairedDominoes(
        left,
        panel,
        new Vector3(18, 0, z),
        new Vector3(0, 1, 0),
        new Vector3(1, 0, 0),
        DEPTH,
        corpusDominoes,
        3,
      );
      pairedDominoes(
        right,
        panel,
        new Vector3(WIDTH - 18, 0, z),
        new Vector3(0, 1, 0),
        new Vector3(-1, 0, 0),
        DEPTH,
        corpusDominoes,
        3,
      );
    }
    backStock
      .makePart({ id: "back", width: WIDTH - 24, height: HEIGHT - 24 })
      .place({ x: 12, y: DEPTH - 10, z: 12, rotate: { x: 90 } });

    // Back grooves, in each side's own XY coordinates, on its inside face.
    new Groove({ toolDiameter: 6 }).cut({
      target: left,
      profile: new Shapes.Rectangle({ width: 6.4, height: HEIGHT - 24 }),
      placement: { x: DEPTH - 16.2, y: 12, z: 12 },
      depth: 6,
    });
    new Groove({ toolDiameter: 6 }).cut({
      target: right,
      profile: new Shapes.Rectangle({ width: 6.4, height: HEIGHT - 24 }),
      placement: { x: DEPTH - 16.2, y: 12 },
      depth: 6,
    });

    for (let i = 0; i < DRAWERS; i++) {
      const z = 36 + i * 210;
      const drawer = new CabinetDrawer("drawer-" + (i + 1)).place({
        x: 30,
        y: 20,
        z,
      });
      this.drawerMotion.push({
        joint: new LinearJoint({
          id: "drawer-" + (i + 1) + "-slide",
          fixed: this,
          moving: drawer,
          axis: "y",
          limits: { min: -380, max: 0 },
        }),
        to: -380,
        delaySeconds: i * 0.75,
      });
      for (const [side, x] of [
        [left, 18],
        [right, WIDTH - 18],
      ] as const) {
        const slide = new DrawerSlide("rail-" + side.id + "-" + (i + 1)).place({
          x,
          y: 20,
          z,
          relativeTo: "world",
        });
        if (side === right) slide.mirror({ axis: "x" });
        drawer.attachSlide(slide);
        // The rail assemblies live under the moving drawer in the registry.
        // Counter-motion keeps the fixed stage on the cabinet and advances
        // the middle stage only half as far as the drawer/inner stage.
        for (const [moving, to] of [
          [slide.fixed, 380],
          [slide.middle, 190],
        ] as const)
          this.drawerMotion.push({
            joint: new LinearJoint({
              id: moving.path,
              fixed: this,
              moving,
              axis: "y",
              limits: { min: 0, max: to },
            }),
            to,
            delaySeconds: i * 0.75,
          });
        Arrangement.linear({
          start: { x: 60, y: z + 15 },
          end: { x: 420, y: z + 15 },
          steps: 3,
        }).execute((pos) =>
          new Drill({ size: 3 }).drill(side, {
            ...pos,
            z: side === left ? [18, -10] : [0, 10],
          }),
        );
      }
    }
  }
}

@cad.outputsFor(KitchenCabinet)
export class CabinetDrawingOutput {
  constructor(readonly cabinet: KitchenCabinet) {}

  @cad.output.technicalDrawing({ fileName: "cabinet-plan.pdf" })
  technicalDrawing() {
    return new TechnicalDrawing({
      title: "Kitchen cabinet · 600 × 500 × 900 mm",
      paper: "A3",
    })
      .view({
        id: "front",
        of: this.cabinet,
        kind: "front",
        at: { x: 30, y: 30 },
        scale: 0.18,
        hiddenLines: false,
      })
      .view({
        id: "iso",
        of: this.cabinet,
        kind: "isometric",
        at: { x: 185, y: 30 },
        scale: 0.14,
      })
      .dimension({
        view: "front",
        from: { x: 0, y: 0, z: 0 },
        to: { x: WIDTH, y: 0, z: 0 },
        offset: 60,
      })
      .note({
        at: { x: 20, y: 235 },
        text: "Hardware geometry is provisional. All dimensions are in millimetres.",
      });
  }
}

@cad.outputsFor(KitchenCabinet)
export class CabinetManufacturingOutputs {
  constructor(readonly cabinet: KitchenCabinet) {}

  @cad.output.cutList({ fileName: "cut-list.csv" })
  cutList() {
    return new CutList({ includeLayouts: true });
  }

  @cad.output.manufacturingDxf({ fileName: "cnc-parts.zip" })
  manufacturingDxf() {
    return new ManufacturingDxf({ parts: "all", layout: "one-file-per-part" });
  }

  @cad.output.step({ fileName: "cabinet.step" })
  stepModel() {
    return new StepModel({ of: this.cabinet });
  }
}

@cad.outputsFor(KitchenCabinet)
export class CabinetMotionOutputs {
  constructor(readonly cabinet: KitchenCabinet) {}

  @cad.output.motion({
    fileName: "drawer-motion.glb",
    title: "Drawers · staggered",
  })
  motion() {
    return this.drawerStudy(true);
  }

  @cad.output.motion({
    fileName: "drawer-motion-together.glb",
    title: "Drawers · together",
  })
  motionTogether() {
    return this.drawerStudy(false);
  }

  private drawerStudy(staggered: boolean) {
    const study = new MotionStudy({ of: this.cabinet });
    // Each drawer starts 25% of the 3-second opening time after its predecessor.
    for (const { joint, to, delaySeconds } of this.cabinet.drawerMotion)
      study.animate({
        joint,
        from: 0,
        to,
        durationSeconds: 3,
        delaySeconds: staggered ? delaySeconds : 0,
      });
    if (staggered)
      study.checkClearance({
        between: [
          this.cabinet.registry.require(
            "kitchen-cabinet/drawer-1/floor",
            SheetPart,
          ),
          this.cabinet.parts.require("kitchen-cabinet/left", SheetPart),
        ],
        minimum: 1,
        samples: 12,
      });
    return study;
  }
}
