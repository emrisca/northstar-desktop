//! The readiness report, ported from `preflight.py`.
//!
//! The web build answered three questions: is the app intact, is RTKLIB
//! present, and can NOAA be reached. In the desktop build the interface is
//! compiled into the binary, so there are no loose app files to miss; the third
//! question is the same fixed NOAA station, and the middle one looks for the
//! tools in the bundle, on the PATH, and in the folders the web build searched.
//!
//! The shape is the one the readiness card reads: `ok`, `app.missing`,
//! `rtklib.found`, `rtklib.release`, `rtklib.binaries.rnx2rtkp.version`,
//! `rtklib.converterFound`, `noaa.ok` and `noaa.message`. The `python` block is
//! gone because there is no Python, and `postProcessingReady` stays because the
//! web build reported it.

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use std::time::Instant;

use crate::noaa;

const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const HINT: &str = "Install RTKLIB 2.4.3 or newer with the installer in Northstar, put rnx2rtkp and convbin on PATH, or copy them into tools/rtklib/.";

/// The name the RTKLIB installer records for this computer.
pub fn platform_key() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unsupported"
    }
}

/// Where an RTKLIB build could be, in the order the web build looked.
pub fn candidate_dirs(root: &Path) -> Vec<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let mut candidates: Vec<PathBuf> = vec![
        root.to_path_buf(),
        root.join("tools"),
        root.join("tools").join("rtklib"),
        root.join("tools").join("rtklib").join("bin"),
        root.join("rtklib"),
        root.join("rtklib").join("bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/opt/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/opt/RTKLIB/bin"),
        PathBuf::from("/opt/rtklib/bin"),
    ];
    if let Some(home) = &home {
        candidates.push(home.join("RTKLIB").join("bin"));
        candidates.push(home.join("rtklib").join("bin"));
        #[cfg(target_os = "macos")]
        if let Ok(entries) = fs::read_dir("/Applications") {
            for entry in entries.flatten() {
                let path = entry.path();
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if name.starts_with("RTKLIB") {
                    candidates.push(path.clone());
                    candidates.push(path.join("bin"));
                }
            }
        }
    }
    for name in ["RTKLIB_HOME", "RTKLIB_BIN"] {
        if let Some(raw) = std::env::var_os(name) {
            let path = PathBuf::from(raw);
            candidates.push(path.clone());
            candidates.push(path.join("bin"));
        }
    }
    let mut seen = std::collections::HashSet::new();
    candidates
        .into_iter()
        .filter(|path| seen.insert(path.to_string_lossy().to_string()))
        .collect()
}

fn path_dirs() -> Vec<PathBuf> {
    std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default()
}

