// What the code editor knows about "codecad/part" (src/code-part/sdk.ts),
// for completion and type checks. Kept by hand; tests/code-sdk-types.test.ts
// checks it names everything the part API exports.
export const sdkTypes = `
declare module "codecad/part" {
  export interface Point2 { x: number; y: number }
  export type Vec3 = [number, number, number];
  export type SignedAxis = "x" | "y" | "z" | "-x" | "-y" | "-z";
  export interface Placement {
    x?: number; y?: number; z?: number;
    rotate?: { x?: number; y?: number; z?: number };
  }
  /** A solid, described (not built) until the part is generated. */
  export interface Shape {
    /** Moves (and turns) the shape, in its own coordinates. */
    move(placement: Placement): this;
    mirror(options: { axis: "x" | "y" | "z"; origin?: number }): this;
  }
  export interface Profile extends Shape {
    /** A solid: the profile swept up its z axis. */
    extrude(height: number): Shape;
  }
  export namespace Shapes {
    /** From its minimum corner: width along x, depth along y, height along z. */
    class Box implements Shape {
      constructor(o: { width: number; depth: number; height: number });
      move(placement: Placement): this;
      mirror(options: { axis: "x" | "y" | "z"; origin?: number }): this;
    }
    /** Centred on (x, y, z), along an axis (z by default). */
    class Cylinder implements Shape {
      constructor(o: { diameter: number; length: number; x?: number; y?: number; z?: number; axis?: SignedAxis });
      move(placement: Placement): this;
      mirror(options: { axis: "x" | "y" | "z"; origin?: number }): this;
    }
    class Rectangle implements Profile {
      constructor(o: { width: number; height: number; center?: boolean });
      extrude(height: number): Shape;
      move(placement: Placement): this;
      mirror(options: { axis: "x" | "y" | "z"; origin?: number }): this;
    }
    class Circle implements Profile {
      constructor(o: { diameter: number; x?: number; y?: number });
      extrude(height: number): Shape;
      move(placement: Placement): this;
      mirror(options: { axis: "x" | "y" | "z"; origin?: number }): this;
    }
    class Polygon implements Profile {
      constructor(o: { points: readonly Point2[] });
      extrude(height: number): Shape;
      move(placement: Placement): this;
      mirror(options: { axis: "x" | "y" | "z"; origin?: number }): this;
    }
  }
  export interface ParameterSpec {
    default: number; min?: number; max?: number; label?: string; unit?: "mm" | "deg" | "";
  }
  export interface PlaneFrame { origin: Vec3; x: Vec3; y: Vec3; normal: Vec3 }
  export interface InterfaceSpec {
    id: string;
    name?: string;
    /** Screws and dowels are drilled into the part this one is mated to. */
    kind?: "screw" | "dowel" | "point";
    /** The plane the points lie in, facing away from the part. */
    plane?: PlaneFrame;
    points: readonly Point2[];
    diameter?: number;
    depth?: number;
  }
  export interface PartOutput {
    bodies: readonly { name: string; shape: Shape }[];
    interfaces?: readonly InterfaceSpec[];
  }
  export interface PartDefinition<P extends Record<string, ParameterSpec>> {
    parameters: P;
    build(values: { readonly [K in keyof P]: number }): PartOutput;
  }
  export function definePart<P extends Record<string, ParameterSpec>>(definition: PartDefinition<P>): PartDefinition<P>;
  /** A plane facing \`normal\` (away from the part); the underside by default. */
  export function plane(options?: { origin?: Vec3; normal?: Vec3; x?: Vec3 }): PlaneFrame;
  export function union(first: Shape, ...rest: Shape[]): Shape;
  export function cut(base: Shape, ...tools: Shape[]): Shape;
  export function intersect(first: Shape, ...rest: Shape[]): Shape;
}
`;

/** What a new code part starts as. */
export const starterSource = `import { definePart, Shapes, cut, plane } from "codecad/part";

// A shelf board with holes for cables, screwed from below.
export default definePart({
  parameters: {
    width: { default: 600, min: 100, max: 2000, label: "Width" },
    depth: { default: 250, min: 50, max: 800, label: "Depth" },
    thickness: { default: 18, min: 6, max: 40, label: "Thickness" },
    holes: { default: 2, min: 0, max: 8, label: "Cable holes" },
  },
  build({ width, depth, thickness, holes }) {
    let board = new Shapes.Box({ width, depth, height: thickness });
    for (let i = 0; i < holes; i++) {
      const x = (width * (i + 1)) / (holes + 1);
      board = cut(
        board,
        new Shapes.Cylinder({ diameter: 35, length: thickness * 2, x, y: depth - 40, z: thickness / 2 }),
      );
    }
    return {
      bodies: [{ name: "Shelf", shape: board }],
      interfaces: [
        {
          id: "underside",
          name: "Underside",
          kind: "screw",
          plane: plane(),
          points: [
            { x: 30, y: -depth / 2 },
            { x: width - 30, y: -depth / 2 },
          ],
          diameter: 4,
          depth: 12,
        },
      ],
    };
  },
});
`;
