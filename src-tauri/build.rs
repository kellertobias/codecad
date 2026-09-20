fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "open_project",
            "show_home",
            "session_tabs",
            "activate_session",
            "close_session",
            "recent_projects",
            "project_catalog",
            "save_project_preview",
            "available_editors",
            "open_in_editor",
            "window_action",
        ]),
    ))
    .expect("Cannot build CodeCAD permissions");
}
