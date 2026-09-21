#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, WebviewWindow};

const RECENT_LIMIT: usize = 5;
// Every open project runs its own CAD runtime, so the tab strip stays bounded.
const MAX_SESSIONS: usize = 8;
const PREVIEW_LIMIT: usize = 400_000;

fn data_file(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(name))
}

fn recent_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    data_file(app, "recent-projects.json")
}

fn read_trusted_file(file: &Path) -> Result<Vec<PathBuf>, String> {
    match std::fs::read(file) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error.to_string()),
    }
}

fn remember_trusted_file(file: &Path, entry: &Path) -> Result<(), String> {
    let entry = entry.canonicalize().map_err(|e| e.to_string())?;
    let mut entries = read_trusted_file(file)?;
    if entries.contains(&entry) {
        return Ok(());
    }
    entries.push(entry);
    std::fs::create_dir_all(file.parent().unwrap()).map_err(|e| e.to_string())?;
    let temporary = file.with_extension("json.tmp");
    std::fs::write(
        &temporary,
        serde_json::to_vec(&entries).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(temporary, file).map_err(|e| e.to_string())
}

fn read_previews(file: &Path) -> Result<HashMap<String, String>, String> {
    match std::fs::read(file) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(HashMap::new()),
        Err(error) => Err(error.to_string()),
    }
}

fn write_previews(file: &Path, previews: &HashMap<String, String>) -> Result<(), String> {
    std::fs::create_dir_all(file.parent().unwrap()).map_err(|e| e.to_string())?;
    let temporary = file.with_extension("json.tmp");
    std::fs::write(
        &temporary,
        serde_json::to_vec(previews).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(temporary, file).map_err(|e| e.to_string())
}

fn valid_preview(image: &str) -> bool {
    let Some(encoded) = image.strip_prefix("data:image/png;base64,") else {
        return false;
    };
    image.len() <= PREVIEW_LIMIT
        && encoded.starts_with("iVBORw0KGgo")
        && encoded.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/' || byte == b'='
        })
}

fn examples_workspace(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("examples-workspace"))
}

fn read_recent(app: &tauri::AppHandle) -> Result<Vec<PathBuf>, String> {
    let file = recent_file(app)?;
    let workspace = examples_workspace(app)?;
    // Bundled examples live in the shared workspace and are listed separately,
    // so they never count as projects the user made.
    Ok(read_recent_file(&file)?
        .into_iter()
        .filter(|path| !path.starts_with(&workspace))
        .collect())
}

fn read_recent_file(file: &Path) -> Result<Vec<PathBuf>, String> {
    let entries: Vec<PathBuf> = match std::fs::read(file) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string())?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(error.to_string()),
    };
    Ok(entries
        .into_iter()
        .filter(|path| path.is_file())
        .take(RECENT_LIMIT)
        .collect())
}

fn remember_project(app: &tauri::AppHandle, entry: &Path) -> Result<(), String> {
    remember_project_file(&recent_file(app)?, entry)
}

