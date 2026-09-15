import { Vector3 } from "three";
import { Part, PartInterface, Shapes, DominoJoint } from "../src/index.js";

/** A common world-space contact plane; opposite normals cut into the two parts. */
export function pairedDominoes(
  first: Part,
  second: Part,
  origin: Vector3,
  along: Vector3,
  outward: Vector3,
  length: number,
  joint: DominoJoint,
  count: number,
) {
  const port = (part: Part, normal: Vector3) => {
    const inverse = part.worldMatrix().invert();
    const point = origin.clone().applyMatrix4(inverse);
    const x = along.clone().normalize(),
      y = normal.clone().normalize().cross(x);
    return new PartInterface({
      outline: new Shapes.Rectangle({
        width: length,
        height: joint.options.thickness,
      }),
      frame: {
        origin: point,
        xAxis: x.transformDirection(inverse),
        yAxis: y.transformDirection(inverse),
      },
    }).bind(part);
  };
  joint.connect({
    first: port(first, outward),
    second: port(second, outward.clone().negate()),
    count,
    edgeOffset: 30,
  });
}
