import * as THREE from "three";

export interface WoodAppearance {
  direction: "width" | "height" | "none";
  layers: readonly {
    thickness: number;
    direction: "width" | "height";
  }[];
}

/** Local Z is sheet thickness; veneer order is bottom to top. */
export function woodFragmentCode(wood: WoodAppearance): string {
  let boundary = 0;
  const bands = wood.layers.map((layer, index) => {
    boundary += layer.thickness;
    const shade = layer.direction === "height" ? 1.09 : 0.77;
    const tint = index % 2 ? 0.97 : 1;
    return `if (woodDepth <= ${boundary.toFixed(5)}) woodShade = ${(shade * tint).toFixed(5)}; else `;
  });
  const edge = wood.layers.length
    ? `float woodDepth = max(vWoodLocalPosition.z, 0.0);\n  float woodShade = 1.0;\n  ${bands.join("")} woodShade = 1.0;\n  diffuseColor.rgb *= woodShade;`
    : "";
  const across = wood.direction === "height" ? "x" : "y";
  const along = wood.direction === "height" ? "y" : "x";
  const face =
    wood.direction === "none"
      ? ""
      : `float grain = sin(vWoodLocalPosition.${across} * 0.11 + sin(vWoodLocalPosition.${along} * 0.018) * 0.8);\n  diffuseColor.rgb *= 0.96 + 0.07 * grain;`;
  return `if (abs(normalize(vWoodLocalNormal).z) < 0.72) { ${edge} } else { ${face} }`;
}

export function applyWoodAppearance(
  material: THREE.MeshPhysicalMaterial,
  wood: WoodAppearance,
): void {
  material.customProgramCacheKey = () => `wood:${JSON.stringify(wood)}`;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vWoodLocalPosition;\nvarying vec3 vWoodLocalNormal;",
      )
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvWoodLocalPosition = position;\nvWoodLocalNormal = normal;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vWoodLocalPosition;\nvarying vec3 vWoodLocalNormal;",
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>\n${woodFragmentCode(wood)}`,
      );
  };
}
