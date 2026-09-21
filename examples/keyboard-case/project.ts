import {
  Project,
  SheetMaterial,
  Shapes,
  SolidShape,
  HardwarePart,
  Bend,
  TechnicalDrawing,
  ManufacturingDxf,
  CutList,
  StepModel,
  PartInterface,
  cad,
  type Point2,
} from "../../src/index.js";
import { Vector3 } from "three";

/** All dimensions mm; provisional fabrication assumptions are deliberately exposed. */
export const keyboardCase = {
  columns: 2,
  rows: 6,
  slotWidth: 96,
  slotHeight: 11,
  gap: 8,
  sideMargin: 8,
  topDepth: 176,
  angle: 20,
  frontWall: 40,
  returnLength: 30,
  thickness: 1.5,
  insideRadius: 5,
  kFactor: 0.42,
  mdfThickness: 18,
  engagement: 3,
  proud: 8,
  clearance: 0.25,
};
const p = keyboardCase,
  rad = Math.PI / 180;
export const caseWidth =
  p.columns * p.slotWidth + (p.columns - 1) * p.gap + 2 * p.sideMargin;
const allowance = (angle: number) =>
  angle * rad * (p.insideRadius + p.kFactor * p.thickness);
const frontAngle = 90 - p.angle,
  backAngle = 90 + p.angle;
const rearWall = p.frontWall + p.topDepth * Math.sin(p.angle * rad);
export const deckStart =
  p.returnLength + allowance(90) + p.frontWall + allowance(frontAngle);
const deckEnd = deckStart + p.topDepth;
export const flatLength =
  deckEnd + allowance(backAngle) + rearWall + allowance(90) + p.returnLength;
export const deckHeight =
  p.frontWall + p.insideRadius * (1 + Math.cos(p.angle * rad));

/** Inside cross-section shared by the sheet-metal definition and the MDF routing. */
export function insideProfile(): Point2[] {
  const branch = (sign: number, angle: number, wall: number, start: number) => {
    const points: Point2[] = [{ x: start, y: 0 }];
    let y = start,
      z = 0;
    const arc = (from: number, to: number) => {
      const originY = y,
        originZ = z,
        steps = Math.ceil((to - from) / 2);
      for (let n = 1; n <= steps; n++) {
        const a = (from + ((to - from) * n) / steps) * rad;
        points.push({
          x:
            originY +
            sign * p.insideRadius * (Math.sin(a) - Math.sin(from * rad)),
          y: originZ + p.insideRadius * (Math.cos(a) - Math.cos(from * rad)),
        });
      }
      y = points.at(-1)!.x;
      z = points.at(-1)!.y;
    };
    arc(0, angle);
    y += sign * wall * Math.cos(angle * rad);
    z -= wall * Math.sin(angle * rad);
    points.push({ x: y, y: z });
    arc(angle, angle + 90);
    return points;
  };
  return [
    ...branch(-1, frontAngle, p.frontWall, 0).reverse(),
    ...branch(1, backAngle, rearWall, p.topDepth),
  ].map((v) => ({
    x: v.x * Math.cos(p.angle * rad) - v.y * Math.sin(p.angle * rad),
    y:
      deckHeight +
      v.x * Math.sin(p.angle * rad) +
      v.y * Math.cos(p.angle * rad),
  }));
}
/** Offset the convex routed cross-section. Curved corners have <=2 degree chords. */
export function offsetProfile(points: Point2[], distance: number): Point2[] {
  const area = points.reduce((sum, a, i) => {
      const b = points[(i + 1) % points.length]!;
      return sum + a.x * b.y - b.x * a.y;
    }, 0),
    sign = area > 0 ? 1 : -1;
  return points.map((v, i) => {
    const a = points[(i + points.length - 1) % points.length]!,
      b = points[(i + 1) % points.length]!;
    const normal = (a: Point2, b: Point2) => {
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      return {
        x: (sign * (b.y - a.y)) / length,
        y: (-sign * (b.x - a.x)) / length,
      };
    };
    const n1 = normal(a, v),
      n2 = normal(v, b),
      denom = 1 + n1.x * n2.x + n1.y * n2.y;
    return {
      x: v.x + (distance * (n1.x + n2.x)) / denom,
      y: v.y + (distance * (n1.y + n2.y)) / denom,
    };
  });
}

