// Writing a code part: TypeScript against "codecad/part", run here in the
// sandbox (Run, or Ctrl/⌘+Enter) with a drawing of what it makes, then
// saved to the library as a new item or a new version. Its parameters are
// what `definePart` declares.
import { Suspense, lazy, useState } from "react";
import {
  codeResultKey,
  parameterValues,
  type CodeOutput,
  type CodePart,
} from "../../../src/document/code-part.ts";
import {
  emptyDocument,
  type CadDocument,
} from "../../../src/document/schema.ts";
import { codeResults, library, type LibraryItemSummary } from "../api.ts";
import { kernel } from "../kernel.ts";
import { Icon } from "../icons.tsx";
import { tip } from "../shortcuts.ts";
import { CodeError, runCodePart } from "./runner.ts";

const CodeEditor = lazy(() => import("./CodeEditor.tsx"));

const thumbnailOf = (svg: string) =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** A document holding just an instance of the code part, for drawings. */
function previewDocument(
  name: string,
  code: CodePart,
  values: Record<string, number>,
): CadDocument {
  return {
    ...emptyDocument(),
    library: [
      {
        item: "preview",
        version: 1,
        name,
        code,
        exposed: code.parameters.map((p) => p.name),
      },
    ],
    features: [
      {
        id: "preview",
        type: "instance",
        name,
        item: "preview",
        version: 1,
        values: Object.fromEntries(
          Object.entries(values).map(([k, v]) => [k, String(v)]),
        ),
      },
    ],
  };
}

const codePartOf = (
  source: string,
  output: CodeOutput,
  files: Readonly<Record<string, string>>,
): CodePart => ({
  source,
  ...(Object.keys(files).length ? { files } : {}),
  parameters: output.parameters,
  interfaces: output.interfaces.map(({ id, name, kind }) => ({
    id,
    name,
    kind,
  })),
});

/** Runs the code, builds and draws it; the result goes to the kernel (and
 * the server, when `store`). */
async function make(
  name: string,
  source: string,
  given: Record<string, number>,
  store: boolean,
  files: Readonly<Record<string, string>>,
) {
  const started = performance.now();
  const probe = await runCodePart(source, given);
  const values = parameterValues(probe.parameters, given);
  const code = codePartOf(source, probe, files);
  const ran = performance.now() - started;
  const key = codeResultKey(source, values, files);
  const { result } = await kernel().buildCode(probe, key, files);
  await kernel().useCodeResults([result]);
  if (store) await codeResults.put(result, true);
  const { svg } = await kernel().drawing(
    previewDocument(name || "Code part", code, values),
    {
      id: "preview",
      name: name || "Code part",
      size: "A4",
      views: [{ id: "iso", kind: "view", angle: "isometric", label: " " }],
    },
    { scratch: true },
  );
  return { code, output: probe, svg, ran, key };
}

