import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sdk = fileURLToPath(new URL(".", import.meta.url));
const emitted = process.env.CODECAD_NATIVE_OUTPUT;
if (!emitted)
  throw new Error("Native CAD loader requires CODECAD_NATIVE_OUTPUT");
const outputFor = (path) =>
  join(emitted, resolve(path).replace(/^\//, "")).replace(
    /\.(mts|cts|tsx|ts)$/,
    (_, extension) =>
      extension === "mts" ? ".mjs" : extension === "cts" ? ".cjs" : ".js",
  );
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@tobisk/codecad")
      specifier = pathToFileURL(join(sdk, "index.ts")).href;
    let result;
    try {
      result = nextResolve(specifier, context);
    } catch (error) {
      if (!/^(\.|\/|file:)/.test(specifier)) {
        // External project files can use the SDK's bundled dependencies.
        result = nextResolve(specifier, {
          ...context,
          parentURL: new URL("index.ts", import.meta.url).href,
        });
      } else {
        const url = new URL(specifier, context.parentURL);
        if (url.protocol !== "file:") throw error;
        const path = fileURLToPath(url);
        const source = path.replace(/\.(mjs|cjs|js)$/, (_, ext) =>
          ext === "mjs" ? ".mts" : ext === "cjs" ? ".cts" : ".ts",
        );
        const candidates =
          source !== path
            ? [source]
            : extname(path)
              ? []
              : [
                  ...[".ts", ".mts", ".cts", ".tsx"].map((ext) => path + ext),
                  ...[".ts", ".mts", ".cts", ".tsx"].map((ext) =>
                    join(path, "index" + ext),
                  ),
                ];
        const match = candidates.find((candidate) => existsSync(candidate));
        if (!match) throw error;
        result = nextResolve(pathToFileURL(match).href, context);
      }
    }
    if (result.url.startsWith("file:")) {
      const path = fileURLToPath(result.url),
        parent = dirname(path);
      if (
        parent !== sdk.replace(/\/$/, "") &&
        /\/src\/[^/]+\.[jt]s$/.test(path)
      ) {
        try {
          const pkg = JSON.parse(
            readFileSync(join(parent, "../package.json"), "utf8"),
          );
          const target = join(
            sdk,
            path.split("/").at(-1).replace(/\.js$/, ".ts"),
          );
          if (
            ["@tobisk/codecad", "@codecad/studio"].includes(pkg.name) &&
            existsSync(target)
          )
            return nextResolve(pathToFileURL(target).href, context);
        } catch {
          /* Unrelated module: retain its original identity. */
        }
      }
    }
    return result;
  },
  load(url, context, nextLoad) {
    if (
      url.startsWith("file:") &&
      /\.(ts|mts|cts|tsx)$/.test(fileURLToPath(url))
    ) {
      const output = outputFor(fileURLToPath(url));
      if (!existsSync(output))
        throw new Error(
          `TypeScript 7 did not emit ${fileURLToPath(url)}; import project modules statically so they enter the compile graph.`,
        );
      // Original URLs preserve import.meta.url, relative assets and module identity.
      return {
        format: url.endsWith(".cts") ? "commonjs" : "module",
        source: readFileSync(output, "utf8").replace(
          /sourceMappingURL=data:application\/json;base64,([^\s]+)/,
          (_, data) => {
            const map = JSON.parse(Buffer.from(data, "base64").toString());
            map.sources = [url];
            map.sourceRoot = "";
            return `sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}`;
          },
        ),
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});
