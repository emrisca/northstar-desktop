//! Where the RTKLIB tools come from, and how a child process is run.
//!
//! The web build asked the person to install RTKLIB into the project with an
//! opt-in download. A desktop build can do better: the two binaries are copied
//! into the app's resources by `scripts/bundle-rtklib.sh` and run from inside
//! the bundle, so conversion and correction work on a machine that has never
//! seen Python or a compiler. The folders the web build searched are still
//! searched, after the bundle, so an existing install on this computer keeps
//! working.
//!
//! The other thing here is [`run`]: `std::process::Command::output` waits
//! forever, and every RTKLIB invocation in the web build had a timeout. This
//! one kills the child when the clock runs out and still collects what it
//! printed, which is what the interface shows when a job fails.

use crate::preflight;
use crate::Failure;
use serde_json::Value;
use std::io;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// The release the bundle carries and the installer downloads.
pub const VERSION: &str = "2.4.3 b34";
pub const RELEASE_TAG: &str = "v2.4.3-b34";
pub const ASSET_URL: &str =
    "https://github.com/tomojitakasu/RTKLIB/releases/download/v2.4.3-b34/RTKLIB_2.4.3_b34.zip";
pub const ASSET_SHA256: &str = "5f2eacee05e9f90cdc3604e48a906222c8832000056be9000f7ee3627bb18874";
pub const ASSET_BYTES: u64 = 75_759_087;
pub const LICENSE: &str = "BSD 2-Clause";

/// The folder under the app's resources that holds the bundled build.
pub const BUNDLE_FOLDER: &str = "rtklib";

