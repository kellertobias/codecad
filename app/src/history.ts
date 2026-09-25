// Undo and redo for the whole document: variable edits, sketch edits and
// drags all go through one history, so Ctrl+Z undoes whatever came last.
// Documents are immutable, so an entry is just the previous document.
import { useCallback, useState } from "react";

interface History<T> {
  readonly past: readonly T[];
  readonly present: T;
  readonly future: readonly T[];
  /** Consecutive changes with the same key (one drag) merge into one step. */
  readonly lastKey?: string;
}

const limit = 200;

export interface DocumentHistory<T> {
  readonly current: T;
  /** Applies a change. Changes sharing `merge` with the previous one replace
   * it instead of adding a step. */
  apply(change: (current: T) => T, merge?: string): void;
  undo(): void;
  redo(): void;
  /** Starts over with a document, forgetting the history. */
  reset(document: T): void;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

export function useDocumentHistory<T>(initial: T): DocumentHistory<T> {
  const [history, setHistory] = useState<History<T>>({
    past: [],
    present: initial,
    future: [],
  });
  const apply = useCallback(
    (change: (current: T) => T, merge?: string) =>
      setHistory((h) => {
        const next = change(h.present);
        if (next === h.present) return h;
        if (merge !== undefined && merge === h.lastKey)
          return { ...h, present: next, future: [] };
        return {
          past: [...h.past, h.present].slice(-limit),
          present: next,
          future: [],
          ...(merge === undefined ? {} : { lastKey: merge }),
        };
      }),
    [],
  );
  const undo = useCallback(
    () =>
      setHistory((h) =>
        h.past.length
          ? {
              past: h.past.slice(0, -1),
              present: h.past[h.past.length - 1]!,
              future: [h.present, ...h.future],
            }
          : h,
      ),
    [],
  );
  const redo = useCallback(
    () =>
      setHistory((h) =>
        h.future.length
          ? {
              past: [...h.past, h.present],
              present: h.future[0]!,
              future: h.future.slice(1),
            }
          : h,
      ),
    [],
  );
  const reset = useCallback(
    (document: T) => setHistory({ past: [], present: document, future: [] }),
    [],
  );
  return {
    current: history.present,
    apply,
    undo,
    redo,
    reset,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
  };
}
