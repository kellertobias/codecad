import { useCallback, useEffect, useRef, useState } from "react";
import { KernelClient } from "../../web/kernel/client.ts";
import type { ShapeMesh } from "../../src/kernel/mesh.ts";
import {
  Conflict,
  projects,
  type Project,
  type ProjectSummary,
} from "./api.ts";
import { newPanel, panelRecipe, type PanelDocument } from "./document.ts";
import { Viewport } from "./Viewport.tsx";

type Variables = PanelDocument["variables"];
const fields: { key: keyof Variables; label: string; min: number }[] = [
  { key: "width", label: "Width (mm)", min: 50 },
  { key: "depth", label: "Depth (mm)", min: 50 },
  { key: "thickness", label: "Thickness (mm)", min: 3 },
  { key: "holes", label: "Holes", min: 0 },
];

// One kernel for the life of the page: loading it costs a 22 MB download,
// and React may mount and unmount components more than once.
let sharedKernel: KernelClient | undefined;
const kernel = () => (sharedKernel ??= new KernelClient("/kernel.worker.js"));

export function App() {
  const [list, setList] = useState<ProjectSummary[]>([]);
  const [open, setOpen] = useState<Project<PanelDocument>>();
  const [draft, setDraft] = useState<PanelDocument>();
  const [mesh, setMesh] = useState<ShapeMesh>();
  // Two messages, because a rebuild finishing must not hide what happened
  // to a save.
  const [status, setStatus] = useState("Loading kernel…");
  const [saveMessage, setSaveMessage] = useState<string>();

  const refresh = useCallback(
    () => projects.list().then(setList, (error) => setStatus(String(error))),
    [],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Rebuild whenever the draft changes. Only the latest request's result is
  // shown, so fast typing never flashes an older model.
  const latest = useRef(0);
  useEffect(() => {
    if (!draft) return;
    const request = ++latest.current;
    const timer = setTimeout(() => {
      setStatus("Building…");
      kernel()
        .evaluate(panelRecipe(draft))
        .then(
          (result) => {
            if (request !== latest.current) return;
            setMesh(result.mesh);
            setStatus(
              `Built in ${(result.buildMs + result.meshMs).toFixed(0)} ms · ${(
                result.volume / 1e6
              ).toFixed(2)} dm³`,
            );
          },
          (error: Error) =>
            request === latest.current && setStatus(error.message),
        );
    }, 120);
    return () => clearTimeout(timer);
  }, [draft]);

  const load = async (id: string) => {
    const project = await projects.get<PanelDocument>(id);
    setOpen(project);
    setDraft(project.document);
    setSaveMessage(undefined);
  };
  const create = async () => {
    const project = await projects.create(
      `Panel ${list.length + 1}`,
      newPanel(),
    );
    await refresh();
    setOpen(project);
    setDraft(project.document);
  };
  const save = async () => {
    if (!open || !draft) return;
    try {
      const saved = await projects.save(open.id, open.revision, draft);
      setOpen(saved);
      setSaveMessage(`Saved revision ${saved.revision}`);
      void refresh();
    } catch (error) {
      setSaveMessage(
        error instanceof Conflict
          ? `Not saved: someone saved revision ${error.revision} in the meantime. Reopen the project to see it.`
          : String(error),
      );
    }
  };
  const dirty =
    open && draft && JSON.stringify(open.document) !== JSON.stringify(draft);

  return (
    <div className="shell">
      <aside className="projects">
        <header>
          <strong>Projects</strong>
          <button onClick={create}>New</button>
        </header>
        <ul>
          {list.map((project) => (
            <li key={project.id}>
              <button
                className={project.id === open?.id ? "current" : undefined}
                onClick={() => void load(project.id)}
              >
                {project.name}
                <small>revision {project.revision}</small>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <main>
        {draft && open ? (
          <form
            className="variables"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <h1>{open.name}</h1>
            {fields.map((field) => (
              <label key={field.key}>
                {field.label}
                <input
                  type="number"
                  min={field.min}
                  value={draft.variables[field.key]}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (!Number.isFinite(value) || value < field.min) return;
                    setDraft({
                      ...draft,
                      variables: { ...draft.variables, [field.key]: value },
                    });
                  }}
                />
              </label>
            ))}
            <button type="submit" disabled={!dirty}>
              Save
            </button>
          </form>
        ) : (
          <p className="empty">Open a project or create a new one.</p>
        )}
        <Viewport mesh={draft ? mesh : undefined} />
        <footer role="status">
          {status}
          {saveMessage ? ` · ${saveMessage}` : ""}
        </footer>
      </main>
    </div>
  );
}
