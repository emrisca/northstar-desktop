//! The desktop shell.
//!
//! Batch 0 opened one window on the interface that already existed. Batch 2
//! adds the project store: the window is now built after the store has been
//! read, and the project and settings the interface expects in `localStorage`
//! are handed to it in an initialisation script, so the first paint is already
//! the saved project.
//!
//! Batch 3 added the NOAA lookups and the readiness report; batch 4 adds
//! RTKLIB: the tools ship inside the app, and conversion, correction and the
//! recovery installer all answer from Rust. That is the last of the nine
//! endpoints `src/native.js` used to answer with a 503.

mod convert;
mod correct;
mod failure;
mod install;
mod noaa;
mod preflight;
mod rtklib;
mod store;

pub use failure::Failure;
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
    /// The RTKLIB tools this build ships, resolved once when the window is
    /// built. `None` when the bundle carries none, which is the case the
    /// recovery installer exists for.
    bundle: Option<PathBuf>,
    installer: install::Installer,
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

/// Where `scripts/bundle-rtklib.sh` put this build's tools, one folder per
/// platform because the binaries are native. A packaged app keeps them under
/// its resources; `tauri dev` copies the same tree beside the binary, and a
/// test run has neither, so the source tree is the last place to look.
fn bundle_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let platform = preflight::platform_key();
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(resources) = app.path().resource_dir() {
        roots.push(resources.join(rtklib::BUNDLE_FOLDER).join(platform));
        roots.push(
            resources
                .join("resources")
                .join(rtklib::BUNDLE_FOLDER)
                .join(platform),
        );
    }
    roots.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join(rtklib::BUNDLE_FOLDER)
            .join(platform),
    );
    roots.into_iter().find(|path| path.is_dir())
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

/// The readiness report the post-processing card shows. The blocking work runs
/// off the command thread so the window keeps painting while NOAA is asked.
#[tauri::command]
async fn preflight(app: tauri::State<'_, Files>, noaa: Option<bool>) -> Result<Value, String> {
    let data = app.store.root().to_path_buf();
    let bundle = app.bundle.clone();
    tauri::async_runtime::spawn_blocking(move || {
        preflight::system_report(&data, bundle.as_deref(), noaa.unwrap_or(true))
    })
    .await
    .map_err(|error| error.to_string())
}

/* ------------------------------------------------------------------ RTKLIB */

/// What the installer panel shows before anything is downloaded. It probes the
/// bundled tools and the build toolchain, so it runs off the command thread.
#[tauri::command]
async fn rtklib_install_info(app: tauri::State<'_, Files>) -> Result<Value, String> {
    let data = app.store.root().to_path_buf();
    let bundle = app.bundle.clone();
    tauri::async_runtime::spawn_blocking(move || {
        install::install_info(&data, bundle.as_deref())
    })
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn rtklib_install_status(app: tauri::State<Files>) -> Value {
    app.installer.status()
}

#[tauri::command]
fn rtklib_install(app: tauri::State<Files>, confirm: Option<bool>) -> Result<Value, Failure> {
    if confirm != Some(true) {
        return Err(Failure::bad(
            "This action requires explicit confirmation.",
        ));
    }
    app.installer
        .start(app.store.root(), app.bundle.as_deref())
}

/// One raw log, sent as base64 because the bytes have to travel as text
/// through the IPC boundary. The size cap is checked before it is decoded.
#[tauri::command]
async fn rtklib_convert(
    app: tauri::State<'_, Files>,
    name: String,
    format: Option<String>,
    mtime: Option<f64>,
    base64: String,
) -> Result<Value, Failure> {
    let data = app.store.root().to_path_buf();
    let bundle = app.bundle.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = rtklib::decode(&base64)?;
        convert::convert(
            &data,
            bundle.as_deref(),
            &name,
            &bytes,
            &format.unwrap_or_default(),
            mtime,
        )
    })
    .await
    .map_err(|error| Failure::new(500, error.to_string()))?
}

/// The job the interface already checked, exactly as it built it.
#[tauri::command]
async fn rtklib_run(
    app: tauri::State<'_, Files>,
    payload: Value,
) -> Result<Value, Failure> {
    if payload.get("confirm").and_then(Value::as_bool) != Some(true) {
        return Err(Failure::bad(
            "This action requires explicit confirmation.",
        ));
    }
    let data = app.store.root().to_path_buf();
    let bundle = app.bundle.clone();
    tauri::async_runtime::spawn_blocking(move || {
        correct::run(&data, bundle.as_deref(), &payload)
    })
    .await
    .map_err(|error| Failure::new(500, error.to_string()))?
}

