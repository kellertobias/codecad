import {
  Project,
  Part,
  Shapes,
  StepModel,
  TechnicalDrawing,
  cad,
} from "../src/index.js";

/** A printable room shell: floor and intersecting walls become one CAD part. */
@cad.project({ id: "joined-solids", units: "mm", title: "Joined room shell" })
export class JoinedSolids extends Project {
  readonly shell: Part;
  constructor() {
    super({ id: "joined-solids" });
    const box = (id: string, width: number, depth: number, height: number) =>
      new Part({ id, shape: new Shapes.Box({ width, depth, height }) });
    const floor = box("floor", 100, 80, 3);
    const back = box("back", 100, 3, 40).place({ y: 77 });
    const left = box("left", 3, 80, 40);
    const right = box("right", 3, 80, 40).place({ x: 97 });
    back.subtract(new Shapes.Box({ width: 26, depth: 5, height: 18 }), {
      x: 36,
      y: -1,
      z: 14,
    });
    this.shell = this.joinSolids([floor, back, left, right], {
      id: "room-shell",
    });
    // Further edits operate in the new part's local coordinates.
    this.shell.union(new Shapes.Box({ width: 15, depth: 8, height: 5 }), {
      x: 42,
      y: 35,
      z: 2,
    });
  }
  @cad.output.step()
  step() {
    return new StepModel({ of: this.shell });
  }
  @cad.output.technicalDrawing({ fileName: "room-shell.pdf" })
  drawing() {
    return new TechnicalDrawing({
      title: "Joined printable room shell",
      paper: "A4",
      orientation: "landscape",
    }).view({
      id: "iso",
      of: this.shell,
      kind: "isometric",
      at: { x: 35, y: 35 },
      scale: 1,
    });
  }
}
