//! The RTKLIB recovery installer, ported from `app/rtklib_install.py`.
//!
//! The batch that made conversion and correction work put RTKLIB inside the
//! app: `scripts/bundle-rtklib.sh` copies the build for this platform into the
//! bundle, and the engine lookup finds it before anything else. That is the
//! normal case, and on it this module only reports what is there.
//!
//! The installer is the recovery path for a build whose bundle is empty, such
//! as one packaged by someone who could not build RTKLIB for the platform. It
//! downloads the one pinned official archive, checks its SHA-256, and writes
//! only inside the app's data folder: Windows takes the official executables
//! from the archive, macOS and Linux build the two tools from the verified
//! source, which is why the card states whether `make` and a C compiler were
//! found. Nothing is installed system-wide and no administrator password is
//! requested. A download that does not match the checksum writes nothing.
//!
//! The panel reads its progress by polling `rtklib_install_status`, so the job
//! is the channel: it carries the step, the percent, the log lines and the end
//! state the panel renders.

use crate::preflight::platform_key;
use crate::rtklib::{self, WorkDir};
use crate::Failure;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_DOWNLOAD: u64 = 95 * 1024 * 1024;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(45);
const BUILD_TIMEOUT: Duration = Duration::from_secs(300);
const MARKER: &str = "INSTALLED.json";
const ARCHIVE_NAME: &str = "RTKLIB_2.4.3_b34.zip";
const USER_AGENT: &str = "Northstar-Field-CAD/1.0 (local RTKLIB installer)";

const README_TEXT: &str = "RTKLIB {version} command-line tools
===================================

Installed by Northstar's opt-in installer from the official release:
{asset}

This folder is inside Northstar's data folder. Nothing was installed
system-wide and no administrator permission was requested.

Binaries: bin/rnx2rtkp{exe} and bin/convbin{exe}
License:  LICENSE.txt (RTKLIB BSD 2-Clause; keep it with the binaries)
Source:   https://github.com/tomojitakasu/RTKLIB

RTKLIB is distributed \"AS IS\", without warranty. Northstar prepares and
checks jobs; it does not make survey-accuracy guarantees.
";

/// Where the tools live when the recovery path installed them.
pub fn install_dir(data: &Path) -> PathBuf {
    data.join("tools").join("rtklib")
}

fn which(names: &[&str]) -> String {
    let Some(path) = std::env::var_os("PATH") else {
        return String::new();
    };
    for directory in std::env::split_paths(&path) {
        for name in names {
            let candidate = directory.join(rtklib::binary_name(name));
            if candidate.is_file() {
                return candidate.display().to_string();
            }
        }
    }
    String::new()
}

fn runs(command: &str) -> bool {
    if command.is_empty() {
        return false;
    }
    let mut child = std::process::Command::new(command);
    child.arg("--version");
    rtklib::run(&mut child, Duration::from_secs(6)).success
}

fn toolchain() -> Value {
    let make = which(&["make", "gmake"]);
    let compiler = which(&["cc", "clang", "gcc"]);
    json!({
        "make": make,
        "compiler": compiler,
        "makeReady": runs(&make),
        "compilerReady": runs(&compiler),
    })
}

/// How this platform's build is produced from the archive.
fn install_method() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows-binaries"
    } else {
        "source-build"
    }
}

/// What the installer panel shows before anything is downloaded.
pub fn install_info(data: &Path, bundle: Option<&Path>) -> Value {
    let engine = rtklib::discover(data, bundle);
    let tools = toolchain();
    let installed = engine.found();
    let mut reason = String::new();
    if !installed {
        if platform_key() == "unsupported" {
            reason =
                "Automatic installation is supported on Windows, macOS and Linux only.".to_string();
        } else if install_method() == "source-build" {
            let make_ready = tools["makeReady"].as_bool().unwrap_or(false);
            let compiler_ready = tools["compilerReady"].as_bool().unwrap_or(false);
            if !make_ready || !compiler_ready {
                let mut missing = Vec::new();
                if !make_ready {
                    missing.push("make");
                }
                if !compiler_ready {
                    missing.push("a C compiler");
                }
                reason = format!(
                    "Building RTKLIB on this computer needs {}. macOS: run \
                     'xcode-select --install'. Linux: install make and a C compiler.",
                    missing.join(" and ")
                );
            }
        }
    }
    let method = if engine.source == "bundle" {
        "bundled"
    } else {
        install_method()
    };
    json!({
        "ok": true,
        "version": if engine.version.is_empty() { rtklib::VERSION.to_string() } else { engine.version.clone() },
        "releaseTag": rtklib::RELEASE_TAG,
        "asset": {
            "url": rtklib::ASSET_URL,
            "sha256": rtklib::ASSET_SHA256,
            "bytes": rtklib::ASSET_BYTES,
        },
        "platform": platform_key(),
        "method": method,
        "source": engine.source,
        "canInstall": !installed && reason.is_empty(),
        "reason": reason,
        "buildTools": tools,
        "installed": installed,
        "converterInstalled": engine.convbin.is_some(),
        "enginePath": engine.rnx2rtkp.as_ref().map(|path| path.display().to_string()).unwrap_or_default(),
        "installPath": rtklib::install_bin(data).display().to_string(),
        "license": rtklib::LICENSE,
        "adminRequired": false,
    })
}

