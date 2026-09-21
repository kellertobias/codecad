import { test } from "node:test";
import assert from "node:assert/strict";
import type { PaneState } from "../web/panes.js";

type Post = { body: PaneState; token: string };

/** A fresh copy of the store, since it keeps one project's state per page. */
async function panes(stored: PaneState | "unreachable") {
  const posts: Post[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push({
        body: JSON.parse(String(init.body)),
        token: String(
          (init.headers as Record<string, string>)["X-CodeCAD-Token"],
        ),
      });
      return { json: async () => ({}) };
    }
    assert.equal(url, "/api/view");
    if (stored === "unreachable") throw new Error("offline");
    return { json: async () => ({ panes: stored }) };
  }) as unknown as typeof fetch;
  const module = await import(
    `../web/panes.js?copy=${posts.length}-${Math.random()}`
  );
  return { ...(module as typeof import("../web/panes.js")), posts };
}

test("restores the panes a project was left with", async () => {
  const { whenRemembered, loadPanes } = await panes({
    code: false,
    parts: true,
  });
  const applied: PaneState[] = [];
  whenRemembered((state) => applied.push(state));
  await loadPanes("t");
  assert.deepEqual(applied, [{ code: false, parts: true }]);
  // A late listener still gets the state, without waiting for another load.
  const late: PaneState[] = [];
  whenRemembered((state) => late.push(state));
  assert.deepEqual(late, [{ code: false, parts: true }]);
});

test("leaves the panes alone when nothing is stored or the server is away", async () => {
  for (const stored of [{}, "unreachable" as const]) {
    const { whenRemembered, loadPanes } = await panes(stored);
    const applied: PaneState[] = [];
    whenRemembered((state) => applied.push(state));
    await loadPanes("t");
    assert.deepEqual(applied, [{}]);
  }
});

test("sends one pane at a time, and only when it changed", async () => {
  const { loadPanes, rememberPane, posts } = await panes({ code: false });
  await loadPanes("secret");
  rememberPane("parts", true);
  // Already false on the server, so nothing to say.
  rememberPane("code", false);
  rememberPane("code", true);
  assert.deepEqual(
    posts.map((post) => post.body),
    [{ parts: true }, { code: true }],
  );
  assert.deepEqual(
    new Set(posts.map((post) => post.token)),
    new Set(["secret"]),
  );
});

test("a pane toggled before the saved state arrives wins, and is not overridden", async () => {
  const { whenRemembered, loadPanes, rememberPane, posts } = await panes({
    code: false,
    parts: false,
  });
  const applied: PaneState[] = [];
  whenRemembered((state) => applied.push(state));
  // The reader opens the parts pane while the fetch is still in flight.
  rememberPane("parts", true);
  await loadPanes("t");
  // Their pane is flushed to the server and left out of what gets restored,
  // so restoring cannot close what they just opened.
  assert.deepEqual(
    posts.map((post) => post.body),
    [{ parts: true }],
  );
  assert.deepEqual(applied, [{ code: false }]);
});
