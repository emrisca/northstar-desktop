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
mod logging;
mod menu;
mod noaa;
mod preflight;
mod rtklib;
mod store;
mod tilecache;
mod update;

pub use failure::Failure;
use serde::Serialize;
use serde_json::{json, Value};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use store::{Entry, Store};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use update::{update_check, update_install, update_state};

/// Where the window keeps the project it is editing. `None` means the project
/// has never been written, so the first save chooses its own name.
struct Open {
    path: Option<PathBuf>,
}

/// macOS delivers an `open` event before the Tauri setup hook has built the
/// window. Keep that path until setup (or the bridge) can consume it.
static PENDING_OPEN: Mutex<Option<PathBuf>> = Mutex::new(None);

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
fn boot_payload(store: &Store, open_path: Option<&Path>) -> Value {
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
        "openPath": open_path.map(|path| path.display().to_string()).unwrap_or_default(),
    })
}

/// A file argument is a project when it exists and ends in `.northstar` or
/// `.json`. The single-dot suffix is the one macOS resolves to this app:
/// LaunchServices maps a compound `.northstar.json` to `public.json` before the
/// declaration is consulted, so the bundle declares both, `.northstar` is what
/// Save a copy writes, and `.json` still opens what older builds exported. The
/// store refuses a file that is not a Northstar document.
fn project_path(value: &OsStr) -> Option<PathBuf> {
    let path = PathBuf::from(value);
    if !path.is_file() {
        return None;
    }
    let extension = path.extension().and_then(|extension| extension.to_str())?;
    let opens = extension.eq_ignore_ascii_case("northstar") || extension.eq_ignore_ascii_case("json");
    opens.then_some(path)
}

/// Answer one `northstar-tile://` request from the cache, fetching on a miss.
///
/// The webview asks for a tile by naming it, never by opening the folder: the
/// scheme is the only door, and `tilecache::check` decides which URLs may come
/// through it.
fn serve_tile(app: &tauri::AppHandle, uri: &str) -> tauri::http::Response<Vec<u8>> {
    let url = match tilecache::target(uri) {
        Ok(url) => url,
        Err(reason) => return tile_response(400, &reason, "text/plain"),
    };
    let opened = app_data(app)
        .map_err(|error| error.to_string())
        .and_then(|root| {
            tilecache::TileCache::open(root.join("tiles"), tilecache::DEFAULT_CAP_BYTES)
                .map_err(|error| error.to_string())
        });
    let cache = match opened {
        Ok(cache) => cache,
        Err(reason) => return tile_response(500, &reason, "text/plain"),
    };
    let (bytes, mime) = match cache.get(&url) {
        Some(hit) => (hit.bytes, hit.mime),
        None => match tilecache::download(&url) {
            Ok((bytes, mime)) => {
                if let Err(error) = cache.put(&url, &bytes, &mime) {
                    logging::note(app, "tiles", &format!("cache write failed: {error}"));
                }
                (bytes, mime)
            }
            Err(reason) => return tile_response(502, &reason, "text/plain"),
        },
    };
    tauri::http::Response::builder()
        .status(200)
        .header("Content-Type", mime)
        .header("Cache-Control", "no-store")
        .header("Access-Control-Allow-Origin", "*")
        .body(bytes)
        .unwrap_or_else(|_| tile_response(500, "the tile response could not be built", "text/plain"))
}

fn tile_response(status: u16, body: &str, mime: &str) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .body(body.as_bytes().to_vec())
        .unwrap_or_default()
}

fn emit_open(window: &tauri::WebviewWindow, path: &Path) {
    let path = serde_json::to_string(&path.to_string_lossy()).unwrap_or_else(|_| "null".into());
    // The bridge is a plain script, not a module, so evaluate the call instead
    // of asking it to load the Tauri event API as a second global. A macOS
    // open event can arrive before the bridge has parsed; keep the path for
    // `ready_` in that case instead of dropping it.
    let _ = window.eval(&format!(
        "if (window.northstarOpenPath) {{ window.northstarOpenPath({path}); }} else {{ window.__NORTHSTAR_PENDING_OPEN__ = {path}; }}"
    ));
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
fn project_open_path(
    app: tauri::State<Files>,
    handle: tauri::AppHandle,
    path: String,
) -> Result<Opened, String> {
    let path = PathBuf::from(path);
    let text = app
        .store
        .read_any(&path)
        .map_err(|error| format!("{}: {error}", path.display()))?;
    *app.open.lock().unwrap() = Open {
        path: Some(path.clone()),
    };
    logging::note(&handle, "project", &format!("opened {}", path.display()));
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
        .add_filter("Northstar project", &["northstar", "json"])
        .set_title("Open a Northstar project")
        .blocking_pick_file();
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|error| format!("that file cannot be read: {error}"))?;
    project_open_path(app, handle, path.display().to_string()).map(Some)
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
    let suggested = format!("{}.northstar", store::slug(name));
    let picked = handle
        .dialog()
        .file()
        .add_filter("Northstar project", &["northstar", "json"])
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

/// The About dialog reads this rather than hard-coding a version in the
/// interface. The notices are compiled in, so they are present in a packaged
/// app even though the repository's markdown file is not an asset.
#[tauri::command]
fn app_info(app: tauri::AppHandle, files: tauri::State<Files>) -> Value {
    let mut rtklib = rtklib::bundle_version(files.bundle.as_deref());
    if rtklib.is_empty() {
        rtklib = rtklib::VERSION.to_string();
    }
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "platform": preflight::platform_key(),
        "rtklib": rtklib,
        "logDir": logging::directory(&app).display().to_string(),
        "logFile": logging::log_path(&app).display().to_string(),
        "crashFile": logging::crash_path(&app).display().to_string(),
        "notices": include_str!("../../THIRD_PARTY_NOTICES.md"),
    })
}