/// One installation, as the panel reads it.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub status: String,
    pub step: String,
    pub message: String,
    pub progress: u8,
    pub log: Vec<String>,
    pub error: String,
    pub started_at: String,
    pub finished_at: String,
    pub result: Option<Value>,
}

impl Job {
    fn new(id: &str) -> Self {
        Self {
            id: id.to_string(),
            status: "running".to_string(),
            step: "starting".to_string(),
            message: "Starting the RTKLIB installer…".to_string(),
            progress: 0,
            log: Vec::new(),
            error: String::new(),
            started_at: iso_now(),
            finished_at: String::new(),
            result: None,
        }
    }
}

/// The one job this app has, which is what memory held in the web build.
#[derive(Default)]
pub struct Installer {
    job: Arc<Mutex<Option<Job>>>,
}

fn step(job: &Arc<Mutex<Option<Job>>>, id: &str, at: &str, message: &str, percent: u8) {
    if let Ok(mut guard) = job.lock() {
        if let Some(job) = guard.as_mut().filter(|job| job.id == id) {
            job.step = at.to_string();
            job.message = message.to_string();
            job.progress = percent.min(100);
        }
    }
}

fn append(job: &Arc<Mutex<Option<Job>>>, id: &str, line: &str) {
    if line.is_empty() {
        return;
    }
    if let Ok(mut guard) = job.lock() {
        if let Some(job) = guard.as_mut().filter(|job| job.id == id) {
            let clipped: String = line.chars().take(500).collect();
            job.log.push(clipped);
            let length = job.log.len();
            if length > 80 {
                job.log.drain(0..length - 80);
            }
        }
    }
}

impl Installer {
    /// `{ok: true, job}` with the job, or `null` before the first install.
    pub fn status(&self) -> Value {
        let job = self.job.lock().ok().and_then(|guard| guard.clone());
        json!({ "ok": true, "job": job })
    }

    /// Refuse early for the reasons the panel would otherwise discover late,
    /// then do the work on a thread so the window keeps painting.
    pub fn start(&self, data: &Path, bundle: Option<&Path>) -> Result<Value, Failure> {
        let info = install_info(data, bundle);
        if info["installed"].as_bool().unwrap_or(false) {
            return Err(Failure::bad("RTKLIB is already available on this computer."));
        }
        if !info["canInstall"].as_bool().unwrap_or(false) {
            let reason = info["reason"]
                .as_str()
                .filter(|reason| !reason.is_empty())
                .unwrap_or("This computer cannot install RTKLIB automatically.");
            return Err(Failure::bad(reason));
        }
        let running = self
            .job
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|job| job.status == "running"))
            .unwrap_or(false);
        if running {
            return Err(Failure::new(
                409,
                "An RTKLIB installation is already running.",
            ));
        }

        let id = job_id();
        let job = Job::new(&id);
        if let Ok(mut guard) = self.job.lock() {
            *guard = Some(job.clone());
        }
        let cell = Arc::clone(&self.job);
        let data = data.to_path_buf();
        std::thread::spawn(move || work(&data, &cell, &id));
        Ok(json!({ "ok": true, "job": job }))
    }
}

fn job_id() -> String {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    let tail = format!("{stamp:x}");
    tail[tail.len().saturating_sub(12)..].to_string()
}

fn work(data: &Path, cell: &Arc<Mutex<Option<Job>>>, id: &str) {
    let progress = |at: &str, message: &str, percent: u8, line: &str| {
        step(cell, id, at, message, percent);
        append(cell, id, line);
    };
    match install(data, &progress) {
        Ok(result) => {
            step(cell, id, "done", "RTKLIB is ready.", 100);
            if let Ok(mut guard) = cell.lock() {
                if let Some(job) = guard.as_mut().filter(|job| job.id == id) {
                    job.status = "done".to_string();
                    job.result = Some(result);
                    job.finished_at = iso_now();
                }
            }
        }
        Err(message) => {
            append(cell, id, &format!("ERROR: {message}"));
            if let Ok(mut guard) = cell.lock() {
                if let Some(job) = guard.as_mut().filter(|job| job.id == id) {
                    job.status = "error".to_string();
                    job.step = "error".to_string();
                    job.message = "The RTKLIB installation did not finish.".to_string();
                    job.error = message;
                    job.finished_at = iso_now();
                }
            }
        }
    }
}

