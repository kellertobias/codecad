import * as monaco from "monaco-editor";

self.MonacoEnvironment = {
  getWorker: (_id, label) =>
    new Worker(
      label === "typescript" || label === "javascript"
        ? "/ts.worker.js"
        : "/editor.worker.js",
      { type: "module" },
    ),
};
monaco.typescript.typescriptDefaults.setCompilerOptions({
  target: monaco.typescript.ScriptTarget.ESNext,
  module: monaco.typescript.ModuleKind.ESNext,
  moduleResolution: monaco.typescript.ModuleResolutionKind.NodeJs,
  allowNonTsExtensions: true,
  strict: true,
});
monaco.typescript.typescriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
});
monaco.typescript.typescriptDefaults.setEagerModelSync(true);

// TypeScript's multiline import block is not consistently tagged as an import
// region by Monaco. Supply that semantic range so default import folding works.
monaco.languages.registerFoldingRangeProvider("typescript", {
  provideFoldingRanges(model) {
    const ranges: monaco.languages.FoldingRange[] = [];
    const source = model.getValue();
    const lines = source.split("\n"),
      stack: { start: number; indent: number }[] = [];
    let previous = 0,
      previousIndent = 0;
    lines.forEach((line, index) => {
      if (!line.trim()) return;
      const indent = line.match(/^\s*/)?.[0].replaceAll("\t", "  ").length ?? 0;
      if (indent > previousIndent)
        stack.push({ start: previous + 1, indent: previousIndent });
      while (stack.length && indent <= stack.at(-1)!.indent) {
        const block = stack.pop()!,
          end = /^\s*[}\])]/.test(line) ? index + 1 : index;
        if (end > block.start) ranges.push({ start: block.start, end });
      }
      previous = index;
      previousIndent = indent;
    });
    const imports = /^import\s[\s\S]*?(?:from\s*)?["'][^"'\n]+["']\s*;?/gm;
    for (const match of source.matchAll(imports)) {
      const start = model.getPositionAt(match.index).lineNumber;
      const end = model.getPositionAt(
        match.index + match[0].trimEnd().length,
      ).lineNumber;
      if (end > start) {
        const existing = ranges.findIndex((r) => r.start === start);
        if (existing >= 0) ranges.splice(existing, 1);
        ranges.push({
          start,
          end,
          kind: monaco.languages.FoldingRangeKind.Imports,
        });
      }
    }
    return ranges;
  },
});

export const codeEditor = monaco.editor.create(
  document.getElementById("editor")!,
  {
    language: "typescript",
    editContext: false,
    theme: "vs-dark",
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 12,
    tabSize: 2,
    folding: true,
    foldingImportsByDefault: true,
    showFoldingControls: "always",
    scrollBeyondLastLine: false,
    ariaLabel: "TypeScript project source",
    fixedOverflowWidgets: true,
  },
);
const decorations = codeEditor.createDecorationsCollection();
let loading = false,
  sessionToken = "";
export async function configureEditor(token: string) {
  sessionToken = token;
  const response = await fetch("/api/editor-libraries");
  const files: { uri: string; content: string }[] = await response.json();
  for (const file of files)
    monaco.typescript.typescriptDefaults.addExtraLib(file.content, file.uri);
}
export function setSource(source: string, file: string) {
  if (codeEditor.getValue() === source) return;
  loading = true;
  const uri = monaco.Uri.file(file),
    old = codeEditor.getModel();
  if (old?.uri.toString() === uri.toString()) old.setValue(source);
  else {
    codeEditor.setModel(monaco.editor.createModel(source, "typescript", uri));
    old?.dispose();
  }
  loading = false;
  const imports = source
    .split("\n")
    .flatMap((line, index) => (/^import\s/.test(line) ? [index] : []));
  void codeEditor
    .getAction("editor.fold")
    ?.run({ selectionLines: imports, levels: 1 });
}
export function onSourceChange(callback: () => void) {
  codeEditor.onDidChangeModelContent(() => {
    if (!loading) callback();
  });
}
export function highlightLines(lines: number[], reveal = true) {
  const model = codeEditor.getModel();
  const valid = [...new Set(lines)].filter(
    (line) => line > 0 && line <= (model?.getLineCount() ?? 0),
  );
  decorations.set(
    valid.map((line) => ({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        isWholeLine: true,
        className: "component-source-line",
        linesDecorationsClassName: "component-source-gutter",
        overviewRuler: {
          color: "#68cbb5",
          position: monaco.editor.OverviewRulerLane.Full,
        },
      },
    })),
  );
  if (reveal && valid.length)
    codeEditor.revealLineInCenterIfOutsideViewport(valid[0]!);
}
monaco.languages.registerCompletionItemProvider("typescript", {
  async provideCompletionItems(model, position, _context, cancellation) {
    const word = model.getWordUntilPosition(position);
    if (word.word.length < 2) return { suggestions: [] };
    const version = model.getVersionId();
    const response = await fetch("/api/editor-completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CodeCAD-Token": sessionToken,
      },
      body: JSON.stringify({
        source: model.getValue(),
        position: model.getOffsetAt(position),
      }),
    });
    if (
      !response.ok ||
      cancellation.isCancellationRequested ||
      version !== model.getVersionId()
    )
      return { suggestions: [] };
    const entries: {
      name: string;
      detail: string;
      edits: { span: { start: number; length: number }; newText: string }[];
    }[] = await response.json();
    return {
      suggestions: entries.map((entry) => ({
        label: entry.name,
        detail: `Auto import from ${entry.detail}`,
        kind: monaco.languages.CompletionItemKind.Class,
        insertText: entry.name,
        range: new monaco.Range(
          position.lineNumber,
          word.startColumn,
          position.lineNumber,
          word.endColumn,
        ),
        additionalTextEdits: entry.edits.map((edit) => {
          const a = model.getPositionAt(edit.span.start),
            b = model.getPositionAt(edit.span.start + edit.span.length);
          return {
            range: new monaco.Range(
              a.lineNumber,
              a.column,
              b.lineNumber,
              b.column,
            ),
            text: edit.newText,
          };
        }),
      })),
    };
  },
});