@cad.project({
  id: "keyboard-case",
  title: "Bent keyboard case with routed MDF cheeks",
  units: "mm",
})
export class KeyboardCase extends Project {
  readonly shell;
  readonly left;
  readonly right;
  constructor() {
    super({ id: "keyboard-case", label: "20° keyboard case · steel + MDF" });
    const steel = new SheetMaterial({
      id: "steel-1.5",
      name: "1.5 mm steel (provisional)",
      thickness: p.thickness,
      width: 1000,
      height: 2000,
      color: "#8aaab8",
      kerf: 0.2,
    });
    const mdf = new SheetMaterial({
      id: "mdf-18",
      name: "18 mm MDF",
      thickness: p.mdfThickness,
      width: 1250,
      height: 2500,
      color: "#b89467",
      partSpacing: 8,
      sheetMargin: 10,
    });
    this.shell = steel.makeSheetMetalPart({
      id: "bent-shell",
      outline: new Shapes.Rectangle({ width: caseWidth, height: flatLength }),
      bendRules: {
        kFactor: p.kFactor,
        minimumInsideRadius: p.insideRadius,
        defaultRelief: "rectangular",
      },
    });
    const fieldDepth = p.rows * p.slotHeight + (p.rows - 1) * p.gap;
    for (let row = 0; row < p.rows; row++)
      for (let column = 0; column < p.columns; column++)
        this.shell.subtract(
          new Shapes.Box({
            width: p.slotWidth,
            depth: p.slotHeight,
            height: p.thickness,
          }),
          {
            x: p.sideMargin + column * (p.slotWidth + p.gap),
            y:
              deckStart +
              (p.topDepth - fieldDepth) / 2 +
              row * (p.slotHeight + p.gap),
          },
        );
    // Fold distal returns FIRST; then the nearer top bends carry them along.
    const fold = (
      id: string,
      y: number,
      angle: number,
      movingSide: "left" | "right",
    ) =>
      this.shell.bend(
        new Bend({
          id,
          start: { x: 0, y },
          end: { x: caseWidth, y },
          angle,
          movingSide,
          direction: "down",
          insideRadius: p.insideRadius,
        }),
      );
    fold("front-bottom-R5", p.returnLength + allowance(90), 90, "right");
    fold(
      "rear-bottom-R5",
      deckEnd + allowance(backAngle) + rearWall,
      90,
      "left",
    );
    fold("front-top-R5", deckStart, frontAngle, "right");
    fold("rear-top-R5", deckEnd, backAngle, "left");
    this.shell.place({
      rotate: { x: p.angle },
      y: -deckStart * Math.cos(p.angle * rad),
      z: deckHeight - deckStart * Math.sin(p.angle * rad),
    });

    const fit = offsetProfile(insideProfile(), -p.clearance),
      outer = offsetProfile(insideProfile(), p.thickness + p.proud);
    const fitOutline = new Shapes.Polygon({ points: fit }).fitArcs(0.01),
      outerOutline = new Shapes.Polygon({ points: outer }).fitArcs(0.01);
    const inverse = this.shell.worldMatrix().invert();
    this.shell.addInterface(
      "wood-cheek",
      new PartInterface({
        outline: fitOutline,
        frame: {
          origin: new Vector3().applyMatrix4(inverse),
          xAxis: new Vector3(0, 1, 0).transformDirection(inverse),
          yAxis: new Vector3(0, 0, 1).transformDirection(inverse),
        },
      }),
    );
    this.left = mdf.makePart({
      id: "mdf-left",
      label: "18 mm MDF · 3 mm fitting tongue · 8 mm proud",
      outline: outerOutline,
    });
    const rebate = new SolidShape({
      kind: "cut",
      left: outerOutline.extrude(p.engagement).recipe,
      right: this.shell.interface("wood-cheek").outline!.extrude(p.engagement)
        .recipe,
    });
    this.left.subtract(rebate, { z: p.mdfThickness - p.engagement });
    this.left.place({
      x: -(p.mdfThickness - p.engagement),
      rotate: { y: 90, z: 90 },
    });
    this.right = this.left
      .copy({ id: "mdf-right" })
      .place({
        x: caseWidth + p.mdfThickness - p.engagement,
        rotate: { y: 90, z: 90 },
      })
      .mirror({ axis: "z" });
    for (const [i, x] of [12, caseWidth - 12].entries())
      for (const [j, y] of [8, p.topDepth - 8].entries()) {
        const shaft = new Shapes.Cylinder({ diameter: 3, length: 10, z: -5 }),
          head = new Shapes.Cylinder({ diameter: 6, length: 0.8, z: -0.4 });
        new HardwarePart({
          id: `stud-${i + 1}-${j + 1}`,
          label: "M3 × 10 internal weld stud · thread envelope",
          measurementStatus: "provisional",
          shape: new SolidShape({
            kind: "union",
            left: shaft.recipe,
            right: head.recipe,
          }),
        }).place({ relativeTo: this.shell, x, y: deckStart + y });
      }
  }
  @cad.output.technicalDrawing({ fileName: "keyboard-case.pdf" })
  drawing() {
    return new TechnicalDrawing({
      title: `Keyboard case · ${caseWidth} mm · 20° deck · R5 bends`,
      paper: "A3",
      project: "Keyboard enclosure",
      drawingNumber: "KB-001",
      revision: "B",
      material: "Steel 1.5 / MDF 18",
    })
      .view({
        id: "iso",
        of: this,
        kind: "isometric",
        at: { x: 20, y: 35 },
        scale: 0.4,
      })
      .view({
        id: "side",
        of: this,
        kind: "right",
        at: { x: 270, y: 40 },
        scale: 0.6,
      })
      .view({
        id: "top",
        of: this,
        kind: "top",
        at: { x: 25, y: 170 },
        scale: 0.4,
      })
      .dimension({
        view: "iso",
        from: { x: 0, y: 0, z: deckHeight },
        to: { x: caseWidth, y: 0, z: deckHeight },
        offset: 0,
        paperOffset: 12,
        label: `${caseWidth} SHELL`,
      })
      .dimension({
        view: "top",
        from: { x: 0, y: 0, z: deckHeight },
        to: { x: caseWidth, y: 0, z: deckHeight },
        offset: 20,
        label: `Sheet width ${caseWidth} mm`,
      })
      .angle({
        view: "side",
        vertex: { x: caseWidth, y: 0, z: deckHeight },
        from: { x: caseWidth, y: 50, z: deckHeight },
        to: {
          x: caseWidth,
          y: 50 * Math.cos(p.angle * rad),
          z: deckHeight + 50 * Math.sin(p.angle * rad),
        },
        radius: 27,
      })
      .note({
        at: { x: 180, y: 180 },
        text: "1.5 steel; inside R5; 20 degree deck.",
      })
      .note({
        at: { x: 180, y: 188 },
        text: "MDF 18: 3 engagement / 0.25 clearance / 8 proud.",
      })
      .note({
        at: { x: 180, y: 196 },
        text: "4 x M3 x 10 internal stud envelopes; weld to inside.",
      })
      .note({
        at: { x: 180, y: 204 },
        text: "Provisional demo - verify tooling and fit before manufacture.",
      })
      .page(this.flatDrawing());
  }
  flatDrawing() {
    const drawing = new TechnicalDrawing({
      title: "Developed shell - cutting and bending",
      project: "Keyboard enclosure",
      drawingNumber: "KB-001",
      revision: "B",
      material: "Steel 1.5 mm / K=0.42",
      paper: "A3",
    })
      .view({
        id: "flat",
        label: "DEVELOPED BLANK",
        of: this.shell,
        kind: "flat",
        at: { x: 30, y: 30 },
        scale: 0.45,
      })
      .dimension({
        view: "flat",
        from: { x: 0, y: 0, z: 0 },
        to: { x: caseWidth, y: 0, z: 0 },
        offset: 0,
        paperOffset: 9,
      })
      .dimension({
        view: "flat",
        from: { x: 0, y: 0, z: 0 },
        to: { x: 0, y: flatLength, z: 0 },
        offset: 0,
        paperOffset: -10,
      })
      .note({
        at: { x: 155, y: 30 },
        text: "BEND SCHEDULE - order matches model operations",
      })
      .note({
        at: { x: 155, y: 38 },
        text: "ID                       Fold / inside radius / allowance",
      });
    this.shell.unfold().bends.forEach((bend, i) => {
      drawing.note({
        at: { x: 155, y: 48 + i * 9 },
        text: `${i + 1}. ${bend.id}: ${bend.direction} ${bend.angle} deg / R${bend.insideRadius} / BA ${bend.allowance.toFixed(3)}`,
      });
      const y = 30 + (flatLength - bend.start.y) * 0.45;
      drawing.note({ at: { x: 131, y }, text: `${i + 1}` });
    });
    return drawing
      .note({
        at: { x: 155, y: 100 },
        text: "12 cutouts: 2 columns x 6 rows, 96 x 11, equal 8 gap.",
      })
      .note({
        at: { x: 155, y: 109 },
        text: "Solid lines: cut. Chain lines: bend centers and tangent limits.",
      })
      .note({
        at: { x: 155, y: 118 },
        text: "Bend directions referenced to the flat sheet's +Z face.",
      })
      .note({
        at: { x: 155, y: 127 },
        text: "Neutral allowance = angle(rad) x (inside R + K x thickness).",
      })
      .note({
        at: { x: 155, y: 145 },
        text: "CNC DXF is 1:1 mm; drawing DXF retains the sheet scale.",
      })
      .note({
        at: { x: 155, y: 154 },
        text: "K-factor and bend sequence require shop/tooling confirmation.",
      })
      .note({
        at: { x: 155, y: 163 },
        text: "Full-width open ends: no bend relief required on this shell.",
      });
  }
  @cad.output.cutList({ fileName: "keyboard-cut-list.pdf" })
  cutList() {
    return new CutList({ includeLayouts: true });
  }
  @cad.output.manufacturingDxf({ fileName: "keyboard-cnc.zip" })
  dxf() {
    return new ManufacturingDxf({ parts: "all", layout: "one-file-per-part" });
  }
  @cad.output.step({ fileName: "keyboard-case.step" })
  step() {
    return new StepModel({ of: this });
  }
}