type Progress<'a> = dyn Fn(&str, &str, u8, &str) + 'a;

/// Download, verify, extract or build, and place the tools.
fn install(data: &Path, progress: &Progress<'_>) -> Result<Value, String> {
    let tools_dir = install_dir(data);
    std::fs::create_dir_all(&tools_dir)
        .map_err(|error| format!("Could not write to the project's tools folder: {error}"))?;
    // The work folder sits inside the tools folder so the final move is a
    // rename on one volume, and so a half-finished install is removed with it.
    let work = WorkDir::new_in(&tools_dir, ".rtklib-install-")
        .map_err(|error| error.message)?;
    let archive = work.path().join(ARCHIVE_NAME);
    let stage = work.path().join("stage");
    std::fs::create_dir_all(&stage)
        .map_err(|error| format!("Could not write to the project's tools folder: {error}"))?;

    download(&archive, progress)?;
    progress("verify", "Verifying the SHA-256 checksum…", 72, "");
    let actual = sha256(&archive)?;
    if actual.to_lowercase() != rtklib::ASSET_SHA256.to_lowercase() {
        return Err("The RTKLIB download did not match the pinned SHA-256 checksum. \
                    Nothing was installed."
            .to_string());
    }
    progress("verify", "Checksum verified.", 74, &format!("SHA-256 {actual}"));

    let file = std::fs::File::open(&archive)
        .map_err(|error| format!("The RTKLIB download could not be read: {error}"))?;
    let mut archive_zip = zip::ZipArchive::new(file)
        .map_err(|_| "The RTKLIB download was not a readable ZIP archive.".to_string())?;
    if install_method() == "windows-binaries" {
        extract_windows(&mut archive_zip, &stage, progress)?;
    } else {
        build_from_source(&mut archive_zip, &stage, work.path(), progress)?;
    }

    progress("check", "Checking the installed tools…", 96, "");
    let mut installed = Vec::new();
    for name in ["rnx2rtkp", "convbin"] {
        let path = stage.join("bin").join(rtklib::binary_name(name));
        if !path.is_file() {
            return Err(format!(
                "The installer did not produce {name}; the existing tools were left alone."
            ));
        }
        validate_binary(&path, name)?;
        installed.push(rtklib::binary_name(name));
    }

    place(&stage, &tools_dir);
    let method = install_method();
    let suffix = if cfg!(target_os = "windows") { ".exe" } else { "" };
    let binaries_block: serde_json::Map<String, Value> = ["rnx2rtkp", "convbin"]
        .iter()
        .map(|name| {
            (
                (*name).to_string(),
                json!(format!("tools/rtklib/bin/{name}{suffix}")),
            )
        })
        .collect();
    let marker = json!({
        "version": rtklib::VERSION,
        "releaseTag": rtklib::RELEASE_TAG,
        "sha256": rtklib::ASSET_SHA256,
        "source": rtklib::ASSET_URL,
        "method": method,
        "platform": platform_key(),
        "installedAt": iso_now(),
        // Relative to the project, so the record survives the folder moving.
        "binaries": binaries_block,
        "license": rtklib::LICENSE,
    });
    std::fs::write(
        tools_dir.join(MARKER),
        format!(
            "{}\n",
            serde_json::to_string_pretty(&marker).unwrap_or_default()
        ),
    )
    .map_err(|error| format!("The install record could not be written: {error}"))?;
    // The engine lookup may have found the archive name; the binaries are the
    // truth, and the helper is what the card's Done line shows.
    progress(
        "done",
        "RTKLIB is ready.",
        100,
        &format!("Installed into {}", rtklib::install_bin(data).display()),
    );
    Ok(json!({
        "ok": true,
        "version": rtklib::VERSION,
        "method": method,
        "path": rtklib::install_bin(data).display().to_string(),
        "binaries": binaries_block,
        "marker": tools_dir.join(MARKER).display().to_string(),
    }))
}

