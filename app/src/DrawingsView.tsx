// Drawing sheets: the document's own sheets and a manufacturing sheet for
// every sheet part. The preview is drawn by the kernel worker from the
// document on screen; the files come from the server, made from the saved
// project.
import { useEffect, useMemo, useState } from "react";
import type {
  CadDocument,
  DrawingSheet,
  DrawingView,
  ViewAngle,
} from "../../src/document/schema.ts";
import { partSheets } from "../../src/document/sheets.ts";
import type { VariableValues } from "../../src/document/variables.ts";
import { kernel, type Model } from "./kernel.ts";
import { outputUrl } from "./api.ts";
import { Choice, ExpressionField, Field } from "./features/fields.tsx";

type Apply = (change: (document: CadDocument) => CadDocument) => void;
/** A view before it has an id, for every kind of view. */
type NewView = DrawingView extends infer V
  ? V extends DrawingView
    ? Omit<V, "id">
    : never
  : never;

const angles: readonly ViewAngle[] = [
  "front",
  "top",
  "right",
  "left",
  "back",
  "bottom",
  "isometric",
];

export function DrawingsView({
  document,
  model,
  variables,
  apply,
  project,
  dirty,
}: {
  document: CadDocument;
  model: Model | undefined;
  variables: VariableValues;
  apply: Apply;
  project: string;
  dirty: boolean;
}) {
  const own = document.drawings ?? [];
  const generated = useMemo(() => partSheets(model?.parts ?? []), [model]);
  const [selected, setSelected] = useState<string>();
  const sheet =
    [...own, ...generated].find((s) => s.id === selected) ??
    own[0] ??
    generated[0];
  const editable = !!sheet && own.some((s) => s.id === sheet.id);

  const [preview, setPreview] = useState<{ url?: string; error?: string }>({});
  useEffect(() => {
    if (!sheet || !model) return;
    let current = true;
    const timer = setTimeout(() => {
      kernel()
        .drawing(document, sheet)
        .then(
          ({ svg }) => {
            if (!current) return;
            const url = URL.createObjectURL(
              new Blob([svg], { type: "image/svg+xml" }),
            );
            setPreview((old) => {
              if (old.url) URL.revokeObjectURL(old.url);
              return { url };
            });
          },
          (error) =>
            current &&
            setPreview({
              error: error instanceof Error ? error.message : String(error),
            }),
        );
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [document, sheet, model]);

  const change = (next: DrawingSheet) =>
    apply((d) => ({
      ...d,
      drawings: (d.drawings ?? []).map((s) => (s.id === next.id ? next : s)),
    }));
  const addSheet = () => {
    let n = own.length + 1;
    while (own.some((s) => s.id === `d${n}`)) n++;
    const created: DrawingSheet = {
      id: `d${n}`,
      name: `Drawing ${n}`,
      size: "A3",
      views: [
        { id: "front", kind: "view", angle: "front" },
        { id: "top", kind: "view", angle: "top" },
        { id: "right", kind: "view", angle: "right" },
        { id: "iso", kind: "view", angle: "isometric" },
      ],
    };
    apply((d) => ({ ...d, drawings: [...(d.drawings ?? []), created] }));
    setSelected(created.id);
  };

  return (
    <div className="drawings">
      <aside className="drawing-list">
        <header>
          <h2>Drawings</h2>
          <button onClick={addSheet}>New</button>
        </header>
        <ul className="list">
          {own.map((s) => (
            <li key={s.id}>
              <button
                className={s.id === sheet?.id ? "current" : undefined}
                onClick={() => setSelected(s.id)}
              >
                {s.name}
                <small>
                  {s.size} · {s.views.length} views
                </small>
              </button>
            </li>
          ))}
        </ul>
        <h2>Part sheets</h2>
        <ul className="list">
          {generated.map((s) => (
            <li key={s.id}>
              <button
                className={s.id === sheet?.id ? "current" : undefined}
                onClick={() => setSelected(s.id)}
              >
                {s.name}
              </button>
            </li>
          ))}
          {!generated.length ? (
            <li className="hint">Sheet parts get a manufacturing sheet.</li>
          ) : null}
        </ul>
      </aside>
      <section className="drawing-main">
        {!sheet ? (
          <p className="empty">Add a drawing, or make sheet parts.</p>
        ) : (
          <>
            <div className="mode-bar">
              <strong>{sheet.name}</strong>
              <span className="spacer" />
              {(["pdf", "dxf", "svg"] as const).map((format) => (
                <a
                  key={format}
                  className={`button${dirty ? " disabled" : ""}`}
                  href={
                    dirty
                      ? undefined
                      : outputUrl(project, "drawing", format, sheet.id)
                  }
                  title={
                    dirty
                      ? "Save first: files are made from the saved project"
                      : undefined
                  }
                >
                  {format.toUpperCase()}
                </a>
              ))}
            </div>
            <div className="sheet-preview">
              {preview.error ? (
                <p className="error">{preview.error}</p>
              ) : preview.url ? (
                <img src={preview.url} alt={`${sheet.name}, as drawn`} />
              ) : (
                <p className="hint">Drawing…</p>
              )}
            </div>
          </>
        )}
      </section>
      {editable && sheet ? (
        <SheetEditor
          sheet={sheet}
          model={model}
          variables={variables}
          change={change}
          remove={() =>
            apply((d) => ({
              ...d,
              drawings: (d.drawings ?? []).filter((s) => s.id !== sheet.id),
            }))
          }
        />
      ) : null}
    </div>
  );
}

function SheetEditor({
  sheet,
  model,
  variables,
  change,
  remove,
}: {
  sheet: DrawingSheet;
  model: Model | undefined;
  variables: VariableValues;
  change: (next: DrawingSheet) => void;
  remove: () => void;
}) {
  const setView = (index: number, view: DrawingView) =>
    change({
      ...sheet,
      views: sheet.views.map((v, i) => (i === index ? view : v)),
    });
  const add = (view: NewView) => {
    let n = sheet.views.length + 1;
    while (sheet.views.some((v) => v.id === `v${n}`)) n++;
    change({
      ...sheet,
      views: [...sheet.views, { ...view, id: `v${n}` } as DrawingView],
    });
  };
  const sheetParts = (model?.parts ?? []).filter((p) => p.stock === "sheet");
  return (
    <aside className="sheet-editor">
      <header>
        <h2>Sheet</h2>
        <button className="danger" onClick={remove}>
          Delete
        </button>
      </header>
      <Field label="Name">
        <input
          value={sheet.name}
          onChange={(event) => change({ ...sheet, name: event.target.value })}
        />
      </Field>
      <Choice
        label="Paper"
        value={sheet.size}
        options={[
          ["A4", "A4"],
          ["A3", "A3"],
          ["A2", "A2"],
          ["A1", "A1"],
        ]}
        commit={(size) => change({ ...sheet, size })}
      />
      <h2>Views</h2>
      <ul className="view-list">
        {sheet.views.map((view, i) => (
          <li key={view.id}>
            <div className="part-main">
              <input
                aria-label="Label"
                placeholder={view.kind}
                value={view.label ?? ""}
                onChange={(event) => {
                  const { label: _label, ...rest } = view;
                  setView(
                    i,
                    (event.target.value
                      ? { ...view, label: event.target.value }
                      : rest) as DrawingView,
                  );
                }}
              />
              <input
                aria-label="Scale"
                className="quantity"
                placeholder="fit"
                value={
                  view.scale === undefined
                    ? ""
                    : `1:${Math.round(1 / view.scale)}`
                }
                onChange={(event) => {
                  const match = /^1\s*:\s*(\d+(?:\.\d+)?)$/.exec(
                    event.target.value.trim(),
                  );
                  const { scale: _scale, ...rest } = view;
                  setView(
                    i,
                    (match
                      ? { ...view, scale: 1 / Number(match[1]) }
                      : rest) as DrawingView,
                  );
                }}
              />
              <button
                className="icon"
                aria-label={`Remove ${view.label ?? view.kind}`}
                onClick={() =>
                  change({
                    ...sheet,
                    views: sheet.views.filter((_, j) => j !== i),
                  })
                }
              >
                ×
              </button>
            </div>
            <ViewFields
              view={view}
              views={sheet.views}
              parts={sheetParts.map((p) => [p.body, p.name] as const)}
              variables={variables}
              set={(next) => setView(i, next)}
            />
          </li>
        ))}
      </ul>
      <div className="button-row">
        {angles.map((angle) => (
          <button key={angle} onClick={() => add({ kind: "view", angle })}>
            {angle}
          </button>
        ))}
        <button
          onClick={() =>
            add({
              kind: "section",
              origin: ["0", "0", "0"],
              normal: [0, -1, 0],
            })
          }
        >
          section
        </button>
        <button
          disabled={!sheet.views.length}
          onClick={() =>
            add({
              kind: "detail",
              of: sheet.views[0]!.id,
              center: { x: 0, y: 0 },
              radius: 50,
            })
          }
        >
          detail
        </button>
        <button onClick={() => add({ kind: "exploded", distance: "100" })}>
          exploded
        </button>
        <button
          disabled={!sheetParts.length}
          onClick={() => add({ kind: "flat", part: sheetParts[0]!.body })}
        >
          blank
        </button>
      </div>
    </aside>
  );
}

const numbers = (text: string, count: number) => {
  const values = (text.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  return values.length === count ? values : undefined;
};

function ViewFields({
  view,
  views,
  parts,
  variables,
  set,
}: {
  view: DrawingView;
  views: readonly DrawingView[];
  parts: readonly (readonly [string, string])[];
  variables: VariableValues;
  set: (view: DrawingView) => void;
}) {
  switch (view.kind) {
    case "view":
      return (
        <>
          <Choice
            label="Seen from"
            value={view.angle}
            options={[...angles, "auxiliary" as const].map(
              (a) => [a, a] as const,
            )}
            commit={(angle) =>
              set({
                ...view,
                angle,
                ...(angle === "auxiliary" && !view.direction
                  ? { direction: [1, -1, 1] as const }
                  : {}),
              })
            }
          />
          {view.angle === "auxiliary" ? (
            <Field label="Toward">
              <input
                defaultValue={(view.direction ?? []).join(", ")}
                onBlur={(event) => {
                  const v = numbers(event.target.value, 3);
                  if (v)
                    set({ ...view, direction: v as [number, number, number] });
                }}
              />
            </Field>
          ) : null}
          <label className="check">
            <input
              type="checkbox"
              checked={!!view.hidden}
              onChange={(event) =>
                set({ ...view, hidden: event.target.checked })
              }
            />
            Hidden edges
          </label>
        </>
      );
    case "section":
      return (
        <>
          {(["x", "y", "z"] as const).map((axis, i) => (
            <ExpressionField
              key={axis}
              label={`Through ${axis}`}
              value={view.origin[i]}
              variables={variables}
              commit={(value) => {
                const origin = [...view.origin] as [string, string, string];
                origin[i] = value ?? "0";
                set({ ...view, origin });
              }}
            />
          ))}
          <Field label="Seen from">
            <input
              defaultValue={view.normal.join(", ")}
              onBlur={(event) => {
                const v = numbers(event.target.value, 3);
                if (v && v.some((c) => c !== 0))
                  set({ ...view, normal: v as [number, number, number] });
              }}
            />
          </Field>
        </>
      );
    case "detail":
      return (
        <>
          <Choice
            label="Of"
            value={view.of}
            options={views
              .filter((v) => v.id !== view.id && v.kind !== "detail")
              .map((v) => [v.id, v.label ?? v.id] as const)}
            commit={(of) => set({ ...view, of })}
          />
          <Field label="Centre">
            <input
              defaultValue={`${view.center.x}, ${view.center.y}`}
              onBlur={(event) => {
                const v = numbers(event.target.value, 2);
                if (v) set({ ...view, center: { x: v[0]!, y: v[1]! } });
              }}
            />
          </Field>
          <Field label="Radius">
            <input
              type="number"
              value={view.radius}
              onChange={(event) =>
                Number(event.target.value) > 0 &&
                set({ ...view, radius: Number(event.target.value) })
              }
            />
          </Field>
        </>
      );
    case "exploded":
      return (
        <ExpressionField
          label="Apart by"
          value={view.distance}
          variables={variables}
          commit={(distance) => set({ ...view, distance: distance ?? "100" })}
        />
      );
    case "flat":
      return (
        <Choice
          label="Part"
          value={view.part}
          options={parts}
          commit={(part) => set({ ...view, part })}
        />
      );
  }
}