fn remember_project_file(file: &Path, entry: &Path) -> Result<(), String> {
    let entry = entry.canonicalize().map_err(|e| e.to_string())?;
    let mut entries = read_recent_file(file)?;
    entries.retain(|path| path != &entry);
    entries.insert(0, entry);
    entries.truncate(RECENT_LIMIT);
    std::fs::create_dir_all(file.parent().unwrap()).map_err(|e| e.to_string())?;
    let temporary = file.with_extension("json.tmp");
    std::fs::write(
        &temporary,
        serde_json::to_vec(&entries).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(temporary, file).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recent_projects_are_deduplicated_ordered_and_pruned() {
        let root = std::env::temp_dir().join(format!(
            "codecad-recent-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let first = root.join("first.ts");
        let second = root.join("second.ts");
        let list = root.join("recent.json");
        std::fs::write(&first, "").unwrap();
        std::fs::write(&second, "").unwrap();
        remember_project_file(&list, &first).unwrap();
        remember_project_file(&list, &second).unwrap();
        remember_project_file(&list, &first).unwrap();
        assert_eq!(
            read_recent_file(&list).unwrap(),
            vec![
                first.canonicalize().unwrap(),
                second.canonicalize().unwrap()
            ]
        );
        std::fs::remove_file(first).unwrap();
        assert_eq!(
            read_recent_file(&list).unwrap(),
            vec![second.canonicalize().unwrap()]
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn trusted_projects_outlive_the_bounded_recent_list() {
        let root = std::env::temp_dir().join(format!(
            "codecad-trust-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let entry = root.join("project.ts");
        let trusted = root.join("trusted-projects.json");
        std::fs::write(&entry, "").unwrap();
        remember_trusted_file(&trusted, &entry).unwrap();
        remember_trusted_file(&trusted, &entry).unwrap();
        assert_eq!(
            read_trusted_file(&trusted).unwrap(),
            vec![entry.canonicalize().unwrap()]
        );
        std::fs::remove_file(&entry).unwrap();
        assert_eq!(read_trusted_file(&trusted).unwrap().len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_page_is_trusted_only_by_its_own_session_origin() {
        assert!(matches_session(
            "http://127.0.0.1:4317/drawings",
            "http://127.0.0.1:4317"
        ));
        assert!(!matches_session(
            "http://127.0.0.1:43170/",
            "http://127.0.0.1:4317"
        ));
        assert!(!matches_session(
            "http://evil.test/#http://127.0.0.1:4317/",
            "http://127.0.0.1:4317"
        ));
    }

    #[test]
    fn closing_a_tab_reveals_its_neighbour() {
        assert_eq!(tab_after_close(2, 0), Some(0));
        assert_eq!(tab_after_close(2, 2), Some(1));
        assert_eq!(tab_after_close(0, 0), None);
    }

    #[test]
    fn project_preview_cache_accepts_only_small_png_data_urls() {
        let png = "data:image/png;base64,iVBORw0KGgoAAA==";
        assert!(valid_preview(png));
        assert!(!valid_preview("data:text/html;base64,iVBORw0KGgoAAA=="));
        assert!(!valid_preview("data:image/png;base64,not-png"));
        assert!(!valid_preview(&format!(
            "data:image/png;base64,iVBORw0KGgo{}",
            "A".repeat(PREVIEW_LIMIT)
        )));
        let root = std::env::temp_dir().join(format!(
            "codecad-preview-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let file = root.join("previews.json");
        let map = HashMap::from([("/project.ts".to_owned(), png.to_owned())]);
        write_previews(&file, &map).unwrap();
        assert_eq!(read_previews(&file).unwrap(), map);
        std::fs::remove_dir_all(root).unwrap();
    }
}

fn editor_app(id: &str) -> Option<PathBuf> {
    let bundle = match id {
        "vscode" => "Visual Studio Code.app",
        "cursor" => "Cursor.app",
        "codex" => "Codex.app",
        _ => return None,
    };
    let mut roots = vec![PathBuf::from("/Applications")];
    if let Some(home) = std::env::var_os("HOME") {
        roots.push(PathBuf::from(home).join("Applications"));
    }
    roots
        .into_iter()
        .map(|root| root.join(bundle))
        .find(|path| path.is_dir())
}

#[tauri::command]
fn available_editors(
    window: WebviewWindow,
    state: tauri::State<Desktop>,
) -> Result<Vec<String>, String> {
    trusted(&window, &state)?;
    if calling_entry(&window, &state).is_err() {
        return Ok(Vec::new());
    }
    Ok(["vscode", "cursor", "codex"]
        .into_iter()
        .filter(|id| editor_app(id).is_some())
        .map(str::to_owned)
        .collect())
}

#[tauri::command]
fn open_in_editor(
    window: WebviewWindow,
    state: tauri::State<Desktop>,
    editor: String,
) -> Result<(), String> {
    trusted(&window, &state)?;
    let app = editor_app(&editor).ok_or("Editor is not installed")?;
    let entry = calling_entry(&window, &state)?;
    let status = Command::new("open")
        .arg("-a")
        .arg(app)
        .arg(entry)
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("Could not open the project in the selected editor".into());
    }
    Ok(())
}

#[tauri::command]
fn recent_projects(
    window: WebviewWindow,
    state: tauri::State<Desktop>,
    app: tauri::AppHandle,
) -> Result<Vec<String>, String> {
    trusted(&window, &state)?;
    Ok(read_recent(&app)?
        .into_iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect())
}

#[derive(Serialize)]
struct ProjectCard {
    id: Option<String>,
    path: Option<String>,
    title: String,
    preview: Option<String>,
}

#[derive(Serialize)]
struct ProjectCatalog {
    recent: Vec<ProjectCard>,
    examples: Vec<ProjectCard>,
}

#[tauri::command]
fn project_catalog(
    window: WebviewWindow,
    state: tauri::State<Desktop>,
    app: tauri::AppHandle,
) -> Result<ProjectCatalog, String> {
    trusted(&window, &state)?;
    let previews = read_previews(&data_file(&app, "project-previews.json")?)?;
    let recent = read_recent(&app)?
        .into_iter()
        .map(|path| {
            let key = path.to_string_lossy().into_owned();
            ProjectCard {
                id: None,
                title: path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("Project")
                    .to_owned(),
                path: Some(key.clone()),
                preview: previews.get(&key).cloned(),
            }
        })
        .collect();
    let example_root = examples_workspace(&app)?.join("examples");
    let examples = [
        ("cabinet", "Kitchen cabinet", "kitchen-cabinet/index.ts"),
        ("keyboard", "Keyboard case", "keyboard-case/index.ts"),
        ("apartment", "Small apartment", "small-apartment/index.ts"),
        ("drawing", "Infinite drawing", "infinite-drawing/index.ts"),
        ("table-base", "Welded table base", "welded-table-base/index.ts"),
    ]
    .into_iter()
    .map(|(id, title, file)| {
        let key = example_root.join(file).to_string_lossy().into_owned();
        ProjectCard {
            id: Some(id.into()),
            title: title.into(),
            path: None,
            preview: previews
                .get(&key)
                .cloned()
                .or_else(|| (id != "drawing").then(|| format!("/previews/{id}.png"))),
        }
    })
    .collect();
    Ok(ProjectCatalog { recent, examples })
}

#[tauri::command]
fn save_project_preview(
    window: WebviewWindow,
    state: tauri::State<Desktop>,
    app: tauri::AppHandle,
    image: String,
) -> Result<(), String> {
    trusted(&window, &state)?;
    if !valid_preview(&image) {
        return Err("Invalid or oversized project preview".into());
    }
    let entry = calling_entry(&window, &state)?
        .to_string_lossy()
        .into_owned();
    let file = data_file(&app, "project-previews.json")?;
    let mut previews = read_previews(&file)?;
    previews.insert(entry, image);
    write_previews(&file, &previews)
}

#[cfg(unix)]
static TERMINATE: AtomicBool = AtomicBool::new(false);
#[cfg(unix)]
extern "C" fn request_termination(_: libc::c_int) {
    TERMINATE.store(true, Ordering::SeqCst);
}

struct Session {
    id: u64,
    child: Child,
    url: String,
    entry: PathBuf,
}
impl Drop for Session {
    fn drop(&mut self) {
        // Stop the entire process group, including an in-flight CAD worker.
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.child.id() as i32), libc::SIGTERM);
        }
        #[cfg(windows)]
        {
            let _ = Command::new("taskkill")
                .args(["/PID", &self.child.id().to_string(), "/T", "/F"])
                .output();
        }
        for _ in 0..30 {
            if self.child.try_wait().ok().flatten().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
#[derive(Default)]
struct Desktop {
    sessions: Arc<Mutex<Vec<Session>>>,
    opening: AtomicBool,
    last_id: AtomicU64,
}
// A page belongs to a session only when the session origin is followed by a
// path separator, so a longer port number can never borrow its trust.
fn matches_session(page: &str, session: &str) -> bool {
    page.starts_with(&format!("{session}/"))
}
fn session_index(page: &str, sessions: &[Session]) -> Option<usize> {
    sessions
        .iter()
        .position(|session| matches_session(page, &session.url))
}
// Closing a tab reveals its right-hand neighbour, or the new last tab.
fn tab_after_close(remaining: usize, closed: usize) -> Option<usize> {
    (remaining > 0).then(|| closed.min(remaining - 1))
}
fn trusted(window: &WebviewWindow, state: &Desktop) -> Result<(), String> {
    let url = window.url().map_err(|e| e.to_string())?;
    if url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost") {
        return Ok(());
    }
    if session_index(url.as_str(), &state.sessions.lock().unwrap()).is_some() {
        return Ok(());
    }
    Err("This page is not an open CodeCAD session".into())
}
fn navigate_home(window: &WebviewWindow) -> Result<(), String> {
    let home = if cfg!(target_os = "macos") {
        "tauri://localhost/"
    } else {
        "http://tauri.localhost/"
    };
    window
        .navigate(tauri::Url::parse(home).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}
// Commands act on the project whose page is calling them, not on a global
// "current" project, so a background tab can never act for the visible one.
fn calling_entry(window: &WebviewWindow, state: &Desktop) -> Result<PathBuf, String> {
    let url = window.url().map_err(|e| e.to_string())?;
    let sessions = state.sessions.lock().unwrap();
    session_index(url.as_str(), &sessions)
        .map(|index| sessions[index].entry.clone())
        .ok_or_else(|| "No active project".into())
}
#[tauri::command]
fn window_action(
    window: WebviewWindow,
    state: tauri::State<Desktop>,
    action: String,
) -> Result<(), String> {
    trusted(&window, &state)?;
    let result = match action.as_str() {
        "minimize" => window.minimize(),
        "maximize" => {
            if window.is_maximized().map_err(|e| e.to_string())? {
                window.unmaximize()
            } else {
                window.maximize()
            }
        }
        "drag" => window.start_dragging(),
        "close" => window.close(),
        _ => return Err("Unknown window action".into()),
    };
    result.map_err(|e| e.to_string())
}
#[derive(Serialize)]
struct SessionTab {
    id: u64,
    title: String,
    path: String,
    url: String,
    active: bool,
}

#[tauri::command]
fn session_tabs(
    window: WebviewWindow,
    state: tauri::State<Desktop>,
) -> Result<Vec<SessionTab>, String> {
    trusted(&window, &state)?;
    let page = window.url().map_err(|e| e.to_string())?;
    let sessions = state.sessions.lock().unwrap();
    let active = session_index(page.as_str(), &sessions);
    Ok(sessions
        .iter()
        .enumerate()
        .map(|(index, session)| SessionTab {
            id: session.id,
            title: session
                .entry
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("Project")
                .to_owned(),
            path: session.entry.to_string_lossy().into_owned(),
            url: format!("{}/", session.url),
            active: active == Some(index),
        })
        .collect())
}

#[tauri::command]
fn activate_session(
    window: WebviewWindow,
    state: tauri::State<Desktop>,
    id: u64,
) -> Result<String, String> {
    trusted(&window, &state)?;
    state
        .sessions
        .lock()
        .unwrap()
        .iter()
        .find(|session| session.id == id)
        .map(|session| format!("{}/", session.url))
        .ok_or_else(|| "That project is no longer open".into())
}

/// Closes one project and reports the tab to show in its place, or `None` when
/// the last project closed. Callers showing another project ignore the result.
#[tauri::command]
fn close_session(
    window: WebviewWindow,
    state: tauri::State<Desktop>,
    id: u64,
) -> Result<Option<String>, String> {
    trusted(&window, &state)?;
    if state.opening.load(Ordering::SeqCst) {
        return Err("A project is still opening".into());
    }
    let page = window.url().map_err(|e| e.to_string())?;
    let mut sessions = state.sessions.lock().unwrap();
    let Some(index) = sessions.iter().position(|session| session.id == id) else {
        return Err("That project is no longer open".into());
    };
    let showing_it = session_index(page.as_str(), &sessions) == Some(index);
    let closed = sessions.remove(index);
    let next = tab_after_close(sessions.len(), index)
        .map(|index| format!("{}/", sessions[index].url));
    drop(sessions);
    // Stopping the runtime waits on the child process; keep the window responsive.
    std::thread::spawn(move || drop(closed));
    // A page whose own project just closed cannot ask for the home screen any
    // more, so take it there before its session stops being trusted.
    if showing_it && next.is_none() {
        navigate_home(&window)?;
    }
    Ok(next)
}

#[tauri::command]
fn show_home(window: WebviewWindow, state: tauri::State<Desktop>) -> Result<(), String> {
    trusted(&window, &state)?;
    if state.opening.load(Ordering::SeqCst) {
        return Err("A project is still opening".into());
    }
    navigate_home(&window)
}
fn runtime(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        return Ok(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.codecad/desktop-runtime"));
    }
    Ok(app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("runtime"))
}
fn launch(app: &tauri::AppHandle, entry: PathBuf, id: u64) -> Result<Session, String> {
    let root = runtime(app)?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join(format!("session-{stamp}"));
    std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    let log_path = cache.join("engine.log");
    let log = std::fs::File::create(&log_path).map_err(|e| e.to_string())?;
    let mut stdout_log = log.try_clone().map_err(|e| e.to_string())?;
    let mut command = Command::new(root.join(if cfg!(windows) { "node.exe" } else { "node" }));
    command
        .args(["--import", "tsx"])
        .arg(root.join("src/server.ts"))
        .arg(&entry)
        .current_dir(&root)
        .env("PORT", "0")
        .env("CODECAD_STORAGE", &cache)
        .env("CODECAD_DESKTOP", "1")
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(log));
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let child = command
        .spawn()
        .map_err(|e| format!("Cannot start bundled CAD runtime: {e}"))?;
    let mut candidate = Session {
        id,
        child,
        url: String::new(),
        entry,
    };
    let stdout = candidate.child.stdout.take().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = writeln!(stdout_log, "{line}");
            if let Some(port) = line
                .strip_prefix("CODECAD_READY:")
                .and_then(|s| s.parse::<u16>().ok())
            {
                let _ = tx.send(port);
            }
        }
    });
    let port = rx
        .recv_timeout(Duration::from_secs(60))
        .map_err(|_| format!("The CAD runtime did not start. See {}", log_path.display()))?;
    candidate.url = format!("http://127.0.0.1:{port}");
    Ok(candidate)
}

#[tauri::command]
async fn open_project(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, Desktop>,
    example: Option<String>,
    path: Option<String>,
) -> Result<Option<String>, String> {
    trusted(&window, &state)?;
    if state.opening.swap(true, Ordering::SeqCst) {
        return Err("A project is already opening".into());
    }
    let result = async {
        let entry = if let Some(example) = example {
            if path.is_some() { return Err("Choose either an example or a recent project".into()); }
            let file = match example.as_str() {
                "cabinet" => "kitchen-cabinet/index.ts",
                "keyboard" => "keyboard-case/index.ts",
                "apartment" => "small-apartment/index.ts",
                "drawing" => "infinite-drawing/index.ts",
                "table-base" => "welded-table-base/index.ts",
                _ => return Err("Unknown example".into()),
            };
            // Copy the entire example workspace once so relative imports stay valid
            // and editing examples never changes signed application resources.
            let workspace = app.path().app_data_dir().map_err(|e|e.to_string())?.join("examples-workspace");
            let root = runtime(&app)?;
            for dir in ["src", "examples", "node_modules"] {
                if !workspace.join(dir).exists() { copy_tree(&root.join(dir), &workspace.join(dir))?; }
            }
            for file in ["package.json", "tsconfig.json"] {
                if !workspace.join(file).exists() { std::fs::copy(root.join(file), workspace.join(file)).map_err(|e|e.to_string())?; }
            }
            let project = Path::new(file).parent().ok_or("Malformed example path")?;
            if !workspace.join("examples").join(project).exists() {
                copy_tree(&root.join("examples").join(project), &workspace.join("examples").join(project))?;
            }
            workspace.join("examples").join(file)
        } else {
            let entry = if let Some(path) = path {
                let path = PathBuf::from(path).canonicalize().map_err(|e| e.to_string())?;
                if !read_recent(&app)?.contains(&path) { return Err("Project is not in Recent".into()); }
                path
            } else {
                let picked = rfd::AsyncFileDialog::new().set_parent(&window).set_title("Open CodeCAD project entry file").add_filter("TypeScript project", &["ts", "mts"]).pick_file().await;
                let Some(picked) = picked else { return Ok(None); };
                picked.path().canonicalize().map_err(|e| e.to_string())?
            };
            let trusted_entries = read_trusted_file(&data_file(&app, "trusted-projects.json")?)?;
            if !trusted_entries.contains(&entry) && !read_recent(&app)?.contains(&entry) {
                let accepted = rfd::AsyncMessageDialog::new().set_parent(&window).set_title("Trust this project?")
                    .set_description("CodeCAD executes TypeScript with your account's file and network access. Only open projects you trust.")
                    .set_buttons(rfd::MessageButtons::OkCancel).show().await;
                if accepted != rfd::MessageDialogResult::Ok { return Ok(None); }
            }
            entry
        };
        if !entry.is_file() { return Err("Project entry file does not exist".into()); }
        if !matches!(entry.extension().and_then(|ext| ext.to_str()), Some("ts" | "mts")) { return Err("Choose a TypeScript project entry".into()); }
        // Opening a project twice would run two runtimes over one source tree,
        // so an already-open project just raises its tab.
        {
            let sessions = state.sessions.lock().unwrap();
            if let Some(open) = sessions.iter().find(|session| session.entry == entry) {
                return Ok(Some(format!("{}/", open.url)));
            }
            if sessions.len() >= MAX_SESSIONS {
                return Err("Too many projects are open. Close a tab first.".into());
            }
        }
        let recent_entry = entry.clone();
        let handle = app.clone();
        let id = state.last_id.fetch_add(1, Ordering::SeqCst) + 1;
        let next = tauri::async_runtime::spawn_blocking(move || launch(&handle, entry, id)).await.map_err(|e|e.to_string())??;
        if !recent_entry.starts_with(examples_workspace(&app)?) {
            remember_project(&app, &recent_entry)?;
        }
        remember_trusted_file(&data_file(&app, "trusted-projects.json")?, &recent_entry)?;
        let url = format!("{}/", next.url);
        state.sessions.lock().unwrap().push(next);
        Ok(Some(url))
    }.await;
    state.opening.store(false, Ordering::SeqCst);
    result
}
fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(from).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let destination = to.join(entry.file_name());
        if path.is_dir() {
            copy_tree(&path, &destination)?;
        } else {
            std::fs::copy(path, destination).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
fn main() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(unix)]
            {
                unsafe {
                    libc::signal(
                        libc::SIGTERM,
                        request_termination as *const () as libc::sighandler_t,
                    );
                }
                let handle = app.handle().clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(Duration::from_millis(100));
                    if TERMINATE.load(Ordering::SeqCst) {
                        handle.exit(0);
                        break;
                    }
                });
            }
            Ok(())
        })
        .manage(Desktop::default())
        .invoke_handler(tauri::generate_handler![
            open_project,
            show_home,
            session_tabs,
            activate_session,
            close_session,
            recent_projects,
            project_catalog,
            save_project_preview,
            available_editors,
            open_in_editor,
            window_action
        ])
        .build(tauri::generate_context!())
        .expect("Cannot create CodeCAD window")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<Desktop>().sessions.lock().unwrap().clear();
            }
        });
}