fn download(destination: &Path, progress: &Progress<'_>) -> Result<(), String> {
    progress("download", "Downloading the official RTKLIB package…", 0, "");
    let agent = ureq::AgentBuilder::new().timeout(DOWNLOAD_TIMEOUT).build();
    let response = agent
        .get(rtklib::ASSET_URL)
        .set("User-Agent", USER_AGENT)
        .set("Accept", "application/zip,application/octet-stream,*/*")
        .call()
        .map_err(|error| format!("Could not download RTKLIB: {}", error_text(&error)))?;
    let total = response
        .header("Content-Length")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(rtklib::ASSET_BYTES);
    if total > MAX_DOWNLOAD {
        return Err(
            "The RTKLIB download was larger than expected; nothing was installed.".to_string(),
        );
    }
    let mut reader = response.into_reader();
    let mut file = std::fs::File::create(destination)
        .map_err(|error| format!("Could not write the RTKLIB download: {error}"))?;
    let mut downloaded = 0u64;
    let mut reported = Instant::now()
        .checked_sub(Duration::from_secs(1))
        .unwrap_or_else(Instant::now);
    let mut chunk = vec![0u8; 512 * 1024];
    loop {
        let read = reader
            .read(&mut chunk)
            .map_err(|error| format!("Could not download RTKLIB: {error}"))?;
        if read == 0 {
            break;
        }
        file.write_all(&chunk[..read])
            .map_err(|error| format!("Could not write the RTKLIB download: {error}"))?;
        downloaded += read as u64;
        if downloaded > MAX_DOWNLOAD {
            return Err(
                "The RTKLIB download was larger than expected; nothing was installed.".to_string(),
            );
        }
        if reported.elapsed() > Duration::from_millis(350) {
            let percent = (downloaded.saturating_mul(70) / total.max(1)).min(70) as u8;
            progress(
                "download",
                &format!(
                    "Downloading {:.1} of {:.1} MB…",
                    downloaded as f64 / 1_048_576.0,
                    total as f64 / 1_048_576.0
                ),
                percent,
                "",
            );
            reported = Instant::now();
        }
    }
    if downloaded == 0 {
        return Err("The RTKLIB download was empty; nothing was installed.".to_string());
    }
    Ok(())
}

fn error_text(error: &ureq::Error) -> String {
    match error {
        // The web build only ever printed the code for an HTTP failure, and the
        // panel's sentence reads the same either way.
        ureq::Error::Status(code, _) => format!("HTTP {code}"),
        ureq::Error::Transport(transport) => transport.to_string(),
    }
}

fn sha256(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path)
        .map_err(|error| format!("The RTKLIB download could not be read: {error}"))?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)
        .map_err(|error| format!("The RTKLIB download could not be read: {error}"))?;
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

/// The folder inside the archive that holds `bin/rnx2rtkp.exe`.
fn archive_root<T: Read + std::io::Seek>(archive: &mut zip::ZipArchive<T>) -> Result<String, String> {
    let names: Vec<String> = archive.file_names().map(str::to_string).collect();
    for name in &names {
        let lower = name.to_lowercase();
        if lower.ends_with("/bin/rnx2rtkp.exe") {
            return Ok(name[..name.len() - "/bin/rnx2rtkp.exe".len()].to_string());
        }
    }
    for name in &names {
        if name.to_lowercase().ends_with("/readme.txt") {
            return Ok(name.rsplit_once('/').map(|(head, _)| head).unwrap_or("").to_string());
        }
    }
    Err("The RTKLIB archive did not contain the expected files.".to_string())
}

fn write_readme(stage: &Path) {
    let exe = if cfg!(target_os = "windows") { ".exe" } else { "" };
    let _ = std::fs::write(
        stage.join("README.txt"),
        README_TEXT
            .replace("{version}", rtklib::VERSION)
            .replace("{asset}", rtklib::ASSET_URL)
            .replace("{exe}", exe),
    );
}

fn write_license<T: Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<T>,
    root: &str,
    stage: &Path,
) -> Result<(), String> {
    let mut written = 0;
    for (candidate, destination) in [
        (format!("{root}/LICENSE.txt"), stage.join("LICENSE.txt")),
        (
            format!("{root}/bin/LICENSE.txt"),
            stage.join("bin").join("LICENSE.txt"),
        ),
    ] {
        let mut buffer = Vec::new();
        let Ok(mut entry) = archive.by_name(&candidate) else {
            continue;
        };
        if entry.read_to_end(&mut buffer).is_err() || buffer.is_empty() {
            continue;
        }
        if let Some(parent) = destination.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(&destination, &buffer)
            .map_err(|error| format!("The license could not be written: {error}"))?;
        written += 1;
    }
    if written == 0 {
        return Err(
            "The RTKLIB archive did not contain its license file; nothing was installed."
                .to_string(),
        );
    }
    Ok(())
}

