// The document format the Phase 0 shell edits: a few variables that size a
// panel with a row of shelf-pin holes. Phase 1 replaces this with the real
// document (variables, sketches, features).
import type { Recipe } from "../../src/model.ts";

export interface PanelDocument {
  readonly schemaVersion: 1;
  readonly variables: {
    readonly width: number;
    readonly depth: number;
    readonly thickness: number;
    readonly holes: number;
  };
}

export const newPanel = (): PanelDocument => ({
  schemaVersion: 1,
  variables: { width: 600, depth: 300, thickness: 18, holes: 8 },
});

/** `source` moved by (x, y, z), as a column-major 4 × 4 matrix. */
const translated = (
  source: Recipe,
  x: number,
  y: number,
  z: number,
): Recipe => ({
  kind: "transform",
  source,
  matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1],
});

export function panelRecipe({ variables: v }: PanelDocument): Recipe {
  let recipe: Recipe = {
    kind: "box",
    width: v.width,
    depth: v.depth,
    height: v.thickness,
  };
  const hole: Recipe = {
    kind: "cylinder",
    diameter: 5,
    length: v.thickness * 2,
  };
  const spacing = v.width / (v.holes + 1);
  for (let i = 1; i <= v.holes; i++)
    recipe = {
      kind: "cut",
      left: recipe,
      right: translated(hole, i * spacing, 40, v.thickness / 2),
    };
  return recipe;
}
