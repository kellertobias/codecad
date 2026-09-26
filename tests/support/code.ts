// Code parts in tests: what the editor's sandbox and kernel do, in Node.
import { transform } from "esbuild";
import * as sdk from "../../src/code-part/sdk.js";
import {
  checkCodeOutput,
  type CodePart,
} from "../../src/document/code-part.js";

/** What the editor's sandbox does, in Node: compile, run against the part
 * API, hand back plain data. */
export async function runCode(
  source: string,
  values: Record<string, number> = {},
) {
  const { code } = await transform(source, { loader: "ts", format: "cjs" });
  const module = { exports: {} as Record<string, unknown> };
  new Function("module", "exports", "require", code)(
    module,
    module.exports,
    () => sdk,
  );
  return JSON.parse(
    JSON.stringify(
      sdk.runPart(module.exports.default ?? module.exports, values),
    ),
  );
}

/** A plate `w` wide and `t` thick with two screws on its underside. */
export const plateSource = `
import { definePart, Shapes, plane } from "codecad/part";

export default definePart({
  parameters: {
    w: { default: 60, min: 20, max: 400, label: "Width" },
    t: { default: 3, min: 1 },
  },
  build({ w, t }) {
    const plate = new Shapes.Box({ width: w, depth: 40, height: t });
    return {
      bodies: [{ name: "Plate", shape: plate }],
      interfaces: [{
        id: "mount",
        name: "Mounting face",
        kind: "screw",
        plane: plane(),
        points: [{ x: 10, y: -20 }, { x: w - 10, y: -20 }],
        diameter: 3,
        depth: 10,
      }],
    };
  },
});
`;

export async function codePart(source: string): Promise<CodePart> {
  const output = checkCodeOutput(await runCode(source));
  return {
    source,
    parameters: output.parameters,
    interfaces: output.interfaces.map(({ id, name, kind }) => ({
      id,
      name,
      kind,
    })),
  };
}
