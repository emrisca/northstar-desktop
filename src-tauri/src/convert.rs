//! Convert a receiver's raw log to RINEX with the bundled `convbin`.
//!
//! A port of `app/rtklib_convert.py`. The browser sends the exact bytes of one
//! local field log; this writes them to a private folder, runs `convbin` with a
//! fixed argument list, reads the RINEX observation and navigation files it
//! produced, and deletes the folder. Nothing is persisted, and no caller
//! supplied path, option or URL reaches the command line.
//!
//! `convbin` reads the raw formats in [`FORMATS`]. Closed formats such as SSF
//! are refused before the engine runs; this module never guesses at bytes
//! outside that published list.

use crate::rtklib::{self, Ran, WorkDir};
use crate::Failure;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub const MAX_INPUT: usize = 48 * 1024 * 1024;
pub const MAX_OUTPUT: usize = 64 * 1024 * 1024;
const RUN_TIMEOUT: Duration = Duration::from_secs(180);
const RINEX_VERSION: &str = "3.03";

/// The input formats RTKLIB convbin documents. Labels stay receiver-neutral in
/// the browser; the engine's own help names the vendors.
const FORMATS: &[(&str, &str, &str)] = &[
    ("rtcm2", "RTCM 2 raw", ".rtcm2"),
    ("rtcm3", "RTCM 3 raw", ".rtcm3"),
    ("nov", "OEM4/6/7 raw", ".gps"),
    ("oem3", "OEM3 raw", ".oem3"),
    ("ubx", "UBX raw", ".ubx"),
    ("ss2", "SS2 raw", ".log"),
    ("hemis", "BIN raw", ".bin"),
    ("stq", "STQ raw", ".stq"),
    ("javad", "GREIS raw", ".jps"),
    ("nvs", "BINR raw", ".nvs"),
    ("binex", "BINEX raw", ".bnx"),
    ("rt17", "RT17 raw", ".rt17"),
    ("sbf", "SBF raw", ".sbf"),
];

const EXTENSIONS: &[(&str, &str)] = &[
    (".rtcm2", "rtcm2"),
    (".rtcm3", "rtcm3"),
    (".gps", "nov"),
    (".oem4", "nov"),
    (".oem6", "nov"),
    (".oem7", "nov"),
    (".oem3", "oem3"),
    (".ubx", "ubx"),
    (".log", "ss2"),
    (".ss2", "ss2"),
    (".stq", "stq"),
    (".jps", "javad"),
    (".nvs", "nvs"),
    (".bnx", "binex"),
    (".binex", "binex"),
    (".rt17", "rt17"),
    (".sbf", "sbf"),
];

/// Formats that look like receiver logs but have no published decoder.
const CLOSED_FORMATS: &[(&str, &str)] = &[(".ssf", "SSF")];

const OUTPUT_SUFFIXES: &[&str] = &[
    ".obs", ".nav", ".gnav", ".hnav", ".qnav", ".lnav", ".cnav", ".inav", ".sbs",
];

fn format_of(name: &str) -> Option<(&'static str, &'static str, &'static str)> {
    FORMATS
        .iter()
        .find(|(key, _, _)| *key == name)
        .map(|(key, label, extension)| (*key, *label, *extension))
}

/// The last extension of a name, lowercased, without separators after the dot.
pub fn extension(name: &str) -> String {
    let Some(index) = name.rfind('.') else {
        return String::new();
    };
    let rest = &name[index + 1..];
    if rest.is_empty() || rest.contains('.') || rest.contains('/') || rest.contains('\\') {
        return String::new();
    }
    name[index..].to_lowercase()
}

