#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::{
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, WebviewWindow};

#[cfg(unix)]
static TERMINATE: AtomicBool = AtomicBool::new(false);
#[cfg(unix)]
extern "C" fn request_termination(_: libc::c_int) {
    TERMINATE.store(true, Ordering::SeqCst);
}

struct Session {
    child: Child,
    url: String,
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
    session: Arc<Mutex<Option<Session>>>,
    opening: AtomicBool,
}
fn trusted(window: &WebviewWindow, state: &Desktop) -> Result<(), String> {
    let url = window.url().map_err(|e| e.to_string())?;
    if url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost") {
        return Ok(());
    }
    if let Some(s) = state.session.lock().unwrap().as_ref() {
        if url.as_str().starts_with(&format!("{}/", s.url)) {
            return Ok(());
        }
    }
    Err("This page is not the active CodeCAD session".into())
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
fn launch(app: &tauri::AppHandle, entry: PathBuf) -> Result<Session, String> {
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
        .arg(entry)
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
        child,
        url: String::new(),
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
) -> Result<Option<String>, String> {
    trusted(&window, &state)?;
    if state.opening.swap(true, Ordering::SeqCst) {
        return Err("A project is already opening".into());
    }
    let result = async {
        let entry = if let Some(example) = example {
            let file = match example.as_str() { "cabinet" => "kitchen-cabinet.ts", "keyboard" => "keyboard-case.ts", "apartment" => "small-apartment.ts", _ => return Err("Unknown example".into()) };
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
            workspace.join("examples").join(file)
        } else {
            let picked = rfd::AsyncFileDialog::new().set_parent(&window).set_title("Open CodeCAD project entry file").add_filter("TypeScript project", &["ts", "mts"]).pick_file().await;
            let Some(picked) = picked else { return Ok(None); };
            let accepted = rfd::AsyncMessageDialog::new().set_parent(&window).set_title("Trust this project?")
                .set_description("CodeCAD executes TypeScript with your account's file and network access. Only open projects you trust.")
                .set_buttons(rfd::MessageButtons::OkCancel).show().await;
            if accepted != rfd::MessageDialogResult::Ok { return Ok(None); }
            picked.path().to_path_buf()
        };
        if !entry.is_file() { return Err("Project entry file does not exist".into()); }
        let handle = app.clone();
        let next = tauri::async_runtime::spawn_blocking(move || launch(&handle, entry)).await.map_err(|e|e.to_string())??;
        let url = format!("{}/", next.url);
        *state.session.lock().unwrap() = Some(next);
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
                unsafe { libc::signal(libc::SIGTERM, request_termination as *const () as libc::sighandler_t); }
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
        .invoke_handler(tauri::generate_handler![open_project, window_action])
        .build(tauri::generate_context!())
        .expect("Cannot create CodeCAD window")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<Desktop>().session.lock().unwrap().take();
            }
        });
}
