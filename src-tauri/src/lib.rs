//! The desktop shell.
//!
//! Batch 0 opened one window on the interface that already existed. Batch 2
//! adds the project store: the window is now built after the store has been
//! read, and the project and settings the interface expects in `localStorage`
//! are handed to it in an initialisation script, so the first paint is already
//! the saved project.
//!
//! The commands here are the file half of the backend. The nine endpoints that
//! replace `serve.py` arrive in batches 3 and 4 and are listed in
//! `src/native.js`.

mod store;

use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use store::{Entry, Store};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// Where the window keeps the project it is editing. `None` means the project
/// has never been written, so the first save chooses its own name.
struct Open {
    path: Option<PathBuf>,
}

struct Files {
    store: Store,
    open: Mutex<Open>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Opened {
    path: String,
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    entry: Entry,
}

fn app_data(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("the app data folder is unavailable: {error}"))
}

/// The document the interface starts with: the settings file, the project it
/// last had open, and the recent list for the chooser.
fn boot_payload(store: &Store) -> Value {
    let settings = store.settings();
    let last = settings
        .get("lastProject")
        .and_then(Value::as_str)
        .map(str::to_string);
    let (project, path) = last
        .as_deref()
        .map(|id| store.read(id))
        .and_then(|read| read.ok())
        .map(|(path, text)| {
            let document = store::parse_document(&text).unwrap_or_else(|_| json!({}));
            (document, path.display().to_string())
        })
        .unwrap_or((Value::Null, String::new()));
    json!({
        "projects": store.list(),
        "settings": settings,
        "project": project,
        "projectPath": path,
        "dataFolder": store.root().display().to_string(),
    })
}

fn emit_open(window: &tauri::WebviewWindow, path: &Path) {
    let _ = window.emit("northstar://open-path", path.display().to_string());
}

#[tauri::command]
fn project_list(app: tauri::State<Files>) -> Vec<Entry> {
    app.store.list()
}

#[tauri::command]
fn project_open(app: tauri::State<Files>, id: String) -> Result<Opened, String> {
    let (path, text) = app.store.read(&id).map_err(|error| error.to_string())?;
    *app.open.lock().unwrap() = Open {
        path: Some(path.clone()),
    };
    Ok(Opened {
        path: path.display().to_string(),
        text,
    })
}

#[tauri::command]
fn project_open_path(app: tauri::State<Files>, path: String) -> Result<Opened, String> {
    let path = PathBuf::from(path);
    let text = app
        .store
        .read_any(&path)
        .map_err(|error| format!("{}: {error}", path.display()))?;
    *app.open.lock().unwrap() = Open {
        path: Some(path.clone()),
    };
    Ok(Opened {
        path: path.display().to_string(),
        text,
    })
}

#[tauri::command]
fn project_pick(app: tauri::State<Files>, handle: tauri::AppHandle) -> Result<Option<Opened>, String> {
    use tauri_plugin_dialog::DialogExt;

    let picked = handle
        .dialog()
        .file()
        .add_filter("Northstar project", &["json"])
        .set_title("Open a Northstar project")
        .blocking_pick_file();
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|error| format!("that file cannot be read: {error}"))?;
    project_open_path(app, path.display().to_string()).map(Some)
}

#[tauri::command]
fn project_save(app: tauri::State<Files>, document: Value) -> Result<Saved, String> {
    let current = app.open.lock().unwrap().path.clone();
    let entry = app
        .store
        .save(current.as_deref(), &document)
        .map_err(|error| error.to_string())?;
    *app.open.lock().unwrap() = Open {
        path: Some(PathBuf::from(&entry.path)),
    };
    Ok(Saved { entry })
}

