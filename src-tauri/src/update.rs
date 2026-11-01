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

/// Past releases, so a build that breaks a feature can be replaced by the one
/// that worked. Tauri's updater only moves forward, so this bypasses it: the
/// list comes from the project's release page, and installing downloads that
/// tag's installer for this platform and opens it in the system installer.
const RELEASES_URL: &str =
    "https://api.github.com/repos/emrisca/northstar-desktop/releases?per_page=30";
const DOWNLOAD_ROOT: &str = "https://github.com/emrisca/northstar-desktop/releases/download/";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PastRelease {
    tag: String,
    version: String,
    name: String,
    date: Option<String>,
    asset: Option<String>,
    size: Option<u64>,
    current: bool,
}

fn fetch_releases() -> Result<Vec<serde_json::Value>, String> {
    let response = ureq::get(RELEASES_URL)
        .set("User-Agent", "northstar-desktop")
        .set("Accept", "application/vnd.github+json")
        .call()
        .map_err(|error| format!("GitHub could not be reached: {error}"))?;
    let body: serde_json::Value = response
        .into_json()
        .map_err(|error| format!("the release list could not be read: {error}"))?;
    body.as_array()
        .cloned()
        .ok_or_else(|| "the release list was not readable".to_string())
}

/// The installer to hand the system for this platform, newest format first.
/// Only a URL under this project's release path is accepted, so a release entry
/// cannot point the download somewhere else.
fn pick_asset(assets: &[serde_json::Value]) -> Option<(String, String, u64)> {
    let wanted: &[&str] = if cfg!(target_os = "macos") {
        &[".dmg", ".app.tar.gz"]
    } else if cfg!(target_os = "windows") {
        &["-setup.exe", ".msi"]
    } else {
        &[".appimage", ".deb"]
    };
    for suffix in wanted {
        for asset in assets {
            let name = asset
                .get("name")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            let url = asset
                .get("browser_download_url")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            let size = asset.get("size").and_then(|value| value.as_u64()).unwrap_or(0);
            if name.to_ascii_lowercase().ends_with(suffix) && url.starts_with(DOWNLOAD_ROOT) {
                return Some((name.to_string(), url.to_string(), size));
            }
        }
    }
    None
}

#[tauri::command]
pub async fn update_releases(app: AppHandle) -> Result<Vec<PastRelease>, String> {
    let current = app.package_info().version.to_string();
    let list = tauri::async_runtime::spawn_blocking(fetch_releases)
        .await
        .map_err(|error| format!("the release list could not be read: {error}"))??;
    let mut past = Vec::new();
    for release in list {
        if release
            .get("draft")
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
        {
            continue;
        }
        let Some(tag) = release.get("tag_name").and_then(|value| value.as_str()) else {
            continue;
        };
        let assets = release
            .get("assets")
            .and_then(|value| value.as_array())
            .cloned()
            .unwrap_or_default();
        let picked = pick_asset(&assets);
        let version = tag.trim_start_matches('v').to_string();
        past.push(PastRelease {
            tag: tag.to_string(),
            current: version == current,
            version,
            name: release
                .get("name")
                .and_then(|value| value.as_str())
                .unwrap_or(tag)
                .to_string(),
            date: release
                .get("published_at")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string()),
            asset: picked.as_ref().map(|(name, _, _)| name.clone()),
            size: picked.map(|(_, _, size)| size),
        });
    }
    Ok(past)
}

#[tauri::command]
pub async fn update_install_release(tag: String) -> Result<String, String> {
    let tag = tag.trim().to_string();
    if tag.is_empty() {
        return Err("choose a release first".into());
    }
    let path = tauri::async_runtime::spawn_blocking(move || download_release(&tag))
        .await
        .map_err(|error| format!("the download could not be started: {error}"))??;
    Ok(path.display().to_string())
}

fn download_release(tag: &str) -> Result<std::path::PathBuf, String> {
    let list = fetch_releases()?;
    let release = list
        .iter()
        .find(|release| release.get("tag_name").and_then(|value| value.as_str()) == Some(tag))
        .ok_or_else(|| format!("{tag} is not on the release page"))?;
    let assets = release
        .get("assets")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let (name, url, _) =
        pick_asset(&assets).ok_or_else(|| format!("{tag} has no installer for this platform"))?;
    let path = std::env::temp_dir().join(format!("northstar-{name}"));
    let response = ureq::get(&url)
        .set("User-Agent", "northstar-desktop")
        .call()
        .map_err(|error| format!("the installer could not be downloaded: {error}"))?;
    let mut file = std::fs::File::create(&path)
        .map_err(|error| format!("the installer could not be saved: {error}"))?;
    std::io::copy(&mut response.into_reader(), &mut file)
        .map_err(|error| format!("the installer could not be saved: {error}"))?;
    open_installer(&path)?;
    Ok(path)
}

/// Hand the file to the system the way a download in a browser would: the
/// installer window opens and the person finishes it.
fn open_installer(path: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let opened = std::process::Command::new("open").arg(path).spawn();
    #[cfg(target_os = "windows")]
    let opened = std::process::Command::new("cmd")
        .args(["/C", "start", ""])
        .arg(path)
        .spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let opened = std::process::Command::new("xdg-open").arg(path).spawn();
    opened
        .map(|_| ())
        .map_err(|error| format!("the installer could not be opened: {error}"))
}

#[cfg(test)]
mod tests {
    use super::pick_asset;
    use serde_json::json;

    fn asset(name: &str) -> serde_json::Value {
        json!({
            "name": name,
            "browser_download_url": format!(
                "https://github.com/emrisca/northstar-desktop/releases/download/v0.1.12/{name}"
            ),
            "size": 1024,
        })
    }

    #[test]
    fn picks_this_platform_installer_and_refuses_foreign_urls() {
        let assets = vec![
            asset("Northstar_0.1.12_x64-setup.exe"),
            asset("Northstar_0.1.12_aarch64.dmg"),
            asset("Northstar_0.1.12_amd64.AppImage"),
        ];
        let (name, url, size) = pick_asset(&assets).expect("an installer");
        if cfg!(target_os = "macos") {
            assert_eq!(name, "Northstar_0.1.12_aarch64.dmg");
        } else if cfg!(target_os = "windows") {
            assert_eq!(name, "Northstar_0.1.12_x64-setup.exe");
        } else {
            assert_eq!(name, "Northstar_0.1.12_amd64.AppImage");
        }
        assert!(url.starts_with(super::DOWNLOAD_ROOT));
        assert_eq!(size, 1024);

        let elsewhere = vec![json!({
            "name": "Northstar.dmg",
            "browser_download_url": "https://example.test/Northstar.dmg",
            "size": 1,
        })];
        assert!(pick_asset(&elsewhere).is_none());
    }
}
