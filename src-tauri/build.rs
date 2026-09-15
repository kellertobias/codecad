fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["open_project", "window_action"]),
    ))
    .expect("Cannot build CodeCAD permissions");
}
