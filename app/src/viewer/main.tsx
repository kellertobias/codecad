import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Viewer } from "./Viewer.tsx";
import "./viewer.css";

const project = /\/p\/([0-9a-f-]{36})\/view/.exec(location.pathname)?.[1];

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {project ? (
      <Viewer project={project} />
    ) : (
      <p className="viewer-message">Open a project's viewer link.</p>
    )}
  </StrictMode>,
);
