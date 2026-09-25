/** Marks a progress line in a build's output, so Studio can tell it from log text. */
export const PROGRESS_PREFIX = "CODECAD_PROGRESS ";

export interface Progress {
  /** How far along, from 0 to 1. */
  fraction: number;
  /** What the build is doing, e.g. "Evaluating geometry · 3 / 12 parts". */
  message: string;
}

let lastMessage = "",
  lastAt = 0;
/**
 * Reports a step of a build that Studio started; a build run from the command
 * line prints nothing extra. A tight loop reports at most every 100 ms, but a
 * new step is always reported.
 */
export function reportProgress(fraction: number, message: string) {
  if (process.env.CODECAD_PROGRESS !== "1") return;
  const now = Date.now();
  if (message === lastMessage && now - lastAt < 100 && fraction < 1) return;
  lastMessage = message;
  lastAt = now;
  const clamped = Math.max(0, Math.min(1, fraction));
  process.stdout.write(
    PROGRESS_PREFIX +
      JSON.stringify({ fraction: Math.round(clamped * 1000) / 1000, message }) +
      "\n",
  );
}

/**
 * Splits a child process's output into progress reports and the remaining log.
 * Output arrives in arbitrary chunks, so an unfinished last line waits for the
 * next one.
 */
export function progressReader(
  onProgress: (progress: Progress) => void,
  onLog: (text: string) => void,
) {
  let pending = "";
  return (chunk: Buffer | string) => {
    pending += chunk.toString();
    const lines = pending.split("\n");
    pending = lines.pop()!;
    let log = "";
    for (const line of lines) {
      if (line.startsWith(PROGRESS_PREFIX)) {
        try {
          const report = JSON.parse(line.slice(PROGRESS_PREFIX.length));
          if (
            typeof report.fraction === "number" &&
            typeof report.message === "string"
          ) {
            onProgress(report);
            continue;
          }
        } catch {
          /* Not a report after all; keep it as log text. */
        }
      }
      log += line + "\n";
    }
    // A partial line that cannot become a report is log text already.
    if (pending && !PROGRESS_PREFIX.startsWith(pending.slice(0, 17))) {
      log += pending;
      pending = "";
    }
    if (log) onLog(log);
  };
}
