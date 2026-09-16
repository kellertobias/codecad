type Native = {
  core: {
    invoke<T>(command: string, args: Record<string, unknown>): Promise<T>;
  };
};
type ProjectCard = {
  id: string | null;
  path: string | null;
  title: string;
  preview: string | null;
};
type ProjectCatalog = { recent: ProjectCard[]; examples: ProjectCard[] };
const native = (window as unknown as { __TAURI__?: Native }).__TAURI__;
export async function saveDesktopPreview(source: HTMLCanvasElement) {
  if (!native || !source.width || !source.height) return;
  const canvas = document.createElement("canvas");
  canvas.width = 240;
  canvas.height = 150;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.fillStyle = "#14242b";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  await native.core.invoke("save_project_preview", {
    image: canvas.toDataURL("image/png"),
  });
}
export function setupDesktop(canLeave: () => boolean) {
  if (!native) return;
  const bridge = native;
  document.body.classList.add("desktop");
  const bar = document.querySelector<HTMLElement>("#tabs")!;
  document.body.classList.add(
    navigator.platform.includes("Mac") ? "platform-macos" : "platform-windows",
  );
  const home = document.createElement("button");
  home.id = "desktop-home";
  home.setAttribute("aria-label", "Close project and return home");
  home.title = "Close project and return home";
  home.innerHTML =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="m3 11 9-8 9 8M5 10v11h14V10M9 21v-7h6v7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const toolbarStart = bar.querySelector<HTMLElement>(".toolbar-start")!;
  const sourceHeader = document.querySelector<HTMLElement>(".source-identity")!;
  const brand = sourceHeader.querySelector<HTMLElement>(".source-brand")!;
  const workspace = document.querySelector<HTMLElement>(".workspace")!;
  toolbarStart.append(home);
  home.onclick = async () => {
    if (!canLeave()) return;
    home.disabled = true;
    try {
      await bridge.core.invoke("close_project", {});
    } catch (e) {
      document.getElementById("source-status")!.textContent =
        `Could not return home: ${String(e)}`;
      home.disabled = false;
    }
  };
  const source = document.getElementById("toggle-source")!;
  sourceHeader.append(source, home);
  source.setAttribute("aria-label", "Hide code");
  source.title = "Hide code";
  source.onclick = () => {
    const hidden = document.body.classList.toggle("source-hidden");
    document.getElementById("rebuild")!.hidden = !hidden;
    source.textContent = hidden ? "◨" : "◧";
    source.setAttribute("aria-label", hidden ? "Show code" : "Hide code");
    source.title = hidden ? "Show code" : "Hide code";
    source.setAttribute("aria-pressed", String(hidden));
    if (hidden) {
      toolbarStart.prepend(brand, home);
      workspace.append(source);
    } else {
      sourceHeader.append(brand, source, home);
    }
  };
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
  let catalog: ProjectCatalog = { recent: [], examples: [] };
  async function openSelection(
    example: string | null = null,
    path: string | null = null,
  ) {
    if (!canLeave()) return;
    home.disabled = true;
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
      home.disabled = false;
    }
  }
  function renderTab(tab: "recent" | "examples") {
    content.replaceChildren();
    for (const [button, name] of [
      [recentTab, "recent"],
      [examplesTab, "examples"],
      [diskTab, "disk"],
    ] as const)
      button.setAttribute("aria-selected", String(tab === name));
    const items = tab === "recent" ? catalog.recent : catalog.examples;
    if (!items.length)
      content.textContent =
        "No recent projects yet. Open an example or choose a file from disk.";
    for (const item of items) {
      const button = document.createElement("button");
      button.className = "picker-item";
      const preview = document.createElement("span");
      preview.className = "project-preview";
      if (item.preview) {
        const image = document.createElement("img");
        image.src = item.preview;
        image.alt = "";
        preview.append(image);
      } else {
        preview.classList.add("preview-pending");
        preview.textContent = "Preview after opening";
      }
      const label = document.createElement("span");
      label.className = "project-card-text";
      const name = document.createElement("strong");
      name.textContent = item.title;
      label.append(name);
      if (item.path) {
        const detail = document.createElement("small");
        detail.textContent = item.path;
        label.append(detail);
      }
      button.append(preview, label);
      button.onclick = () => void openSelection(item.id, item.path);
      content.append(button);
    }
  }
  recentTab.onclick = () => renderTab("recent");
  examplesTab.onclick = () => renderTab("examples");
  diskTab.onclick = () => void openSelection();
  picker.onclick = (event) => {
    if (event.target === picker) picker.close();
  };
  async function showPicker() {
    try {
      catalog = await bridge.core.invoke<ProjectCatalog>("project_catalog", {});
    } catch (e) {
      document.getElementById("source-status")!.textContent = String(e);
      return;
    }
    renderTab(catalog.recent.length ? "recent" : "examples");
    picker.showModal();
  }
  const controls = document.createElement("div");
  controls.className = "window-controls";
  const actions = document.body.classList.contains("platform-macos")
    ? [
        ["close", "Close", "×"],
        ["minimize", "Minimize", "−"],
        ["maximize", "Maximize or restore", "□"],
      ]
    : [
        ["minimize", "Minimize", "−"],
        ["maximize", "Maximize or restore", "□"],
        ["close", "Close", "×"],
      ];
  for (const [action, label, icon] of actions) {
    const button = document.createElement("button");
    button.dataset.action = action!;
    button.textContent = icon!;
    button.setAttribute("aria-label", label!);
    button.onclick = () => {
      if (action !== "close" || canLeave())
        void native.core.invoke("window_action", { action });
    };
    controls.append(button);
  }
  if (document.body.classList.contains("platform-macos")) bar.prepend(controls);
  else bar.append(controls);
  const dragWindow = (e: MouseEvent) => {
    if (
      e.button === 0 &&
      !(e.target as HTMLElement).closest(
        "button,input,select,summary,details,label",
      )
    )
      void native.core.invoke("window_action", {
        action: e.detail === 2 ? "maximize" : "drag",
      });
  };
  bar.onmousedown = dragWindow;
  sourceHeader.onmousedown = dragWindow;
  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "o") {
      e.preventDefault();
      void showPicker();
    }
  });
}
