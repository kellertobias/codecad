// The mobile viewer's service worker (served as /p/sw.js, scope /p/): keeps
// the viewer page, its scripts and every file of the revisions looked at,
// so drawings, cut lists and layouts open in a workshop without wifi.
//
// - pages and the manifest: from the network, or the cache when offline
// - scripts and revision files: from the cache, as they never change
// - cut progress: from the network, or the last answer when offline
const version = "v1";
const shellCache = `codecad-viewer-shell-${version}`;
const filesCache = `codecad-viewer-files-${version}`;
const dataCache = `codecad-viewer-data-${version}`;
const caches_ = [shellCache, filesCache, dataCache];
/** Any viewer page stands in for another offline: it routes itself. */
const shellKey = "/p/offline-shell";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys())
        if (name.startsWith("codecad-viewer-") && !caches_.includes(name))
          await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});

const isRevisionFile = (path) =>
  /^\/api\/projects\/[0-9a-f-]{36}\/viewer\/\d+\/[a-z0-9-]+\.[a-z]+$/.test(
    path,
  );
const isData = (path) =>
  /^\/api\/projects\/[0-9a-f-]{36}\/(viewer|progress\/\d+)$/.test(path) ||
  path === "/api/session";

/** The network, with a time limit so a dead wifi falls back quickly. */
async function network(request, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(request, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function networkFirst(request, cacheName, fallbackKey) {
  const cache = await caches.open(cacheName);
  try {
    const response = await network(request, 5000);
    if (response.ok) {
      await cache.put(request, response.clone());
      if (fallbackKey) await cache.put(fallbackKey, response.clone());
    }
    return response;
  } catch (error) {
    const cached =
      (await cache.match(request, { ignoreVary: true })) ??
      (fallbackKey ? await cache.match(fallbackKey) : undefined);
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request, { ignoreVary: true });
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== location.origin || request.method !== "GET") return;
  const path = url.pathname;
  if (request.mode === "navigate" && /^\/p\/[0-9a-f-]{36}\/view/.test(path))
    event.respondWith(networkFirst(request, shellCache, shellKey));
  else if (path.startsWith("/app/assets/"))
    event.respondWith(cacheFirst(request, shellCache));
  else if (isRevisionFile(path))
    event.respondWith(cacheFirst(request, filesCache));
  else if (isData(path)) event.respondWith(networkFirst(request, dataCache));
});

// The page lists what it loaded before this worker took over, and the
// files of the revision it shows; all of it is fetched into the cache.
self.addEventListener("message", (event) => {
  const message = event.data;
  if (!message || message.type !== "keep") return;
  event.waitUntil(
    (async () => {
      const shell = await caches.open(shellCache);
      const files = await caches.open(filesCache);
      if (message.page && !(await shell.match(shellKey))) {
        try {
          const response = await fetch(message.page);
          if (response.ok) {
            await shell.put(message.page, response.clone());
            await shell.put(shellKey, response);
          }
        } catch {
          // Offline already; the page is cached next time.
        }
      }
      // Older revisions of the same projects are not needed any more.
      const kept = new Set(
        (message.urls ?? [])
          .map((url) => new URL(url, location.origin).pathname)
          .filter(isRevisionFile)
          .map((path) => path.split("/").slice(0, 6).join("/")),
      );
      const projects = new Set([...kept].map((p) => p.split("/")[3]));
      for (const request of await files.keys()) {
        const path = new URL(request.url).pathname;
        const [, , , project] = path.split("/");
        if (
          projects.has(project) &&
          !kept.has(path.split("/").slice(0, 6).join("/"))
        )
          await files.delete(request);
      }
      for (const url of message.urls ?? []) {
        const cache = isRevisionFile(new URL(url, location.origin).pathname)
          ? files
          : shell;
        if (await cache.match(url)) continue;
        try {
          const response = await fetch(url);
          if (response.ok) await cache.put(url, response);
        } catch {
          // Try again on the next visit.
        }
      }
    })(),
  );
});