fn extract_windows<T: Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<T>,
    stage: &Path,
    progress: &Progress<'_>,
) -> Result<Vec<String>, String> {
    progress("extract", "Extracting the official Windows binaries…", 76, "");
    let root = archive_root(archive)?;
    let bin_dir = stage.join("bin");
    std::fs::create_dir_all(&bin_dir)
        .map_err(|error| format!("Could not write to the project's tools folder: {error}"))?;
    let prefix = format!("{}/bin/", root.to_lowercase());
    let names: Vec<String> = archive.file_names().map(str::to_string).collect();
    let mut copied = Vec::new();
    for name in names {
        let lower = name.to_lowercase();
        if !lower.starts_with(&prefix) {
            continue;
        }
        let relative = &name[prefix.len()..];
        if relative.contains('/') {
            continue;
        }
        let relative_lower = relative.to_lowercase();
        let wanted = relative_lower == "rnx2rtkp.exe"
            || relative_lower == "convbin.exe"
            || relative_lower.ends_with(".dll");
        if !wanted {
            continue;
        }
        let mut buffer = Vec::new();
        archive
            .by_name(&name)
            .map_err(|error| format!("The RTKLIB archive could not be read: {error}"))?
            .read_to_end(&mut buffer)
            .map_err(|error| format!("The RTKLIB archive could not be read: {error}"))?;
        std::fs::write(bin_dir.join(relative), &buffer)
            .map_err(|error| format!("Could not write to the project's tools folder: {error}"))?;
        copied.push(relative.to_string());
    }
    if !copied
        .iter()
        .any(|name| name.to_lowercase() == "rnx2rtkp.exe")
    {
        return Err(
            "The RTKLIB archive did not contain rnx2rtkp.exe; nothing was installed.".to_string(),
        );
    }
    write_license(archive, &root, stage)?;
    write_readme(stage);
    copied.sort();
    progress(
        "extract",
        "Windows binaries extracted.",
        84,
        &format!("Files: {}", copied.join(", ")),
    );
    Ok(copied)
}

fn build_tool(
    source_root: &Path,
    name: &str,
    stage: &Path,
    progress: &Progress<'_>,
    start: u8,
    end: u8,
) -> Result<(), String> {
    let tools = toolchain();
    let make = tools["make"].as_str().unwrap_or("");
    let compiler = tools["compiler"].as_str().unwrap_or("");
    if !tools["makeReady"].as_bool().unwrap_or(false)
        || !tools["compilerReady"].as_bool().unwrap_or(false)
    {
        return Err(install_info(source_root, None)["reason"]
            .as_str()
            .unwrap_or("This computer cannot install RTKLIB automatically.")
            .to_string());
    }
    let workdir = source_root.join("app").join("consapp").join(name).join("gcc");
    if !workdir.is_dir() {
        return Err(format!(
            "The RTKLIB source did not contain the {name} build files."
        ));
    }
    let link_libs = if cfg!(target_os = "macos") {
        "-lm"
    } else {
        "-lm -lrt"
    };
    let mut command = std::process::Command::new(make);
    command
        .current_dir(&workdir)
        .arg(format!("CC={compiler}"))
        .arg(format!("LDLIBS={link_libs}"));
    progress(
        "build",
        &format!("Building {name} from the verified source…"),
        start,
        &format!("{make} CC={compiler} LDLIBS={link_libs}"),
    );
    let ran = rtklib::run(&mut command, BUILD_TIMEOUT);
    if ran.timed_out {
        return Err(format!(
            "Building {name} timed out after {} seconds.",
            BUILD_TIMEOUT.as_secs()
        ));
    }
    if let Some(error) = ran.start_error {
        return Err(format!("Could not start the {name} build: {error}"));
    }
    if !ran.success {
        let tail = ran.tail(18);
        progress("build", &format!("Building {name} failed."), end, &tail);
        return Err(format!("Building {name} failed.\n{tail}"));
    }
    let built = workdir.join(rtklib::binary_name(name));
    if !built.is_file() {
        return Err(format!(
            "Building {name} finished but did not produce a binary."
        ));
    }
    let bin_dir = stage.join("bin");
    std::fs::create_dir_all(&bin_dir)
        .map_err(|error| format!("Could not write to the project's tools folder: {error}"))?;
    let destination = bin_dir.join(rtklib::binary_name(name));
    std::fs::copy(&built, &destination)
        .map_err(|error| format!("The {name} binary could not be copied: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&destination, std::fs::Permissions::from_mode(0o755));
    }
    progress(
        "build",
        &format!("{name} built."),
        end,
        &format!("Built {name}; it will be validated before installation."),
    );
    Ok(())
}

fn build_from_source<T: Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<T>,
    stage: &Path,
    work: &Path,
    progress: &Progress<'_>,
) -> Result<Vec<String>, String> {
    let source_dir = work.join("source");
    std::fs::create_dir_all(&source_dir)
        .map_err(|error| format!("Could not write to the project's tools folder: {error}"))?;
    progress("extract", "Extracting the verified RTKLIB source…", 76, "");
    safe_extract(archive, &source_dir)?;
    let source_root = std::fs::read_dir(&source_dir)
        .map_err(|error| format!("The RTKLIB source could not be read: {error}"))?
        .flatten()
        .map(|entry| entry.path())
        .find(|path| path.join("app").join("consapp").join("rnx2rtkp").join("gcc").is_dir())
        .ok_or_else(|| {
            "The RTKLIB archive did not contain its source tree; nothing was installed.".to_string()
        })?;
    build_tool(&source_root, "rnx2rtkp", stage, progress, 80, 90)?;
    build_tool(&source_root, "convbin", stage, progress, 90, 95)?;
    for name in ["LICENSE.txt", "readme.txt"] {
        let source = source_root.join(name);
        if source.is_file() {
            let _ = std::fs::copy(&source, stage.join(name));
        }
    }
    if !stage.join("LICENSE.txt").is_file() {
        return Err(
            "The RTKLIB source did not contain its license file; nothing was installed."
                .to_string(),
        );
    }
    write_readme(stage);
    Ok(vec![
        rtklib::binary_name("rnx2rtkp"),
        rtklib::binary_name("convbin"),
    ])
}

