import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DocumentError,
  emptyDocument,
  readDocument,
  type CadDocument,
  type Plane,
  type SketchFeature,
} from "../../src/document/schema.ts";
import { evaluateVariables } from "../../src/document/variables.ts";
import { newId, solveDocument } from "../../src/document/sketch-edit.ts";
import type {
  SketchSolution,
  SketchSolver,
} from "../../src/document/sketch-solver.ts";
import { Conflict, projects, type ProjectSummary } from "./api.ts";
import { useDocumentHistory } from "./history.ts";
import { loadSolver } from "./solver.ts";
import { VariablesPanel } from "./VariablesPanel.tsx";
import { SketchEditor } from "./sketch/SketchEditor.tsx";

interface Open {
  readonly id: string;
  readonly name: string;
  readonly revision: number;
  /** The document as last saved, to tell whether there are changes. */
  readonly saved: string;
}

const newSketch = (document: CadDocument, plane: Plane): SketchFeature => {
  let n = document.features.length + 1;
  while (document.features.some((f) => f.name === `Sketch ${n}`)) n++;
  return {
    id: newId("s"),
    type: "sketch",
    name: `Sketch ${n}`,
    plane,
    entities: [],
    constraints: [],
  };
};

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLInputElement ||
  target instanceof HTMLTextAreaElement ||
  target instanceof HTMLSelectElement;

