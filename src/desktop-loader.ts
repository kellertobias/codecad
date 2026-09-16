import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// All project classes must use the same runtime class identities as the worker.
// Map SDK imports from another CodeCAD workspace to the bundled, versioned SDK.
const sdk = resolve(fileURLToPath(new URL(".", import.meta.url)));
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@tobisk/codecad")
      return nextResolve(pathToFileURL(join(sdk, "index.ts")).href, context);
    const result = nextResolve(specifier, context);
    if (!result.url.startsWith("file:")) return result;
    const path = fileURLToPath(result.url),
      parent = dirname(path);
    if (parent === sdk || !path.match(/[/\\]src[/\\][^/\\]+\.[jt]s$/))
      return result;
    try {
      const pkg = JSON.parse(
        readFileSync(join(parent, "../package.json"), "utf8"),
      );
      const target = join(sdk, relative(parent, path).replace(/\.js$/, ".ts"));
      if (pkg.name === "@tobisk/codecad" && existsSync(target))
        return nextResolve(pathToFileURL(target).href, context);
    } catch {
      /* Not a CodeCAD SDK; retain the project's own module. */
    }
    return result;
  },
});