#[tauri::command]
async fn noaa_nearby(lat: f64, lon: f64, height: Option<f64>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || noaa::nearby(lat, lon, height.unwrap_or(0.0)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn noaa_station(id: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || noaa::station(&id))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn noaa_base(
    station: String,
    date: String,
    start: Option<String>,
    hours: Option<i64>,
    interval: Option<i64>,
) -> Result<Value, String> {
    let start = start.unwrap_or_else(|| "00:00".to_string());
    let hours = hours.unwrap_or(1);
    let interval = interval.unwrap_or(30);
    tauri::async_runtime::spawn_blocking(move || noaa::base(&station, &date, &start, hours, interval))
        .await
        .map_err(|error| error.to_string())?
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

            // A launch from a terminal or the file manager leaves the new
            // window behind the active app: the process is frontmost, but the
            // window is not key, so the first clicks only activate it and the
            // interface looks frozen for a moment. Ask for focus as it opens.
            let _ = window.set_focus();

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

            let bundle = bundle_path(app.handle());
            app.manage(Files {
                store,
                bundle,
                installer: install::Installer::default(),
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
            settings_save,
            preflight,
            noaa_nearby,
            noaa_station,
            noaa_base,
            rtklib_install_info,
            rtklib_install_status,
            rtklib_install,
            rtklib_convert,
            rtklib_run
        ])
        .run(tauri::generate_context!())
        .expect("the Northstar window failed to start");
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime};
    use tauri::webview::InvokeRequest;

    /// A window over a throwaway data folder, with the commands registered the
    /// way the real builder registers them. This is the seam a browser harness
    /// cannot reach: the command names and the argument names the bridge sends.
    fn shell(name: &str) -> tauri::WebviewWindow<MockRuntime> {
        let root = std::env::temp_dir().join(format!(
            "northstar-ipc-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let store = Store::open(root).unwrap();
        let app = mock_builder()
            .manage(Files {
                store,
                bundle: None,
                installer: install::Installer::default(),
                open: Mutex::new(Open { path: None }),
            })
            .invoke_handler(tauri::generate_handler![
                preflight,
                noaa_nearby,
                noaa_station,
                noaa_base,
                rtklib_install_info,
                rtklib_install_status,
                rtklib_install,
                rtklib_convert,
                rtklib_run
            ])
            .build(mock_context(noop_assets()))
            .unwrap();
        tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap()
    }

    fn call(
        window: &tauri::WebviewWindow<MockRuntime>,
        command: &str,
        args: Value,
    ) -> Result<Value, Value> {
        get_ipc_response(
            window,
            InvokeRequest {
                cmd: command.to_string(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(),
                body: InvokeBody::Json(args),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.to_string(),
            },
        )
        .map(|body| body.deserialize::<Value>().unwrap())
        .map_err(|error| error)
    }

    #[test]
    fn the_bundle_this_checkout_ships_carries_both_tools() {
        let bundle = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join(rtklib::BUNDLE_FOLDER)
            .join(preflight::platform_key());
        if !bundle.is_dir() {
            // A platform whose bundle has not been produced yet; that is the
            // case the recovery installer exists for.
            return;
        }
        let engine = rtklib::discover(&std::env::temp_dir(), Some(&bundle));
        assert_eq!(engine.source, "bundle", "{engine:?}");
        assert!(engine.rnx2rtkp.is_some(), "the correction engine is bundled");
        assert!(engine.convbin.is_some(), "the converter is bundled");
        assert_eq!(engine.version, rtklib::VERSION);
    }

    #[test]
    fn the_readiness_check_answers_with_the_shape_the_card_reads() {
        let window = shell("preflight");
        let report = call(&window, "preflight", json!({ "noaa": false })).unwrap();
        assert!(report.get("rtklib").is_some(), "{report}");
        assert_eq!(report["noaa"]["skipped"], json!(true));
        assert!(report.get("python").is_none());
    }

    #[test]
    fn the_noaa_commands_take_the_argument_names_the_bridge_sends() {
        let window = shell("noaa");

        // Each of these is refused before a request leaves, so the test needs no
        // network and still proves the argument names arrive.
        let error = call(&window, "noaa_nearby", json!({ "lat": 200.0, "lon": 0.0 }))
            .unwrap_err();
        assert_eq!(
            error.as_str().unwrap(),
            "Latitude or longitude is outside its valid range."
        );

        let error = call(&window, "noaa_station", json!({ "id": "12" })).unwrap_err();
        assert_eq!(
            error.as_str().unwrap(),
            "Station ID must be four letters or digits."
        );

        let error = call(
            &window,
            "noaa_base",
            json!({
                "station": "1LSU",
                "date": "2026-10-29",
                "start": "09:00",
                "hours": 1,
                "interval": 10
            }),
        )
        .unwrap_err();
        assert_eq!(
            error.as_str().unwrap(),
            "Interval must be 1, 5, 15 or 30 seconds."
        );
    }

    #[test]
    fn the_rtklib_commands_take_the_argument_names_the_bridge_sends() {
        let window = shell("rtklib");

        // No job has run in this window yet, and the panel expects null.
        let status = call(&window, "rtklib_install_status", json!({})).unwrap();
        assert_eq!(status["ok"], json!(true));
        assert_eq!(status["job"], json!(null));

        // An install without the confirmation the panel sends stops before any
        // request leaves the machine.
        let error = call(&window, "rtklib_install", json!({ "confirm": false })).unwrap_err();
        assert_eq!(
            error["message"].as_str().unwrap(),
            "This action requires explicit confirmation."
        );
        assert_eq!(error["status"], json!(400));

        // The bytes arrive as base64 under the name the bridge uses.
        let error = call(
            &window,
            "rtklib_convert",
            json!({ "name": "rover.ubx", "format": "ubx", "base64": "" }),
        )
        .unwrap_err();
        assert_eq!(error["message"].as_str().unwrap(), "The file is empty.");

        let error = call(&window, "rtklib_convert", json!({ "name": "rover.ubx", "base64": "!!!" }))
            .unwrap_err();
        assert_eq!(
            error["message"].as_str().unwrap(),
            "The file did not arrive completely."
        );

        let error = call(&window, "rtklib_run", json!({ "payload": { "confirm": true } }))
            .unwrap_err();
        assert_eq!(error["message"].as_str().unwrap(), "The rover file is missing.");
    }
}