/// A short, safe output stem from the caller's file name.
fn safe_stem(name: &str) -> String {
    let mut value = name.replace('\\', "/");
    if let Some(index) = value.rfind('/') {
        value = value[index + 1..].to_string();
    }
    if value.to_lowercase().ends_with(".gz") {
        value.truncate(value.len() - 3);
    }
    if let Some((head, _)) = value.rsplit_once('.') {
        value = head.to_string();
    }
    let cleaned: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || "._-".contains(character) {
                character
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches(|character| character == '.' || character == '_');
    if trimmed.is_empty() {
        "receiver".to_string()
    } else {
        trimmed.chars().take(80).collect()
    }
}

/// Identify only signatures that are unambiguous across convbin's formats.
fn signature_format(data: &[u8]) -> &'static str {
    if data.starts_with(b"\xb5\x62") {
        "ubx"
    } else if data.starts_with(b"$@") {
        "sbf"
    } else if data.starts_with(b"\xd3") {
        "rtcm3"
    } else if data.starts_with(b"\xe2") {
        "binex"
    } else if data.starts_with(b"\xaa\x44\x12") {
        "nov"
    } else if data.starts_with(b"\xaa\x44\x11") {
        "oem3"
    } else {
        ""
    }
}

/// Resolve a caller format, or identify a supported one without guessing.
fn detect_format(name: &str, data: &[u8], requested: &str) -> Result<&'static str, Failure> {
    let ext = extension(name);
    if let Some((_, label)) = CLOSED_FORMATS.iter().find(|(suffix, _)| *suffix == ext) {
        return Err(Failure::new(
            415,
            format!(
                "{label} is a closed receiver format that RTKLIB convbin cannot read. \
                 Export RINEX with the receiver's office software, then drop the \
                 observation file here."
            ),
        ));
    }
    if !requested.is_empty() {
        if let Some((key, _, _)) = format_of(requested) {
            return Ok(key);
        }
        return Err(Failure::bad(
            "Choose a raw format supported by RTKLIB convbin.",
        ));
    }
    let detected = signature_format(data);
    if !detected.is_empty() {
        return Ok(detected);
    }
    if let Some((_, key)) = EXTENSIONS.iter().find(|(suffix, _)| *suffix == ext) {
        return Ok(key);
    }
    Err(Failure::bad(
        "The raw format could not be identified from this file. Choose the \
         receiver format in the Convert card and try again.",
    ))
}

fn write_file(path: &Path, bytes: &[u8]) -> Result<(), Failure> {
    std::fs::write(path, bytes)
        .map_err(|error| Failure::new(500, format!("The local conversion failed: {error}")))
}

