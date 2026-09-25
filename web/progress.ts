/** A step the server reports, from 0 to 1, with what it is doing. */
export interface Progress {
  fraction: number;
  message: string;
}

/**
 * A progress bar with a caption. Without a fraction it runs as an
 * indeterminate bar, for work that has not said how far along it is.
 */
export function progressBar(className = "") {
  const element = document.createElement("div"),
    track = document.createElement("div"),
    fill = document.createElement("div"),
    caption = document.createElement("span");
  element.className = ("progress " + className).trim();
  element.setAttribute("role", "progressbar");
  element.setAttribute("aria-valuemin", "0");
  element.setAttribute("aria-valuemax", "100");
  track.className = "progress-track";
  fill.className = "progress-fill";
  caption.className = "progress-caption";
  track.append(fill);
  element.append(track, caption);
  const set = (fraction: number | undefined, message: string) => {
    const known = fraction !== undefined && Number.isFinite(fraction);
    const percent = known
      ? Math.round(Math.max(0, Math.min(1, fraction)) * 100)
      : 0;
    element.classList.toggle("indeterminate", !known);
    fill.style.width = known ? `${percent}%` : "";
    caption.textContent = known ? `${message} · ${percent}%` : message;
    element.setAttribute("aria-label", message);
    if (known) element.setAttribute("aria-valuenow", String(percent));
    else element.removeAttribute("aria-valuenow");
  };
  set(undefined, "Working…");
  return { element, set };
}

/** Files the server is generating on request, as the event stream reports. */
const exports = new Map<string, Progress>();
const exportListeners = new Set<(name: string, progress?: Progress) => void>();
/** Takes the server's latest list of files being generated. */
export function updateExports(current: Record<string, Progress> = {}) {
  for (const name of [...exports.keys()])
    if (!(name in current)) {
      exports.delete(name);
      exportListeners.forEach((listener) => listener(name));
    }
  for (const [name, progress] of Object.entries(current)) {
    const known = exports.get(name);
    if (
      known?.fraction === progress.fraction &&
      known.message === progress.message
    )
      continue;
    exports.set(name, progress);
    exportListeners.forEach((listener) => listener(name, progress));
  }
}
/** Hears the server's progress on one file; returns how to stop listening. */
export function onExport(name: string, listener: (progress: Progress) => void) {
  const heard = (changed: string, progress?: Progress) => {
    if (changed === name && progress) listener(progress);
  };
  exportListeners.add(heard);
  const known = exports.get(name);
  if (known) listener(known);
  return () => exportListeners.delete(heard);
}
/** The artifact name in a Studio `/artifacts/…` URL. */
export function artifactName(href: string) {
  const path = new URL(href, location.href).pathname;
  return path.startsWith("/artifacts/")
    ? decodeURIComponent(path.slice("/artifacts/".length))
    : undefined;
}

const preparing = new Set<string>();
/**
 * Downloads an artifact with its progress shown after `after`. Most files are
 * generated only when asked for, which can take a while, so the server makes
 * the file first and the browser saves it once it exists.
 */
export async function downloadWithProgress(
  href: string,
  filename: string,
  after: Element,
) {
  const name = artifactName(href) ?? filename;
  if (preparing.has(href)) return;
  preparing.add(href);
  const bar = progressBar("download-progress");
  bar.set(undefined, `Generating ${name}`);
  // A file that is ready already comes back at once; no bar flickers by.
  const reveal = setTimeout(() => after.after(bar.element), 150);
  const stop = onExport(name, (progress) =>
    bar.set(progress.fraction, progress.message),
  );
  try {
    const url = new URL(href, location.href);
    url.searchParams.delete("download");
    url.searchParams.set("prepare", "");
    const response = await fetch(url);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error ?? `Could not generate ${name}`);
    }
    bar.set(1, `Saving ${name}`);
    const link = document.createElement("a");
    link.href = href;
    link.download = filename;
    link.dataset.prepared = "";
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    clearTimeout(reveal);
    bar.element.remove();
  } catch (error) {
    clearTimeout(reveal);
    bar.element.classList.add("failed");
    // A failed export carries its whole log; the first line says enough here.
    const message = error instanceof Error ? error.message : String(error);
    bar.set(undefined, message.split("\n")[0]!.slice(0, 160));
    after.after(bar.element);
    setTimeout(() => bar.element.remove(), 8000);
  } finally {
    stop();
    preparing.delete(href);
  }
}
/** Gives every artifact download link on the page its progress display. */
export function showDownloadProgress(root: Document | Element = document) {
  root.addEventListener("click", (event) => {
    const link = (event.target as Element | null)?.closest?.("a[href]");
    if (!(link instanceof HTMLAnchorElement) || "prepared" in link.dataset)
      return;
    const url = new URL(link.href, location.href);
    if (!artifactName(link.href) || !url.searchParams.has("download")) return;
    event.preventDefault();
    void downloadWithProgress(
      link.href,
      link.download || artifactName(link.href)!,
      link,
    );
  });
}
