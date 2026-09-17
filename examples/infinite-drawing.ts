import { Project, SheetMaterial, TechnicalDrawing, cad } from "../src/index.js";

/** A code-defined, unbounded sketch with an optional printable plan. */
@cad.project({ id: "infinite-drawing", title: "Infinite drawing", units: "mm" })
export class InfiniteDrawing extends Project {
  constructor() {
    super({ id: "infinite-drawing", label: "Infinite drawing" });
    const stock = new SheetMaterial({
      id: "birch-panel",
      name: "Birch plywood",
      width: 600,
      height: 400,
      thickness: 12,
    });
    stock.makePart({ id: "panel", width: 280, height: 180 });

    // The Drawings workspace has no page boundary; coordinates are millimetres.
    this.view2D
      .path(
        [
          { x: 0, y: 0 },
          { x: 280, y: 0 },
          { x: 280, y: 180 },
          { x: 0, y: 180 },
        ],
        { closed: true, label: "Panel outline" },
      )
      .line(
        { x: -60, y: 90 },
        { x: 340, y: 90 },
        {
          label: "Centre line",
          color: "#7f9ca8",
        },
      );
    for (const x of [25, 255])
      for (const y of [25, 155])
        this.view2D.circle({ x, y }, 4, { label: "Mounting hole" });
  }

  @cad.output.technicalDrawing({ fileName: "panel-plan.pdf" })
  printablePlan() {
    return new TechnicalDrawing({ title: "Panel plan", paper: "A4" }).view({
      id: "panel-top",
      of: this,
      kind: "top",
      at: { x: 25, y: 30 },
      scale: 0.6,
    });
  }
}
