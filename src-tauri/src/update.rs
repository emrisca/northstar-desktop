//! One-button updates.
//!
//! The interface is plain JavaScript with no bundler, so the updater lives
//! here instead of in `@tauri-apps/plugin-updater`: a check is a command, an
//! install is a command that starts a task, and the window polls the state for
//! progress. The background thread checks once after launch and then every six
//! hours; when the window is not focused it raises a native notification.

use serde::Serialize;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;

const CHECK_AFTER_LAUNCH: Duration = Duration::from_secs(10);
const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateView {
    current_version: String,
    status: String,
    version: Option<String>,
    notes: Option<String>,
    date: Option<String>,
    downloaded: u64,
    total: Option<u64>,
    error: Option<String>,
}

struct Inner {
    status: String,
    version: Option<String>,
    notes: Option<String>,
    date: Option<String>,
    downloaded: u64,
    total: Option<u64>,
    error: Option<String>,
    notified: Option<String>,
}

pub struct UpdateHolder {
    inner: Mutex<Inner>,
}

impl UpdateHolder {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                status: "idle".into(),
                version: None,
                notes: None,
                date: None,
                downloaded: 0,
                total: None,
                error: None,
                notified: None,
            }),
        }
    }

    fn view(&self, app: &AppHandle) -> UpdateView {
        let inner = self.inner.lock().unwrap();
        UpdateView {
            current_version: app.package_info().version.to_string(),
            status: inner.status.clone(),
            version: inner.version.clone(),
            notes: inner.notes.clone(),
            date: inner.date.clone(),
            downloaded: inner.downloaded,
            total: inner.total,
            error: inner.error.clone(),
        }
    }
}

fn available(app: &AppHandle, update: tauri_plugin_updater::Update) {
    let holder = app.state::<UpdateHolder>();
    let mut inner = holder.inner.lock().unwrap();
    inner.status = "available".into();
    inner.version = Some(update.version);
    inner.notes = update.body;
    inner.date = update.date.map(|date| date.to_string());
    inner.downloaded = 0;
    inner.total = None;
    inner.error = None;
}

fn failed(app: &AppHandle, error: String) {
    let holder = app.state::<UpdateHolder>();
    let mut inner = holder.inner.lock().unwrap();
    inner.status = "error".into();
    inner.error = Some(error);
}

/// Checks the release endpoint and records the result. A network failure is
/// state, not a rejected command, so the window can show the reason.
pub async fn check(app: &AppHandle) -> Result<UpdateView, String> {
    let busy = {
        let holder = app.state::<UpdateHolder>();
        let mut inner = holder.inner.lock().unwrap();
        let busy = matches!(
            inner.status.as_str(),
            "downloading" | "installing" | "restarting"
        );
        if !busy {
            inner.status = "checking".into();
            inner.error = None;
        }
        busy
    };
    if busy {
        return Ok(app.state::<UpdateHolder>().view(app));
    }

    let result = match app.updater() {
        Ok(updater) => updater.check().await,
        Err(error) => Err(error),
    };

    match result {
        Ok(Some(update)) => available(app, update),
        Ok(None) => {
            let holder = app.state::<UpdateHolder>();
            let mut inner = holder.inner.lock().unwrap();
            inner.status = "upToDate".into();
            inner.version = None;
            inner.notes = None;
            inner.date = None;
            inner.downloaded = 0;
            inner.total = None;
            inner.error = None;
        }
        Err(error) => failed(app, error.to_string()),
    }

    Ok(app.state::<UpdateHolder>().view(app))
}

async fn check_and_notify(app: AppHandle) {
    let Ok(view) = check(&app).await else {
        return;
    };
    if view.status != "available" {
        return;
    }
    let Some(version) = view.version else {
        return;
    };

    let already_notified = {
        let holder = app.state::<UpdateHolder>();
        let inner = holder.inner.lock().unwrap();
        inner.notified.as_deref() == Some(version.as_str())
    };
    if already_notified {
        return;
    }

    let focused = app
        .get_webview_window("main")
        .and_then(|window| window.is_focused().ok())
        .unwrap_or(false);
    if focused {
        return;
    }

    if app
        .notification()
        .builder()
        .title(format!("Northstar {version} is available"))
        .body("Open Northstar and choose Update now.")
        .show()
        .is_ok()
    {
        let holder = app.state::<UpdateHolder>();
        holder.inner.lock().unwrap().notified = Some(version);
    }
}

/// Downloads and installs the release the endpoint currently advertises.
/// Windows exits inside the installer; macOS and Linux need the restart below.
async fn install(app: &AppHandle) -> Result<(), String> {
    let busy = {
        let holder = app.state::<UpdateHolder>();
        let mut inner = holder.inner.lock().unwrap();
        let busy = matches!(
            inner.status.as_str(),
            "downloading" | "installing" | "restarting"
        );
        if !busy {
            inner.status = "checking".into();
            inner.error = None;
        }
        busy
    };
    if busy {
        return Ok(());
    }

    let update = match app.updater() {
        Ok(updater) => match updater.check().await {
            Ok(Some(update)) => update,
            Ok(None) => {
                let holder = app.state::<UpdateHolder>();
                let mut inner = holder.inner.lock().unwrap();
                inner.status = "upToDate".into();
                inner.error = None;
                return Ok(());
            }
            Err(error) => {
                failed(app, error.to_string());
                return Err(error.to_string());
            }
        },
        Err(error) => {
            failed(app, error.to_string());
            return Err(error.to_string());
        }
    };

    {
        let holder = app.state::<UpdateHolder>();
        let mut inner = holder.inner.lock().unwrap();
        inner.status = "downloading".into();
        inner.version = Some(update.version.clone());
        inner.notes = update.body.clone();
        inner.date = update.date.map(|date| date.to_string());
        inner.downloaded = 0;
        inner.total = None;
        inner.error = None;
    }

    let progress = app.clone();
    let finished = app.clone();
    let result = update
        .download_and_install(
            move |chunk, total| {
                let holder = progress.state::<UpdateHolder>();
                let mut inner = holder.inner.lock().unwrap();
                inner.downloaded += chunk as u64;
                if total.is_some() {
                    inner.total = total;
                }
            },
            move || {
                let holder = finished.state::<UpdateHolder>();
                holder.inner.lock().unwrap().status = "installing".into();
            },
        )
        .await;

    if let Err(error) = result {
        let message = error.to_string();
        failed(app, message.clone());
        return Err(message);
    }

    {
        let holder = app.state::<UpdateHolder>();
        holder.inner.lock().unwrap().status = "restarting".into();
    }
    app.restart();
}

#[tauri::command]
pub fn update_state(app: AppHandle) -> UpdateView {
    app.state::<UpdateHolder>().view(&app)
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<UpdateView, String> {
    check(&app).await
}

#[tauri::command]
pub fn update_install(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn(async move {
        let _ = install(&app).await;
    });
    Ok(())
}

/// The launch check runs off the UI thread so startup is never waiting on the
/// network. A failed check is deliberately quiet: the previous version stays
/// usable and the panel still offers a manual retry.
pub fn watch(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(CHECK_AFTER_LAUNCH);
        loop {
            let handle = app.clone();
            let _ = tauri::async_runtime::block_on(check_and_notify(handle));
            std::thread::sleep(CHECK_EVERY);
        }
    });
}
