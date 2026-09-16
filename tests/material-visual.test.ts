import { test } from "node:test";
import assert from "node:assert/strict";
import { BlockMaterial, Project, cad } from "../src/index.js";
import { OpenCascadeEngine } from "../src/engine.js";
import { glb } from "../src/exporters.js";

@cad.project({ id: "visual-material-test", units: "mm" })
class VisualMaterialProject extends Project {
  constructor() {
    super({ id: "visual-material-test" });
    const glass = new BlockMaterial({
      color: "#88bbcc",
      opacity: 0.4,
      reflectivity: 0.8,
    });
    glass.makePart({ id: "pane", width: 100, depth: 10, height: 80 });
  }
}

test("transparent reflective material reaches mesh and GLB", async () => {
  const engine = new OpenCascadeEngine();
  try {
    const model = await engine.evaluate({
      root: new VisualMaterialProject(),
      revision: 1,
    });
    const mesh = model.meshes[0]!;
    assert.equal(mesh.color, "#88bbcc");
    assert.equal(mesh.opacity, 0.4);
    assert.equal(mesh.reflectivity, 0.8);
    const bytes = Buffer.from(await glb(model.meshes));
    assert.equal(bytes.toString("ascii", 0, 4), "glTF");
    const jsonLength = bytes.readUInt32LE(12);
    const manifest = JSON.parse(bytes.toString("utf8", 20, 20 + jsonLength));
    assert.equal(manifest.materials[0].alphaMode, "BLEND");
    assert.equal(
      manifest.materials[0].pbrMetallicRoughness.baseColorFactor[3],
      0.4,
    );
    assert.ok(manifest.materials[0].extensions?.KHR_materials_clearcoat);
  } finally {
    engine.dispose();
  }
});
