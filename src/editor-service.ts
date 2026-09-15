import ts from "typescript";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function editorService(root: string, entry: string) {
  const files = new Map<string, string>();
  for (const directory of [join(root, "src"), join(root, "examples")]) {
    for (const name of await readdir(directory))
      if (name.endsWith(".ts"))
        files.set(
          join(directory, name),
          await readFile(join(directory, name), "utf8"),
        );
  }
  let revision = 0;
  const service = ts.createLanguageService({
    getCompilationSettings: () => ({
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
    }),
    getScriptFileNames: () => [...new Set([...files.keys(), entry])],
    getScriptVersion: () => String(revision),
    getScriptSnapshot: (file) => {
      const source = files.get(file) ?? ts.sys.readFile(file);
      return source === undefined
        ? undefined
        : ts.ScriptSnapshot.fromString(source);
    },
    getCurrentDirectory: () => root,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
  });
  return {
    libraries: () =>
      [...files].map(([file, content]) => ({
        uri: pathToFileURL(file).href,
        content,
      })),
    complete(source: string, position: number) {
      files.set(entry, source);
      revision++;
      const preferences: ts.UserPreferences = {
        includeCompletionsForModuleExports: true,
        includeCompletionsWithInsertText: true,
        importModuleSpecifierPreference: "relative",
        importModuleSpecifierEnding: "js",
      };
      const completions = service.getCompletionsAtPosition(
        entry,
        position,
        preferences,
      );
      const prefix =
        source.slice(0, position).match(/[A-Za-z_$][\w$]*$/)?.[0] ?? "";
      if (prefix.length < 2) return [];
      return (completions?.entries ?? [])
        .filter(
          (item) =>
            item.hasAction &&
            item.name.toLowerCase().startsWith(prefix.toLowerCase()),
        )
        .slice(0, 30)
        .flatMap((item) => {
          const details = service.getCompletionEntryDetails(
            entry,
            position,
            item.name,
            { indentSize: 2, convertTabsToSpaces: true },
            item.source,
            preferences,
            item.data,
          );
          const changes =
            details?.codeActions?.flatMap((action) => action.changes) ?? [];
          if (changes.some((change) => change.fileName !== entry)) return [];
          return [
            {
              name: item.name,
              detail: item.source ?? "Auto import",
              edits: changes.flatMap((change) => change.textChanges),
            },
          ];
        });
    },
  };
}