export function CodePartEditor({
  initial,
  items,
  close,
  saved,
}: {
  initial: {
    item?: string;
    name: string;
    source: string;
    files?: Readonly<Record<string, string>>;
  };
  items: readonly LibraryItemSummary[];
  close(): void;
  saved(message: string): void;
}) {
  const [name, setName] = useState(initial.name);
  const [source, setSource] = useState(initial.source);
  const [target, setTarget] = useState(initial.item ?? "new");
  const [values, setValues] = useState<Record<string, number>>({});
  /** STEP files the code imports, base64 by name. */
  const [files, setFiles] = useState<Record<string, string>>({
    ...(initial.files ?? {}),
  });
  const [last, setLast] = useState<{
    output: CodeOutput;
    svg: string;
    ran: number;
  }>();
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState<"run" | "save">();

  const run = async () => {
    if (busy) return;
    setBusy("run");
    setProblem(undefined);
    try {
      const made = await make(name, source, values, false, files);
      setLast(made);
      // Values for parameters the code no longer has are dropped.
      setValues((v) =>
        Object.fromEntries(
          Object.entries(v).filter(([k]) =>
            made.output.parameters.some((p) => p.name === k),
          ),
        ),
      );
    } catch (error) {
      setProblem(
        error instanceof CodeError
          ? `${error.phase === "compile" ? "Does not compile" : error.phase === "timeout" ? "Stopped" : "Failed"}: ${error.message}`
          : error instanceof Error
            ? error.message
            : String(error),
      );
    } finally {
      setBusy(undefined);
    }
  };

  const save = async () => {
    if (busy) return;
    setBusy("save");
    setProblem(undefined);
    try {
      // Made with the defaults, stored, and drawn for the thumbnail.
      const made = await make(name, source, {}, true, files);
      const body = {
        code: made.code,
        exposed: made.code.parameters.map((p) => p.name),
        thumbnail: made.svg,
      };
      if (target === "new")
        await library.create({ ...body, name: name.trim(), tags: ["code"] });
      else await library.addVersion(target, body);
      saved(
        target === "new"
          ? `Saved ${name.trim()} to the library.`
          : `Saved a new version of ${items.find((i) => i.id === target)?.name}.`,
      );
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(undefined);
    }
  };

  const parameters = last?.output.parameters ?? [];
  return (
    <section className="code-part-editor">
      <div className="mode-bar">
        <input
          aria-label="Code part name"
          value={name}
          placeholder="Name"
          onChange={(e) => setName(e.target.value)}
        />
        <select
          aria-label="Save as"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        >
          <option value="new">a new item</option>
          {items
            .filter((i) => i.kind === "code")
            .map((item) => (
              <option key={item.id} value={item.id}>
                version {item.latest + 1} of {item.name}
              </option>
            ))}
        </select>
        <span className="spacer" />
        <button
          className="primary"
          disabled={!!busy}
          title={tip("closeSketch", "Run the code here")}
          onClick={() => void run()}
        >
          <Icon name="extrude" size={16} />{" "}
          {busy === "run" ? "Running…" : "Run"}
        </button>
        <button
          disabled={!!busy || (target === "new" && !name.trim())}
          onClick={() => void save()}
        >
          <Icon name="save" size={16} />{" "}
          {busy === "save" ? "Saving…" : "Save to library"}
        </button>
        <button
          className="icon"
          aria-label="Close the code part"
          onClick={close}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="code-part-body">
        <Suspense
          fallback={<p className="hint code-editor">Loading the editor…</p>}
        >
          <CodeEditor
            value={source}
            onChange={setSource}
            onRun={() => void run()}
          />
        </Suspense>
        <aside className="code-part-side">
          {problem ? <p className="error code-problem">{problem}</p> : null}
          {last ? (
            <>
              <img
                className="code-preview"
                src={thumbnailOf(last.svg)}
                alt="What the code makes"
              />
              <p className="hint">
                Ran in {Math.round(last.ran)} ms in this browser:{" "}
                {last.output.bodies.length} bod
                {last.output.bodies.length === 1 ? "y" : "ies"},{" "}
                {last.output.interfaces.length} interface
                {last.output.interfaces.length === 1 ? "" : "s"}.
              </p>
            </>
          ) : (
            <p className="hint">
              Run the code (Ctrl/⌘+Enter) to see what it makes. It runs here, in
              a sandbox without network, and is stopped after 10 s.
            </p>
          )}
          <h2>Files</h2>
          <p className="hint">
            STEP models the code can place:{" "}
            <code>
              new Shapes.ImportedStep({"{"} path: "hinge.step" {"}"})
            </code>
          </p>
          <ul className="code-files">
            {Object.keys(files).map((file) => (
              <li key={file}>
                <span>{file}</span>
                <button
                  className="icon"
                  aria-label={`Remove ${file}`}
                  onClick={() =>
                    setFiles((all) => {
                      const next = { ...all };
                      delete next[file];
                      return next;
                    })
                  }
                >
                  <Icon name="close" size={14} />
                </button>
              </li>
            ))}
          </ul>
          <label className="button">
            Add STEP file…
            <input
              type="file"
              accept=".step,.stp"
              hidden
              onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                const bytes = new Uint8Array(await file.arrayBuffer());
                let text = "";
                for (let i = 0; i < bytes.length; i += 0x8000)
                  text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
                const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, "-");
                setFiles((all) => ({ ...all, [safe]: btoa(text) }));
              }}
            />
          </label>
          {parameters.length ? <h2>Parameters</h2> : null}
          {parameters.map((p) => (
            <label key={p.name} className="field">
              <span>{p.label ?? p.name}</span>
              <input
                type="number"
                value={values[p.name] ?? ""}
                placeholder={String(p.default)}
                min={p.min}
                max={p.max}
                onChange={(e) =>
                  setValues((v) => {
                    const next = { ...v };
                    if (e.target.value === "") delete next[p.name];
                    else next[p.name] = Number(e.target.value);
                    return next;
                  })
                }
              />
            </label>
          ))}
        </aside>
      </div>
    </section>
  );
}
