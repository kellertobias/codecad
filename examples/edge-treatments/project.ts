import {
  BlockMaterial,
  Project,
  StepModel,
  TechnicalDrawing,
  WorldAxes,
  cad,
  type BlockPart,
} from "../../src/index.js";

const oak = new BlockMaterial({
  id: "oak",
  name: "Solid oak",
  color: "#c9aa78",
  densityKgPerM3: 700,
});

/** Two blocks that meet at a corner: one broken edge each, then a corner mate. */
@cad.project({ id: "edge-treatments", units: "mm", title: "Broken edges" })
export class EdgeTreatments extends Project {
  readonly base: BlockPart;
  readonly post: BlockPart;
  constructor() {
    super({ id: "edge-treatments" });
    this.base = oak.makePart({
      id: "base",
      label: "Base slab",
      width: 300,
      depth: 200,
      height: 40,
    });
    // A 45 degree break all along the front top edge, and a softer top corner.
    this.base.getEdge("top", "front").chamfer(6);
    this.base.getCorner("top", "right", "back").fillet(12);

    this.post = oak.makePart({
      id: "post",
      label: "Corner post",
      width: 60,
      depth: 60,
      height: 220,
    });
    // Unequal setbacks: 20 mm down the front face, 8 mm back along the top.
    this.post.getEdge("front", "top").chamfer(20, 8);
    // Turn the post a quarter turn, then seat its back-left top corner on the
    // slab's front-right top corner.
    this.post.rotate({ axis: WorldAxes.Z, angle: 90 });
    this.post.place(
      this.post.getCorner("bottom", "left", "back").point(),
      this.base.getCorner("top", "right", "front").point(),
    );
  }
  @cad.output.step()
  step() {
    return new StepModel({ of: this });
  }
  @cad.output.technicalDrawing({ fileName: "broken-edges.pdf" })
  drawing() {
    return new TechnicalDrawing({
      title: "Broken edges",
      paper: "A4",
      orientation: "landscape",
    }).view({
      id: "iso",
      of: this,
      kind: "isometric",
      at: { x: 140, y: 100 },
      scale: 0.5,
    });
  }
}
