// The TypeScript editor for code parts: Monaco, with the part API's types.
// Loaded only when a code part is opened.
import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker.js?worker";
import { sdkTypes } from "./sdk-types.ts";

let configured = false;
function configure() {
  if (configured) return;
  configured = true;
  self.MonacoEnvironment = {
    getWorker: (_id, label) =>
      label === "typescript" || label === "javascript"
        ? new TsWorker()
        : new EditorWorker(),
  };
  const ts = monaco.typescript.typescriptDefaults;
  ts.setCompilerOptions({
    target: monaco.typescript.ScriptTarget.ESNext,
    module: monaco.typescript.ModuleKind.ESNext,
    moduleResolution: monaco.typescript.ModuleResolutionKind.NodeJs,
    allowNonTsExtensions: true,
    strict: true,
  });
  ts.addExtraLib(sdkTypes, "file:///node_modules/codecad/part.d.ts");
}

export default function CodeEditor({
  value,
  onChange,
  onRun,
}: {
  value: string;
  onChange(value: string): void;
  onRun(): void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor>(undefined);
  const handlers = useRef({ onChange, onRun });
  handlers.current = { onChange, onRun };

  useEffect(() => {
    configure();
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    const model = monaco.editor.createModel(
      value,
      "typescript",
      monaco.Uri.file(`/part-${Math.random().toString(36).slice(2)}.ts`),
    );
    const created = monaco.editor.create(box.current!, {
      model,
      theme: dark ? "vs-dark" : "vs",
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      tabSize: 2,
      scrollBeyondLastLine: false,
      fixedOverflowWidgets: true,
      ariaLabel: "Code part source",
    });
    created.onDidChangeModelContent(() =>
      handlers.current.onChange(created.getValue()),
    );
    created.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () =>
      handlers.current.onRun(),
    );
    editor.current = created;
    return () => {
      created.dispose();
      model.dispose();
    };
    // The editor keeps its own text; `value` only seeds it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const current = editor.current;
    if (current && current.getValue() !== value) current.setValue(value);
  }, [value]);

  return <div ref={box} className="code-editor" />;
}