export function App() {
  const [list, setList] = useState<ProjectSummary[]>([]);
  const [open, setOpen] = useState<Open>();
  const [problem, setProblem] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [solver, setSolver] = useState<SketchSolver>();
  const [active, setActive] = useState<string>();
  const [plane, setPlane] = useState<Plane>("XY");
  const history = useDocumentHistory<CadDocument>(emptyDocument());
  const document = history.current;

  useEffect(() => {
    loadSolver().then(setSolver, (error) =>
      setProblem(`The sketch solver did not load: ${String(error)}`),
    );
  }, []);
  const refresh = useCallback(
    () => projects.list().then(setList, (error) => setProblem(String(error))),
    [],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Every change is solved before it enters the history, so the stored
  // document always holds solved positions.
  const solve = useCallback(
    (next: CadDocument) =>
      solver ? solveDocument(next, solver).document : next,
    [solver],
  );
  const change = useCallback(
    (update: (d: CadDocument) => CadDocument, merge?: string) =>
      history.apply((d) => solve(update(d)), merge),
    [history, solve],
  );
  const solved = useMemo(
    () =>
      solver
        ? solveDocument(document, solver)
        : {
            document,
            variables: evaluateVariables(document.variables),
            solutions: new Map<string, SketchSolution>(),
          },
    [document, solver],
  );

  const dirty = open !== undefined && JSON.stringify(document) !== open.saved;
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [dirty]);

  const load = async (id: string) => {
    if (dirty && !confirm("Discard the unsaved changes to this project?"))
      return;
    const project = await projects.get<unknown>(id);
    try {
      const loaded = solve(readDocument(project.document));
      history.reset(loaded);
      setOpen({
        id,
        name: project.name,
        revision: project.revision,
        saved: JSON.stringify(loaded),
      });
      setActive(loaded.features[0]?.id);
      setProblem(undefined);
      setMessage(undefined);
    } catch (error) {
      history.reset(emptyDocument());
      setOpen({
        id,
        name: project.name,
        revision: project.revision,
        saved: "",
      });
      setActive(undefined);
      setMessage(undefined);
      setProblem(
        error instanceof DocumentError
          ? `This project cannot be opened (${error.message}). Saving it replaces it with the empty document shown.`
          : String(error),
      );
    }
  };
  const create = async () => {
    const start = emptyDocument();
    const project = await projects.create(`Project ${list.length + 1}`, {
      ...start,
      features: [newSketch(start, "XY")],
    });
    await refresh();
    await load(project.id);
  };
  const save = useCallback(async () => {
    if (!open) return;
    try {
      const saved = await projects.save(open.id, open.revision, document);
      setOpen({
        ...open,
        revision: saved.revision,
        saved: JSON.stringify(document),
      });
      setMessage(`Saved revision ${saved.revision}`);
      setProblem(undefined);
      void refresh();
    } catch (error) {
      setMessage(
        error instanceof Conflict
          ? `Not saved: revision ${error.revision} was saved elsewhere in the meantime. Reopen the project to see it.`
          : String(error),
      );
    }
  }, [open, document, refresh]);

  // Undo, redo and save from the keyboard, unless a field is being typed in
  // (fields keep their own undo).
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === "s") {
        event.preventDefault();
        void save();
      } else if (!isTyping(event.target) && (key === "z" || key === "y")) {
        event.preventDefault();
        if (key === "y" || event.shiftKey) history.redo();
        else history.undo();
      }
    };
    addEventListener("keydown", keys);
    return () => removeEventListener("keydown", keys);
  }, [history, save]);

  const sketch = document.features.find(
    (f): f is SketchFeature => f.id === active && f.type === "sketch",
  );
  const editSketch = (next: SketchFeature, merge?: string) =>
    change(
      (d) => ({
        ...d,
        features: d.features.map((f) => (f.id === next.id ? next : f)),
      }),
      merge,
    );
  const drag = (point: string, x: number, y: number, session: string) => {
    if (!solver || !sketch) return;
    history.apply(
      (d) =>
        solveDocument(d, solver, { feature: sketch.id, point, x, y }).document,
      `drag:${session}`,
    );
  };

  return (
    <div className="shell">
      <header className="topbar">
        <strong>CodeCAD</strong>
        {open ? <span className="project-name">{open.name}</span> : null}
        <span className="spacer" />
        <button
          onClick={history.undo}
          disabled={!history.canUndo}
          title="Undo (Ctrl/⌘+Z)"
        >
          Undo
        </button>
        <button
          onClick={history.redo}
          disabled={!history.canRedo}
          title="Redo (Shift+Ctrl/⌘+Z)"
        >
          Redo
        </button>
        <button
          className="primary"
          onClick={() => void save()}
          disabled={!open || !dirty}
          title="Save (Ctrl/⌘+S)"
        >
          {dirty ? "Save" : "Saved"}
        </button>
      </header>
      <aside className="sidebar">
        <section>
          <header>
            <h2>Projects</h2>
            <button onClick={() => void create()}>New</button>
          </header>
          <ul className="list">
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
        </section>
        {open ? (
          <section>
            <header>
              <h2>Sketches</h2>
              <select
                aria-label="Plane for a new sketch"
                value={plane}
                onChange={(event) => setPlane(event.target.value as Plane)}
              >
                <option value="XY">XY (top)</option>
                <option value="XZ">XZ (front)</option>
                <option value="YZ">YZ (side)</option>
              </select>
              <button
                onClick={() => {
                  const created = newSketch(document, plane);
                  change((d) => ({ ...d, features: [...d.features, created] }));
                  setActive(created.id);
                }}
              >
                New
              </button>
            </header>
            <ul className="list">
              {document.features.flatMap((feature) =>
                feature.type !== "sketch"
                  ? []
                  : [
                      <FeatureRow
                        key={feature.id}
                        feature={feature}
                        current={feature.id === active}
                        solution={solved.solutions.get(feature.id)}
                        open={() => setActive(feature.id)}
                        rename={(name) =>
                          change((d) => ({
                            ...d,
                            features: d.features.map((f) =>
                              f.id === feature.id ? { ...f, name } : f,
                            ),
                          }))
                        }
                        remove={() =>
                          change((d) => ({
                            ...d,
                            features: d.features.filter(
                              (f) => f.id !== feature.id,
                            ),
                          }))
                        }
                      />,
                    ],
              )}
            </ul>
          </section>
        ) : null}
      </aside>
      <main>
        {problem ? <p className="banner error">{problem}</p> : null}
        {message ? <p className="banner">{message}</p> : null}
        {!open ? (
          <p className="empty">Open a project or create a new one.</p>
        ) : !sketch ? (
          <p className="empty">Choose a sketch, or create one.</p>
        ) : (
          <SketchEditor
            sketch={sketch}
            solution={solved.solutions.get(sketch.id)}
            variables={solved.variables}
            edit={editSketch}
            drag={drag}
          />
        )}
      </main>
      {open ? (
        <aside className="inspector">
          <VariablesPanel
            document={document}
            values={solved.variables}
            apply={change}
          />
        </aside>
      ) : null}
    </div>
  );
}

function FeatureRow({
  feature,
  current,
  solution,
  open,
  rename,
  remove,
}: {
  feature: SketchFeature;
  current: boolean;
  solution: SketchSolution | undefined;
  open: () => void;
  rename: (name: string) => void;
  remove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const state = !solution
    ? ""
    : solution.status === "failed" || solution.conflicting.length
      ? "problem"
      : solution.dof === 0
        ? "constrained"
        : "";
  return (
    <li>
      {editing ? (
        <input
          autoFocus
          aria-label="Sketch name"
          defaultValue={feature.name}
          onBlur={(event) => {
            setEditing(false);
            if (event.target.value.trim()) rename(event.target.value.trim());
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") setEditing(false);
          }}
        />
      ) : (
        <button
          className={`${current ? "current" : ""} ${state}`}
          onClick={open}
          onDoubleClick={() => setEditing(true)}
          title="Double-click to rename"
        >
          {feature.name}
          <small>
            {feature.plane} ·{" "}
            {!solution
              ? "…"
              : state === "problem"
                ? "needs attention"
                : solution.dof === 0
                  ? "fully constrained"
                  : `${solution.dof} free`}
          </small>
        </button>
      )}
      <button
        className="icon"
        aria-label={`Delete ${feature.name}`}
        onClick={remove}
      >
        ×
      </button>
    </li>
  );
}