#[tauri::command]
fn project_save_as(
    app: tauri::State<Files>,
    handle: tauri::AppHandle,
    document: Value,
) -> Result<Option<Saved>, String> {
    use tauri_plugin_dialog::DialogExt;

    let name = document
        .get("workspaceName")
        .and_then(Value::as_str)
        .unwrap_or("Survey workspace");
    let suggested = format!("{}.northstar.json", store::slug(name));
    let picked = handle
        .dialog()
        .file()
        .add_filter("Northstar project", &["json"])
        .set_title("Save a copy of this project")
        .set_file_name(&suggested)
        .blocking_save_file();
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|error| format!("that file cannot be written: {error}"))?;
    let entry = app
        .store
        .save_as(&path, &document)
        .map_err(|error| error.to_string())?;
    *app.open.lock().unwrap() = Open {
        path: Some(PathBuf::from(&entry.path)),
    };
    Ok(Some(Saved { entry }))
}

#[tauri::command]
fn project_delete(app: tauri::State<Files>, id: String) -> Result<Vec<Entry>, String> {
    let deleted = app
        .store
        .project_path(&id)
        .map_err(|error| error.to_string())?;
    app.store.delete(&id).map_err(|error| error.to_string())?;
    let mut open = app.open.lock().unwrap();
    if open.path.as_deref() == Some(deleted.as_path()) {
        open.path = None;
    }
    Ok(app.store.list())
}

/// Tell the file manager where a project lives, which is what "Show in Finder"
/// means on each platform.
#[tauri::command]
fn project_reveal(path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    // The file manager selects a file and opens a folder, so a folder path is
    // passed through and a file path gains the flag that selects it.
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        if path.is_dir() {
            command.arg(&path);
        } else {
            command.arg("-R").arg(&path);
        }
        command
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("explorer");
        if path.is_dir() {
            command.arg(&path);
        } else {
            command.arg(format!("/select,{}", path.display()));
        }
        command
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(if path.is_dir() {
            path.clone()
        } else {
            path.parent().unwrap_or(&path).to_path_buf()
        });
        command
    };
    command
        .spawn()
        .map_err(|error| format!("the file manager did not open: {error}"))?;
    Ok(())
}

#[tauri::command]
fn project_folder(app: tauri::State<Files>) -> String {
    app.store.root().display().to_string()
}

#[tauri::command]
fn project_forget(app: tauri::State<Files>) {
    *app.open.lock().unwrap() = Open { path: None };
}

#[tauri::command]
fn settings_save(app: tauri::State<Files>, document: Value) -> Result<Value, String> {
    app.store
        .save_settings(&document)
        .map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // A second launch is how a person opens a project from the file manager
    // while the app is already running, so it hands its argument to this
    // window instead of starting a second store over the same files.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let path = argv
                .iter()
                .skip(1)
                .find(|argument| argument.ends_with(".json"))
                .cloned();
            if let (Some(window), Some(path)) = (app.get_webview_window("main"), path) {
                emit_open(&window, Path::new(&path));
            }
        }));
    }

    builder
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let root = app_data(app.handle())?;
            let store = Store::open(root).map_err(|error| error.to_string())?;
            let boot = boot_payload(&store);
            let script = format!(
                "window.__NORTHSTAR_BOOT__ = {};",
                serde_json::to_string(&boot).unwrap_or_else(|_| "null".into())
            );

            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Northstar Field CAD")
                .inner_size(1440.0, 900.0)
                .min_inner_size(1024.0, 700.0)
                .initialization_script(&script)
                .build()?;

            // A project dragged onto the window opens in this window instead
            // of starting a second copy on the same files.
            let drop_window = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                    if let Some(path) = paths
                        .iter()
                        .find(|path| path.extension().and_then(|e| e.to_str()) == Some("json"))
                    {
                        emit_open(&drop_window, path);
                    }
                }
            });

            app.manage(Files {
                store,
                open: Mutex::new(Open { path: None }),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            project_list,
            project_open,
            project_open_path,
            project_pick,
            project_save,
            project_save_as,
            project_delete,
            project_reveal,
            project_folder,
            project_forget,
            settings_save
        ])
        .run(tauri::generate_context!())
        .expect("the Northstar window failed to start");
}
