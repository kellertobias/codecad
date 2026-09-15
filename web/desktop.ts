type Native = {
  core: {
    invoke<T>(command: string, args: Record<string, unknown>): Promise<T>;
  };
};
const native = (window as unknown as { __TAURI__?: Native }).__TAURI__;
export function setupDesktop(canLeave: () => boolean) {
  if (!native) return;
  document.body.classList.add("desktop");
  const bar = document.querySelector("header")!;
  const open = document.createElement("button");
  open.id = "open-project";
  open.textContent = "Open project…";
  bar.insertBefore(open, document.getElementById("rebuild"));
  open.onclick = async () => {
    if (!canLeave()) return;
    open.disabled = true;
    try {
      const url = await native.core.invoke<string | null>("open_project", {
        example: null,
      });
      if (url) location.replace(url);
    } catch (e) {
      const status = document.getElementById("source-status");
      if (status) status.textContent = `Could not open project: ${String(e)}`;
    } finally {
      open.disabled = false;
    }
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
