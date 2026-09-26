// Keeps the results of a document's code parts where the kernel can use
// them. For each instance's key (its code and values): the server's stored
// result when there is one; otherwise the code runs here, in the sandbox,
// the kernel builds its geometry, and the result goes to the server for
// drawings, exports and the phone viewer. Code only runs when no result
// exists for its code and values, or when asked to.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  codeInstances,
  type CodeInstance,
  type CodeResult,
} from "../../../src/document/code-part.ts";
import type { CadDocument } from "../../../src/document/schema.ts";
import { codeResults } from "../api.ts";
import { kernel } from "../kernel.ts";
import { runCodePart } from "./runner.ts";

export type CodeState =
  | { readonly state: "ready"; readonly ran: boolean }
  | { readonly state: "working"; readonly message: string }
  | { readonly state: "error"; readonly message: string };

/** Makes the result for one instance: runs the code, builds it, stores
 * it on the server (unless `upload` is false), and gives it the kernel. */
export async function generate(
  need: Pick<CodeInstance, "pinned" | "values" | "key">,
  options: { replace?: boolean; upload?: boolean } = {},
): Promise<CodeResult> {
  const output = await runCodePart(need.pinned.code.source, need.values!);
  const { result } = await kernel().buildCode(
    output,
    need.key!,
    need.pinned.code.files,
  );
  await kernel().useCodeResults([result]);
  if (options.upload !== false)
    await codeResults.put(result, options.replace ?? false);
  return result;
}

export function useCodeResults(document: CadDocument | undefined) {
  /** Bumped whenever the kernel gets a result, so the model is evaluated
   * again with it. */
  const [generation, setGeneration] = useState(0);
  const [states, setStates] = useState<ReadonlyMap<string, CodeState>>(
    new Map(),
  );
  const provided = useRef(new Set<string>());
  const busy = useRef(new Set<string>());
  const failed = useRef(new Map<string, string>());

  const set = (key: string, state: CodeState) =>
    setStates((all) => new Map(all).set(key, state));

  const obtain = useCallback(async (need: CodeInstance, force = false) => {
    const key = need.key!;
    if (busy.current.has(key)) return;
    busy.current.add(key);
    failed.current.delete(key);
    try {
      let ran = false;
      if (!force) {
        set(key, { state: "working", message: "Loading its stored result…" });
        const stored = await codeResults.get(key);
        if (stored) await kernel().useCodeResults([stored]);
        else {
          set(key, { state: "working", message: "Running its code…" });
          await generate(need);
          ran = true;
        }
      } else {
        set(key, { state: "working", message: "Running its code…" });
        await generate(need, { replace: true });
        ran = true;
      }
      provided.current.add(key);
      set(key, { state: "ready", ran });
      setGeneration((g) => g + 1);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.current.set(key, message);
      set(key, { state: "error", message });
    } finally {
      busy.current.delete(key);
    }
  }, []);

  // Whatever the document needs and nobody has asked for yet. Failures
  // are not retried until the code or values change, or on request.
  useEffect(() => {
    if (!document) return;
    const timer = setTimeout(() => {
      for (const need of codeInstances(document))
        if (
          need.key &&
          !provided.current.has(need.key) &&
          !failed.current.has(need.key)
        )
          void obtain(need);
    }, 250);
    return () => clearTimeout(timer);
  }, [document, obtain]);

  /** The state of an instance's result, by the instance's id. */
  const stateOf = (instance: string): CodeState | undefined => {
    if (!document) return undefined;
    const need = codeInstances(document).find((n) => n.feature.id === instance);
    if (!need) return undefined;
    if (need.problem) return { state: "error", message: need.problem };
    return states.get(need.key!);
  };
  /** Runs an instance's code again, and replaces the stored result. */
  const regenerate = (instance: string) => {
    if (!document) return;
    const need = codeInstances(document).find((n) => n.feature.id === instance);
    if (need?.key) void obtain(need, true);
  };
  return { generation, stateOf, regenerate };
}