/// Resolve one archive member against `destination`, refusing a name that would
/// climb out of it. The check is lexical on purpose: the destination itself may
/// sit behind a symlink (`/var` to `/private/var` on macOS), so comparing
/// canonical paths there would reject the whole archive.
fn member_path(destination: &Path, name: &str) -> Option<PathBuf> {
    if name.starts_with('/') || name.starts_with('\\') || name.contains(':') {
        return None;
    }
    let mut target = destination.to_path_buf();
    for part in name.split(['/', '\\']) {
        match part {
            "" | "." => {}
            ".." => return None,
            other => target.push(other),
        }
    }
    Some(target)
}

/// Unpack every member, refusing anything that would land outside `destination`.
fn safe_extract<T: Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<T>,
    destination: &Path,
) -> Result<(), String> {
    let names: Vec<String> = archive.file_names().map(str::to_string).collect();
    for name in names {
        let Some(target) = member_path(destination, &name) else {
            return Err(
                "The RTKLIB archive contained an unsafe path; nothing was installed.".to_string(),
            );
        };
        if name.ends_with('/') {
            let _ = std::fs::create_dir_all(&target);
            continue;
        }
        if let Some(parent) = target.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let mut buffer = Vec::new();
        archive
            .by_name(&name)
            .map_err(|error| format!("The RTKLIB archive could not be read: {error}"))?
            .read_to_end(&mut buffer)
            .map_err(|error| format!("The RTKLIB archive could not be read: {error}"))?;
        std::fs::write(&target, &buffer)
            .map_err(|error| format!("Could not write to the project's tools folder: {error}"))?;
    }
    Ok(())
}

fn validate_binary(path: &Path, name: &str) -> Result<String, String> {
    let flag = if name == "rnx2rtkp" { "-v" } else { "-h" };
    let mut command = std::process::Command::new(path);
    command.arg(flag).current_dir(path.parent().unwrap_or(Path::new(".")));
    let ran = rtklib::run(&mut command, Duration::from_secs(10));
    if let Some(error) = ran.start_error {
        return Err(format!("The installed {name} could not be started: {error}"));
    }
    let output = format!("{}\n{}", ran.stdout, ran.stderr);
    let lower = output.to_lowercase();
    if !lower.contains(&name.to_lowercase()) && !lower.contains("usage") {
        let tail = ran.tail(6);
        return Err(format!(
            "The installed {name} did not report itself correctly.\n{tail}"
        ));
    }
    Ok(output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.chars().take(160).collect())
        .unwrap_or_else(|| "ready".to_string()))
}

/// Move the staged files into the tools folder, replacing what was there.
fn place(stage: &Path, tools_dir: &Path) {
    let bin_target = tools_dir.join("bin");
    let _ = std::fs::create_dir_all(&bin_target);
    for item in std::fs::read_dir(stage).into_iter().flatten().flatten() {
        let name = item.file_name();
        if name == "bin" {
            continue;
        }
        let destination = tools_dir.join(&name);
        let _ = std::fs::remove_file(&destination);
        let _ = std::fs::rename(item.path(), destination);
    }
    for item in std::fs::read_dir(stage.join("bin")).into_iter().flatten().flatten() {
        let name = item.file_name();
        let destination = bin_target.join(&name);
        let _ = std::fs::remove_file(&destination);
        let _ = std::fs::rename(item.path(), destination);
    }
}

fn iso_now() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    let days = (seconds / 86_400) as i64;
    let rest = seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}+00:00",
        rest / 3600,
        (rest % 3600) / 60,
        rest % 60
    )
}

