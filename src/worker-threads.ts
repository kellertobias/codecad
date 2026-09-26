// Starting worker threads from TypeScript sources in development (tsx)
// and from compiled JavaScript otherwise.
import { Worker, type ResourceLimits } from "node:worker_threads";

/** The flags that load TypeScript carry over to workers; the rest of the
 * process's flags (a test runner's, for example) may not apply to them. */
export function workerExecArgv(): string[] {
  const kept: string[] = [];
  process.execArgv.forEach((flag, i, all) => {
    if (/^--(import|require|loader|experimental-loader)=/.test(flag))
      kept.push(flag);
    else if (/^--(import|require|loader|experimental-loader)$/.test(flag))
      kept.push(flag, all[i + 1]!);
  });
  return kept;
}

/** A worker for the module next to `from` named `name` (without its
 * extension). */
export function startWorker(
  from: string,
  name: string,
  resourceLimits?: ResourceLimits,
  workerData?: unknown,
): Worker {
  const file = new URL(
    `./${name}${from.endsWith(".ts") ? ".ts" : ".js"}`,
    from,
  );
  return new Worker(file, {
    execArgv: workerExecArgv(),
    ...(resourceLimits ? { resourceLimits } : {}),
    ...(workerData === undefined ? {} : { workerData }),
  });
}
