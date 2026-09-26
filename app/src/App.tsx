import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DocumentError,
  emptyDocument,
  readDocument,
  type CadDocument,
  type EdgeReference,
  type FaceReference,
  type Feature,
  type Plane,
  type SketchFeature,
} from "../../src/document/schema.ts";
import { evaluateVariables } from "../../src/document/variables.ts";
import { solveDocument } from "../../src/document/sketch-edit.ts";
import { detectProfiles } from "../../src/document/profiles.ts";
import {
  insertFeature,
  newFeatureId,
  nextName,
} from "../../src/document/features.ts";
import type {
  SketchSolution,
  SketchSolver,
} from "../../src/document/sketch-solver.ts";
import {
  Conflict,
  library,
  projects,
  type LibraryItemSummary,
  type ProjectSummary,
} from "./api.ts";
import { updateInstance } from "../../src/document/library.ts";
import { LibraryView } from "./LibraryView.tsx";
import { useDocumentHistory } from "./history.ts";
import { loadSolver } from "./solver.ts";
import { kernel, useModel } from "./kernel.ts";
import { VariablesPanel } from "./VariablesPanel.tsx";
import { PartsPanel } from "./PartsPanel.tsx";
import { SketchEditor } from "./sketch/SketchEditor.tsx";
import { sketchSegments } from "./sketch/geometry.ts";
import {
  Viewport,
  type ViewControls,
  type Highlight,
  type Pick,
  type PickMode,
  type SketchOverlay,
} from "./Viewport.tsx";
import { FeatureTree } from "./features/FeatureTree.tsx";
import { DrawingsView } from "./DrawingsView.tsx";
import { LayoutsView } from "./LayoutsView.tsx";
import { FeatureEditor, type PickField } from "./features/FeatureEditor.tsx";
import { ShortcutHelp, ToolButton } from "./controls.tsx";
import { Icon, type IconName } from "./icons.tsx";
import { isTyping, matches, tip, type ShortcutId } from "./shortcuts.ts";

interface Open {
  readonly id: string;
  readonly name: string;
  readonly revision: number;
  /** The document as last saved, to tell whether there are changes. */
  readonly saved: string;
}

type Area = "model" | "drawings" | "layouts" | "library";
const areas: readonly [Area, string, IconName, ShortcutId][] = [
  ["model", "Model", "model", "areaModel"],
  ["drawings", "Drawings", "drawings", "areaDrawings"],
  ["layouts", "Stock & layouts", "layouts", "areaLayouts"],
  ["library", "Library", "library", "areaLibrary"],
];

type Tab = "feature" | "variables" | "parts";

const sameFace = (a: FaceReference, b: FaceReference) =>
  a.body === b.body && a.origin === b.origin && a.role === b.role;
const sameEdge = (a: EdgeReference, b: EdgeReference) =>
  (sameFace(a.a, b.a) && sameFace(a.b, b.b)) ||
  (sameFace(a.a, b.b) && sameFace(a.b, b.a));

