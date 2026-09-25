// The sketch solver, loaded once for the page from the planegcs WASM file
// that Vite serves next to the bundle.
import wasm from "@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url";
import { SketchSolver } from "../../src/document/sketch-solver.ts";

let loading: Promise<SketchSolver> | undefined;

export const loadSolver = () => (loading ??= SketchSolver.create({ wasm }));
