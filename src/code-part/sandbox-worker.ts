// Runs a code part's compiled code, in a Web Worker the editor starts inside
// a sandboxed iframe: no origin of its own, no network (the iframe's policy
// forbids connections), and terminated if it runs too long. It answers with
// the recipes the code returned, or with what went wrong.
import * as sdk from "./sdk.js";

interface Job {
  readonly code: string;
  readonly values: Readonly<Record<string, number>>;
}

// Defence in depth: the policy already blocks these.
for (const name of [
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "importScripts",
  "indexedDB",
  "caches",
]) {
  try {
    Object.defineProperty(self, name, { value: undefined });
  } catch {
    // Not configurable here; the policy still applies.
  }
}

const modules: Record<string, unknown> = {
  "codecad/part": sdk,
  "@tobisk/codecad/part": sdk,
};

self.onmessage = (event: MessageEvent<Job>) => {
  const { code, values } = event.data;
  try {
    const module = { exports: {} as Record<string, unknown> };
    const require = (name: string) => {
      if (name in modules) return modules[name];
      throw new Error(
        `Code parts can only import "codecad/part", not "${name}"`,
      );
    };
    new Function("module", "exports", "require", code)(
      module,
      module.exports,
      require,
    );
    const definition = module.exports.default ?? module.exports;
    const output = sdk.runPart(definition, values);
    // Recipes are plain data; anything else fails here, not in the editor.
    postMessage({ ok: true, output: JSON.parse(JSON.stringify(output)) });
  } catch (error) {
    postMessage({
      ok: false,
      error:
        error instanceof Error
          ? `${error.name === "Error" ? "" : `${error.name}: `}${error.message}`
          : String(error),
    });
  }
};
