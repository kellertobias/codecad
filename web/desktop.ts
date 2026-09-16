type Native = {
  core: {
    invoke<T>(command: string, args: Record<string, unknown>): Promise<T>;
  };
};
const native = (window as unknown as { __TAURI__?: Native }).__TAURI__;
export function setupDesktop(canLeave: () => boolean) {
  if (!native) return;
  const bridge = native;
  document.body.classList.add("desktop");
  const bar = document.querySelector("header")!;
  const open = document.createElement("button");
  open.id = "open-project";
  open.textContent = "Open project…";
  bar.insertBefore(open, document.getElementById("rebuild"));
  const source = document.createElement("button");
  source.id = "desktop-toggle-source";
  source.textContent = "Hide code";
  source.onclick = () => {
    const hidden = document.body.classList.toggle("source-hidden");
    source.textContent = hidden ? "Show code" : "Hide code";
    source.setAttribute("aria-pressed", String(hidden));
  };
  bar.insertBefore(source, document.getElementById("rebuild"));
  const editors = document.createElement("select");
  editors.id = "external-editor";
  editors.setAttribute("aria-label", "Open in external editor");
  const placeholder = document.createElement("option");
  placeholder.textContent = "Open in…";
  placeholder.value = "";
  editors.append(placeholder);
  editors.onchange = async () => {
    const editor = editors.value;
    editors.value = "";
    if (!editor) return;
    try {
      await bridge.core.invoke("open_in_editor", { editor });
    } catch (e) {
      document.getElementById("source-status")!.textContent =
        `Could not open editor: ${String(e)}`;
    }
  };
  bar.insertBefore(editors, document.getElementById("rebuild"));
  void bridge.core
    .invoke<string[]>("available_editors", {})
    .then((installed) => {
      for (const [id, label] of [
        ["vscode", "VS Code"],
        ["cursor", "Cursor"],
        ["codex", "Codex"],
      ] as const) {
        if (!installed.includes(id)) continue;
        const option = document.createElement("option");
        option.value = id;
        option.textContent = label;
        editors.append(option);
      }
      editors.hidden = !installed.length;
    })
    .catch(() => {
      editors.hidden = true;
    });
  const picker = document.createElement("dialog");
  picker.className = "project-picker";
  picker.setAttribute("aria-label", "Open project");
  const title = document.createElement("h2");
  title.textContent = "Open project";
  const tabs = document.createElement("div");
  tabs.className = "picker-tabs";
  const content = document.createElement("div");
  content.className = "picker-content";
  const recentTab = document.createElement("button");
  const examplesTab = document.createElement("button");
  const diskTab = document.createElement("button");
  for (const [button, label] of [
    [recentTab, "Recent"],
    [examplesTab, "Examples"],
    [diskTab, "From disk"],
  ] as const) {
    button.textContent = label;
    tabs.append(button);
  }
  picker.append(title, tabs, content);
  document.body.append(picker);
  let recent: string[] = [];
  async function openSelection(
    example: string | null = null,
    path: string | null = null,
  ) {
    if (!canLeave()) return;
    open.disabled = true;
    try {
      const url = await bridge.core.invoke<string | null>("open_project", {
        example,
        path,
      });
      if (url) location.replace(url);
    } catch (e) {
      const status = document.getElementById("source-status");
      if (status) status.textContent = `Could not open project: ${String(e)}`;
    } finally {
      open.disabled = false;
    }
  }
  function renderTab(tab: "recent" | "examples" | "disk") {
    content.replaceChildren();
    for (const [button, name] of [
      [recentTab, "recent"],
      [examplesTab, "examples"],
      [diskTab, "disk"],
    ] as const)
      button.setAttribute("aria-selected", String(tab === name));
    if (tab === "disk") {
      const button = document.createElement("button");
      button.textContent = "Choose a TypeScript file…";
      button.onclick = () => void openSelection();
      content.append(button);
      return;
    }
    const items =
      tab === "recent"
        ? recent.map((path) => ({
            label: path.split(/[\\/]/).at(-1)!,
            detail: path,
            path,
          }))
        : [
            { label: "Kitchen cabinet", example: "cabinet" },
            { label: "Keyboard case", example: "keyboard" },
            { label: "Small apartment", example: "apartment" },
          ];
    if (!items.length)
      content.textContent =
        "No recent projects yet. Open an example or choose a file from disk.";
    for (const item of items) {
      const button = document.createElement("button");
      button.className = "picker-item";
      button.textContent = item.label;
      if ("detail" in item) {
        const detail = document.createElement("small");
        detail.textContent = item.detail!;
        button.append(detail);
      }
      button.onclick = () =>
        void openSelection(
          "example" in item ? item.example! : null,
          "path" in item ? item.path! : null,
        );
      content.append(button);
    }
  }
  recentTab.onclick = () => renderTab("recent");
  examplesTab.onclick = () => renderTab("examples");
  diskTab.onclick = () => renderTab("disk");
  picker.onclick = (event) => {
    if (event.target === picker) picker.close();
  };
  open.onclick = async () => {
    try {
      recent = await native.core.invoke<string[]>("recent_projects", {});
    } catch (e) {
      document.getElementById("source-status")!.textContent = String(e);
      return;
    }
    renderTab(recent.length ? "recent" : "examples");
    picker.showModal();
  };
  const controls = document.createElement("div");
  controls.className = "window-controls";
  for (const [action, label, icon] of [
    ["minimize", "Minimize", "−"],
    ["maximize", "Maximize or restore", "□"],
    ["close", "Close", "×"],
  ]) {
    const button = document.createElement("button");
    button.textContent = icon!;
    button.setAttribute("aria-label", label!);
    button.onclick = () => {
      if (action !== "close" || canLeave())
        void native.core.invoke("window_action", { action });
    };
    controls.append(button);
  }
  bar.append(controls);
  bar.onmousedown = (e) => {
    if (
      e.button === 0 &&
      !(e.target as HTMLElement).closest("button,input,select")
    )
      void native.core.invoke("window_action", {
        action: e.detail === 2 ? "maximize" : "drag",
      });
  };
  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "o") {
      e.preventDefault();
      open.click();
    }
  });
}
