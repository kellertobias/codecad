import { Vector3 } from "three";
import {
  Part,
  PartInterface,
  Shapes,
  DominoJoint,
  HardwarePart,
  Material,
} from "../src/index.js";

const dominoMaterial = new Material({
  id: "beech-domino",
  name: "Beech Domino",
  color: "#d6b17a",
});

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
  const firstPort = port(first, outward);
  const secondPort = port(second, outward.clone().negate());
  const positions = joint.connect({
    first: firstPort,
    second: secondPort,
    count,
    edgeOffset: 30,
  });
  for (const [index, x] of positions.entries()) {
    const connector = new HardwarePart({
      id: `domino-${first.id}-${second.id}-${index + 1}`,
      label: `Beech Domino ${joint.options.width} × ${joint.options.thickness} × ${joint.options.depthPerSide * 2} mm`,
      shape: joint.connectorShape(),
      measurementStatus: "provisional",
    }).place({ relativeTo: firstPort, x });
    connector.drawingMaterial = dominoMaterial;
  }
}
