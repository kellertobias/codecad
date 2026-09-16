fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "open_project",
            "recent_projects",
            "available_editors",
            "open_in_editor",
            "window_action",
        ]),
    ))
    .expect("Cannot build CodeCAD permissions");
}
