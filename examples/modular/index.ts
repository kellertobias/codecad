import type { ProjectInfo } from "../../src/index.js";

// Importing the output modules here is what registers them.
import "./drawing.js";
import "./manufacturing.js";
import "./motion.js";

export * from "./project.js";

export const PROJECTINFO: ProjectInfo = {
  name: "Modular outputs",
  author: "CodeCAD",
  description:
    "One assembly module plus drawing, manufacturing and motion modules, each bound with @cad.outputsFor.",
  revision: "A",
};
