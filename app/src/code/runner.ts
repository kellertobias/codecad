// Runs a code part's TypeScript in the browser, and nowhere else:
//
// 1. esbuild (WebAssembly) compiles it to plain JavaScript, here.
// 2. A hidden iframe with `sandbox="allow-scripts"` (an origin of its own,
//    so no cookies, storage or session of the editor) and a policy that
//    forbids every connection starts a Web Worker from the sandbox bundle
//    (/code-sandbox.js, the part API), and hands it the code.
// 3. The code's answer (recipes, plain data) comes back over a message
//    port. If none comes in time the iframe is removed, which ends the
//    worker however busy it is: a runaway loop cannot freeze the editor.
import * as esbuild from "esbuild-wasm";
import esbuildWasm from "esbuild-wasm/esbuild.wasm?url";
import {
  checkCodeOutput,
  type CodeOutput,
} from "../../../src/document/code-part.ts";

export class CodeError extends Error {
  constructor(
    readonly phase: "compile" | "run" | "timeout" | "output",
    message: string,
  ) {
    super(message);
  }
}

// esbuild can only be started once per page, so the promise lives on the
// page rather than in this module (which hot reloading may run again).
const holder = globalThis as { codecadEsbuild?: Promise<void> | undefined };
const ready = () =>
  (holder.codecadEsbuild ??= esbuild
    .initialize({ wasmURL: esbuildWasm, worker: true })
    .catch((error: unknown) => {
      holder.codecadEsbuild = undefined;
      throw error;
    }));

/** TypeScript to a CommonJS function body the sandbox can run. */
export async function compile(source: string): Promise<string> {
  await ready();
  try {
    const { code } = await esbuild.transform(source, {
      loader: "ts",
      format: "cjs",
      target: "es2022",
      sourcefile: "part.ts",
    });
    return code;
  } catch (error) {
    const failure = error as {
      errors?: { text: string; location?: { line: number; column: number } }[];
    };
    const first = failure.errors?.[0];
    throw new CodeError(
      "compile",
      first
        ? `${first.location ? `Line ${first.location.line}:${first.location.column + 1}: ` : ""}${first.text}`
        : String(error),
    );
  }
}

let sandboxBundle: Promise<string> | undefined;
const sandboxSource = () =>
  (sandboxBundle ??= fetch("/code-sandbox.js").then((response) => {
    if (!response.ok) {
      sandboxBundle = undefined;
      throw new Error("The code sandbox did not load");
    }
    return response.text();
  }));

// The iframe's own script: start the worker, pass the job on, pass the
// answer back. Nothing of the editor is reachable from here.
const bootstrap = `
addEventListener("message", (event) => {
  const port = event.ports[0];
  const { worker, code, values } = event.data;
  const url = URL.createObjectURL(new Blob([worker], { type: "text/javascript" }));
  // A classic worker: module workers from blob URLs do not start in an
  // origin-less (sandboxed) document.
  const running = new Worker(url);
  running.onmessage = (e) => port.postMessage(e.data);
  running.onerror = (e) => {
    e.preventDefault();
    port.postMessage({ ok: false, error: e.message || "The code failed" });
  };
  running.postMessage({ code, values });
}, { once: true });
`;
const policy =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:; connect-src 'none'";

export interface RunOptions {
  /** How long the code may run. */
  readonly timeoutMs?: number;
}

/** Runs a code part for some parameter values; its checked output. */
export async function runCodePart(
  source: string,
  values: Readonly<Record<string, number>>,
  options: RunOptions = {},
): Promise<CodeOutput> {
  const [code, worker] = await Promise.all([compile(source), sandboxSource()]);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const answer = await new Promise<{
    ok: boolean;
    output?: unknown;
    error?: string;
  }>((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
    frame.style.display = "none";
    frame.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}"><script>${bootstrap}</script>`;
    const channel = new MessageChannel();
    const finish = () => {
      clearTimeout(timer);
      channel.port1.close();
      frame.remove();
    };
    const timer = setTimeout(() => {
      finish();
      reject(
        new CodeError(
          "timeout",
          `The code was stopped after ${Math.round(timeoutMs / 1000)} s: does it loop forever?`,
        ),
      );
    }, timeoutMs);
    channel.port1.onmessage = (event) => {
      finish();
      resolve(event.data as { ok: boolean; output?: unknown; error?: string });
    };
    frame.onload = () =>
      frame.contentWindow?.postMessage({ worker, code, values }, "*", [
        channel.port2,
      ]);
    document.body.append(frame);
  });
  if (!answer.ok) throw new CodeError("run", answer.error ?? "The code failed");
  try {
    return checkCodeOutput(answer.output);
  } catch (error) {
    throw new CodeError(
      "output",
      error instanceof Error ? error.message : String(error),
    );
  }
}
