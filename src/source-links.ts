import ts from "typescript";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface SourceLine {
  file: string;
  line: number;
}
/** Match executed construction sites, then resolve lexical references (not name matching). */
export function sourceLinks(entry: string) {
  const runtimeDirectory = dirname(fileURLToPath(import.meta.url)) + "/";
  const program = ts.createProgram([entry], {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  return (traces: readonly string[]): SourceLine[] => {
    const locations = new Map<string, SourceLine>();
    const add = (file: ts.SourceFile, node: ts.Node) => {
      const start =
        file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      const end = file.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      for (let line = start; line <= end; line++)
        locations.set(`${file.fileName}:${line}`, {
          file: resolve(file.fileName),
          line,
        });
    };
    const statement = (node: ts.Node): ts.Node => {
      while (
        node.parent &&
        !ts.isStatement(node) &&
        !ts.isVariableDeclaration(node)
      )
        node = node.parent;
      return node;
    };
    for (const trace of traces) {
      // Only the nearest project callsite: outer constructor frames are shared by unrelated children.
      for (const frame of trace.split("\n")) {
        const match = frame.match(
          /(?:\(|\s)((?:file:\/\/\/|\/)[^()]+):(\d+):(\d+)\)?$/,
        );
        if (!match) continue;
        const path = match[1]!.startsWith("file:")
          ? fileURLToPath(match[1]!)
          : match[1]!;
        const file = program.getSourceFile(path);
        if (
          !file ||
          path.includes("/node_modules/") ||
          path.startsWith(runtimeDirectory)
        )
          continue;
        const position = file.getPositionOfLineAndCharacter(
          Number(match[2]) - 1,
          Number(match[3]) - 1,
        );
        let hit: ts.Node = file;
        const visit = (node: ts.Node) => {
          if (node.getStart(file) <= position && node.end >= position) {
            hit = node;
            node.forEachChild(visit);
          }
        };
        visit(file);
        const site = statement(hit);
        add(file, site);
        if (
          !trace.startsWith("snapshot\n") &&
          ts.isVariableDeclaration(site) &&
          ts.isIdentifier(site.name)
        ) {
          const symbol = checker.getSymbolAtLocation(site.name);
          const references = (node: ts.Node) => {
            if (
              ts.isIdentifier(node) &&
              checker.getSymbolAtLocation(node) === symbol
            )
              add(file, statement(node));
            node.forEachChild(references);
          };
          references(file);
        }
        break;
      }
    }
    return [...locations.values()].sort(
      (a, b) => a.file.localeCompare(b.file) || a.line - b.line,
    );
  };
}
