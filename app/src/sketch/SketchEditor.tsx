// The sketch canvas: draw lines, rectangles, circles, arcs and slots, select
// and drag geometry, add constraints and dimensions, and see what the solver
// says about them. Every change goes out through `edit` (or `drag`), which
// the app applies to the document, re-solves and keeps in its history.
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type WheelEvent,
} from "react";
import type {
  SketchEntity,
  SketchFeature,
} from "../../../src/document/schema.ts";
import type { SketchSolution } from "../../../src/document/sketch-solver.ts";
import {
  evaluateWith,
  type VariableValues,
} from "../../../src/document/variables.ts";
import { detectProfiles } from "../../../src/document/profiles.ts";
import {
  addArc,
  addCircle,
  addConstraint,
  addLine,
  addRectangle,
  addSlot,
  applicableConstraints,
  canOffset,
  offset,
  trim,
  applicableDimensions,
  newId,
  remove,
  toggleConstruction,
  type NewConstraint,
  type PointInput,
} from "../../../src/document/sketch-edit.ts";
import {
  arcPath,
  distanceToSegment,
  fit,
  gridStep,
  hitTest,
  pointsOf,
  snap,
  toScreen,
  toWorld,
  type Snap,
  type Vec,
  type View,
} from "./geometry.ts";
import {
  dimensionLabel,
  layoutDimensions,
  layoutGlyphs,
} from "./annotations.ts";

type Tool =
  "select" | "line" | "rectangle" | "circle" | "arc" | "slot" | "trim";
const tools: { tool: Tool; label: string; key: string; clicks: string }[] = [
  { tool: "select", label: "Select", key: "Escape", clicks: "" },
  { tool: "line", label: "Line", key: "l", clicks: "Click points; Esc ends" },
  {
    tool: "rectangle",
    label: "Rectangle",
    key: "r",
    clicks: "Click two corners",
  },
  {
    tool: "circle",
    label: "Circle",
    key: "c",
    clicks: "Click the centre, then the edge",
  },
  {
    tool: "arc",
    label: "Arc",
    key: "a",
    clicks: "Click centre, start, end (counter-clockwise)",
  },
  {
    tool: "slot",
    label: "Slot",
    key: "s",
    clicks: "Click both ends, then the width",
  },
  {
    tool: "trim",
    label: "Trim",
    key: "t",
    clicks: "Click the piece of a line to cut away",
  },
];

export interface SketchEditorProps {
  sketch: SketchFeature;
  solution: SketchSolution | undefined;
  variables: VariableValues;
  /** Replaces the sketch with an edited one, computed from `sketch`. */
  edit(next: SketchFeature, merge?: string): void;
  drag(point: string, x: number, y: number, session: string): void;
}

interface Editing {
  readonly constraint: string;
  readonly text: string;
}