/// A frontend exception is written to the same log as a Rust panic, which is
/// what makes a Windows report actionable without asking for a console dump.
#[tauri::command]
fn log_frontend_error(
    app: tauri::AppHandle,
    source: String,
    message: String,
    detail: String,
) -> Result<(), String> {
    let source: String = source.chars().take(64).collect();
    let message: String = message.chars().take(4000).collect();
    let detail: String = detail.chars().take(16000).collect();
    logging::record(&app, &source, &message, &detail)
}

#[tauri::command]
fn open_logs(app: tauri::AppHandle) -> Result<(), String> {
    project_reveal(logging::directory(&app).display().to_string())
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
    let startup_path = std::env::args_os()
        .skip(1)
        .find_map(|argument| project_path(&argument));
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
                .find_map(|argument| project_path(OsStr::new(argument)));
            if let (Some(window), Some(path)) = (app.get_webview_window("main"), path) {
                emit_open(&window, &path);
            }
        }));
    }

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .register_asynchronous_uri_scheme_protocol(tilecache::SCHEME, |app, request, responder| {
            let uri = request.uri().to_string();
            let app = app.app_handle().clone();
            std::thread::spawn(move || {
                responder.respond(serve_tile(&app, &uri));
            });
        })
        .setup(move |app| {
            logging::init(app.handle());
            let root = app_data(app.handle())?;
            let store = Store::open(root).map_err(|error| error.to_string())?;
            let startup_path = startup_path.or_else(|| PENDING_OPEN.lock().unwrap().take());
            let boot = boot_payload(&store, startup_path.as_deref());
            // Manage the update state before the window can run update.js.
            app.manage(update::UpdateHolder::new());
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

            // The other half of the pre-setup event race: an open request can
            // arrive after setup starts but before the window exists.
            if let Some(path) = PENDING_OPEN.lock().unwrap().take() {
                emit_open(&window, &path);
            }

            // A project dragged onto the window opens in this window instead
            // of starting a second copy on the same files.
            let drop_window = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                    if let Some(path) = paths
                        .iter()
                        .find_map(|path| project_path(path.as_os_str()))
                    {
                        emit_open(&drop_window, &path);
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
            menu::install(app.handle())?;
            update::watch(app.handle().clone());
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
            update_state,
            update_check,
            update_install,
            preflight,
            noaa_nearby,
            noaa_station,
            noaa_base,
            rtklib_install_info,
            rtklib_install_status,
            rtklib_install,
            rtklib_convert,
            rtklib_run,
            app_info,
            log_frontend_error,
            open_logs
        ])
        .build(tauri::generate_context!())
        .expect("the Northstar window failed to start")
        .run(|app_handle, event| {
            #[cfg(target_os = "macos")]
            {
                if let tauri::RunEvent::Opened { urls } = event {
                    logging::note(
                        app_handle,
                        "launch",
                        &format!("received open event for {} URL(s)", urls.len()),
                    );
                    let path = urls
                        .iter()
                        .filter_map(|url| url.to_file_path().ok())
                        .find_map(|path| project_path(path.as_os_str()));
                    if let Some(path) = path {
                        if let Some(window) = app_handle.get_webview_window("main") {
                            emit_open(&window, &path);
                        } else {
                            *PENDING_OPEN.lock().unwrap() = Some(path);
                        }
                    }
                }
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = (app_handle, event);
            }
        });
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
        let url = if cfg!(windows) {
            "http://tauri.localhost"
        } else {
            "tauri://localhost"
        };
        get_ipc_response(
            window,
            InvokeRequest {
                cmd: command.to_string(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: url.parse().unwrap(),
                body: InvokeBody::Json(args),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.to_string(),
            },
        )
        .map(|body| body.deserialize::<Value>().unwrap())
        .map_err(|error| error)
    }

    #[test]
    fn only_an_existing_json_file_is_a_project_argument() {
        let root = std::env::temp_dir().join(format!(
            "northstar-project-argument-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let project = root.join("survey.northstar.json");
        std::fs::write(&project, "{}").unwrap();
        assert_eq!(project_path(project.as_os_str()), Some(project.clone()));

        let text = root.join("notes.txt");
        std::fs::write(&text, "not a project").unwrap();
        assert_eq!(project_path(text.as_os_str()), None);
        assert_eq!(project_path(OsStr::new("missing.northstar.json")), None);

        let single = root.join("survey.northstar");
        std::fs::write(&single, "{}").unwrap();
        assert_eq!(project_path(single.as_os_str()), Some(single.clone()));
        assert_eq!(project_path(OsStr::new("missing.northstar")), None);
        let _ = std::fs::remove_dir_all(&root);
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
