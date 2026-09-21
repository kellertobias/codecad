// Which panes a project was last left with.
//
// The server keeps this, not the page: every session is served from its own
// port, so the origin — and with it anything the page could store for itself —
// changes every time the project is opened.
export type PaneName = "code" | "parts";
export type PaneState = Partial<Record<PaneName, boolean>>;

let state: PaneState = {};
let token = "";
let loaded = false;
/** Panes the reader changed before the saved state arrived; theirs wins. */
const changed = new Set<PaneName>();
const waiting: ((state: PaneState) => void)[] = [];

function save(panes: PaneState) {
  void fetch("/api/view", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CodeCAD-Token": token },
    body: JSON.stringify(panes),
  }).catch(() => {});
}

/** Applies the remembered state once it arrives, or at once if it already has.
 * A pane the reader has already touched is left out, so restoring never undoes
 * something they just did. */
export function whenRemembered(apply: (state: PaneState) => void) {
  if (loaded) apply(state);
  else waiting.push(apply);
}

/** Fetches what this project was left with. Never rejects: no preference yet
 * and an unreachable server both mean "leave the panes as they are". */
export async function loadPanes(sessionToken: string) {
  token = sessionToken;
  let stored: PaneState = {};
  try {
    const response = await fetch("/api/view");
    stored = ((await response.json()).panes as PaneState | undefined) ?? {};
  } catch {
    stored = {};
  }
  const mine: PaneState = {};
  for (const name of changed) {
    const open = state[name];
    if (open !== undefined) mine[name] = open;
  }
  state = { ...stored, ...mine };
  loaded = true;
  if (changed.size) save(mine);
  changed.clear();
  const restore: PaneState = { ...state };
  for (const name of Object.keys(mine) as PaneName[]) delete restore[name];
  for (const apply of waiting.splice(0)) apply(restore);
}

/** Records one pane. Only that pane is sent, so two pages of the same project
 * cannot overwrite each other's other panes. */
export function rememberPane(name: PaneName, open: boolean) {
  if (state[name] === open) return;
  state[name] = open;
  if (!loaded) changed.add(name);
  else save({ [name]: open });
}