export function SketchEditor({
  sketch,
  solution,
  variables,
  edit,
  drag,
}: SketchEditorProps) {
  const wrapper = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  // Until the user pans or zooms, the view is "fit": recomputed from the
  // canvas size on every render, so it is right however late the size
  // settles. Panning or zooming pins it.
  const [view, setView] = useState<View>();
  const [tool, setTool] = useState<Tool>("select");
  const [selection, setSelection] = useState<string[]>([]);
  const [clicks, setClicks] = useState<Snap[]>([]);
  const [hover, setHover] = useState<Snap>();
  const [editing, setEditing] = useState<Editing>();
  /** Distance for the next offset: a number or an expression. */
  const [offsetBy, setOffsetBy] = useState("10");
  const gesture = useRef<
    | { kind: "pan"; start: Vec; view: View; moved: boolean }
    | { kind: "drag"; point: string; session: string; moved: boolean }
  >(undefined);

  const measure = () => {
    const element = wrapper.current;
    // Laid out but not yet sized (a stacked layout on a phone): wait.
    if (element?.clientWidth && element.clientHeight)
      setSize((size) =>
        size.width === element.clientWidth &&
        size.height === element.clientHeight
          ? size
          : { width: element.clientWidth, height: element.clientHeight },
      );
  };
  useLayoutEffect(() => {
    const element = wrapper.current!;
    // Measure now as well (after layout, before paint): resize observers
    // only report on rendered frames, which a hidden page does not get.
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // A different sketch opened: fit it.
  useEffect(() => {
    setView(undefined);
    setSelection([]);
    setClicks([]);
  }, [sketch.id]);

  const current: View = view
    ? { ...view, ...size }
    : fit(sketch, size.width, size.height);
  const points = useMemo(() => pointsOf(sketch), [sketch]);
  const profiles = useMemo(() => detectProfiles(sketch), [sketch]);
  const glyphList = useMemo(
    () => layoutGlyphs(sketch, current),
    [
      sketch,
      current.scale,
      current.cx,
      current.cy,
      current.width,
      current.height,
    ],
  );
  const dimensionList = useMemo(
    () => layoutDimensions(sketch, current, variables),
    [
      sketch,
      variables,
      current.scale,
      current.cx,
      current.cy,
      current.width,
      current.height,
    ],
  );
  const problems = new Set([
    ...(solution?.conflicting ?? []),
    ...(solution?.errors.keys() ?? []),
  ]);
  const redundant = new Set(solution?.redundant ?? []);
  const fullyConstrained = solution?.status === "solved" && solution.dof === 0;

  const worldOf = (event: { clientX: number; clientY: number }) => {
    const box = wrapper.current!.getBoundingClientRect();
    return toWorld(current, {
      x: event.clientX - box.left,
      y: event.clientY - box.top,
    });
  };
  const input = (s: Snap): PointInput =>
    s.kind === "point" ? { id: s.id } : s.at;

  /** After creating geometry on snapped points, pin new points that landed
   * on a curve to it. */
  const pinToCurves = (
    next: SketchFeature,
    placed: readonly { snap: Snap; point: string }[],
  ) => {
    let result = next;
    for (const { snap: s, point } of placed)
      if (s.kind === "curve")
        result = addConstraint(result, {
          type: "onEntity",
          point,
          entity: s.id,
        }).sketch;
    return result;
  };

  const place = (s: Snap) => {
    const all = [...clicks, s];
    const finish = (next: SketchFeature) => {
      edit(next);
      setClicks([]);
    };
    switch (tool) {
      case "line": {
        if (all.length < 2) return setClicks(all);
        const [a, b] = all as [Snap, Snap];
        const made = addLine(sketch, input(a), input(b));
        const line = made.sketch.entities.find(
          (e) => e.id === made.created[made.created.length - 1],
        ) as Extract<SketchEntity, { type: "line" }>;
        edit(
          pinToCurves(made.sketch, [
            { snap: a, point: line.start },
            { snap: b, point: line.end },
          ]),
        );
        // Keep drawing from the end just placed.
        setClicks([{ kind: "point", id: line.end, at: b.at }]);
        return;
      }
      case "rectangle":
        if (all.length < 2) return setClicks(all);
        return finish(addRectangle(sketch, input(all[0]!), all[1]!.at).sketch);
      case "circle": {
        if (all.length < 2) return setClicks(all);
        const [c, edge] = all as [Snap, Snap];
        const radius = Math.hypot(edge.at.x - c.at.x, edge.at.y - c.at.y);
        if (radius <= 0) return;
        return finish(addCircle(sketch, input(c), radius).sketch);
      }
      case "arc":
        if (all.length < 3) return setClicks(all);
        return finish(
          addArc(sketch, input(all[0]!), input(all[1]!), all[2]!.at).sketch,
        );
      case "slot": {
        if (all.length < 3) return setClicks(all);
        const [a, b, w] = all as [Snap, Snap, Snap];
        const radius = distanceToSegment(w.at, a.at, b.at);
        if (radius <= 0) return;
        return finish(addSlot(sketch, a.at, b.at, radius).sketch);
      }
    }
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    wrapper.current!.focus();
    measure();
    // Pin the view before anything is drawn or moved, so new geometry does
    // not make it jump to a new fit.
    if (!view) setView(current);
    if (editing) return;
    const world = worldOf(event);
    if (event.button === 1 || (tool === "select" && event.button === 0)) {
      const target =
        event.button === 0 ? hitTest(sketch, current, world) : undefined;
      if (target?.type === "point" && !event.shiftKey) {
        gesture.current = {
          kind: "drag",
          point: target.id,
          session: newId("d"),
          moved: false,
        };
        setSelection([target.id]);
      } else if (target) {
        setSelection((s) =>
          event.shiftKey
            ? s.includes(target.id)
              ? s.filter((id) => id !== target.id)
              : [...s, target.id]
            : [target.id],
        );
        return;
      } else
        gesture.current = {
          kind: "pan",
          start: { x: event.clientX, y: event.clientY },
          view: current,
          moved: false,
        };
      wrapper.current!.setPointerCapture(event.pointerId);
      return;
    }
    if (event.button === 2) {
      setClicks([]);
      return;
    }
    if (event.button === 0 && tool === "trim") {
      const target = hitTest(sketch, current, world);
      if (target?.type === "line") edit(trim(sketch, target.id, world));
      return;
    }
    if (event.button === 0) place(snap(sketch, current, world));
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const world = worldOf(event);
    const g = gesture.current;
    if (g?.kind === "pan") {
      const dx = (event.clientX - g.start.x) / g.view.scale;
      const dy = (event.clientY - g.start.y) / g.view.scale;
      if (Math.abs(dx) + Math.abs(dy) > 0) g.moved = true;
      setView({ ...g.view, cx: g.view.cx - dx, cy: g.view.cy + dy });
      return;
    }
    if (g?.kind === "drag") {
      g.moved = true;
      drag(g.point, world.x, world.y, g.session);
      return;
    }
    setHover(tool === "select" ? undefined : snap(sketch, current, world));
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    gesture.current = undefined;
    if (wrapper.current!.hasPointerCapture(event.pointerId))
      wrapper.current!.releasePointerCapture(event.pointerId);
    // A click on empty canvas (no pan) clears the selection.
    if (g?.kind === "pan" && !g.moved && event.button === 0) setSelection([]);
  };

  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    const world = worldOf(event);
    const factor = Math.exp(-event.deltaY * 0.0015);
    const scale = Math.min(200, Math.max(0.01, current.scale * factor));
    // Keep the point under the cursor where it is.
    setView({
      ...current,
      scale,
      cx: world.x - (world.x - current.cx) * (current.scale / scale),
      cy: world.y - (world.y - current.cy) * (current.scale / scale),
    });
  };

  const addAndEdit = (constraint: NewConstraint) => {
    const made = addConstraint(sketch, constraint);
    edit(made.sketch);
    // A new dimension opens for typing its value or expression.
    if ("value" in constraint)
      setEditing({ constraint: made.id, text: constraint.value });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (editing || event.target !== wrapper.current) return;
    if (event.key === "Escape") {
      if (clicks.length) setClicks([]);
      else if (tool !== "select") setTool("select");
      else setSelection([]);
      return;
    }
    if (
      (event.key === "Delete" || event.key === "Backspace") &&
      selection.length
    ) {
      event.preventDefault();
      edit(remove(sketch, new Set(selection)));
      setSelection([]);
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "x" && selection.length) {
      edit(toggleConstruction(sketch, new Set(selection)));
      return;
    }
    const chosen = tools.find((t) => t.key === event.key);
    if (chosen) {
      setTool(chosen.tool);
      setClicks([]);
    }
  };

  const commitEditing = () => {
    if (!editing) return;
    const { constraint, text } = editing;
    setEditing(undefined);
    if (!text.trim()) return;
    edit({
      ...sketch,
      constraints: sketch.constraints.map((c) =>
        c.id === constraint && "value" in c ? { ...c, value: text.trim() } : c,
      ),
    });
  };

  const options = applicableConstraints(sketch, selection);
  const dimensionOptions = applicableDimensions(sketch, selection);
  const selectedCurves = selection.some((id) =>
    sketch.entities.some((e) => e.id === id && e.type !== "point"),
  );
  const step = gridStep(current, 40);
  const editedDimension = dimensionList.find(
    (d) => d.constraint === editing?.constraint,
  );

  return (
    <section className="sketch-editor">
      <div className="sketch-toolbar" role="toolbar" aria-label="Sketch tools">
        {tools.map((t) => (
          <button
            key={t.tool}
            className={tool === t.tool ? "active" : undefined}
            title={`${t.label} (${t.key === "Escape" ? "Esc" : t.key.toUpperCase()})`}
            onClick={() => {
              setTool(t.tool);
              setClicks([]);
              wrapper.current?.focus();
            }}
          >
            {t.label}
          </button>
        ))}
        <span className="spacer" />
        <button onClick={() => setView(undefined)}>Fit</button>
      </div>
      <div
        className="sketch-context"
        role="toolbar"
        aria-label="Actions for the selection"
      >
        {selection.length ? null : (
          <span className="hint">
            Select geometry to constrain or dimension it; Shift adds to the
            selection.
          </span>
        )}
        {options.map((option) => (
          <button
            key={option.label}
            onClick={() => addAndEdit(option.constraint)}
          >
            {option.label}
          </button>
        ))}
        {dimensionOptions.map((option) => (
          <button
            key={option.label}
            className="dimension"
            onClick={() => addAndEdit(option.constraint)}
          >
            {option.label}
          </button>
        ))}
        {canOffset(sketch, selection) ? (
          <span className="offset">
            <input
              aria-label="Offset distance"
              title="Distance, or an expression such as t; negative offsets inwards"
              value={offsetBy}
              onChange={(event) => setOffsetBy(event.target.value)}
            />
            <button
              onClick={() => {
                let distance: number;
                try {
                  distance = evaluateWith(offsetBy, variables);
                } catch {
                  return;
                }
                // The constraints hold the size; the sign only picks the side.
                const value = offsetBy.trim().replace(/^-\s*/, "");
                const made = offset(sketch, selection, distance, value);
                if (!made) return;
                edit(made.sketch);
                setSelection(
                  made.created.filter((id) =>
                    made.sketch.entities.some(
                      (e) => e.id === id && e.type !== "point",
                    ),
                  ),
                );
              }}
            >
              Offset
            </button>
          </span>
        ) : null}
        {selectedCurves ? (
          <button
            title="Construction geometry guides the sketch but makes no profile (X)"
            onClick={() => edit(toggleConstruction(sketch, new Set(selection)))}
          >
            Construction
          </button>
        ) : null}
        {selection.length ? (
          <button
            className="danger"
            onClick={() => {
              edit(remove(sketch, new Set(selection)));
              setSelection([]);
            }}
          >
            Delete
          </button>
        ) : null}
      </div>
      <div
        ref={wrapper}
        className={`sketch-canvas tool-${tool}`}
        tabIndex={0}
        aria-label="Sketch canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHover(undefined)}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        onContextMenu={(event) => event.preventDefault()}
      >
        <svg width={size.width} height={size.height}>
          <Grid view={current} step={step} />
          {profiles.regions.map((region) => (
            <path
              key={region.id}
              className="region"
              fillRule="evenodd"
              d={[region.outer, ...region.holes]
                .map(
                  (loop) =>
                    "M " +
                    loop.polygon
                      .map((p) => {
                        const s = toScreen(current, p);
                        return `${s.x} ${s.y}`;
                      })
                      .join(" L ") +
                    " Z",
                )
                .join(" ")}
            />
          ))}
          {sketch.entities.map((entity) => (
            <Curve
              key={entity.id}
              entity={entity}
              points={points}
              view={current}
              selected={selection.includes(entity.id)}
              constrained={fullyConstrained}
            />
          ))}
          {dimensionList.map((d) => (
            <g
              key={d.constraint}
              className={`dimension-mark${problems.has(d.constraint) ? " problem" : redundant.has(d.constraint) ? " redundant" : ""}${selection.includes(d.constraint) ? " selected" : ""}`}
              onPointerDown={(event) => {
                event.stopPropagation();
                setSelection([d.constraint]);
              }}
              onDoubleClick={() => {
                const c = sketch.constraints.find((x) => x.id === d.constraint);
                if (c && "value" in c)
                  setEditing({ constraint: c.id, text: c.value });
              }}
            >
              <line x1={d.from.x} y1={d.from.y} x2={d.to.x} y2={d.to.y} />
              <text
                x={d.at.x}
                y={d.at.y}
                textAnchor="middle"
                dominantBaseline="middle"
              >
                {d.label}
              </text>
            </g>
          ))}
          {glyphList.map((g, i) => (
            <text
              key={`${g.constraint}-${i}`}
              className={`glyph${problems.has(g.constraint) ? " problem" : redundant.has(g.constraint) ? " redundant" : ""}${selection.includes(g.constraint) ? " selected" : ""}`}
              x={g.at.x}
              y={g.at.y}
              textAnchor="middle"
              dominantBaseline="middle"
              onPointerDown={(event) => {
                event.stopPropagation();
                setSelection([g.constraint]);
              }}
            >
              {g.symbol}
            </text>
          ))}
          <Preview tool={tool} clicks={clicks} hover={hover} view={current} />
          {sketch.entities.map((entity) =>
            entity.type === "point" ? (
              <circle
                key={entity.id}
                className={`point${selection.includes(entity.id) ? " selected" : ""}${fullyConstrained ? " constrained" : ""}`}
                cx={toScreen(current, entity).x}
                cy={toScreen(current, entity).y}
                r={3.5}
              />
            ) : null,
          )}
          {hover && hover.kind !== "free" ? (
            <circle
              className="snap"
              cx={toScreen(current, hover.at).x}
              cy={toScreen(current, hover.at).y}
              r={7}
            />
          ) : null}
        </svg>
        {editing && editedDimension ? (
          <input
            className="dimension-input"
            style={{ left: editedDimension.at.x, top: editedDimension.at.y }}
            autoFocus
            // Typing replaces the value; arrow keys still allow editing it.
            onFocus={(event) => event.currentTarget.select()}
            aria-label="Dimension value or expression"
            value={editing.text}
            onChange={(event) =>
              setEditing({ ...editing, text: event.target.value })
            }
            onKeyDown={(event) => {
              if (event.key === "Enter") commitEditing();
              if (event.key === "Escape") setEditing(undefined);
            }}
            onBlur={commitEditing}
          />
        ) : null}
      </div>
      <Status
        solution={solution}
        describe={(id) => describe(sketch, id, variables)}
        tool={tools.find((t) => t.tool === tool)!}
        open={profiles.open.length}
        regions={profiles.regions.length}
        select={(id) => setSelection([id])}
      />
    </section>
  );
}

function Curve({
  entity,
  points,
  view,
  selected,
  constrained,
}: {
  entity: SketchEntity;
  points: ReadonlyMap<string, Vec>;
  view: View;
  selected: boolean;
  constrained: boolean;
}) {
  if (entity.type === "point") return null;
  const className = [
    "curve",
    entity.construction ? "construction" : "",
    selected ? "selected" : "",
    constrained ? "constrained" : "",
  ].join(" ");
  if (entity.type === "line") {
    const a = toScreen(view, points.get(entity.start)!);
    const b = toScreen(view, points.get(entity.end)!);
    return <line className={className} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
  }
  if (entity.type === "circle") {
    const c = toScreen(view, points.get(entity.center)!);
    return (
      <circle
        className={className}
        cx={c.x}
        cy={c.y}
        r={entity.radius * view.scale}
      />
    );
  }
  return (
    <path
      className={className}
      d={arcPath(
        view,
        points.get(entity.center)!,
        points.get(entity.start)!,
        points.get(entity.end)!,
      )}
    />
  );
}

/** What the next click of the active tool would make. */
function Preview({
  tool,
  clicks,
  hover,
  view,
}: {
  tool: Tool;
  clicks: readonly Snap[];
  hover: Snap | undefined;
  view: View;
}) {
  if (!clicks.length || !hover) return null;
  const s = (p: Vec) => toScreen(view, p);
  const [a, b] = [clicks[0]!.at, hover.at];
  switch (tool) {
    case "line":
      return (
        <line
          className="preview"
          x1={s(a).x}
          y1={s(a).y}
          x2={s(b).x}
          y2={s(b).y}
        />
      );
    case "rectangle": {
      const [p, q] = [s(a), s(b)];
      return (
        <rect
          className="preview"
          x={Math.min(p.x, q.x)}
          y={Math.min(p.y, q.y)}
          width={Math.abs(q.x - p.x)}
          height={Math.abs(q.y - p.y)}
        />
      );
    }
    case "circle":
      return (
        <circle
          className="preview"
          cx={s(a).x}
          cy={s(a).y}
          r={Math.hypot(b.x - a.x, b.y - a.y) * view.scale}
        />
      );
    case "arc":
      if (clicks.length === 1)
        return (
          <line
            className="preview"
            x1={s(a).x}
            y1={s(a).y}
            x2={s(b).x}
            y2={s(b).y}
          />
        );
      {
        const start = clicks[1]!.at;
        const r = Math.hypot(start.x - a.x, start.y - a.y);
        const angle = Math.atan2(b.y - a.y, b.x - a.x);
        const end = {
          x: a.x + r * Math.cos(angle),
          y: a.y + r * Math.sin(angle),
        };
        return <path className="preview" d={arcPath(view, a, start, end)} />;
      }
    case "slot":
      if (clicks.length === 1)
        return (
          <line
            className="preview"
            x1={s(a).x}
            y1={s(a).y}
            x2={s(b).x}
            y2={s(b).y}
          />
        );
      {
        const end = clicks[1]!.at;
        const width = distanceToSegment(b, a, end) * 2 * view.scale;
        return (
          <line
            className="preview slot"
            x1={s(a).x}
            y1={s(a).y}
            x2={s(end).x}
            y2={s(end).y}
            strokeWidth={Math.max(width, 1)}
          />
        );
      }
    default:
      return null;
  }
}

function Grid({ view, step }: { view: View; step: number }) {
  const lines: ReactElement[] = [];
  const topLeft = toWorld(view, { x: 0, y: 0 });
  const bottomRight = toWorld(view, { x: view.width, y: view.height });
  for (
    let x = Math.ceil(topLeft.x / step) * step;
    x <= bottomRight.x;
    x += step
  ) {
    const sx = toScreen(view, { x, y: 0 }).x;
    lines.push(
      <line
        key={`x${x}`}
        className={Math.abs(x) < step / 2 ? "axis" : "grid"}
        x1={sx}
        y1={0}
        x2={sx}
        y2={view.height}
      />,
    );
  }
  for (
    let y = Math.ceil(bottomRight.y / step) * step;
    y <= topLeft.y;
    y += step
  ) {
    const sy = toScreen(view, { x: 0, y }).y;
    lines.push(
      <line
        key={`y${y}`}
        className={Math.abs(y) < step / 2 ? "axis" : "grid"}
        x1={0}
        y1={sy}
        x2={view.width}
        y2={sy}
      />,
    );
  }
  return <g>{lines}</g>;
}

/** A short name for a constraint in messages, like "Distance 500". */
function describe(
  sketch: SketchFeature,
  id: string,
  variables: VariableValues,
): string {
  const constraint = sketch.constraints.find((c) => c.id === id);
  if (!constraint) return "Constraint";
  const name =
    constraint.type === "onEntity"
      ? "On"
      : constraint.type[0]!.toUpperCase() + constraint.type.slice(1);
  return "value" in constraint
    ? `${name} ${dimensionLabel(constraint, variables)}`
    : name;
}

function Status({
  solution,
  describe,
  tool,
  open,
  regions,
  select,
}: {
  solution: SketchSolution | undefined;
  describe: (id: string) => string;
  tool: (typeof tools)[number];
  open: number;
  regions: number;
  select: (id: string) => void;
}) {
  const parts: ReactElement[] = [];
  if (!solution) parts.push(<span key="s">Loading solver…</span>);
  else if (solution.status === "failed")
    parts.push(
      <span key="s" className="error">
        The sketch cannot be solved as constrained
      </span>,
    );
  else
    parts.push(
      <span key="s" className={solution.dof === 0 ? "ok" : undefined}>
        {solution.dof === 0
          ? "Fully constrained"
          : `${solution.dof} degree${solution.dof === 1 ? "" : "s"} of freedom left`}
      </span>,
    );
  for (const id of solution?.conflicting ?? [])
    parts.push(
      <button key={`c${id}`} className="link error" onClick={() => select(id)}>
        Conflict: {describe(id)}
      </button>,
    );
  for (const [id, message] of solution?.errors ?? [])
    parts.push(
      <button key={`e${id}`} className="link error" onClick={() => select(id)}>
        {describe(id)}: {message}
      </button>,
    );
  if ((solution?.redundant.length ?? 0) > 0)
    parts.push(
      <span key="r" className="warning">
        {solution!.redundant.length} redundant
      </span>,
    );
  parts.push(
    <span key="p">
      {regions} region{regions === 1 ? "" : "s"}
      {open ? ` · ${open} open curve${open === 1 ? "" : "s"}` : ""}
    </span>,
  );
  if (tool.clicks)
    parts.push(
      <span key="t" className="hint">
        {tool.clicks}
      </span>,
    );
  return <footer className="sketch-status">{parts}</footer>;
}