pub fn binary_name(name: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// `resource_dir()/rtklib/bin`, where the bundle puts the two tools.
pub fn bundle_bin(bundle: &Path) -> PathBuf {
    bundle.join("bin")
}

/// `<data>/tools/rtklib/bin`, where the recovery installer puts them. The same
/// folder the web build used, inside the folder this app can write.
pub fn install_bin(data: &Path) -> PathBuf {
    data.join("tools").join("rtklib").join("bin")
}

/// One resolved pair of tools.
#[derive(Debug, Clone)]
pub struct Engine {
    pub rnx2rtkp: Option<PathBuf>,
    pub convbin: Option<PathBuf>,
    /// What the interface shows as the engine version.
    pub version: String,
    /// `bundle`, `installed` or `path`, for the installer card and the docs.
    pub source: &'static str,
}

impl Engine {
    pub fn found(&self) -> bool {
        self.rnx2rtkp.is_some()
    }
}

/// Look for the tools, closest first: the build shipped inside this app, then
/// an install the recovery path placed in the data folder, then whatever is on
/// `PATH`, then the folders the web build searched.
pub fn discover(data: &Path, bundle: Option<&Path>) -> Engine {
    let directories = preflight::candidate_dirs(data, bundle);
    let rnx2rtkp = preflight::find_path("rnx2rtkp", &directories);
    let convbin = preflight::find_path("convbin", &directories);
    let source = match &rnx2rtkp {
        None => "none",
        Some(path) => {
            if let Some(bundle) = bundle {
                if path.starts_with(bundle_bin(bundle)) {
                    "bundle"
                } else if path.starts_with(install_bin(data)) {
                    "installed"
                } else {
                    "path"
                }
            } else if path.starts_with(install_bin(data)) {
                "installed"
            } else {
                "path"
            }
        }
    };
    let version = match source {
        "bundle" => bundle_version(bundle),
        "installed" => {
            let recorded = preflight::installed_release(data);
            if recorded.is_empty() {
                probed_version(rnx2rtkp.as_deref())
            } else {
                recorded
            }
        }
        _ => probed_version(rnx2rtkp.as_deref()),
    };
    Engine {
        rnx2rtkp,
        convbin,
        version,
        source,
    }
}

/// The version `scripts/bundle-rtklib.sh` recorded beside the binaries.
pub fn bundle_version(bundle: Option<&Path>) -> String {
    let Some(bundle) = bundle else {
        return String::new();
    };
    let Ok(text) = std::fs::read_to_string(bundle.join("BUNDLED.json")) else {
        return String::new();
    };
    serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|value| value.get("version").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_default()
}

fn probed_version(path: Option<&Path>) -> String {
    path.map(|path| {
        preflight::probe(path)
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    })
    .unwrap_or_default()
}

/// A private folder that removes itself. `tempfile` was not a dependency and
/// the web build only needed the one behaviour.
pub struct WorkDir {
    path: PathBuf,
}

impl WorkDir {
    pub fn new(prefix: &str) -> Result<Self, Failure> {
        Self::new_in(&std::env::temp_dir(), prefix)
    }

    /// A work folder inside `parent`, which is what the installer needs so its
    /// final move is a rename on one volume.
    pub fn new_in(parent: &Path, prefix: &str) -> Result<Self, Failure> {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        let path = parent.join(format!(
            "{prefix}{}-{stamp}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).map_err(|error| {
            Failure::new(500, format!("The local work folder could not be made: {error}"))
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700));
        }
        Ok(Self { path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for WorkDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// What a child process did before the clock ran out.
pub struct Ran {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    /// Set when the process could not start at all.
    pub start_error: Option<String>,
}

impl Ran {
    /// What the web build read as "the error": stderr, or stdout when stderr
    /// is quiet.
    fn output(&self) -> &str {
        if self.stderr.trim().is_empty() {
            &self.stdout
        } else {
            &self.stderr
        }
    }

    /// The last `lines` non-empty lines of whichever stream spoke.
    pub fn tail(&self, lines: usize) -> String {
        tail_of(self.output(), lines)
    }

    /// The last `lines` of stderr, or of stdout when stderr said nothing, for
    /// the `warnings` line a finished correction carries.
    pub fn stderr_tail(&self, lines: usize) -> String {
        tail_of(&self.output(), lines)
    }
}

fn tail_of(text: &str, lines: usize) -> String {
    let clean = text.replace('\r', "\n");
    let rows: Vec<&str> = clean
        .lines()
        .map(str::trim)
        .filter(|row| !row.is_empty())
        .collect();
    rows[rows.len().saturating_sub(lines)..].join("\n")
}

/// Run a command with a deadline, keeping its output.
pub fn run(command: &mut Command, timeout: Duration) -> Ran {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return Ran {
                success: false,
                stdout: String::new(),
                stderr: String::new(),
                timed_out: false,
                start_error: Some(error.to_string()),
            }
        }
    };
    // Read both pipes on their own threads, because a child that fills a pipe
    // would block before it could be waited on.
    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let out_reader = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        if let Some(pipe) = stdout_pipe.as_mut() {
            let _ = pipe.read_to_end(&mut buffer);
        }
        buffer
    });
    let err_reader = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        if let Some(pipe) = stderr_pipe.as_mut() {
            let _ = pipe.read_to_end(&mut buffer);
        }
        buffer
    });

    let started = Instant::now();
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if started.elapsed() >= timeout {
                    let _ = child.kill();
                    timed_out = true;
                    break child.wait().ok();
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => break None,
        }
    };
    let stdout = out_reader.join().unwrap_or_default();
    let stderr = err_reader.join().unwrap_or_default();
    Ran {
        success: status.map(|status| status.success()).unwrap_or(false),
        stdout: String::from_utf8_lossy(&stdout).to_string(),
        stderr: String::from_utf8_lossy(&stderr).to_string(),
        timed_out,
        start_error: None,
    }
}

/// Read a text file the way Python's `read_text` did: lossy UTF-8, and line
/// endings normalised to `\n`, so a `.pos` or `.obs` this build hands back is
/// the same string the web build handed back.
pub fn read_text(path: &Path) -> io::Result<String> {
    let bytes = std::fs::read(path)?;
    Ok(String::from_utf8_lossy(&bytes).replace("\r\n", "\n"))
}

/// The bridge sends a body it could not make a file from as base64, because a
/// 40 MB array of numbers would travel as a 160 MB string.
pub fn decode(encoded: &str) -> Result<Vec<u8>, Failure> {
    use base64::Engine as _;
    if encoded.len() > crate::convert::MAX_INPUT / 3 * 4 + 8 {
        return Err(Failure::new(
            413,
            format!(
                "The file is larger than {} MB.",
                crate::convert::MAX_INPUT / (1024 * 1024)
            ),
        ));
    }
    base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| Failure::bad("The file did not arrive completely."))
}
