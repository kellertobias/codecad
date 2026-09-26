// The mobile viewer at /p/<project>/view: the model, drawings, cut list and
// layouts of the latest saved revision, from files the server prebuilt.
// It never loads the kernel; three.js only when the model is looked at.
import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import type {
  ViewerDrawing,
  ViewerLayout,
  ViewerManifest,
  ViewerPart,
} from "../../../src/document/viewer.ts";
import { copyKey } from "../../../src/document/viewer.ts";
import { Icon, type IconName } from "../icons.tsx";
import {
  fileUrl,
  keepOffline,
  loadManifest,
  manifestFiles,
  readOnly,
  useSource,
  type ViewerSource,
  useOnline,
  useProgress,
  type Progress,
} from "./data.ts";
import { ZoomPan } from "./ZoomPan.tsx";

const ModelView = lazy(() => import("./ModelView.tsx"));

type Tab = "model" | "drawings" | "cuts" | "layouts";
const tabs: readonly [Tab, string, IconName][] = [
  ["model", "Model", "model"],
  ["drawings", "Drawings", "drawings"],
  ["cuts", "Cut list", "cutlist"],
  ["layouts", "Layouts", "layouts"],
];

/** A part, or one copy of it, picked in any of the views. */
interface Selection {
  readonly part: string;
  readonly copy?: number;
}

const remembered = (): Tab => {
  try {
    const tab = localStorage.getItem("codecad-viewer-tab");
    if (tabs.some(([t]) => t === tab)) return tab as Tab;
  } catch {
    // Storage is off.
  }
  return "model";
};

const mm = (value: number | undefined) =>
  value === undefined ? "" : String(Math.round(value * 10) / 10);

