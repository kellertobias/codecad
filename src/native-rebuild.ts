import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
/** Compile in a per-build directory; never write JS alongside the user's source. */
export async function compileCad(
  entry: string,
  directory: string,
  signal?: AbortSignal,
) {
  const output = join(resolve(directory), ".native"),
    config = join(output, "tsconfig.json");
  await mkdir(output, { recursive: true });
  await writeFile(
    config,
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2023",
          module: "ESNext",
          moduleResolution: "Bundler",
          rootDir: "/",
          outDir: join(output, "js"),
          noCheck: true,
          noEmit: false,
          declaration: false,
          inlineSourceMap: true,
          inlineSources: true,
          rewriteRelativeImportExtensions: true,
          allowImportingTsExtensions: true,
          paths: { "@tobisk/codecad": [join(root, "src/index.ts")] },
          skipLibCheck: true,
        },
        files: [
          await realpath(entry),
          join(root, "src/worker.ts"),
          join(root, "src/index.ts"),
        ],
      },
      null,
      2,
    ),
  );
  const started = performance.now();
  await run(
    process.execPath,
    [join(root, "node_modules/@typescript/native/lib/tsc.js"), "-p", config],
    signal,
  );
  console.log(
    `TypeScript 7 emit: ${Math.round(performance.now() - started)} ms`,
  );
  return join(output, "js");
}
function run(
  command: string,
  args: string[],
  signal?: AbortSignal,
  env = process.env,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      env,
    });
    const abort = () => child.kill("SIGTERM");
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    child.on("error", reject);
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (code === 0 && !signal?.aborted) resolve();
      else reject(new Error(`CAD subprocess failed (${code ?? "terminated"})`));
    });
  });
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());
  try {
    const entry = resolve(
      process.argv[2] ?? join(root, "examples/kitchen-cabinet/index.ts"),
    );
    const directory = resolve(
      process.argv[3] ?? join(root, "output/kitchen-cabinet"),
    );
    const emitted = await compileCad(entry, directory, controller.signal);
    await run(
      process.execPath,
      [
        "--enable-source-maps",
        "--import",
        join(root, "src/native-loader.mjs"),
        join(root, "src/worker.ts"),
        entry,
        directory,
      ],
      controller.signal,
      {
        ...process.env,
        CODECAD_NATIVE_OUTPUT: emitted,
      },
    );
  } catch (error) {
    if (!controller.signal.aborted) console.error(error);
    process.exitCode = controller.signal.aborted ? 130 : 1;
  }
}
