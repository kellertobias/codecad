const invoke = window.__TAURI__.core.invoke;
const bar = document.getElementById("titlebar");
bar.onmousedown = (e) => {
  if (e.button === 0 && !e.target.closest("button"))
    void invoke("window_action", {
      action: e.detail === 2 ? "maximize" : "drag",
    });
};
document
  .querySelectorAll("[data-window]")
  .forEach(
    (button) =>
      (button.onclick = () =>
        invoke("window_action", { action: button.dataset.window })),
  );
async function openProject(example = null) {
  const buttons = document.querySelectorAll("main button");
  buttons.forEach((b) => (b.disabled = true));
  document.getElementById("message").textContent = "Opening project…";
  try {
    const url = await invoke("open_project", { example });
    if (url) location.replace(url);
    else document.getElementById("message").textContent = "";
  } catch (e) {
    document.getElementById("message").textContent = String(e);
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}
document.getElementById("open-project").onclick = () => openProject();
document
  .querySelectorAll("[data-example]")
  .forEach((b) => (b.onclick = () => openProject(b.dataset.example)));