export function Viewer({ source }: { source: ViewerSource }) {
  useSource(source);
  const [manifest, setManifest] = useState<ViewerManifest>();
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState<Tab>(remembered);
  const [selected, setSelected] = useState<Selection>();
  const online = useOnline();
  const progress = useProgress(manifest);

  useEffect(() => {
    let cancelled = false;
    loadManifest().then(
      (loaded) => {
        if (cancelled) return;
        setManifest(loaded);
        setError(undefined);
        document.title = `${loaded.name} · CodeCAD`;
      },
      (reason: unknown) =>
        !cancelled &&
        setError(
          reason instanceof Error ? reason.message : "The project did not load",
        ),
    );
    return () => {
      cancelled = true;
    };
  }, [source, online]);

  // When the project is on screen and the tabs answer: what the "under two
  // seconds" budget is measured to.
  useEffect(() => {
    if (manifest && !performance.getEntriesByName("viewer-interactive").length)
      performance.mark("viewer-interactive");
  }, [manifest]);

  // Everything this revision needs, kept for use offline; three.js too, so
  // the model opens without wifi even if it was never looked at.
  useEffect(() => {
    if (!manifest) return;
    const idle = setTimeout(() => {
      void import("./ModelView.tsx")
        .catch(() => {})
        .then(() => keepOffline(manifestFiles(manifest)));
    }, 500);
    return () => clearTimeout(idle);
  }, [manifest]);

  const choose = (next: Tab) => {
    setTab(next);
    try {
      localStorage.setItem("codecad-viewer-tab", next);
    } catch {
      // Storage is off.
    }
  };

  return (
    <div className="viewer">
      <header className="viewer-top">
        <div className="viewer-title">
          <strong>{manifest?.name ?? "CodeCAD"}</strong>
          {manifest ? <small>revision {manifest.revision}</small> : null}
        </div>
        {!online ? (
          <span className="badge offline" title="Shown from this phone">
            <Icon name="offline" size={14} /> offline
          </span>
        ) : null}
        {readOnly ? (
          <span className="badge" title="Opened with a view link">
            view only
          </span>
        ) : null}
        {progress.pending ? (
          <span className="badge" title="Ticks not on the server yet">
            {progress.pending} to sync
          </span>
        ) : null}
      </header>
      <main className="viewer-main">
        {error && !manifest ? (
          <p className="viewer-message error">{error}</p>
        ) : !manifest ? (
          <p className="viewer-message">Preparing the project…</p>
        ) : (
          <>
            {manifest.problems.length ? (
              <details className="problems">
                <summary>
                  {manifest.problems.length} thing
                  {manifest.problems.length === 1 ? "" : "s"} could not be built
                </summary>
                <ul>
                  {manifest.problems.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              </details>
            ) : null}
            {tab === "model" ? (
              <ModelTab
                manifest={manifest}
                selected={selected}
                select={setSelected}
              />
            ) : tab === "drawings" ? (
              <DrawingsTab manifest={manifest} />
            ) : tab === "cuts" ? (
              <CutsTab
                manifest={manifest}
                progress={progress}
                selected={selected}
                select={setSelected}
              />
            ) : (
              <LayoutsTab
                manifest={manifest}
                progress={progress}
                selected={selected}
                select={setSelected}
              />
            )}
          </>
        )}
      </main>
      <nav className="viewer-tabs" aria-label="Show">
        {tabs.map(([key, label, icon]) => (
          <button
            key={key}
            type="button"
            className={tab === key ? "active" : undefined}
            aria-current={tab === key ? "page" : undefined}
            onClick={() => choose(key)}
          >
            <Icon name={icon} size={22} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

function ModelTab({
  manifest,
  selected,
  select,
}: {
  manifest: ViewerManifest;
  selected: Selection | undefined;
  select(selection: Selection | undefined): void;
}) {
  const [isolate, setIsolate] = useState(false);
  const part = manifest.parts.find((p) => p.body === selected?.part);
  if (!manifest.model)
    return <p className="viewer-message">The project has no solids yet.</p>;
  return (
    <section className="model-tab">
      <Suspense fallback={<p className="viewer-message">Loading the model…</p>}>
        <ModelView
          url={fileUrl(manifest, manifest.model)}
          selected={selected?.part}
          isolate={isolate && !!part}
          select={(body) => select(body ? { part: body } : undefined)}
        />
      </Suspense>
      <div className="selection-bar">
        {part ? (
          <>
            <span className="selection-name">
              <strong>{part.name}</strong> <PartSize part={part} />
            </span>
            <button
              type="button"
              className={isolate ? "active" : undefined}
              aria-pressed={isolate}
              onClick={() => setIsolate(!isolate)}
            >
              <Icon name="isolate" size={18} /> Alone
            </button>
            <button
              type="button"
              aria-label="Show all parts"
              onClick={() => {
                setIsolate(false);
                select(undefined);
              }}
            >
              <Icon name="close" size={18} />
            </button>
          </>
        ) : (
          <span className="hint">
            Drag to turn, pinch to zoom, tap a part to pick it.
          </span>
        )}
      </div>
    </section>
  );
}

function PartSize({ part }: { part: ViewerPart }) {
  return (
    <span className="part-size">
      {part.stock === "sheet"
        ? `${mm(part.width)} × ${mm(part.height)} × ${mm(part.thickness)} mm`
        : "solid"}
      {part.material ? ` · ${part.material}` : ""}
    </span>
  );
}

function DrawingsTab({ manifest }: { manifest: ViewerManifest }) {
  const [open, setOpen] = useState<ViewerDrawing>();
  if (open)
    return (
      <section className="sheet-view">
        <div className="sheet-bar">
          <button
            type="button"
            aria-label="Back to the drawings"
            onClick={() => setOpen(undefined)}
          >
            <Icon name="close" size={18} />
          </button>
          <strong className="sheet-name">{open.name}</strong>
          <a
            className="button"
            href={fileUrl(manifest, open.pdf)}
            download={`${open.name}.pdf`}
          >
            <Icon name="download" size={18} /> PDF
          </a>
        </div>
        <ZoomPan className="sheet-zoom" label={open.name}>
          <img
            src={fileUrl(manifest, open.svg)}
            alt=""
            draggable={false}
            style={{ aspectRatio: `${open.width} / ${open.height}` }}
          />
        </ZoomPan>
        <p className="hint">Pinch or double-tap to zoom.</p>
      </section>
    );
  const groups: [string, ViewerDrawing[]][] = [
    ["Drawings", manifest.drawings.filter((d) => d.kind === "drawing")],
    ["Part sheets", manifest.drawings.filter((d) => d.kind === "part")],
  ];
  if (!manifest.drawings.length)
    return <p className="viewer-message">The project has no drawings.</p>;
  return (
    <section className="drawings-tab">
      {groups.map(([title, drawings]) =>
        drawings.length ? (
          <div key={title}>
            <h2>{title}</h2>
            <ul className="sheet-list">
              {drawings.map((drawing) => (
                <li key={drawing.id}>
                  <button type="button" onClick={() => setOpen(drawing)}>
                    <img
                      src={fileUrl(manifest, drawing.svg)}
                      alt=""
                      loading="lazy"
                      style={{
                        aspectRatio: `${drawing.width} / ${drawing.height}`,
                      }}
                    />
                    <span>{drawing.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null,
      )}
    </section>
  );
}

function CutsTab({
  manifest,
  progress,
  selected,
  select,
}: {
  manifest: ViewerManifest;
  progress: Progress;
  selected: Selection | undefined;
  select(selection: Selection | undefined): void;
}) {
  const total = manifest.parts.reduce((n, p) => n + p.quantity, 0);
  const cut = manifest.parts.reduce(
    (n, p) =>
      n +
      Array.from({ length: p.quantity }, (_, i) =>
        progress.done.has(copyKey(p.body, i)),
      ).filter(Boolean).length,
    0,
  );
  const byMaterial = useMemo(() => {
    const groups = new Map<string, ViewerPart[]>();
    for (const part of manifest.parts) {
      const key = part.material || "No material";
      groups.set(key, [...(groups.get(key) ?? []), part]);
    }
    return [...groups];
  }, [manifest.parts]);
  return (
    <section className="cuts-tab">
      <div className="progress-summary">
        <div>
          <strong>
            {cut} of {total}
          </strong>{" "}
          cut
        </div>
        <progress max={total || 1} value={cut} aria-label="Parts cut" />
        {manifest.cutList ? (
          <div className="downloads">
            <a
              className="button"
              href={fileUrl(manifest, manifest.cutList.pdf)}
              download="cut-list.pdf"
            >
              <Icon name="download" size={16} /> PDF
            </a>
            <a
              className="button"
              href={fileUrl(manifest, manifest.cutList.csv)}
              download="cut-list.csv"
            >
              <Icon name="download" size={16} /> CSV
            </a>
          </div>
        ) : null}
      </div>
      {byMaterial.map(([material, parts]) => (
        <div key={material} className="material-group">
          <h2>{material}</h2>
          <ul className="cut-rows">
            {parts.map((part) => (
              <li
                key={part.body}
                className={
                  selected?.part === part.body ? "selected" : undefined
                }
              >
                <button
                  type="button"
                  className="cut-name"
                  onClick={() =>
                    select(
                      selected?.part === part.body
                        ? undefined
                        : { part: part.body },
                    )
                  }
                >
                  <strong>{part.name}</strong>
                  <PartSize part={part} />
                </button>
                <div className="copies">
                  {Array.from({ length: part.quantity }, (_, i) => {
                    const key = copyKey(part.body, i);
                    return (
                      <label key={key} className="copy">
                        <input
                          type="checkbox"
                          disabled={readOnly}
                          checked={progress.done.has(key)}
                          onChange={(event) =>
                            progress.set(key, event.target.checked)
                          }
                        />
                        <span>{part.quantity > 1 ? `#${i + 1}` : "cut"}</span>
                      </label>
                    );
                  })}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {manifest.hardware.length ? (
        <div className="material-group">
          <h2>Hardware</h2>
          <ul className="hardware">
            {manifest.hardware.map((h) => (
              <li key={`${h.kind}${h.size}`}>
                <span>
                  {h.kind[0]!.toUpperCase() + h.kind.slice(1)} {h.size}
                </span>
                <strong>× {h.count}</strong>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function LayoutsTab({
  manifest,
  progress,
  selected,
  select,
}: {
  manifest: ViewerManifest;
  progress: Progress;
  selected: Selection | undefined;
  select(selection: Selection | undefined): void;
}) {
  if (!manifest.layouts.length)
    return (
      <p className="viewer-message">
        No layouts yet: place parts on stock in the editor.
      </p>
    );
  const names = new Map(manifest.parts.map((p) => [p.body, p.name]));
  const chosen = selected?.copy !== undefined ? selected : undefined;
  return (
    <section className="layouts-tab">
      {manifest.layouts.map((layout) => (
        <LayoutCard
          key={layout.id}
          layout={layout}
          names={names}
          progress={progress}
          selected={selected}
          select={select}
        />
      ))}
      {chosen ? (
        <div className="selection-bar floating">
          <span className="selection-name">
            <strong>{names.get(chosen.part)}</strong>
            {(manifest.parts.find((p) => p.body === chosen.part)?.quantity ??
              1) > 1
              ? ` #${chosen.copy! + 1}`
              : ""}
          </span>
          <label className="copy">
            <input
              type="checkbox"
              disabled={readOnly}
              checked={progress.done.has(copyKey(chosen.part, chosen.copy!))}
              onChange={(event) =>
                progress.set(
                  copyKey(chosen.part, chosen.copy!),
                  event.target.checked,
                )
              }
            />
            <span>cut</span>
          </label>
          <button
            type="button"
            aria-label="Clear the selection"
            onClick={() => select(undefined)}
          >
            <Icon name="close" size={18} />
          </button>
        </div>
      ) : null}
    </section>
  );
}

function LayoutCard({
  layout,
  names,
  progress,
  selected,
  select,
}: {
  layout: ViewerLayout;
  names: ReadonlyMap<string, string>;
  progress: Progress;
  selected: Selection | undefined;
  select(selection: Selection | undefined): void;
}) {
  const xs = layout.stock.outline.map((p) => p.x);
  const ys = layout.stock.outline.map((p) => p.y);
  const box = {
    x: Math.min(...xs),
    y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  };
  const pad = Math.max(box.w, box.h) * 0.02;
  const text = Math.max(box.w, box.h) / 40;
  const points = (outline: readonly { x: number; y: number }[]) =>
    outline.map((p) => `${p.x},${-p.y}`).join(" ");
  const cut = layout.placements.filter((p) =>
    progress.done.has(copyKey(p.part, p.copy)),
  ).length;
  return (
    <article className="layout-card">
      <header>
        <strong>{layout.name}</strong>
        <small>
          {layout.stock.name} · {cut} of {layout.placements.length} cut
        </small>
      </header>
      <ZoomPan className="layout-zoom" label={`Layout ${layout.name}`}>
        <svg
          viewBox={`${box.x - pad} ${-(box.y + box.h) - pad} ${box.w + 2 * pad} ${box.h + 2 * pad}`}
          preserveAspectRatio="xMidYMid meet"
        >
          <polygon className="stock" points={points(layout.stock.outline)} />
          {layout.placements.map((placement) => {
            const outline = placement.outline;
            const cx = outline.reduce((s, p) => s + p.x, 0) / outline.length;
            const cy = outline.reduce((s, p) => s + p.y, 0) / outline.length;
            const done = progress.done.has(
              copyKey(placement.part, placement.copy),
            );
            const isPart = selected?.part === placement.part;
            const isCopy = isPart && selected?.copy === placement.copy;
            return (
              <g
                key={copyKey(placement.part, placement.copy)}
                className={[
                  "placed",
                  done ? "done" : "",
                  isPart ? "same-part" : "",
                  isCopy ? "selected" : "",
                ].join(" ")}
                data-part={placement.part}
                data-copy={placement.copy}
                onClick={() =>
                  select(
                    isCopy
                      ? undefined
                      : { part: placement.part, copy: placement.copy },
                  )
                }
              >
                <polygon points={points(outline)} />
                <text x={cx} y={-cy} fontSize={text}>
                  {done ? "✓ " : ""}
                  {names.get(placement.part) ?? placement.part}
                </text>
              </g>
            );
          })}
        </svg>
      </ZoomPan>
    </article>
  );
}
