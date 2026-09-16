import {
  Project,
  SheetMaterial,
  TechnicalDrawing,
  CutList,
  ManufacturingDxf,
  StepModel,
  defineParameters,
  cad,
  type ParameterValues,
} from "../src/index.js";

export const shelfParameters = defineParameters({
  width: {
    type: "number",
    label: "Overall width",
    unit: "mm",
    default: 800,
    min: 400,
    max: 1200,
    step: 10,
  },
  height: {
    type: "number",
    label: "Overall height",
    unit: "mm",
    default: 900,
    min: 500,
    max: 1800,
    step: 10,
  },
  depth: {
    type: "number",
    label: "Shelf depth",
    unit: "mm",
    default: 320,
    min: 200,
    max: 500,
    step: 10,
  },
  thickness: {
    type: "select",
    label: "Board thickness",
    unit: "mm",
    default: "18",
    options: [
      { value: "12", label: "12 mm" },
      { value: "18", label: "18 mm" },
    ],
  },
  backPanel: { type: "boolean", label: "Include back panel", default: true },
});

@cad.project({
  id: "parameterized-shelf",
  title: "Parameterized shelf",
  units: "mm",
})
export class ParameterizedShelf extends Project {
  readonly settings: ParameterValues<typeof shelfParameters>;
  readonly stock: SheetMaterial;
  constructor() {
    super({ id: "parameterized-shelf", label: "Parameterized shelf" });
    this.settings = this.configureParameters(shelfParameters);
    const { width, height, depth, thickness, backPanel } = this.settings;
    const board = Number(thickness);
    this.stock = new SheetMaterial({
      id: `birch-${thickness}`,
      name: `${thickness} mm birch plywood`,
      width: 1250,
      height: 2500,
      thickness: board,
      kerf: 3.2,
      sheetMargin: 10,
      partSpacing: 6,
      color: "#d2b88d",
    });
    this.stock
      .makePart({ id: "left-side", width: depth, height })
      .place({ x: 0, y: 0 });
    this.stock
      .makePart({ id: "right-side", width: depth, height })
      .place({ x: width - board, y: 0 });
    this.stock
      .makePart({ id: "bottom", width: width - 2 * board, height: depth })
      .place({ x: board, y: 0, z: board });
    this.stock
      .makePart({ id: "middle", width: width - 2 * board, height: depth })
      .place({ x: board, y: height / 2, z: board });
    this.stock
      .makePart({ id: "top", width: width - 2 * board, height: depth })
      .place({ x: board, y: height - depth, z: board });
    if (backPanel)
      this.stock
        .makePart({ id: "back", width: width, height })
        .place({ x: 0, y: 0, z: depth });
  }

  @cad.output.technicalDrawing({ fileName: "shelf-drawing.pdf" })
  drawing() {
    return new TechnicalDrawing({ title: "Parameterized shelf", paper: "A3" })
      .view({
        id: "front",
        of: this,
        kind: "top",
        at: { x: 30, y: 35 },
        scale: 1 / 8,
      })
      .dimension({
        view: "front",
        from: { x: 0, y: 0, z: 0 },
        to: { x: this.settings.width, y: 0, z: 0 },
        offset: 0,
        paperOffset: 12,
      })
      .note({
        at: { x: 230, y: 40 },
        text: `Depth ${this.settings.depth} mm; board ${this.settings.thickness} mm`,
      });
  }

  @cad.output.cutList({ fileName: "shelf-cut-list.csv" })
  cutList() {
    return new CutList({
      materials: [this.stock],
      nesting: "automatic",
      includeLayouts: true,
    });
  }

  @cad.output.manufacturingDxf({ fileName: "shelf-parts.zip" })
  manufacturingDxf() {
    return new ManufacturingDxf({ parts: "all", layout: "nested-by-sheet" });
  }

  @cad.output.step({ fileName: "shelf.step" })
  step() {
    return new StepModel({ of: this });
  }
}