/// Convert one binary log and return its RINEX observation and navigation.
pub fn convert(
    data_root: &Path,
    bundle: Option<&Path>,
    name: &str,
    bytes: &[u8],
    requested: &str,
    modified: Option<f64>,
) -> Result<Value, Failure> {
    if bytes.is_empty() {
        return Err(Failure::bad("The file is empty."));
    }
    if bytes.len() > MAX_INPUT {
        return Err(Failure::new(
            413,
            format!(
                "The file is larger than {} MB. Shorten the session or use the \
                 receiver's own RINEX export.",
                MAX_INPUT / (1024 * 1024)
            ),
        ));
    }

    let format = detect_format(name, bytes, requested.trim().to_lowercase().as_str())?;
    let (format_key, format_label, format_extension) = format_of(format).expect("a known format");
    let engine = rtklib::discover(data_root, bundle);
    let Some(convbin) = engine.convbin.clone() else {
        return Err(Failure::new(
            409,
            "RTKLIB convbin is not installed on this computer. Run the \
             post-processing readiness check and install RTKLIB, or use the \
             receiver's own RINEX export.",
        ));
    };
    if !convbin.is_file() {
        return Err(Failure::new(
            409,
            "The RTKLIB convbin engine could not be found.",
        ));
    }

    let stem = safe_stem(name);
    let input_name = format!("input{format_extension}");
    let started = Instant::now();
    let work = WorkDir::new("northstar-convbin-")?;
    let temp = work.path();
    let input_path = temp.join(&input_name);
    write_file(&input_path, bytes)?;
    if let Some(seconds) = modified.filter(|value| *value > 0.0) {
        // convbin uses the log's modified time when a format such as RTCM has
        // no time tag; keep the browser's timestamp instead of the temporary
        // file's.
        if let Some(stamp) = std::time::UNIX_EPOCH.checked_add(
            Duration::from_secs_f64(seconds),
        ) {
            if let Ok(file) = std::fs::File::options().write(true).open(&input_path) {
                let _ = file.set_times(std::fs::FileTimes::new().set_modified(stamp));
            }
        }
    }

    let mut command = std::process::Command::new(&convbin);
    command
        .current_dir(temp)
        .arg("-r")
        .arg(format_key)
        .arg("-v")
        .arg(RINEX_VERSION)
        .arg(&input_name);
    let ran: Ran = rtklib::run(&mut command, RUN_TIMEOUT);
    if let Some(error) = ran.start_error.clone() {
        return Err(Failure::new(
            500,
            format!("The RTKLIB converter could not start: {error}"),
        ));
    }
    if ran.timed_out {
        return Err(Failure::new(
            504,
            format!(
                "The conversion took longer than {} seconds and was stopped. \
                 Try a shorter session.",
                RUN_TIMEOUT.as_secs()
            ),
        ));
    }
    if !ran.success {
        let detail = ran.tail(8);
        return Err(Failure::new(
            422,
            format!(
                "RTKLIB convbin could not convert this file.{}",
                if detail.is_empty() {
                    String::new()
                } else {
                    format!("\n{detail}")
                }
            ),
        ));
    }

    let mut outputs: Vec<(String, String)> = Vec::new();
    let mut total = 0usize;
    for suffix in OUTPUT_SUFFIXES {
        let path: PathBuf = temp.join(format!("input{suffix}"));
        if !path.is_file() {
            continue;
        }
        let size = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0) as usize;
        if size > MAX_OUTPUT {
            return Err(Failure::new(
                413,
                "The converted RINEX data is larger than 64 MB. Shorten the \
                 session and try again.",
            ));
        }
        total += size;
        if total > MAX_OUTPUT {
            return Err(Failure::new(
                413,
                "The converted RINEX data is larger than 64 MB. Shorten the \
                 session and try again.",
            ));
        }
        outputs.push((
            suffix.to_string(),
            rtklib::read_text(&path).unwrap_or_default(),
        ));
    }

    let observation = outputs
        .iter()
        .find(|(suffix, _)| suffix == ".obs")
        .map(|(_, text)| text.clone())
        .unwrap_or_default();
    if observation.trim().is_empty() {
        let detail = ran.tail(8);
        return Err(Failure::new(
            422,
            format!(
                "RTKLIB convbin finished but produced no RINEX observation file. \
                 The log may use a closed format, or it may contain no usable \
                 survey epochs.{}",
                if detail.is_empty() {
                    String::new()
                } else {
                    format!("\n{detail}")
                }
            ),
        ));
    }

    let elapsed = started.elapsed().as_millis() as u64;
    let nav: Vec<Value> = [".nav", ".gnav", ".hnav", ".qnav", ".lnav", ".cnav", ".inav"]
        .iter()
        .filter_map(|suffix| {
            outputs
                .iter()
                .find(|(found, text)| found == suffix && !text.trim().is_empty())
                .map(|(_, text)| json!({ "name": format!("{stem}{suffix}"), "text": text }))
        })
        .collect();

    Ok(json!({
        "ok": true,
        "obs": { "name": format!("{stem}.obs"), "text": observation },
        "nav": nav,
        "format": format_key,
        "formatLabel": format_label,
        "rinexVersion": RINEX_VERSION,
        "elapsedMs": elapsed,
        "inputBytes": bytes.len(),
        "command": format!("convbin -r {format_key} -v {RINEX_VERSION} {input_name}"),
        "engine": {
            "path": convbin.display().to_string(),
            "version": if engine.version.is_empty() {
                rtklib::VERSION.to_string()
            } else {
                engine.version.clone()
            },
        },
        "warnings": "",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_signature_names_the_format_before_the_extension_does() {
        assert_eq!(signature_format(b"\xb5\x62\x01"), "ubx");
        assert_eq!(signature_format(b"$@"), "sbf");
        assert_eq!(signature_format(b"\xd3"), "rtcm3");
        assert_eq!(signature_format(b"\xe2"), "binex");
        assert_eq!(signature_format(b"\xaa\x44\x12"), "nov");
        assert_eq!(signature_format(b"\xaa\x44\x11"), "oem3");
        assert_eq!(signature_format(b"abc"), "");
    }

    #[test]
    fn the_extension_rule_ignores_dots_that_are_not_an_extension() {
        assert_eq!(extension("survey.UBX"), ".ubx");
        assert_eq!(extension("logs/run.2026-10-25.ubx"), ".ubx");
        assert_eq!(extension("no-extension"), "");
        assert_eq!(extension("trailing."), "");
        assert_eq!(extension("a.b/c"), "");
    }

    #[test]
    fn a_raw_log_is_identified_by_signature_then_by_name() {
        assert_eq!(detect_format("log.bin", b"\xb5\x62\x01", "").unwrap(), "ubx");
        let found = detect_format("rover.oem7", b"plain", "").unwrap();
        assert_eq!(found, "nov");
        assert!(detect_format("rover.dat", b"plain", "").is_err());
    }

    #[test]
    fn a_closed_format_is_refused_with_its_own_sentence() {
        let failure = detect_format("session.ssf", b"plain", "").unwrap_err();
        assert_eq!(failure.status, 415);
        assert!(failure.message.starts_with("SSF is a closed receiver format"));
    }

    #[test]
    fn an_unknown_requested_format_is_a_bad_request() {
        let failure = detect_format("log.ubx", b"\xb5\x62", "sbfx").unwrap_err();
        assert_eq!(failure.status, 400);
        assert_eq!(
            failure.message,
            "Choose a raw format supported by RTKLIB convbin."
        );
    }

    #[test]
    fn the_output_stem_is_short_and_has_no_path() {
        assert_eq!(safe_stem("KINGS.obs"), "KINGS");
        assert_eq!(safe_stem("/tmp/a b/run 01.ubx.gz"), "run_01");
        assert_eq!(safe_stem("..."), "receiver");
        assert_eq!(safe_stem(""), "receiver");
        assert!(safe_stem(&"x".repeat(200)).len() <= 80);
    }

    #[test]
    fn an_empty_file_is_refused_before_the_engine_is_looked_for() {
        let failure = convert(Path::new("/nonexistent"), None, "a.ubx", b"", "", None).unwrap_err();
        assert_eq!(failure.message, "The file is empty.");
    }

    /// A UBX-RXM-RAW frame, which is what `convbin -r ubx` reads for a
    /// u-blox LEA-4T/5T/6T.
    fn ubx_frame(class: u8, id: u8, payload: &[u8]) -> Vec<u8> {
        let mut body = vec![class, id];
        body.extend_from_slice(&(payload.len() as u16).to_le_bytes());
        body.extend_from_slice(payload);
        let (mut a, mut b) = (0u8, 0u8);
        for byte in &body {
            a = a.wrapping_add(*byte);
            b = b.wrapping_add(a);
        }
        let mut frame = vec![0xb5, 0x62];
        frame.extend_from_slice(&body);
        frame.extend_from_slice(&[a, b]);
        frame
    }

    /// A two-minute log written to the published RXM-RAW layout for the session
    /// the rest of the fixtures use: GPS week 2442, 25 October 2026 01:36:30.
    fn ubx_log() -> Vec<u8> {
        const WEEK: i16 = 2442;
        const TOW: f64 = 5790.0;
        let satellites = [1u8, 5, 12, 17, 20, 23, 28, 30];
        let mut out = Vec::new();
        for second in 0..120 {
            let mut payload = Vec::new();
            payload.extend_from_slice(&((TOW as u32) * 1000 + second * 1000).to_le_bytes());
            payload.extend_from_slice(&WEEK.to_le_bytes());
            payload.push(satellites.len() as u8);
            payload.push(0);
            for (index, sv) in satellites.iter().enumerate() {
                let range = 20_800_000.0 + index as f64 * 137_000.0 + second as f64 * 1.4;
                payload.extend_from_slice(&(range / 0.190_293_673).to_le_bytes());
                payload.extend_from_slice(&range.to_le_bytes());
                payload.extend_from_slice(&(-1.4f32).to_le_bytes());
                payload.push(*sv);
                payload.push(4);
                payload.push(42);
                payload.push(0);
            }
            out.extend_from_slice(&ubx_frame(0x02, 0x10, &payload));
        }
        out
    }

    #[test]
    fn the_generated_log_has_the_shape_convbin_expects() {
        let log = ubx_log();
        assert_eq!(&log[..2], b"\xb5\x62");
        assert_eq!(log[2], 0x02);
        assert_eq!(log[3], 0x10);
        let length = u16::from_le_bytes([log[4], log[5]]) as usize;
        assert_eq!(length, 8 + 8 * 24);
        assert_eq!(log.len(), 120 * (8 + length));
    }

    /// The check this batch turns on: the bundled engine really converts a raw
    /// log. It needs the platform's bundled `convbin`, so it is opt-in.
    #[test]
    #[ignore]
    fn the_bundled_engine_converts_a_ubx_log_to_rinex_3_03() {
        let bundle = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("rtklib")
            .join(if cfg!(target_os = "windows") { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "linux" });
        if !rtklib::bundle_bin(&bundle).is_dir() {
            eprintln!("no bundled RTKLIB for this platform; nothing to run");
            return;
        }
        // The generated log by default; a real one when a path is given, which
        // is how the parity check against the web build feeds both engines the
        // same bytes.
        let external = std::env::var("NORTHSTAR_UBX").ok();
        let log = match &external {
            Some(path) => std::fs::read(path).expect("the log reads"),
            None => ubx_log(),
        };
        let result = convert(
            Path::new("/nonexistent"),
            Some(&bundle),
            "HUD RANGERS.ubx",
            &log,
            "ubx",
            None,
        )
        .expect("the bundled engine converts the log");

        let obs = result["obs"]["text"].as_str().unwrap();
        assert!(obs.contains("RINEX VERSION / TYPE"), "{obs:.200}");
        assert!(obs.contains("3.03"));
        let epochs = obs.lines().filter(|line| line.starts_with("> ")).count();
        assert!(epochs >= 1, "no epochs in the converted observation");
        if external.is_none() {
            assert_eq!(epochs, 120, "one epoch per second in the generated log");
        }
        // The stem is sanitised the way the web build sanitised it.
        assert_eq!(result["obs"]["name"], json!("HUD_RANGERS.obs"));
        assert_eq!(result["format"], json!("ubx"));
        assert_eq!(result["rinexVersion"], json!("3.03"));
        assert_eq!(result["inputBytes"], json!(log.len()));
        assert!(result["engine"]["path"].as_str().unwrap().contains("rtklib"));
        assert!(result["nav"].as_array().unwrap().is_empty());
        // For the parity check against the web build's Python engine.
        if let Ok(path) = std::env::var("NORTHSTAR_OBS_OUT") {
            std::fs::write(path, obs).expect("the observation writes");
        }
        eprintln!("converted {} bytes in {} ms", result["inputBytes"], result["elapsedMs"]);
    }

    #[test]
    fn an_oversized_file_is_refused_with_413() {
        let failure = convert(
            Path::new("/nonexistent"),
            None,
            "a.ubx",
            &vec![0u8; MAX_INPUT + 1],
            "",
            None,
        )
        .unwrap_err();
        assert_eq!(failure.status, 413);
    }
}
