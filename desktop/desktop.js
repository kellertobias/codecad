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
let recent = [];
let activeTab = "recent";
const examples = [
  ["cabinet", "Kitchen cabinet"],
  ["keyboard", "Keyboard case"],
  ["apartment", "Small apartment"],
];
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
  if (tab === "disk") {
    const button = document.createElement("button");
    button.textContent = "Choose a TypeScript file…";
    button.onclick = () => openProject();
    pickerContent.append(button);
    return;
  }
  const items =
    tab === "recent"
      ? recent.map((path) => [path, path.split(/[\\/]/).pop(), path])
      : examples.map(([id, title]) => [id, title, null]);
  if (!items.length)
    pickerContent.textContent =
      "No recent projects yet. Open an example or choose a file from disk.";
  for (const [id, title, path] of items) {
    const button = document.createElement("button");
    button.className = "picker-item";
    button.textContent = title;
    if (path) {
      const detail = document.createElement("small");
      detail.textContent = path;
      button.append(detail);
    }
    button.onclick = () => openProject(path ? null : id, path);
    pickerContent.append(button);
  }
}
async function showPicker() {
  try {
    recent = await invoke("recent_projects", {});
  } catch (e) {
    document.getElementById("message").textContent = String(e);
    return;
  }
  renderPicker(recent.length ? "recent" : "examples");
  picker.showModal();
}
document.getElementById("open-project").onclick = showPicker;
document.getElementById("close-picker").onclick = () => picker.close();
picker.onclick = (event) => {
  if (event.target === picker) picker.close();
};
document
  .querySelectorAll("[data-picker-tab]")
  .forEach(
    (button) => (button.onclick = () => renderPicker(button.dataset.pickerTab)),
  );
document
  .querySelectorAll("[data-example]")
  .forEach((b) => (b.onclick = () => openProject(b.dataset.example)));
void invoke("recent_projects", {})
  .then((entries) => {
    recent = entries;
    const list = document.getElementById("recent-list");
    for (const path of recent) {
      const button = document.createElement("button");
      button.textContent = path.split(/[\\/]/).pop();
      button.title = path;
      button.onclick = () => openProject(null, path);
      list.append(button);
    }
    document.getElementById("recent-projects").hidden = !recent.length;
  })
  .catch((e) => {
    document.getElementById("message").textContent = String(e);
  });
