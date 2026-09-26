// Stock and layouts: the pieces of material on hand (full sheets, boards,
// offcuts of any outline), and part blanks placed on them by hand or by
// auto-nesting, checked as they move.
import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import type {
  CadDocument,
  Layout,
  Placement,
  StockPiece,
} from "../../src/document/schema.ts";
import {
  checkLayout,
  parseOutline,
  placedOutline,
  rectangleOutline,
  unplaced,
  type LayoutPart,
} from "../../src/document/layout.ts";
import { kernel, type Model } from "./kernel.ts";
import { outputUrl } from "./api.ts";
import { Field } from "./features/fields.tsx";
import { ToolButton } from "./controls.tsx";
import { Icon } from "./icons.tsx";
import { isTyping, matches, tip } from "./shortcuts.ts";

type Apply = (
  change: (document: CadDocument) => CadDocument,
  merge?: string,
) => void;

const newId = (prefix: string, taken: readonly { id: string }[]) => {
  let n = taken.length + 1;
  while (taken.some((t) => t.id === `${prefix}${n}`)) n++;
  return `${prefix}${n}`;
};

export function LayoutsView({
  document,
  model,
  apply,
  project,
  dirty,
}: {
  document: CadDocument;
  model: Model | undefined;
  apply: Apply;
  project: string;
  dirty: boolean;
}) {
  const stock = document.stock ?? [];
  const layouts = document.layouts ?? [];
  const [selected, setSelected] = useState<string>();
  const layout = layouts.find((l) => l.id === selected) ?? layouts[0];
  const piece = stock.find((p) => p.id === layout?.stock);
  const parts = useMemo<LayoutPart[]>(
    () =>
      (model?.parts ?? []).flatMap((part) =>
        part.stock === "sheet" &&
        part.outline &&
        part.material?.id === piece?.material
          ? [
              {
                id: part.body,
                name: part.name,
                outline: part.outline,
                quantity: part.quantity,
                grain: part.grain,
              },
            ]
          : [],
      ),
    [model, piece?.material],
  );
  const setLayout = (next: Layout, merge?: string) =>
    apply(
      (d) => ({
        ...d,
        layouts: (d.layouts ?? []).map((l) => (l.id === next.id ? next : l)),
      }),
      merge,
    );
  return (
    <div className="layouts">
      <aside className="layout-list">
        <StockList document={document} apply={apply} />
        <header>
          <h2>Layouts</h2>
          <button
            disabled={!stock.length}
            title={stock.length ? undefined : "Add a stock piece first"}
            onClick={() => {
              const id = newId("l", layouts);
              apply((d) => ({
                ...d,
                layouts: [
                  ...(d.layouts ?? []),
                  {
                    id,
                    name: `Layout ${layouts.length + 1}`,
                    stock: stock[0]!.id,
                    kerf: 4,
                    margin: 10,
                    placements: [],
                  },
                ],
              }));
              setSelected(id);
            }}
          >
            New
          </button>
        </header>
        <ul className="list">
          {layouts.map((l) => (
            <li key={l.id}>
              <button
                className={l.id === layout?.id ? "current" : undefined}
                onClick={() => setSelected(l.id)}
              >
                {l.name}
                <small>
                  {stock.find((p) => p.id === l.stock)?.name ?? "no stock"} ·{" "}
                  {l.placements.length} parts
                </small>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      {layout && piece ? (
        <LayoutEditor
          key={layout.id}
          layout={layout}
          piece={piece}
          stock={stock}
          parts={parts}
          others={layouts.filter((l) => l.id !== layout.id)}
          set={setLayout}
          remove={() =>
            apply((d) => ({
              ...d,
              layouts: (d.layouts ?? []).filter((l) => l.id !== layout.id),
            }))
          }
          download={
            dirty ? undefined : outputUrl(project, "layout", "dxf", layout.id)
          }
        />
      ) : (
        <p className="empty">
          Add the stock you have, then a layout to place parts on it.
        </p>
      )}
    </div>
  );
}

function StockList({
  document,
  apply,
}: {
  document: CadDocument;
  apply: Apply;
}) {
  const stock = document.stock ?? [];
  const materials = (document.materials ?? []).filter(
    (m) => m.kind !== "solid",
  );
  const [adding, setAdding] = useState<"sheet" | "offcut">();
  const [size, setSize] = useState("2500 x 1250");
  const [outline, setOutline] = useState(
    "0,0 1000,0 1000,300 600,300 600,600 0,600",
  );
  const [problem, setProblem] = useState<string>();
  const add = () => {
    let points;
    if (adding === "sheet") {
      const [w, h] = (size.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
      if (!w || !h) return setProblem("Give the size as width x height");
      points = rectangleOutline(w, h);
    } else {
      const parsed = parseOutline(outline);
      if (typeof parsed === "string") return setProblem(parsed);
      points = parsed;
    }
    const piece: StockPiece = {
      id: newId("p", stock),
      name: adding === "sheet" ? `Sheet ${size}` : `Offcut ${stock.length + 1}`,
      material: materials[0]!.id,
      kind: adding!,
      outline: points,
      grain: "none",
    };
    apply((d) => ({ ...d, stock: [...(d.stock ?? []), piece] }));
    setAdding(undefined);
    setProblem(undefined);
  };
  const update = (id: string, change: Partial<StockPiece>) =>
    apply((d) => ({
      ...d,
      stock: (d.stock ?? []).map((p) =>
        p.id === id ? { ...p, ...change } : p,
      ),
    }));
  return (
    <>
      <header>
        <h2>Stock</h2>
        <button
          disabled={!materials.length}
          title={
            materials.length
              ? undefined
              : "Add a sheet material under Parts first"
          }
          onClick={() => setAdding("sheet")}
        >
          Sheet
        </button>
        <button
          disabled={!materials.length}
          onClick={() => setAdding("offcut")}
        >
          Offcut
        </button>
      </header>
      {adding ? (
        <div className="stock-form">
          {adding === "sheet" ? (
            <Field label="Size">
              <input value={size} onChange={(e) => setSize(e.target.value)} />
            </Field>
          ) : (
            <label className="field">
              <span className="field-label">Corners (x,y)</span>
              <textarea
                rows={3}
                value={outline}
                onChange={(e) => setOutline(e.target.value)}
              />
            </label>
          )}
          {problem ? <p className="error">{problem}</p> : null}
          <div className="button-row">
            <button className="primary" onClick={add}>
              Add
            </button>
            <button onClick={() => setAdding(undefined)}>Cancel</button>
          </div>
        </div>
      ) : null}
      <ul className="stock-list">
        {stock.map((piece) => (
          <li key={piece.id}>
            <input
              aria-label="Stock name"
              value={piece.name}
              onChange={(e) => update(piece.id, { name: e.target.value })}
            />
            <div className="part-details">
              <select
                aria-label="Material"
                value={piece.material}
                onChange={(e) => update(piece.id, { material: e.target.value })}
              >
                {materials.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              <select
                aria-label="Grain"
                value={piece.grain ?? "none"}
                onChange={(e) =>
                  update(piece.id, {
                    grain: e.target.value as "none" | "x" | "y",
                  })
                }
              >
                <option value="none">no grain</option>
                <option value="x">grain along x</option>
                <option value="y">grain along y</option>
              </select>
              <button
                className="icon"
                aria-label={`Delete ${piece.name}`}
                onClick={() =>
                  apply((d) => ({
                    ...d,
                    stock: (d.stock ?? []).filter((p) => p.id !== piece.id),
                  }))
                }
              >
                ×
              </button>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

function LayoutEditor({
  layout,
  piece,
  stock,
  parts,
  others,
  set,
  remove,
  download,
}: {
  layout: Layout;
  piece: StockPiece;
  stock: readonly StockPiece[];
  parts: readonly LayoutPart[];
  others: readonly Layout[];
  set: (next: Layout, merge?: string) => void;
  remove: () => void;
  download: string | undefined;
}) {
  const [active, setActive] = useState<number>();
  const [message, setMessage] = useState<string>();
  const [nesting, setNesting] = useState(false);
  const issues = useMemo(
    () => checkLayout(layout, piece, parts),
    [layout, piece, parts],
  );
  const flagged = new Set(issues.flatMap((issue) => issue.placements));
  const byId = new Map(parts.map((p) => [p.id, p]));
  const left = unplaced(parts, [...others, layout]);

  // The piece fills the canvas, with room around it; y runs up.
  const xs = piece.outline.map((p) => p.x);
  const ys = piece.outline.map((p) => p.y);
  const box = {
    x: Math.min(...xs),
    y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  };
  const pad = Math.max(box.w, box.h) * 0.04;
  // Labels a readable size whatever the piece measures.
  const label = Math.max(box.w, box.h) / 60;
  const svg = useRef<SVGSVGElement>(null);
  const toModel = (event: PointerEvent) => {
    const matrix = svg.current!.getScreenCTM()!.inverse();
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(
      matrix,
    );
    // The drawing is flipped so y runs up.
    return { x: p.x, y: -p.y };
  };
  const drag = useRef<{
    index: number;
    from: { x: number; y: number };
    start: Placement;
    session: string;
  }>(undefined);
  const place = (index: number, change: Partial<Placement>, merge?: string) =>
    set(
      {
        ...layout,
        placements: layout.placements.map((p, i) =>
          i === index ? { ...p, ...change } : p,
        ),
      },
      merge,
    );
  const points = (outline: readonly { x: number; y: number }[]) =>
    outline.map((p) => `${p.x},${-p.y}`).join(" ");
  const autoNest = async () => {
    if (nesting || !parts.length) return;
    setNesting(true);
    try {
      const result = await kernel().nest(
        { ...layout, placements: [] },
        piece,
        parts,
        others,
      );
      set({ ...layout, placements: [...result.placements] });
      const how =
        result.method === "shape" ? "by their true shapes" : "in rectangles";
      setMessage(
        result.left.length
          ? `Placed ${result.placements.length} ${how}; did not fit: ${result.left.join(", ")}`
          : `Placed ${result.placements.length} parts ${how}`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setNesting(false);
    }
  };
  const removeActive = () => {
    if (active === undefined) return;
    set({
      ...layout,
      placements: layout.placements.filter((_, i) => i !== active),
    });
    setActive(undefined);
  };

  // Keys for the selected part (see shortcuts.ts); replaced every render.
  const onKey = useRef<(event: KeyboardEvent) => void>(() => {});
  onKey.current = (event) => {
    if (event.defaultPrevented || isTyping(event.target)) return;
    if (document.querySelector("dialog[open]")) return;
    const run = (action: () => void) => {
      event.preventDefault();
      action();
    };
    if (matches(event, "layoutNest")) return run(() => void autoNest());
    const count = layout.placements.length;
    if (matches(event, "layoutNext") && count)
      return run(() => setActive(((active ?? -1) + 1) % count));
    if (matches(event, "layoutPrevious") && count)
      return run(() => setActive(((active ?? count) + count - 1) % count));
    const selected =
      active === undefined ? undefined : layout.placements[active];
    if (active === undefined || !selected) return;
    if (matches(event, "cancel")) return run(() => setActive(undefined));
    if (matches(event, "layoutRotateLeft"))
      return run(() =>
        place(active, { rotation: (selected.rotation + 90) % 360 }),
      );
    if (matches(event, "layoutRotateRight"))
      return run(() =>
        place(active, { rotation: (selected.rotation + 270) % 360 }),
      );
    if (matches(event, "layoutFlip"))
      return run(() => place(active, { flip: !selected.flip }));
    if (matches(event, "layoutRemove")) return run(removeActive);
    if (matches(event, "layoutNudge")) {
      const step = event.shiftKey ? 10 : 1;
      const [dx, dy] =
        event.key === "ArrowLeft"
          ? [-step, 0]
          : event.key === "ArrowRight"
            ? [step, 0]
            : event.key === "ArrowUp"
              ? [0, step]
              : [0, -step];
      return run(() =>
        place(
          active,
          { x: selected.x + dx, y: selected.y + dy },
          `nudge:${layout.id}:${active}`,
        ),
      );
    }
  };
  useEffect(() => {
    const keys = (event: KeyboardEvent) => onKey.current(event);
    addEventListener("keydown", keys);
    return () => removeEventListener("keydown", keys);
  }, []);

  return (
    <section className="layout-main">
      <div className="mode-bar">
        <input
          aria-label="Layout name"
          value={layout.name}
          onChange={(e) =>
            set({ ...layout, name: e.target.value }, `name:${layout.id}`)
          }
        />
        <select
          aria-label="Stock piece"
          value={layout.stock}
          onChange={(e) => set({ ...layout, stock: e.target.value })}
        >
          {stock.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {(["kerf", "margin", "minimumStrip"] as const).map((key) => (
          <label key={key} className="inline-number">
            {key === "minimumStrip" ? "min. strip" : key}
            <input
              type="number"
              min={0}
              value={layout[key] ?? 0}
              onChange={(e) =>
                set(
                  {
                    ...layout,
                    [key]: Math.max(0, Number(e.target.value) || 0),
                  },
                  `${key}:${layout.id}`,
                )
              }
            />
          </label>
        ))}
        <select
          aria-label="How auto-nest places parts"
          title="Rectangles suit a panel saw; true shapes interlock parts for a CNC"
          value={layout.nesting ?? "auto"}
          onChange={(e) =>
            set({
              ...layout,
              nesting: e.target.value as NonNullable<Layout["nesting"]>,
            })
          }
        >
          <option value="auto">best of both</option>
          <option value="guillotine">rectangles (saw)</option>
          <option value="shape">true shapes (CNC)</option>
        </select>
        <span className="spacer" />
        <button
          disabled={nesting || !parts.length}
          title={tip("layoutNest", "Auto-nest")}
          onClick={() => void autoNest()}
        >
          <Icon name="pattern" size={16} /> {nesting ? "Nesting…" : "Auto-nest"}
        </button>
        <a
          className={`button${download ? "" : " disabled"}`}
          href={download}
          title={
            download
              ? undefined
              : "Save first: files are made from the saved project"
          }
        >
          DXF
        </a>
        <button className="danger" onClick={remove}>
          Delete
        </button>
      </div>
      <div className="layout-body">
        <svg
          ref={svg}
          className="layout-canvas"
          viewBox={`${box.x - pad} ${-(box.y + box.h) - pad} ${box.w + 2 * pad} ${box.h + 2 * pad}`}
          onPointerMove={(event) => {
            const d = drag.current;
            if (!d) return;
            const at = toModel(event);
            place(
              d.index,
              {
                x: Math.round(d.start.x + at.x - d.from.x),
                y: Math.round(d.start.y + at.y - d.from.y),
              },
              d.session,
            );
          }}
          onPointerUp={() => (drag.current = undefined)}
          onPointerLeave={() => (drag.current = undefined)}
        >
          <polygon className="stock" points={points(piece.outline)} />
          {piece.grain && piece.grain !== "none" ? (
            <text
              className="grain"
              x={box.x + pad / 2}
              y={-(box.y + box.h) + pad}
            >
              grain {piece.grain === "x" ? "→" : "↑"}
            </text>
          ) : null}
          {layout.placements.map((placement, index) => {
            const part = byId.get(placement.part);
            if (!part) return null;
            const outline = placedOutline(part, placement);
            const cx = outline.reduce((s, p) => s + p.x, 0) / outline.length;
            const cy = outline.reduce((s, p) => s + p.y, 0) / outline.length;
            return (
              <g
                key={index}
                className={[
                  "placed",
                  index === active ? "active" : "",
                  flagged.has(index) ? "problem" : "",
                ].join(" ")}
                onPointerDown={(event) => {
                  event.preventDefault();
                  (event.currentTarget.ownerSVGElement ??
                    svg.current)!.setPointerCapture(event.pointerId);
                  setActive(index);
                  drag.current = {
                    index,
                    from: toModel(event),
                    start: placement,
                    session: `drag:${layout.id}:${index}:${Date.now()}`,
                  };
                }}
              >
                <polygon points={points(outline)} />
                <text x={cx} y={-cy} fontSize={label}>
                  {part.name}
                </text>
              </g>
            );
          })}
        </svg>
        <aside className="layout-side">
          {active !== undefined && layout.placements[active] ? (
            <PlacementTools
              placement={layout.placements[active]!}
              name={byId.get(layout.placements[active]!.part)?.name ?? ""}
              change={(c) => place(active, c)}
              remove={removeActive}
            />
          ) : (
            <p className="hint">
              Drag parts to move them; click one to turn or flip it. [ and ]
              select parts, arrows move them, R turns and F flips.
            </p>
          )}
          <h2>Checks</h2>
          {issues.length ? (
            <ul className="issues">
              {issues.map((issue, i) => (
                <li
                  key={i}
                  className={issue.kind === "strip" ? "warning" : "error"}
                >
                  {issue.message}
                </li>
              ))}
            </ul>
          ) : (
            <p className="ok">Everything fits.</p>
          )}
          {message ? <p className="hint">{message}</p> : null}
          <h2>To place</h2>
          {left.length ? (
            <ul className="to-place">
              {left.map(({ part, copies }) => (
                <li key={part.id}>
                  <span>
                    {part.name}
                    {copies > 1 ? ` ×${copies}` : ""}
                  </span>
                  <button
                    onClick={() => {
                      set({
                        ...layout,
                        placements: [
                          ...layout.placements,
                          {
                            part: part.id,
                            x: box.x + (layout.margin ?? 0),
                            y: box.y + (layout.margin ?? 0),
                            rotation: 0,
                          },
                        ],
                      });
                      setActive(layout.placements.length);
                    }}
                  >
                    Place
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">
              {parts.length
                ? "Every part of this material is placed."
                : "No sheet parts of this piece's material."}
            </p>
          )}
        </aside>
      </div>
    </section>
  );
}

function PlacementTools({
  placement,
  name,
  change,
  remove,
}: {
  placement: Placement;
  name: string;
  change: (c: Partial<Placement>) => void;
  remove: () => void;
}) {
  return (
    <div className="placement-tools">
      <strong>{name}</strong>
      <div className="button-row">
        <ToolButton
          icon="rotate_left"
          label="Turn 90° counter-clockwise"
          shortcut="layoutRotateLeft"
          onClick={() => change({ rotation: (placement.rotation + 90) % 360 })}
        />
        <ToolButton
          icon="rotate_right"
          label="Turn 90° clockwise"
          shortcut="layoutRotateRight"
          onClick={() => change({ rotation: (placement.rotation + 270) % 360 })}
        />
        <ToolButton
          icon="mirror"
          label="Flip"
          shortcut="layoutFlip"
          active={!!placement.flip}
          onClick={() => change({ flip: !placement.flip })}
        />
        <ToolButton
          icon="trash"
          label="Take off the stock"
          shortcut="layoutRemove"
          className="danger"
          onClick={remove}
        />
      </div>
      <Field label="Angle">
        <input
          type="number"
          value={placement.rotation}
          onChange={(e) => change({ rotation: Number(e.target.value) || 0 })}
        />
      </Field>
      <Field label="At">
        <span className="size">
          <input
            type="number"
            aria-label="x"
            value={placement.x}
            onChange={(e) => change({ x: Number(e.target.value) || 0 })}
          />
          <input
            type="number"
            aria-label="y"
            value={placement.y}
            onChange={(e) => change({ y: Number(e.target.value) || 0 })}
          />
        </span>
      </Field>
    </div>
  );
}
