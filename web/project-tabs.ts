// Tab strip listing every project the desktop app currently has open. Each tab
// is its own CAD runtime, so switching tabs navigates the window to that
// project's local server instead of rebuilding anything.
type Invoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;
export type SessionTab = {
  id: number;
  title: string;
  path: string;
  url: string;
  active: boolean;
};
export type ProjectTabsHost = {
  invoke: Invoke;
  container: HTMLElement;
  /** Confirms leaving the current page; unsaved edits can cancel a switch. */
  canLeave?: () => boolean;
  /** Opens the project picker. Omitted on the home screen, which is the picker. */
  newTab?: () => void;
  onError?: (message: string) => void;
};
export function mountProjectTabs(host: ProjectTabsHost) {
  const { invoke, container } = host;
  const canLeave = host.canLeave ?? (() => true);
  const report = host.onError ?? (() => {});
  container.classList.add("project-tabs");
  const strip = document.createElement("div");
  strip.className = "project-tab-strip";
  strip.setAttribute("role", "tablist");
  strip.setAttribute("aria-label", "Open projects");
  const add = document.createElement("button");
  add.className = "project-tab-add";
  add.textContent = "+";
  add.setAttribute("aria-label", "Open another project");
  add.title = "Open another project";
  if (host.newTab) add.onclick = () => host.newTab?.();
  else {
    add.disabled = true;
    add.classList.add("current");
    add.title = "Project picker";
  }
  container.append(strip, add);
  let tabs: SessionTab[] = [];
  function go(url: string) {
    location.replace(url);
  }
  async function activate(tab: SessionTab) {
    if (tab.active || !canLeave()) return;
    try {
      go(await invoke<string>("activate_session", { id: tab.id }));
    } catch (error) {
      report(String(error));
      void refresh();
    }
  }
  async function close(tab: SessionTab) {
    if (tab.active && !canLeave()) return;
    try {
      const next = await invoke<string | null>("close_session", { id: tab.id });
      // Closing the last project sends the window home on the native side.
      if (!tab.active) await refresh();
      else if (next) go(next);
    } catch (error) {
      report(String(error));
      void refresh();
    }
  }
  function render() {
    // The home screen is itself the picker, so an empty strip stays out of the way.
    container.hidden = tabs.length === 0;
    strip.replaceChildren(
      ...tabs.map((tab) => {
        const item = document.createElement("span");
        item.className = "project-tab";
        if (tab.active) item.classList.add("active");
        const open = document.createElement("button");
        open.className = "project-tab-open";
        open.textContent = tab.title;
        open.title = tab.path;
        open.setAttribute("role", "tab");
        open.setAttribute("aria-selected", String(tab.active));
        open.onclick = () => void activate(tab);
        const shut = document.createElement("button");
        shut.className = "project-tab-close";
        shut.textContent = "×";
        shut.setAttribute("aria-label", `Close ${tab.title}`);
        shut.title = `Close ${tab.title}`;
        shut.onclick = () => void close(tab);
        item.append(open, shut);
        return item;
      }),
    );
  }
  async function refresh() {
    try {
      tabs = await invoke<SessionTab[]>("session_tabs", {});
    } catch (error) {
      report(String(error));
      return;
    }
    render();
  }
  window.addEventListener("keydown", (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey)
      return;
    const digit = Number(event.key);
    if (digit >= 1 && digit <= 9 && tabs[digit - 1]) {
      event.preventDefault();
      void activate(tabs[digit - 1]!);
    } else if (event.key.toLowerCase() === "t" && host.newTab) {
      event.preventDefault();
      host.newTab();
    }
  });
  void refresh();
  return { refresh };
}
