// What the viewer loads: the manifest the server prebuilt for the latest
// saved revision, the files it names, and the cut progress, which is kept
// on the phone until the server has it, so ticking works without wifi.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ViewerManifest } from "../../../src/document/viewer.ts";

export const fileUrl = (manifest: ViewerManifest, name: string) =>
  `/api/projects/${manifest.project}/viewer/${manifest.revision}/${name}`;

export async function loadManifest(project: string): Promise<ViewerManifest> {
  const response = await fetch(`/api/projects/${project}/viewer`);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(
      body.error ?? `The project did not load (${response.status})`,
    );
  }
  return (await response.json()) as ViewerManifest;
}

/** Every file of the revision, for the offline cache. */
export const manifestFiles = (manifest: ViewerManifest) =>
  [
    ...(manifest.model ? [manifest.model] : []),
    ...manifest.drawings.flatMap((d) => [d.svg, d.pdf]),
    ...(manifest.cutList ? [manifest.cutList.pdf, manifest.cutList.csv] : []),
  ].map((name) => fileUrl(manifest, name));

export function useOnline(): boolean {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    addEventListener("online", update);
    addEventListener("offline", update);
    return () => {
      removeEventListener("online", update);
      removeEventListener("offline", update);
    };
  }, []);
  return online;
}

let token: Promise<string> | undefined;
const sessionToken = (fresh = false) => {
  if (fresh) token = undefined;
  return (token ??= fetch("/api/session", { cache: "no-store" })
    .then((response) => response.json())
    .then((body: { token: string }) => body.token)
    .catch((error: unknown) => {
      token = undefined;
      throw error;
    }));
};

interface Stored {
  readonly done: readonly string[];
  /** Changes the server has not confirmed yet, oldest first. */
  readonly queue: readonly { readonly key: string; readonly done: boolean }[];
}

const read = (key: string): Stored => {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "") as Stored;
    if (Array.isArray(value.done) && Array.isArray(value.queue)) return value;
  } catch {
    // Nothing stored yet, or storage is off.
  }
  return { done: [], queue: [] };
};
const write = (key: string, value: Stored) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode: progress still reaches the server while online.
  }
};

const applied = (
  done: Iterable<string>,
  queue: Stored["queue"],
): Set<string> => {
  const result = new Set(done);
  for (const change of queue)
    if (change.done) result.add(change.key);
    else result.delete(change.key);
  return result;
};

export interface Progress {
  readonly done: ReadonlySet<string>;
  /** Changes still waiting for the server. */
  readonly pending: number;
  set(key: string, done: boolean): void;
}

/** Cut progress for one revision: ticked locally at once, sent to the
 * server as soon as it can be, and merged with what others ticked. */
export function useProgress(manifest: ViewerManifest | undefined): Progress {
  const storageKey = manifest
    ? `codecad-progress:${manifest.project}:${manifest.revision}`
    : undefined;
  const [state, setState] = useState<Stored>({ done: [], queue: [] });
  const sending = useRef(false);
  const online = useOnline();

  const store = useCallback(
    (next: Stored) => {
      if (storageKey) write(storageKey, next);
      setState(next);
    },
    [storageKey],
  );

  const sync = useCallback(async () => {
    if (!manifest || !storageKey || sending.current) return;
    sending.current = true;
    let more = false;
    const path = `/api/projects/${manifest.project}/progress/${manifest.revision}`;
    try {
      const queue = read(storageKey).queue;
      let done: string[];
      if (queue.length) {
        const post = async (fresh: boolean) =>
          fetch(path, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-codecad-token": await sessionToken(fresh),
            },
            body: JSON.stringify({ changes: queue }),
          });
        let response = await post(false);
        // The server restarted since the token was fetched.
        if (response.status === 403) response = await post(true);
        if (!response.ok) return;
        done = ((await response.json()) as { done: string[] }).done;
      } else {
        const response = await fetch(path, { cache: "no-store" });
        if (!response.ok) return;
        done = ((await response.json()) as { done: string[] }).done;
      }
      // Ticks made while the request was under way stay queued.
      const latest = read(storageKey);
      const rest = latest.queue.slice(queue.length);
      store({ done: [...applied(done, rest)], queue: rest });
      more = rest.length > 0;
    } catch {
      // Offline: the queue waits for the next chance.
    } finally {
      sending.current = false;
    }
    if (more) void sync();
  }, [manifest, storageKey, store]);

  useEffect(() => {
    if (!storageKey) return;
    setState(read(storageKey));
    void sync();
  }, [storageKey, sync]);
  useEffect(() => {
    if (online) void sync();
  }, [online, sync]);

  const done = applied(state.done, []);
  return {
    done,
    pending: state.queue.length,
    set(key, value) {
      if (!storageKey) return;
      const current = read(storageKey);
      const queue = [...current.queue, { key, done: value }];
      store({
        done: [...applied(current.done, [{ key, done: value }])],
        queue,
      });
      void sync();
    },
  };
}

/** Registers the service worker that keeps the viewer for use offline,
 * and hands it what this page loaded, so all of it is cached even before
 * the worker controlled a request. */
export async function keepOffline(urls: readonly string[]): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("/p/sw.js", { scope: "/p/" });
    const registration = await navigator.serviceWorker.ready;
    const loaded = performance
      .getEntriesByType("resource")
      .map((entry) => new URL(entry.name))
      .filter(
        (url) =>
          url.origin === location.origin && url.pathname.startsWith("/app/"),
      )
      .map((url) => url.pathname);
    registration.active?.postMessage({
      type: "keep",
      page: location.pathname,
      urls: [...new Set([...loaded, ...urls])],
    });
  } catch {
    // Without a service worker the viewer still works online.
  }
}