export function App() {
  const [list, setList] = useState<ProjectSummary[]>([]);
  const [open, setOpen] = useState<Open>();
  const [problem, setProblem] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [solver, setSolver] = useState<SketchSolver>();
  /** The feature shown in the inspector. */
  const [selected, setSelected] = useState<string>();
  /** The sketch open in the sketch editor. */
  const [sketching, setSketching] = useState<string>();
  const [rollbackAt, setRollback] = useState<number>();
  const [picking, setPicking] = useState<PickField>();
  const [measuring, setMeasuring] = useState(false);
  const [plane, setPlane] = useState<Plane>("XY");
  const [tab, setTab] = useState<Tab>("variables");
  /** What the main area shows. */
  const [area, setArea] = useState<Area>("model");
  const [help, setHelp] = useState(false);
  const viewControls = useRef<ViewControls>(null);
  const [items, setItems] = useState<LibraryItemSummary[]>([]);
  const refreshLibrary = useCallback(
    () => library.list().then(setItems, () => {}),
    [],
  );
  useEffect(() => {
    void refreshLibrary();
  }, [refreshLibrary, area]);
  const latest = useMemo(
    () => new Map(items.map((item) => [item.id, item.latest])),
    [items],
  );
  /** The face last clicked in the 3D view, for a new sketch. */
  const [face, setFace] = useState<Extract<Pick, { kind: "face" }>>();
  const [body, setBody] = useState<string>();
  /** A joint or mate being set up: the parts or faces clicked so far. */
  const [draft, setDraft] = useState<
    | { readonly kind: "joint"; readonly bodies: readonly string[] }
    | { readonly kind: "mate"; readonly faces: readonly FaceReference[] }
  >();
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

  const features = document.features;
  const rollback =
    rollbackAt === undefined || rollbackAt >= features.length - 1
      ? undefined
      : rollbackAt;
  const selectedIndex = features.findIndex((f) => f.id === selected);
  const feature = features[selectedIndex];
  // While picking a reference for a feature, show the model as it is
  // before that feature: its references can only name what came before.
  const until = picking && selectedIndex >= 0 ? selectedIndex - 1 : rollback;
  const {
    model,
    busy,
    error: kernelError,
  } = useModel(open && solver ? document : undefined, until);

  const dirty = open !== undefined && JSON.stringify(document) !== open.saved;
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [dirty]);

  const forget = () => {
    setSelected(undefined);
    setSketching(undefined);
    setRollback(undefined);
    setPicking(undefined);
    setFace(undefined);
    setBody(undefined);
  };
  const load = async (id: string) => {
    if (dirty && !confirm("Discard the unsaved changes to this project?"))
      return;
    const project = await projects.get<unknown>(id);
    forget();
    try {
      const loaded = solve(readDocument(project.document));
      history.reset(loaded);
      setOpen({
        id,
        name: project.name,
        revision: project.revision,
        saved: JSON.stringify(loaded),
      });
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
      setMessage(undefined);
      setProblem(
        error instanceof DocumentError
          ? `This project cannot be opened (${error.message}). Saving it replaces it with the empty document shown.`
          : String(error),
      );
    }
  };
  const create = async () => {
    const project = await projects.create(
      `Project ${list.length + 1}`,
      emptyDocument(),
    );
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

  // Keyboard shortcuts (see shortcuts.ts). The handler is replaced every
  // render, so it always sees the current state; the listener stays.
  const onKey = useRef<(event: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    const keys = (event: KeyboardEvent) => onKey.current(event);
    addEventListener("keydown", keys);
    return () => removeEventListener("keydown", keys);
  }, []);

  const replace = (next: Feature, merge?: string) =>
    change(
      (d) => ({
        ...d,
        features: d.features.map((f) => (f.id === next.id ? next : f)),
      }),
      merge,
    );
  const sketch = features.find(
    (f): f is SketchFeature => f.id === sketching && f.type === "sketch",
  );
  const drag = (point: string, x: number, y: number, session: string) => {
    if (!solver || !sketch) return;
    history.apply(
      (d) =>
        solveDocument(d, solver, { feature: sketch.id, point, x, y }).document,
      `drag:${session}`,
    );
  };

  /** Adds a feature at the rollback bar and selects it. */
  const add = <F extends Feature>(
    type: F["type"],
    make: (id: string, name: string) => F,
  ): F => {
    const next = make(newFeatureId(document, type), nextName(document, type));
    change((d) => insertFeature(d, next, rollback));
    if (rollback !== undefined) setRollback(rollback + 1);
    setSelected(next.id);
    setTab("feature");
    return next;
  };
  /** The sketch a new extrude or hole uses: the selected one, or the last
   * one before the rollback bar. */
  const baseSketch = () => {
    if (feature?.type === "sketch") return feature;
    const upTo = rollback ?? features.length - 1;
    return features
      .slice(0, upTo + 1)
      .reverse()
      .find((f): f is SketchFeature => f.type === "sketch");
  };

  const newSketch = async () => {
    let on: FaceReference | undefined;
    if (face) {
      try {
        const answer = await kernel().pickFace(face.body, face.face);
        if (!answer.planar) return setMessage("Sketches go on flat faces.");
        if (!answer.ref) return setMessage(answer.reason);
        on = answer.ref;
      } catch (error) {
        return setMessage(
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    const created = add("sketch", (id, name) => ({
      id,
      type: "sketch",
      name,
      plane,
      ...(on ? { face: on } : {}),
      entities: [],
      constraints: [],
    }));
    setFace(undefined);
    setSketching(created.id);
  };
  const newExtrude = () => {
    const from = baseSketch();
    if (!from) return setMessage("Draw a sketch first.");
    const regions = [...detectProfiles(from).regions]
      .sort((p, q) => (p.id < q.id ? -1 : 1))
      .map((r) => r.id);
    add("extrude", (id, name) => ({
      id,
      type: "extrude",
      name,
      sketch: from.id,
      ...(regions.length ? { regions } : {}),
      extent: "blind",
      // On a face, the usual next step is a pocket into it.
      ...(from.face
        ? { operation: "cut", distance: "5", reverse: true }
        : { operation: "new", distance: "18" }),
    }));
  };
  const newHole = () => {
    const from = baseSketch();
    if (!from) return setMessage("Draw a sketch with points first.");
    add("hole", (id, name) => ({
      id,
      type: "hole",
      name,
      sketch: from.id,
      kind: "simple",
      diameter: "5",
    }));
  };
  const newRound = (type: "fillet" | "chamfer") => {
    if (type === "fillet")
      add("fillet", (id, name) => ({
        id,
        type,
        name,
        edges: [],
        radius: "3",
      }));
    else
      add("chamfer", (id, name) => ({
        id,
        type,
        name,
        edges: [],
        distance: "2",
      }));
    setPicking("edges");
  };
  const newShell = () => {
    add("shell", (id, name) => ({
      id,
      type: "shell",
      name,
      faces: [],
      thickness: "3",
    }));
    setPicking("faces");
  };
  const newRepeat = (type: "pattern" | "mirror") => {
    const repeat =
      feature?.type === "extrude" || feature?.type === "hole"
        ? [feature.id]
        : [];
    const chosen = body ?? face?.body;
    const bodies = chosen ? { bodies: [chosen] } : {};
    if (type === "pattern")
      add("pattern", (id, name) => ({
        id,
        type,
        name,
        kind: "linear",
        axis: "X",
        count: "3",
        spacing: "32",
        features: repeat,
        ...bodies,
      }));
    else
      add("mirror", (id, name) => ({
        id,
        type,
        name,
        plane: "YZ",
        features: repeat,
        ...bodies,
      }));
  };

  const newMove = () => {
    const chosen = body ?? face?.body;
    add("move", (id, name) => ({
      id,
      type: "move",
      name,
      bodies: chosen ? [chosen] : [],
      translate: ["0", "0", "0"],
    }));
  };

  /** Continues setting up a joint or mate with a click in the view. */
  const onDraft = async (pick: Pick | undefined) => {
    if (!draft || !pick) return;
    if (draft.kind === "joint") {
      const bodies = draft.bodies.includes(pick.body)
        ? draft.bodies
        : [...draft.bodies, pick.body];
      if (bodies.length < 2) return setDraft({ kind: "joint", bodies });
      setDraft(undefined);
      const [a, b] = bodies as [string, string];
      const answer = await kernel().contact(document, rollback, a, b);
      if (!answer.joints.length)
        return setMessage(`No joint fits: ${answer.description}.`);
      setMessage(undefined);
      add("joint", (id, name) => ({
        id,
        type: "joint",
        name,
        kind: answer.joints[0]!,
        a,
        b,
      }));
      return;
    }
    if (pick.kind !== "face") return;
    const answer = await kernel().pickFace(pick.body, pick.face);
    if (!answer.ref) return setMessage(answer.reason);
    if (!answer.planar) return setMessage("Mates join flat faces.");
    const faces = [...draft.faces, answer.ref];
    if (faces.length < 2) return setDraft({ kind: "mate", faces });
    setDraft(undefined);
    const [moving, target] = faces as [FaceReference, FaceReference];
    if (moving.body === target.body)
      return setMessage("Pick the second face on another part.");
    setMessage(undefined);
    add("mate", (id, name) => ({
      id,
      type: "mate",
      name,
      kind: "planar",
      moving,
      target,
    }));
  };

  /** A click in the 3D view: fills the field being picked, or selects. */
  const onPick = async (pick: Pick | undefined) => {
    if (draft) {
      try {
        await onDraft(pick);
      } catch (error) {
        setDraft(undefined);
        setMessage(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (!picking || !feature) {
      // A click selects a face; the body highlight is the parts list's.
      setFace(pick?.kind === "face" ? pick : undefined);
      setBody(undefined);
      return;
    }
    try {
      if (picking === "edges") {
        if (pick?.kind !== "edge") return;
        if (feature.type !== "fillet" && feature.type !== "chamfer") return;
        const answer = await kernel().pickEdge(pick.body, pick.edge);
        if (!answer.ref) return setMessage(answer.reason);
        const ref = answer.ref;
        replace({
          ...feature,
          edges: feature.edges.some((e) => sameEdge(e, ref))
            ? feature.edges.filter((e) => !sameEdge(e, ref))
            : [...feature.edges, ref],
        });
        setMessage(undefined);
        return;
      }
      if ((picking === "a" || picking === "b") && feature.type === "joint") {
        if (!pick) return;
        const other = feature[picking === "a" ? "b" : "a"];
        if (pick.body === other)
          return setMessage("Pick a different part for the other side.");
        replace({ ...feature, [picking]: pick.body });
        setPicking(undefined);
        return;
      }
      if (
        (picking === "movingEdge" || picking === "targetEdge") &&
        feature.type === "mate"
      ) {
        if (pick?.kind !== "edge") return;
        const answer = await kernel().pickEdge(pick.body, pick.edge);
        if (!answer.ref) return setMessage(answer.reason);
        replace({ ...feature, [picking]: answer.ref });
        setPicking(undefined);
        return;
      }
      if (pick?.kind !== "face") return;
      const answer = await kernel().pickFace(pick.body, pick.face);
      if (!answer.ref) return setMessage(answer.reason);
      const ref = answer.ref;
      if (picking === "faces" && feature.type === "shell")
        replace({
          ...feature,
          faces: feature.faces.some((f) => sameFace(f, ref))
            ? feature.faces.filter((f) => !sameFace(f, ref))
            : [...feature.faces, ref],
        });
      else if (picking === "upTo" && feature.type === "extrude") {
        if (!answer.planar) return setMessage("Extrude up to a flat face.");
        replace({ ...feature, upTo: ref });
        setPicking(undefined);
      } else if (
        (picking === "moving" || picking === "target") &&
        feature.type === "mate"
      ) {
        if (!answer.planar) return setMessage("Mates join flat faces.");
        replace({ ...feature, [picking]: ref });
        setPicking(undefined);
      } else if (picking === "instanceTarget" && feature.type === "instance") {
        if (!answer.planar) return setMessage("Mate onto a flat face.");
        const pinned = document.library?.find(
          (p) => p.item === feature.item && p.version === feature.version,
        );
        const first = pinned?.document.interfaces?.[0];
        if (!first) return setMessage("The item has no interface to mate by.");
        replace({
          ...feature,
          mate: feature.mate
            ? { ...feature.mate, target: ref }
            : { interface: first.id, target: ref },
        });
        setPicking(undefined);
      } else if (picking === "face" && feature.type === "sketch") {
        if (!answer.planar) return setMessage("Sketches go on flat faces.");
        replace({ ...feature, face: ref });
        setPicking(undefined);
      }
      setMessage(undefined);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const mode: PickMode = measuring
    ? "measure"
    : draft?.kind === "joint" || picking === "a" || picking === "b"
      ? "body"
      : picking === "edges" ||
          picking === "movingEdge" ||
          picking === "targetEdge"
        ? "edge"
        : "face";
  const highlight = useMemo((): Highlight => {
    const faces = new Map<string, Set<number>>();
    if (face && !picking) faces.set(face.body, new Set([face.face]));
    return {
      faces,
      ...(body && !face && !picking ? { bodies: new Set([body]) } : {}),
    };
  }, [face, body, picking]);

  // Sketches shown in 3D: the selected one, and those nothing uses yet.
  const overlays = useMemo((): SketchOverlay[] => {
    if (!model) return [];
    const used = new Set(
      features.flatMap((f) =>
        f.type === "extrude" || f.type === "hole" ? [f.sketch] : [],
      ),
    );
    return features.flatMap((f) => {
      if (f.type !== "sketch") return [];
      const frame = model.frames.get(f.id);
      if (!frame || (used.has(f.id) && f.id !== selected)) return [];
      return [
        {
          id: f.id,
          frame,
          segments: sketchSegments(f),
          active: f.id === selected,
        },
      ];
    });
  }, [model, features, selected]);

  onKey.current = (event) => {
    if (event.defaultPrevented) return;
    const run = (action: () => void) => {
      event.preventDefault();
      action();
    };
    if (matches(event, "save")) return run(() => void save());
    // Fields keep their own keys, undo included; the overview its own.
    if (isTyping(event.target) || help) return;
    if (matches(event, "undo")) return run(history.undo);
    if (matches(event, "redo")) return run(history.redo);
    if (matches(event, "help")) return run(() => setHelp(true));
    if (!open) return;
    if (sketch) {
      // The sketch editor has its own single keys.
      if (matches(event, "closeSketch")) run(() => setSketching(undefined));
      return;
    }
    for (const [key, , , shortcut] of areas)
      if (matches(event, shortcut)) return run(() => setArea(key));
    if (matches(event, "cancel")) {
      setPicking(undefined);
      setDraft(undefined);
      setMeasuring(false);
      return;
    }
    if (area !== "model") return;
    const index = features.findIndex((f) => f.id === selected);
    const select = (at: number) => {
      const next = features[Math.max(0, Math.min(features.length - 1, at))];
      if (!next) return;
      setSelected(next.id);
      setPicking(undefined);
      setTab("feature");
    };
    const upTo = rollback ?? features.length - 1;
    const onButton =
      event.target instanceof HTMLButtonElement ||
      event.target instanceof HTMLAnchorElement;
    const commands: [ShortcutId, () => void][] = [
      ["sketch", () => void newSketch()],
      ["extrude", newExtrude],
      ["hole", newHole],
      ["fillet", () => newRound("fillet")],
      ["chamfer", () => newRound("chamfer")],
      ["shell", newShell],
      ["pattern", () => newRepeat("pattern")],
      ["mirror", () => newRepeat("mirror")],
      [
        "joint",
        () =>
          setDraft(
            draft?.kind === "joint" ? undefined : { kind: "joint", bodies: [] },
          ),
      ],
      [
        "mate",
        () =>
          setDraft(
            draft?.kind === "mate" ? undefined : { kind: "mate", faces: [] },
          ),
      ],
      ["move", newMove],
      ["measure", () => setMeasuring((m) => !m)],
      ["viewFit", () => viewControls.current?.setView([0.4, -1, 0.7])],
      ["viewFront", () => viewControls.current?.setView([0, -1, 0])],
      ["viewTop", () => viewControls.current?.setView([0, 0, 1])],
      ["viewRight", () => viewControls.current?.setView([1, 0, 0])],
      ["variables", () => setTab("variables")],
      ["parts", () => setTab("parts")],
      [
        "previousFeature",
        () => select(index < 0 ? features.length - 1 : index - 1),
      ],
      ["nextFeature", () => select(index < 0 ? 0 : index + 1)],
      ["rollbackUp", () => setRollback(Math.max(0, upTo - 1))],
      [
        "rollbackDown",
        () =>
          setRollback(upTo + 1 >= features.length - 1 ? undefined : upTo + 1),
      ],
    ];
    if (feature && !onButton)
      commands.push(
        [
          "editFeature",
          () => {
            if (feature.type === "sketch") setSketching(feature.id);
            else setTab("feature");
          },
        ],
        [
          "deleteFeature",
          () => {
            change((d) => ({
              ...d,
              features: d.features.filter((f) => f.id !== feature.id),
            }));
            setSelected(undefined);
            setTab("variables");
          },
        ],
        [
          "suppressFeature",
          () =>
            replace(
              feature.suppressed
                ? (({ suppressed: _s, ...rest }) => rest as Feature)(feature)
                : { ...feature, suppressed: true },
            ),
        ],
      );
    for (const [shortcut, action] of commands)
      if (matches(event, shortcut)) return run(action);
  };

  const failed = model
    ? [...model.status.values()].filter((s) => s.state === "error").length
    : 0;

  return (
    <div
      className={`shell${open && area !== "model" && !sketch ? " wide" : ""}`}
    >
      <header className="topbar">
        <strong>CodeCAD</strong>
        {open ? <span className="project-name">{open.name}</span> : null}
        <span className="spacer" />
        <ToolButton
          icon="undo"
          label="Undo"
          shortcut="undo"
          onClick={history.undo}
          disabled={!history.canUndo}
        />
        <ToolButton
          icon="redo"
          label="Redo"
          shortcut="redo"
          onClick={history.redo}
          disabled={!history.canRedo}
        />
        <ToolButton
          icon={dirty || !open ? "save" : "saved"}
          label={dirty || !open ? "Save" : "Saved"}
          shortcut="save"
          className={dirty ? "primary" : undefined}
          onClick={() => void save()}
          disabled={!open || !dirty}
        />
        {open ? (
          <a
            className="button tool"
            href={`/p/${open.id}/view`}
            target="_blank"
            rel="noreferrer"
            title="The saved project on a phone: model, drawings, cut list and layouts, also offline"
            aria-label="Open the phone viewer"
          >
            <Icon name="phone" />
          </a>
        ) : null}
        <ToolButton
          icon="keyboard"
          label="Keyboard shortcuts"
          shortcut="help"
          onClick={() => setHelp(true)}
        />
      </header>
      {help ? <ShortcutHelp close={() => setHelp(false)} /> : null}
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
              <h2>Features</h2>
            </header>
            <FeatureTree
              document={document}
              status={model?.status}
              selected={selected}
              rollback={rollback}
              select={(id) => {
                setSelected(id);
                setPicking(undefined);
                setTab("feature");
              }}
              open={(id) => {
                setSelected(id);
                setSketching(id);
              }}
              setRollback={setRollback}
              apply={change}
              report={setMessage}
            />
          </section>
        ) : null}
      </aside>
      <main>
        {problem ? <p className="banner error">{problem}</p> : null}
        {message ? (
          <p className="banner">
            {message}{" "}
            <button className="link" onClick={() => setMessage(undefined)}>
              dismiss
            </button>
          </p>
        ) : null}
        {open && !sketch ? (
          <nav className="areas" aria-label="Show">
            {areas.map(([key, label, icon, shortcut]) => (
              <button
                key={key}
                className={area === key ? "active" : undefined}
                title={tip(shortcut, label)}
                onClick={() => setArea(key)}
              >
                <Icon name={icon} size={16} />
                <span>{label}</span>
              </button>
            ))}
          </nav>
        ) : null}
        {!open ? (
          <p className="empty">Open a project or create a new one.</p>
        ) : area === "drawings" && !sketch ? (
          <DrawingsView
            document={document}
            model={model}
            variables={solved.variables}
            apply={change}
            project={open.id}
            dirty={dirty}
          />
        ) : area === "library" && !sketch ? (
          <LibraryView
            document={document}
            items={items}
            refresh={refreshLibrary}
            apply={change}
            rollback={rollback}
            inserted={(id) => {
              setSelected(id);
              setTab("feature");
              setArea("model");
              if (rollback !== undefined) setRollback(rollback + 1);
            }}
            report={setMessage}
          />
        ) : area === "layouts" && !sketch ? (
          <LayoutsView
            document={document}
            model={model}
            apply={change}
            project={open.id}
            dirty={dirty}
          />
        ) : sketch ? (
          <>
            <div className="mode-bar">
              <strong>{sketch.name}</strong>
              <span className="hint">
                {sketch.face ? "on a face" : `${sketch.plane} plane`}
              </span>
              <span className="spacer" />
              <button
                className="primary"
                title={tip("closeSketch")}
                onClick={() => setSketching(undefined)}
              >
                <Icon name="close_sketch" size={16} /> Close sketch
              </button>
            </div>
            <SketchEditor
              sketch={sketch}
              solution={solved.solutions.get(sketch.id)}
              variables={solved.variables}
              edit={(next, merge) => replace(next, merge)}
              drag={drag}
              reference={model?.projections.get(sketch.id)}
            />
          </>
        ) : (
          <>
            <div className="model-toolbar">
              <select
                aria-label="Plane for a new sketch"
                value={plane}
                onChange={(event) => setPlane(event.target.value as Plane)}
                disabled={!!face}
              >
                <option value="XY">XY (top)</option>
                <option value="XZ">XZ (front)</option>
                <option value="YZ">YZ (side)</option>
              </select>
              <ToolButton
                icon="sketch"
                label={
                  face
                    ? "Sketch on the selected face"
                    : `Sketch on the ${plane} plane`
                }
                shortcut="sketch"
                onClick={() => void newSketch()}
              />
              <span className="separator" />
              <ToolButton
                icon="extrude"
                label="Extrude"
                shortcut="extrude"
                onClick={newExtrude}
              />
              <ToolButton
                icon="hole"
                label="Hole"
                shortcut="hole"
                onClick={newHole}
              />
              <ToolButton
                icon="fillet"
                label="Fillet"
                shortcut="fillet"
                onClick={() => newRound("fillet")}
              />
              <ToolButton
                icon="chamfer"
                label="Chamfer"
                shortcut="chamfer"
                onClick={() => newRound("chamfer")}
              />
              <ToolButton
                icon="shell"
                label="Shell"
                shortcut="shell"
                onClick={newShell}
              />
              <ToolButton
                icon="pattern"
                label="Pattern"
                shortcut="pattern"
                onClick={() => newRepeat("pattern")}
              />
              <ToolButton
                icon="mirror"
                label="Mirror"
                shortcut="mirror"
                onClick={() => newRepeat("mirror")}
              />
              <span className="separator" />
              <ToolButton
                icon="joint"
                label="Joint: click two touching parts, then choose how they are joined"
                shortcut="joint"
                active={draft?.kind === "joint"}
                onClick={() =>
                  setDraft(
                    draft?.kind === "joint"
                      ? undefined
                      : { kind: "joint", bodies: [] },
                  )
                }
              />
              <ToolButton
                icon="mate"
                label="Mate: click a face of the part to move, then the face it goes onto"
                shortcut="mate"
                active={draft?.kind === "mate"}
                onClick={() =>
                  setDraft(
                    draft?.kind === "mate"
                      ? undefined
                      : { kind: "mate", faces: [] },
                  )
                }
              />
              <ToolButton
                icon="move"
                label="Move"
                shortcut="move"
                onClick={newMove}
              />
              <span className="separator" />
              <ToolButton
                icon="measure"
                label="Measure"
                shortcut="measure"
                active={measuring}
                onClick={() => setMeasuring((m) => !m)}
              />
            </div>
            <Viewport
              bodies={model?.bodies ?? []}
              sketches={overlays}
              mode={mode}
              highlight={highlight}
              controls={viewControls}
              onPick={(pick) => void onPick(pick)}
            />
            <div className="model-status">
              {draft ? (
                <span className="ok">
                  {draft.kind === "joint"
                    ? draft.bodies.length
                      ? "Now click the part it joins."
                      : "Click the first of two touching parts."
                    : draft.faces.length
                      ? "Now click the face it goes onto."
                      : "Click a face of the part to move."}{" "}
                  Esc cancels.
                </span>
              ) : picking ? (
                <span className="ok">
                  Click{" "}
                  {picking === "edges"
                    ? "edges"
                    : picking === "a" || picking === "b"
                      ? "a part"
                      : picking === "movingEdge" || picking === "targetEdge"
                        ? "an edge"
                        : "a face"}{" "}
                  in the view
                  {until !== undefined && until < features.length - 1
                    ? " (the model is shown as it is before this feature)"
                    : ""}
                  . Esc ends.
                </span>
              ) : face ? (
                <span>Face selected: Sketch (S) starts a sketch on it.</span>
              ) : null}
              <span className="spacer" />
              {kernelError ? (
                <span className="error">{kernelError}</span>
              ) : null}
              {failed ? (
                <span className="error">
                  {failed} feature{failed === 1 ? "" : "s"} failed
                </span>
              ) : null}
              <span className="hint">
                {busy
                  ? "Building…"
                  : model
                    ? `${model.bodies.length} bod${model.bodies.length === 1 ? "y" : "ies"} · ${Math.round(model.ms)} ms`
                    : "Loading the kernel…"}
              </span>
            </div>
          </>
        )}
      </main>
      {open && (area === "model" || sketch) ? (
        <aside className="inspector">
          <nav className="tabs">
            {feature ? (
              <button
                className={tab === "feature" ? "active" : undefined}
                onClick={() => setTab("feature")}
              >
                {feature.name}
              </button>
            ) : null}
            <button
              className={tab === "variables" ? "active" : undefined}
              onClick={() => setTab("variables")}
            >
              Variables
            </button>
            <button
              className={tab === "parts" ? "active" : undefined}
              onClick={() => setTab("parts")}
            >
              Parts
            </button>
          </nav>
          {tab === "feature" && feature ? (
            <FeatureEditor
              document={document}
              feature={feature}
              status={model?.status.get(feature.id)}
              variables={solved.variables}
              model={model}
              picking={picking}
              setPicking={setPicking}
              update={replace}
              editSketch={(id) => setSketching(id)}
              library={{
                latest,
                update: (instance) => {
                  const target = features.find(
                    (f) => f.id === instance && f.type === "instance",
                  );
                  if (target?.type !== "instance") return;
                  const newest = latest.get(target.item);
                  if (newest === undefined) return;
                  const item = items.find((i) => i.id === target.item)!;
                  void library.version<CadDocument>(target.item, newest).then(
                    (version) =>
                      change((d) =>
                        updateInstance(
                          d,
                          instance,
                          { id: item.id, name: item.name },
                          version,
                        ),
                      ),
                    (error) => setMessage(String(error)),
                  );
                },
              }}
              close={() => {
                setSelected(undefined);
                setPicking(undefined);
                setTab("variables");
              }}
            />
          ) : tab === "parts" ? (
            <PartsPanel
              document={document}
              model={model}
              variables={solved.variables}
              apply={change}
              selected={body}
              select={setBody}
            />
          ) : (
            <VariablesPanel
              document={document}
              values={solved.variables}
              apply={change}
            />
          )}
        </aside>
      ) : null}
    </div>
  );
}
