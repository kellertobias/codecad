import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Viewer } from "./Viewer.tsx";
import type { ViewerSource } from "./data.ts";
import "./viewer.css";

const project = /\/p\/([0-9a-f-]{36})\/view/.exec(location.pathname)?.[1];
const shared = /\/s\/([A-Za-z0-9_-]{32})/.exec(location.pathname)?.[1];
const source: ViewerSource | undefined = project
  ? { kind: "project", id: project }
  : shared
    ? { kind: "shared", token: shared }
    : undefined;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {source ? (
      <Viewer source={source} />
    ) : (
      <p className="viewer-message">Open a project's viewer link.</p>
    )}
  </StrictMode>,
);