/// Days since 1970 as a calendar date, by Howard Hinnant's civil algorithm.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 { shifted } else { shifted - 146_096 } / 146_097;
    let day_of_era = (shifted - era * 146_097) as u64;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era as i64 + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_prime + 2) / 5 + 1) as u32;
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::preflight;
    use zip::write::FileOptions;

    fn fixture(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "northstar-install-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn zip_with(entries: &[(&str, &str)]) -> zip::ZipArchive<std::io::Cursor<Vec<u8>>> {
        let mut buffer = Vec::new();
        {
            let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut buffer));
            for (name, body) in entries {
                let options: FileOptions<'_, ()> = FileOptions::default();
                writer.start_file(*name, options).unwrap();
                writer.write_all(body.as_bytes()).unwrap();
            }
            writer.finish().unwrap();
        }
        zip::ZipArchive::new(std::io::Cursor::new(buffer)).unwrap()
    }

    #[test]
    fn the_installer_card_gets_the_shape_it_reads() {
        let root = fixture("shape");
        let info = install_info(&root, None);
        for key in [
            "ok",
            "version",
            "releaseTag",
            "asset",
            "platform",
            "method",
            "canInstall",
            "reason",
            "buildTools",
            "installed",
            "converterInstalled",
            "enginePath",
            "installPath",
            "license",
            "adminRequired",
        ] {
            assert!(info.get(key).is_some(), "{key} is missing");
        }
        assert_eq!(info["version"], json!(rtklib::VERSION));
        assert_eq!(info["asset"]["sha256"], json!(rtklib::ASSET_SHA256));
        assert_eq!(info["adminRequired"], json!(false));
        assert!(std::path::Path::new(info["installPath"].as_str().unwrap())
            .ends_with(std::path::Path::new("tools").join("rtklib").join("bin")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_job_carries_the_fields_the_panel_renders() {
        let installer = Installer::default();
        assert_eq!(installer.status()["job"], json!(null));
        let job = Job::new("abc123");
        let value = serde_json::to_value(&job).unwrap();
        for key in [
            "id",
            "status",
            "step",
            "message",
            "progress",
            "log",
            "error",
            "startedAt",
            "finishedAt",
            "result",
        ] {
            assert!(value.get(key).is_some(), "{key} is missing");
        }
        assert_eq!(value["status"], json!("running"));
        assert!(value["startedAt"].as_str().unwrap().ends_with("+00:00"));
    }

    #[test]
    fn progress_lines_stop_at_eighty_and_percent_at_hundred() {
        let installer = Installer::default();
        let cell = Arc::clone(&installer.job);
        if let Ok(mut guard) = cell.lock() {
            *guard = Some(Job::new("job1"));
        }
        for index in 0..100 {
            append(&cell, "job1", &format!("line {index}"));
        }
        step(&cell, "job1", "build", "Building", 140);
        let job = cell.lock().unwrap().clone().unwrap();
        assert_eq!(job.log.len(), 80);
        assert_eq!(job.log.first().unwrap(), "line 20");
        assert_eq!(job.progress, 100);
        // A line meant for a job that has been replaced is dropped.
        step(&cell, "other", "build", "nope", 10);
        assert_eq!(cell.lock().unwrap().clone().unwrap().message, "Building");
    }

    #[test]
    fn the_windows_archive_is_read_from_its_own_root_and_keeps_the_license() {
        let root = fixture("extract");
        let stage = root.join("stage");
        std::fs::create_dir_all(&stage).unwrap();
        let mut archive = zip_with(&[
            ("RTKLIB_2.4.3_b34/bin/rnx2rtkp.exe", "binary"),
            ("RTKLIB_2.4.3_b34/bin/convbin.exe", "binary"),
            ("RTKLIB_2.4.3_b34/bin/pthreadVC2.dll", "library"),
            ("RTKLIB_2.4.3_b34/bin/notes.txt", "left behind"),
            ("RTKLIB_2.4.3_b34/LICENSE.txt", "BSD 2-Clause"),
        ]);
        let copied = extract_windows(&mut archive, &stage, &|_, _, _, _| {}).unwrap();
        assert_eq!(
            copied,
            vec![
                "convbin.exe".to_string(),
                "pthreadVC2.dll".to_string(),
                "rnx2rtkp.exe".to_string()
            ]
        );
        assert!(stage.join("bin").join("rnx2rtkp.exe").is_file());
        assert!(!stage.join("bin").join("notes.txt").exists());
        assert!(stage.join("LICENSE.txt").is_file());
        assert!(stage.join("README.txt").is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_archive_without_the_engine_is_refused() {
        let root = fixture("no-engine");
        let stage = root.join("stage");
        std::fs::create_dir_all(&stage).unwrap();
        // A readme is enough for the archive root to be found, so the refusal
        // comes from the missing engine rather than from the missing root.
        let mut archive = zip_with(&[
            ("RTKLIB_2.4.3_b34/bin/convbin.exe", "binary"),
            ("RTKLIB_2.4.3_b34/readme.txt", "RTKLIB"),
        ]);
        let failure = extract_windows(&mut archive, &stage, &|_, _, _, _| {}).unwrap_err();
        assert_eq!(
            failure,
            "The RTKLIB archive did not contain rnx2rtkp.exe; nothing was installed."
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_archive_with_no_expected_folder_at_all_is_refused() {
        let root = fixture("no-root");
        let stage = root.join("stage");
        std::fs::create_dir_all(&stage).unwrap();
        let mut archive = zip_with(&[("something.txt", "no")]);
        let failure = extract_windows(&mut archive, &stage, &|_, _, _, _| {}).unwrap_err();
        assert_eq!(
            failure,
            "The RTKLIB archive did not contain the expected files."
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_extracted_path_cannot_leave_the_source_folder() {
        let root = fixture("unsafe");
        let destination = root.join("source");
        std::fs::create_dir_all(&destination).unwrap();
        let mut archive = zip_with(&[("../escape.txt", "no")]);
        let failure = safe_extract(&mut archive, &destination).unwrap_err();
        assert_eq!(
            failure,
            "The RTKLIB archive contained an unsafe path; nothing was installed."
        );
        assert!(!root.join("escape.txt").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A destination reached through a symlink is the normal case on macOS
    /// (`/var` points at `/private/var`, and the temp folder lives under it), so
    /// the containment check must not compare a canonical path against a
    /// lexical one.
    #[test]
    fn a_nested_archive_extracts_through_a_symlinked_destination() {
        let root = fixture("symlinked");
        let real = root.join("real");
        std::fs::create_dir_all(&real).unwrap();
        let link = root.join("link");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, &link).unwrap();
        #[cfg(not(unix))]
        {
            let _ = &link;
        }
        let destination = if link.exists() { link } else { real.clone() }.join("source");
        std::fs::create_dir_all(&destination).unwrap();
        let mut archive = zip_with(&[
            ("RTKLIB/", ""),
            ("RTKLIB/bin/rnx2rtkp", "binary"),
            ("RTKLIB/LICENSE.txt", "BSD 2-Clause"),
        ]);
        safe_extract(&mut archive, &destination).unwrap();
        assert!(destination.join("RTKLIB/bin/rnx2rtkp").is_file());
        assert!(destination.join("RTKLIB/LICENSE.txt").is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_staged_binaries_and_papers_land_in_the_tools_folder() {
        let root = fixture("place");
        let stage = root.join("stage");
        std::fs::create_dir_all(stage.join("bin")).unwrap();
        std::fs::write(stage.join("bin").join("rnx2rtkp"), "binary").unwrap();
        std::fs::write(stage.join("LICENSE.txt"), "BSD 2-Clause").unwrap();
        let tools = root.join("tools").join("rtklib");
        std::fs::create_dir_all(&tools).unwrap();
        place(&stage, &tools);
        assert!(tools.join("bin").join("rnx2rtkp").is_file());
        assert!(tools.join("LICENSE.txt").is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The recovery path, run for real: download the pinned archive, check it,
    /// build or extract, place the tools and write the record the readiness
    /// check reads. Opt-in because it is 75 MB and, on macOS and Linux, a
    /// source build.
    ///
    ///     cargo test --lib -- --ignored the_recovery_installer
    #[test]
    #[ignore]
    fn the_recovery_installer_places_a_record_the_readiness_check_accepts() {
        let data = fixture("recovery");
        let steps = std::sync::Arc::new(Mutex::new(Vec::<String>::new()));
        let seen = std::sync::Arc::clone(&steps);
        let result = install(&data, &move |at, _, percent, _| {
            seen.lock().unwrap().push(format!("{percent:>3}% {at}"));
        })
        .expect("the installer finishes");

        let record = std::fs::read_to_string(install_dir(&data).join(MARKER)).unwrap();
        let marker: Value = serde_json::from_str(&record).unwrap();
        assert_eq!(marker["platform"], json!(platform_key()));
        assert_eq!(marker["version"], json!(rtklib::VERSION));
        assert_eq!(marker["sha256"], json!(rtklib::ASSET_SHA256));
        assert_eq!(
            marker["binaries"]["rnx2rtkp"],
            json!(format!(
                "tools/rtklib/bin/rnx2rtkp{}",
                if cfg!(target_os = "windows") { ".exe" } else { "" }
            ))
        );
        for name in ["rnx2rtkp", "convbin"] {
            assert!(
                install_dir(&data)
                    .join("bin")
                    .join(rtklib::binary_name(name))
                    .is_file(),
                "{name} was not placed"
            );
        }
        assert!(install_dir(&data).join("LICENSE.txt").is_file());
        assert_eq!(preflight::installed_release(&data), rtklib::VERSION);
        let engine = rtklib::discover(&data, None);
        assert_eq!(engine.source.contains("installed"), true, "{engine:?}");
        assert_eq!(result["method"], json!(install_method()));
        eprintln!("steps: {:?}", steps.lock().unwrap());
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn a_date_reads_as_the_panel_expects() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_723), (2026, 9, 27));
        assert_eq!(civil_from_days(20_725), (2026, 9, 29));
        let stamp = iso_now();
        assert_eq!(stamp.len(), 25, "{stamp}");
        assert!(stamp.ends_with("+00:00"));
    }
}
