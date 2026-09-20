import { mountProjectTabs } from "./project-tabs.js";
const invoke = window.__TAURI__.core.invoke;
const message = (text) => {
  document.getElementById("message").textContent = text;
};
const bar = document.getElementById("titlebar");
if (navigator.platform.includes("Mac")) {
  document.body.classList.add("platform-macos");
  const controls = bar.querySelector(".controls");
  controls.prepend(controls.querySelector('[data-window="close"]'));
  bar.prepend(controls);
}
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
// Projects opened earlier keep running; their tabs lead back to them.
const projectTabs = mountProjectTabs({
  invoke,
  container: document.getElementById("project-tabs"),
  onError: message,
});
let catalog = { recent: [], examples: [] };
const exampleDetails = {
  cabinet: "Joinery · hardware · motion",
  keyboard: "Sheet metal · MDF interfaces",
  apartment: "Rooms · windows · floor plans",
  "table-base": "Steel tube · welded frame",
};
function projectButton(item) {
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
    preview.textContent = "Preview after opening";
    preview.classList.add("preview-pending");
  }
  const text = document.createElement("span");
  text.className = "project-card-text";
  const title = document.createElement("strong");
  title.textContent = item.title;
  text.append(title);
  const detail = document.createElement("small");
  detail.textContent = item.path ?? exampleDetails[item.id] ?? "";
  text.append(detail);
  button.append(preview, text);
  button.title = item.path ?? item.title;
  button.onclick = () => openProject(item.id ?? null, item.path ?? null);
  return button;
}
function renderHome() {
  document
    .getElementById("recent-list")
    .replaceChildren(...catalog.recent.map(projectButton));
  document.getElementById("recent-projects").hidden = !catalog.recent.length;
  document
    .getElementById("example-list")
    .replaceChildren(...catalog.examples.map(projectButton));
}
async function refreshCatalog() {
  catalog = await invoke("project_catalog", {});
  renderHome();
}
async function openProject(example = null, path = null) {
  const buttons = document.querySelectorAll("main button");
  buttons.forEach((b) => (b.disabled = true));
  message("Opening project…");
  try {
    const url = await invoke("open_project", { example, path });
    if (url) location.replace(url);
    else message("");
  } catch (e) {
    message(String(e));
    void projectTabs.refresh();
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}
document.getElementById("open-disk").onclick = () => openProject();
window.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "o") {
    event.preventDefault();
    void openProject();
  }
});
void refreshCatalog().catch((e) => message(String(e)));