/// Run the tool with no arguments and keep the line that names its version.
/// RTKLIB answers that with `error : no input file`, which is not a version, so
/// a line beginning with `error` is skipped, exactly as the web build did.
pub fn probe(path: &Path) -> Value {
    let started = Instant::now();
    let mut child = match Command::new(path)
        .current_dir(path.parent().unwrap_or(Path::new(".")))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            return json!({
                "found": false,
                "path": path.display().to_string(),
                "version": "",
                "error": truncate(&error.to_string(), 160),
            });
        }
    };
    let exited = loop {
        match child.try_wait() {
            Ok(Some(_)) => break true,
            Ok(None) => {
                if started.elapsed() > PROBE_TIMEOUT {
                    let _ = child.kill();
                    break false;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(_) => break false,
        }
    };
    let output = child.wait_with_output();
    if !exited {
        return json!({
            "found": false,
            "path": path.display().to_string(),
            "version": "",
            "error": "the tool did not answer within three seconds",
        });
    }
    match output {
        Ok(output) => {
            let mut text = String::from_utf8_lossy(&output.stdout).to_string();
            text.push('\n');
            text.push_str(&String::from_utf8_lossy(&output.stderr));
            let lines: Vec<&str> = text
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .collect();
            let usable: Vec<&&str> = lines
                .iter()
                .filter(|line| !line.to_lowercase().starts_with("error"))
                .collect();
            let named = usable
                .iter()
                .find(|line| {
                    let lower = line.to_lowercase();
                    lower.contains("ver.")
                        || lower.contains("version")
                        || lower.contains("rtklib")
                })
                .map(|line| (***line).to_string());
            let version = named
                .or_else(|| usable.first().map(|line| (***line).to_string()))
                .unwrap_or_else(|| "version not reported".to_string());
            json!({
                "found": true,
                "path": path.display().to_string(),
                "version": truncate(&version, 180),
            })
        }
        Err(error) => json!({
            "found": false,
            "path": path.display().to_string(),
            "version": "",
            "error": truncate(&error.to_string(), 160),
        }),
    }
}

fn truncate(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

fn find_tool(name: &str, directories: &[PathBuf]) -> Value {
    let suffix = if cfg!(target_os = "windows") { ".exe" } else { "" };
    let file = format!("{name}{suffix}");
    for directory in path_dirs() {
        let candidate = directory.join(&file);
        if candidate.is_file() {
            return probe(&candidate);
        }
    }
    for directory in directories {
        let candidate = directory.join(&file);
        if candidate.is_file() {
            return probe(&candidate);
        }
    }
    json!({ "found": false, "path": "", "version": "" })
}

/// The version the installer recorded, but only when the record still describes
/// this computer and binaries that resolve inside this build's tools folder. A
/// record carried over from another machine or another folder names a build that
/// is not here.
pub fn installed_release(root: &Path) -> String {
    let tools = root.join("tools").join("rtklib");
    let Ok(text) = fs::read_to_string(tools.join("INSTALLED.json")) else {
        return String::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return String::new();
    };
    if value.get("platform").and_then(Value::as_str) != Some(platform_key()) {
        return String::new();
    }
    let Some(binaries) = value.get("binaries").and_then(Value::as_object) else {
        return String::new();
    };
    if binaries.is_empty() {
        return String::new();
    }
    let Ok(bin_dir) = tools.join("bin").canonicalize() else {
        return String::new();
    };
    for recorded in binaries.values() {
        let Some(recorded) = recorded.as_str().filter(|path| !path.is_empty()) else {
            return String::new();
        };
        let Ok(resolved) = root.join(recorded).canonicalize() else {
            return String::new();
        };
        if !resolved.starts_with(&bin_dir) || !resolved.is_file() {
            return String::new();
        }
    }
    value
        .get("version")
        .and_then(Value::as_str)
        .map(|version| truncate(version.trim(), 40))
        .unwrap_or_default()
}

pub fn rtklib_report(root: &Path) -> Value {
    let directories = candidate_dirs(root);
    let rnx2rtkp = find_tool("rnx2rtkp", &directories);
    let convbin = find_tool("convbin", &directories);
    let release = installed_release(root);
    json!({
        "found": rnx2rtkp.get("found").and_then(Value::as_bool).unwrap_or(false),
        "converterFound": convbin.get("found").and_then(Value::as_bool).unwrap_or(false),
        "release": release,
        "binaries": { "rnx2rtkp": rnx2rtkp, "convbin": convbin },
        "searched": directories.iter().map(|path| path.display().to_string()).collect::<Vec<_>>(),
        "hint": HINT,
    })
}

/// Whether the app can write beside its own projects. This replaces the web
/// build's check for loose interface files, which do not exist here because
/// they are compiled into the binary.
fn data_folder(app_root: &Path) -> Value {
    let probe = app_root.join(".write-check");
    let writable = fs::write(&probe, b"northstar").is_ok();
    if writable {
        let _ = fs::remove_file(&probe);
    }
    json!({
        "ok": writable,
        "root": app_root.display().to_string(),
        "missing": [],
    })
}

pub fn platform_block() -> Value {
    let release = Command::new("uname")
        .arg("-r")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| "unknown".to_string());
    json!({
        "system": std::env::consts::OS,
        "release": release,
        "machine": std::env::consts::ARCH,
    })
}

/// The whole report. `tools_root` is where an RTKLIB build would live and
/// `app_root` is the data folder the store owns.
pub fn system_report(tools_root: &Path, app_root: &Path, check_noaa: bool) -> Value {
    let app = data_folder(app_root);
    let rtklib = rtklib_report(tools_root);
    let noaa = if check_noaa {
        noaa::reachability(Duration::from_secs(6))
    } else {
        json!({
            "ok": Value::Null,
            "latencyMs": Value::Null,
            "message": "Network check skipped.",
            "skipped": true,
        })
    };
    let core_ok = app.get("ok").and_then(Value::as_bool).unwrap_or(false);
    let ready = core_ok
        && rtklib.get("found").and_then(Value::as_bool).unwrap_or(false)
        && noaa.get("ok").and_then(Value::as_bool).unwrap_or(false);
    json!({
        "ok": core_ok,
        "postProcessingReady": ready,
        "platform": platform_block(),
        "app": app,
        "rtklib": rtklib,
        "noaa": noaa,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("northstar-preflight-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn the_report_keeps_the_shape_the_readiness_card_reads() {
        let root = fixture("shape");
        let report = system_report(&root, &root, false);
        for key in ["ok", "postProcessingReady", "platform", "app", "rtklib", "noaa"] {
            assert!(report.get(key).is_some(), "{key} is missing");
        }
        assert!(report.get("python").is_none(), "python is gone in the desktop build");
        assert!(report["app"]["missing"].as_array().unwrap().is_empty());
        assert_eq!(report["noaa"]["skipped"], json!(true));
        assert_eq!(report["noaa"]["message"], json!("Network check skipped."));
        assert!(report["rtklib"]["searched"].as_array().unwrap().len() > 3);
        assert_eq!(report["rtklib"]["hint"], json!(HINT));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_folder_the_app_cannot_write_is_reported_as_not_ok() {
        let root = fixture("readonly");
        let missing = root.join("not-there");
        fs::create_dir_all(&missing).unwrap();
        fs::remove_dir_all(&missing).unwrap();
        let report = system_report(&root, &missing, false);
        assert_eq!(report["app"]["ok"], json!(false));
        assert_eq!(report["ok"], json!(false));
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn a_tool_is_probed_for_the_version_line_it_prints() {
        use std::os::unix::fs::PermissionsExt;
        let root = fixture("probe");
        let tool = root.join("rnx2rtkp");
        fs::write(&tool, "#!/bin/sh\necho 'RTKLIB ver. 2.4.3'\necho 'usage: rnx2rtkp' >&2\n").unwrap();
        let mut permissions = fs::metadata(&tool).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&tool, permissions).unwrap();

        let found = probe(&tool);
        assert_eq!(found["found"], json!(true));
        assert_eq!(found["version"], json!("RTKLIB ver. 2.4.3"));
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn a_tool_that_only_complains_reports_its_usage_line_not_an_error() {
        use std::os::unix::fs::PermissionsExt;
        let root = fixture("usage");
        let tool = root.join("rnx2rtkp");
        fs::write(&tool, "#!/bin/sh\necho 'error : no input file' >&2\necho 'rnx2rtkp 2.4.3' >&2\n").unwrap();
        let mut permissions = fs::metadata(&tool).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&tool, permissions).unwrap();

        let found = probe(&tool);
        assert_eq!(found["found"], json!(true));
        assert_eq!(found["version"], json!("rnx2rtkp 2.4.3"));
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn a_file_that_cannot_run_is_not_a_found_tool() {
        use std::os::unix::fs::PermissionsExt;
        let root = fixture("not-executable");
        let tool = root.join("rnx2rtkp");
        fs::write(&tool, "RTKLIB ver. 2.4.3\n").unwrap();
        let mut permissions = fs::metadata(&tool).unwrap().permissions();
        permissions.set_mode(0o644);
        fs::set_permissions(&tool, permissions).unwrap();

        let found = probe(&tool);
        assert_eq!(found["found"], json!(false));
        assert!(found["error"].as_str().unwrap().len() > 0);
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn a_record_from_another_platform_is_ignored() {
        use std::os::unix::fs::PermissionsExt;
        let root = fixture("record");
        let bin = root.join("tools").join("rtklib").join("bin");
        fs::create_dir_all(&bin).unwrap();
        let tool = bin.join("rnx2rtkp");
        fs::write(&tool, "#!/bin/sh\necho 'RTKLIB ver. 2.4.3'\n").unwrap();
        let mut permissions = fs::metadata(&tool).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&tool, permissions).unwrap();

        let record = json!({
            "version": "2.4.3",
            "platform": platform_key(),
            "binaries": { "rnx2rtkp": "tools/rtklib/bin/rnx2rtkp" },
        });
        fs::write(
            root.join("tools").join("rtklib").join("INSTALLED.json"),
            serde_json::to_vec_pretty(&record).unwrap(),
        )
        .unwrap();
        assert_eq!(installed_release(&root), "2.4.3");

        // The same record, for another computer.
        let mut other = record.clone();
        other["platform"] = json!("windows");
        fs::write(
            root.join("tools").join("rtklib").join("INSTALLED.json"),
            serde_json::to_vec_pretty(&other).unwrap(),
        )
        .unwrap();
        assert_eq!(installed_release(&root), "");

        // A record naming a binary that is no longer there.
        fs::remove_file(&tool).unwrap();
        fs::write(
            root.join("tools").join("rtklib").join("INSTALLED.json"),
            serde_json::to_vec_pretty(&record).unwrap(),
        )
        .unwrap();
        assert_eq!(installed_release(&root), "");
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn a_tool_in_a_candidate_folder_is_found_and_reported() {
        use std::os::unix::fs::PermissionsExt;
        let root = fixture("candidate");
        let bin = root.join("tools").join("rtklib").join("bin");
        fs::create_dir_all(&bin).unwrap();
        let tool = bin.join("rnx2rtkp");
        fs::write(&tool, "#!/bin/sh\necho 'RTKLIB ver. 2.4.3'\n").unwrap();
        let mut permissions = fs::metadata(&tool).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&tool, permissions).unwrap();

        let report = rtklib_report(&root);
        assert_eq!(report["found"], json!(true));
        assert_eq!(report["binaries"]["rnx2rtkp"]["version"], json!("RTKLIB ver. 2.4.3"));
        assert_eq!(report["converterFound"], json!(false));
        let _ = fs::remove_dir_all(&root);
    }
}
