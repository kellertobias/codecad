// The feature list: every feature in the order it is built, with its state
// (fine, failed, suppressed, rolled back). The rollback bar sits after the
// last feature that is built; new features go there.
import { useState } from "react";
import type { CadDocument, Feature } from "../../../src/document/schema.ts";
import {
  featureLabel,
  moveFeature,
  whyNotMove,
} from "../../../src/document/features.ts";
import type { FeatureStatus } from "../../../src/kernel/evaluator.ts";

const symbols: Record<Feature["type"], string> = {
  sketch: "✎",
  extrude: "⬒",
  fillet: "◜",
  chamfer: "◸",
  shell: "▢",
  hole: "◎",
  pattern: "⋯",
  mirror: "⇋",
  joint: "⊞",
  move: "✥",
  mate: "⊣",
  instance: "❖",
};

export function FeatureTree({
  document,
  status,
  selected,
  rollback,
  select,
  open,
  setRollback,
  apply,
  report,
}: {
  document: CadDocument;
  status: ReadonlyMap<string, FeatureStatus> | undefined;
  selected: string | undefined;
  /** Index of the last feature built; undefined builds them all. */
  rollback: number | undefined;
  select(id: string): void;
  /** Opens a feature: a sketch in the sketch editor. */
  open(id: string): void;
  setRollback(index: number | undefined): void;
  apply(change: (document: CadDocument) => CadDocument): void;
  report(message: string): void;
}) {
  const [renaming, setRenaming] = useState<string>();
  const last = rollback ?? document.features.length - 1;
  const move = (feature: Feature, index: number, to: number) => {
    const problem = whyNotMove(document, feature.id, to);
    if (problem) return report(`Cannot move: ${problem}.`);
    apply((d) => moveFeature(d, feature.id, to));
    // Keep the rollback bar next to the same features.
    if (rollback !== undefined && index <= rollback !== to <= rollback)
      setRollback(index <= rollback ? rollback - 1 : rollback + 1);
  };
  const bar = (
    <li className="rollback" key="rollback">
      <span>
        {rollback === undefined
          ? "End of features"
          : `Rolled back: ${document.features.length - 1 - rollback} feature(s) not built`}
      </span>
      {rollback !== undefined ? (
        <button className="link" onClick={() => setRollback(undefined)}>
          Roll to end
        </button>
      ) : null}
    </li>
  );
  return (
    <ul className="feature-tree" aria-label="Features">
      {rollback === -1 ? bar : null}
      {document.features.map((feature, index) => {
        const state = status?.get(feature.id);
        const after = index > last;
        const row = (
          <li
            key={feature.id}
            className={[
              feature.id === selected ? "selected" : "",
              state?.state === "error" ? "problem" : "",
              feature.suppressed ? "suppressed" : "",
              after ? "after-rollback" : "",
            ].join(" ")}
          >
            <span className="symbol" aria-hidden>
              {symbols[feature.type]}
            </span>
            {renaming === feature.id ? (
              <input
                autoFocus
                aria-label="Feature name"
                defaultValue={feature.name}
                onBlur={(event) => {
                  setRenaming(undefined);
                  const name = event.target.value.trim();
                  if (name)
                    apply((d) => ({
                      ...d,
                      features: d.features.map((f) =>
                        f.id === feature.id ? { ...f, name } : f,
                      ),
                    }));
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape") setRenaming(undefined);
                }}
              />
            ) : (
              <button
                className="name"
                onClick={() => select(feature.id)}
                onDoubleClick={() =>
                  feature.type === "sketch"
                    ? open(feature.id)
                    : setRenaming(feature.id)
                }
                title={
                  state?.state === "error"
                    ? state.message
                    : `${featureLabel(feature.type)}${feature.type === "sketch" ? " — double-click to edit" : " — double-click to rename"}`
                }
              >
                {feature.name}
                <small>
                  {state?.state === "error"
                    ? state.broken
                      ? "broken reference"
                      : "failed"
                    : feature.suppressed
                      ? "suppressed"
                      : after
                        ? "not built"
                        : state?.state === "ok"
                          ? featureLabel(feature.type)
                          : "…"}
                </small>
              </button>
            )}
            <span className="row-actions">
              <button
                className="icon"
                title={feature.suppressed ? "Unsuppress" : "Suppress"}
                aria-label={`${feature.suppressed ? "Unsuppress" : "Suppress"} ${feature.name}`}
                onClick={() =>
                  apply((d) => ({
                    ...d,
                    features: d.features.map((f) =>
                      f.id !== feature.id
                        ? f
                        : f.suppressed
                          ? (({ suppressed: _s, ...rest }) => rest as Feature)(
                              f,
                            )
                          : { ...f, suppressed: true },
                    ),
                  }))
                }
              >
                {feature.suppressed ? "◌" : "●"}
              </button>
              <button
                className="icon"
                title="Move up"
                aria-label={`Move ${feature.name} up`}
                disabled={index === 0}
                onClick={() => move(feature, index, index - 1)}
              >
                ↑
              </button>
              <button
                className="icon"
                title="Move down"
                aria-label={`Move ${feature.name} down`}
                disabled={index === document.features.length - 1}
                onClick={() => move(feature, index, index + 1)}
              >
                ↓
              </button>
              <button
                className="icon"
                title="Roll back to here"
                aria-label={`Roll back to ${feature.name}`}
                onClick={() =>
                  setRollback(
                    index === document.features.length - 1 ? undefined : index,
                  )
                }
              >
                ⤒
              </button>
              <button
                className="icon"
                title="Delete"
                aria-label={`Delete ${feature.name}`}
                onClick={() =>
                  apply((d) => ({
                    ...d,
                    features: d.features.filter((f) => f.id !== feature.id),
                  }))
                }
              >
                ×
              </button>
            </span>
          </li>
        );
        return index === last && rollback !== undefined ? [row, bar] : row;
      })}
      {rollback === undefined ? bar : null}
    </ul>
  );
}
