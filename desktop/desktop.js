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
const picker = document.getElementById("project-picker");
const pickerContent = document.getElementById("picker-content");
let catalog = { recent: [], examples: [] };
let activeTab = "recent";
const exampleDetails = {
  cabinet: "Joinery · hardware · motion",
  keyboard: "Sheet metal · MDF interfaces",
  apartment: "Rooms · windows · floor plans",
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
  document.getElementById("message").textContent = "Opening project…";
  try {
    const url = await invoke("open_project", { example, path });
    if (url) location.replace(url);
    else document.getElementById("message").textContent = "";
  } catch (e) {
    document.getElementById("message").textContent = String(e);
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}
function renderPicker(tab) {
  activeTab = tab;
  document.querySelectorAll("[data-picker-tab]").forEach((button) => {
    button.setAttribute(
      "aria-selected",
      String(button.dataset.pickerTab === tab),
    );
  });
  pickerContent.replaceChildren();
  const items = tab === "recent" ? catalog.recent : catalog.examples;
  if (!items.length)
    pickerContent.textContent =
      "No recent projects yet. Open an example or choose a file from disk.";
  for (const item of items) pickerContent.append(projectButton(item));
}
async function showPicker() {
  try {
    await refreshCatalog();
  } catch (e) {
    document.getElementById("message").textContent = String(e);
    return;
  }
  renderPicker(catalog.recent.length ? "recent" : "examples");
  picker.showModal();
}
document.getElementById("open-disk").onclick = () => openProject();
document.getElementById("browse-projects").onclick = showPicker;
document.getElementById("close-picker").onclick = () => picker.close();
picker.onclick = (event) => {
  if (event.target === picker) picker.close();
};
document
  .querySelectorAll("[data-picker-tab]")
  .forEach(
    (button) =>
      (button.onclick = () =>
        button.dataset.pickerTab === "disk"
          ? openProject()
          : renderPicker(button.dataset.pickerTab)),
  );
void refreshCatalog().catch((e) => {
  document.getElementById("message").textContent = String(e);
});
