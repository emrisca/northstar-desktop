//! Crash and error logging.
//!
//! The desktop shell has no console on Windows and no terminal when it is
//! launched from Finder, so a failed start or a panic used to leave nothing
//! behind. This module owns one append-only log and one crash log in the
//! platform's log directory. The About dialog asks the shell for the exact
//! paths, and Help > Open Log Folder opens the same folder.
//!
//! The log never contains project coordinates. It records the app version,
//! frontend errors, and panic messages with their location and a backtrace.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

/// Where the shell writes its logs. Tauri resolves this per platform:
/// `~/Library/Logs/com.emrisca.northstar` on macOS,
/// `%LOCALAPPDATA%\com.emrisca.northstar\logs` on Windows, and the app's data
/// directory under `$XDG_DATA_HOME` on Linux. If the platform resolver fails,
/// the app data folder is the fallback.
pub fn directory(app: &AppHandle) -> PathBuf {
    app.path().app_log_dir().unwrap_or_else(|_| {
        app.path()
            .app_data_dir()
            .map(|path| path.join("logs"))
            .unwrap_or_else(|_| std::env::temp_dir().join("northstar-logs"))
    })
}

pub fn log_path(app: &AppHandle) -> PathBuf {
    directory(app).join("northstar.log")
}

pub fn crash_path(app: &AppHandle) -> PathBuf {
    directory(app).join("crash.log")
}

fn timestamp() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    format!("{seconds}")
}

fn append(path: &Path, level: &str, source: &str, message: &str, detail: &str) {
    let Some(parent) = path.parent() else {
        return;
    };
    if fs::create_dir_all(parent).is_err() {
        return;
    }
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    let message = message.replace('\r', " ").replace('\n', " ");
    let detail = detail.replace('\0', "");
    let _ = writeln!(
        file,
        "{} [{}] {}: {}{}",
        timestamp(),
        level,
        source,
        message,
        if detail.is_empty() {
            String::new()
        } else {
            format!("\n{detail}")
        }
    );
}

/// Record one informational event, such as the path a file-association
/// launch asked the shell to open. This makes that hand-off inspectable when
/// the window itself cannot be driven interactively.
pub fn note(app: &AppHandle, source: &str, message: &str) {
    append(&log_path(app), "INFO", source, message, "");
}

/// Record one non-fatal error. Frontend errors arrive through
/// `log_frontend_error`; startup and recovery messages call this directly.
pub fn record(app: &AppHandle, source: &str, message: &str, detail: &str) -> Result<(), String> {
    let path = log_path(app);
    append(&path, "ERROR", source, message, detail);
    if path.exists() {
        Ok(())
    } else {
        Err(format!(
            "the log file could not be written: {}",
            path.display()
        ))
    }
}

/// Install the panic hook and write one startup line. Called at the beginning
/// of setup, so a panic in the rest of the shell is captured.
pub fn init(app: &AppHandle) {
    let directory = directory(app);
    let _ = fs::create_dir_all(&directory);
    append(
        &directory.join("northstar.log"),
        "INFO",
        "app",
        "started",
        &format!(
            "version {}; {} {}",
            env!("CARGO_PKG_VERSION"),
            std::env::consts::OS,
            std::env::consts::ARCH
        ),
    );

    let crash = directory.join("crash.log");
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = if let Some(text) = info.payload().downcast_ref::<&str>() {
            (*text).to_string()
        } else if let Some(text) = info.payload().downcast_ref::<String>() {
            text.clone()
        } else {
            "panic with no message".to_string()
        };
        let location = info
            .location()
            .map(|location| {
                format!(
                    "{}:{}:{}",
                    location.file(),
                    location.line(),
                    location.column()
                )
            })
            .unwrap_or_else(|| "unknown location".to_string());
        let thread = std::thread::current();
        let name = thread.name().unwrap_or("unnamed");
        let detail = format!(
            "thread: {name}\nlocation: {location}\nbacktrace:\n{}",
            std::backtrace::Backtrace::force_capture()
        );
        append(&crash, "PANIC", "rust", &payload, &detail);
        previous(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_record_is_one_line_even_when_the_message_has_newlines() {
        let root = std::env::temp_dir().join(format!("northstar-log-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let path = root.join("northstar.log");
        append(&path, "ERROR", "frontend", "first\nsecond", "");
        let text = fs::read_to_string(&path).unwrap();
        assert_eq!(text.matches('\n').count(), 1);
        assert!(text.contains("ERROR] frontend: first second"));
        let _ = fs::remove_dir_all(&root);
    }
}
