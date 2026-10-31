//! Run an RTKLIB correction with the bundled `rnx2rtkp`.
//!
//! A port of `app/rtklib_run.py`. The browser sends the job it already checked;
//! this writes those exact bytes to a private folder, runs `rnx2rtkp` with a
//! fixed argument list, reads the resulting `.pos`, and deletes the folder. No
//! project file, observation or result is persisted.
//!
//! The payload is never treated as a path or a shell argument: the file names
//! are this module's own, and a configuration that names a `file` or `path` is
//! refused, because RTKLIB would read that path from the operator's computer.

use crate::rtklib::{self, WorkDir};
use crate::Failure;
use serde_json::{json, Value};
use std::path::Path;
use std::time::{Duration, Instant};

const MAX_PAYLOAD: usize = 48 * 1024 * 1024;
const MAX_FILE: usize = 20 * 1024 * 1024;
const MAX_CONFIG: usize = 64 * 1024;
const MAX_OUTPUT: usize = 25 * 1024 * 1024;
const MAX_NAV: usize = 8;
const RUN_TIMEOUT: Duration = Duration::from_secs(300);

/// One attached text file, as the browser sends it.
fn text_file(value: Option<&Value>, label: &str) -> Result<String, Failure> {
    let Some(value) = value.filter(|value| value.is_object()) else {
        return Err(Failure::bad(format!("The {label} file is missing.")));
    };
    let text = value.get("text").and_then(Value::as_str).unwrap_or("");
    if text.trim().is_empty() {
        return Err(Failure::bad(format!("The {label} file is empty.")));
    }
    if text.len() > MAX_FILE {
        return Err(Failure::bad(format!("The {label} file is larger than 20 MB.")));
    }
    if text.contains('\0') {
        return Err(Failure::bad(format!("The {label} file is not text.")));
    }
    Ok(text.to_string())
}

fn write(path: &Path, text: &str) -> Result<usize, Failure> {
    std::fs::write(path, text.as_bytes())
        .map_err(|error| Failure::new(500, format!("The local correction failed: {error}")))?;
    Ok(text.len())
}

/// Run one correction and return the `.pos` text.
pub fn run(data_root: &Path, bundle: Option<&Path>, payload: &Value) -> Result<Value, Failure> {
    if !payload.is_object() {
        return Err(Failure::bad("The correction request was not readable."));
    }

    let rover = text_file(payload.get("rover"), "rover")?;
    let base = text_file(payload.get("base"), "base")?;
    let nav_value = payload.get("nav").cloned().unwrap_or_else(|| json!([]));
    let Some(nav) = nav_value.as_array().cloned() else {
        return Err(Failure::bad("Attach no more than eight navigation files."));
    };
    if nav.len() > MAX_NAV {
        return Err(Failure::bad("Attach no more than eight navigation files."));
    }
    let mut nav_texts = Vec::new();
    for (index, item) in nav.iter().enumerate() {
        nav_texts.push(text_file(Some(item), &format!("navigation file {}", index + 1))?);
    }
    let sp3 = match payload.get("sp3").filter(|value| !value.is_null()) {
        Some(item) => Some(text_file(Some(item), "SP3")?),
        None => None,
    };

    let config = payload.get("config").and_then(Value::as_str).unwrap_or("");
    if config.trim().is_empty() {
        return Err(Failure::bad("The RTKLIB configuration is missing."));
    }
    if config.len() > MAX_CONFIG {
        return Err(Failure::bad(
            "The RTKLIB configuration is larger than 64 KB.",
        ));
    }
    if config.contains('\0') {
        return Err(Failure::bad("The RTKLIB configuration is not text."));
    }
    let file_setting = regex::Regex::new(r"(?im)^\s*[^#\r\n]*(?:file|path)\s*=")
        .expect("a fixed pattern");
    if file_setting.is_match(config) {
        return Err(Failure::bad(
            "The RTKLIB configuration contains an unsupported file setting.",
        ));
    }

    let total = rover.len()
        + base.len()
        + nav_texts.iter().map(String::len).sum::<usize>()
        + sp3.as_ref().map(String::len).unwrap_or(0);
    if total > MAX_PAYLOAD {
        return Err(Failure::bad("The correction files are larger than 48 MB."));
    }

    let engine = rtklib::discover(data_root, bundle);
    let Some(engine_path) = engine.rnx2rtkp.clone() else {
        return Err(Failure::new(
            409,
            "RTKLIB is not installed on this computer. Run the readiness check \
             and install RTKLIB, or download the job package and run it yourself.",
        ));
    };
    if !engine_path.is_file() {
        return Err(Failure::new(
            409,
            "The RTKLIB correction engine could not be found.",
        ));
    }

    let started = Instant::now();
    let work = WorkDir::new("northstar-rtk-")?;
    let temp = work.path();
    write(&temp.join("rover.obs"), &rover)?;
    write(&temp.join("base.obs"), &base)?;
    let mut nav_names = Vec::new();
    for (index, text) in nav_texts.iter().enumerate() {
        let name = format!("nav_{}.nav", index + 1);
        write(&temp.join(&name), text)?;
        nav_names.push(name);
    }
    let has_sp3 = sp3.is_some();
    if let Some(text) = &sp3 {
        write(&temp.join("orbit.sp3"), text)?;
    }
    write(&temp.join("northstar_job.conf"), config)?;

    let mut command = std::process::Command::new(&engine_path);
    command
        .current_dir(temp)
        .arg("-k")
        .arg("northstar_job.conf")
        .arg("rover.obs")
        .arg("base.obs");
    for name in &nav_names {
        command.arg(name);
    }
    if has_sp3 {
        command.arg("orbit.sp3");
    }
    command.arg("-o").arg("result.pos");
    let ran = rtklib::run(&mut command, RUN_TIMEOUT);
    if let Some(error) = ran.start_error.clone() {
        return Err(Failure::new(
            500,
            format!("The RTKLIB engine could not start: {error}"),
        ));
    }
    if ran.timed_out {
        return Err(Failure::new(
            504,
            format!(
                "The correction took longer than {} seconds and was stopped. \
                 Try a shorter session or a smaller kinematic file.",
                RUN_TIMEOUT.as_secs()
            ),
        ));
    }

    let result_path = temp.join("result.pos");
    let mut output = String::new();
    if result_path.is_file() {
        let size = std::fs::metadata(&result_path)
            .map(|meta| meta.len())
            .unwrap_or(0) as usize;
        if size > MAX_OUTPUT {
            return Err(Failure::new(
                413,
                "The correction result was larger than 25 MB.",
            ));
        }
        output = rtklib::read_text(&result_path).unwrap_or_default();
    }
    if !ran.success {
        let tail = ran.tail(12);
        return Err(Failure::new(
            422,
            format!(
                "RTKLIB could not finish the correction.{}",
                if tail.is_empty() {
                    String::new()
                } else {
                    format!("\n{tail}")
                }
            ),
        ));
    }
    if output.trim().is_empty() {
        return Err(Failure::new(
            422,
            "RTKLIB finished but did not create a .pos result.",
        ));
    }

    let elapsed = started.elapsed().as_millis() as u64;
    let command_line = format!(
        "rnx2rtkp -k northstar_job.conf rover.obs base.obs{}{} -o result.pos",
        if nav_names.is_empty() {
            String::new()
        } else {
            format!(" {}", nav_names.join(" "))
        },
        if has_sp3 { " orbit.sp3" } else { "" }
    );
    Ok(json!({
        "ok": true,
        "pos": output,
        "fileName": "northstar.pos",
        "elapsedMs": elapsed,
        "engine": {
            "path": engine_path.display().to_string(),
            "version": if engine.version.is_empty() {
                rtklib::VERSION.to_string()
            } else {
                engine.version.clone()
            },
        },
        "command": command_line,
        "warnings": ran.stderr_tail(8),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(rover: &str, base: &str) -> Value {
        json!({
            "confirm": true,
            "rover": { "name": "rover.obs", "text": rover },
            "base": { "name": "base.obs", "text": base },
            "nav": [],
            "sp3": null,
            "config": "pos1-posmode = static\n",
        })
    }

    #[test]
    fn a_missing_rover_is_named_in_the_sentence_the_interface_shows() {
        let failure = run(Path::new("/nonexistent"), None, &json!({ "base": { "text": "x" } }))
            .unwrap_err();
        assert_eq!(failure.message, "The rover file is missing.");
        assert_eq!(failure.status, 400);
    }

    #[test]
    fn an_empty_base_is_refused() {
        let failure = run(
            Path::new("/nonexistent"),
            None,
            &job("some rover text", "   "),
        )
        .unwrap_err();
        assert_eq!(failure.message, "The base file is empty.");
    }

    #[test]
    fn a_configuration_that_names_a_file_is_refused() {
        let mut payload = job("rover", "base");
        payload["config"] = json!("pos1-posmode = static\nfile = /etc/passwd\n");
        let failure = run(Path::new("/nonexistent"), None, &payload).unwrap_err();
        assert_eq!(
            failure.message,
            "The RTKLIB configuration contains an unsupported file setting."
        );
        payload["config"] = json!("  path =C:\\\\Windows\\\\win.ini\n");
        let failure = run(Path::new("/nonexistent"), None, &payload).unwrap_err();
        assert_eq!(
            failure.message,
            "The RTKLIB configuration contains an unsupported file setting."
        );
    }

    #[test]
    fn a_file_line_the_operator_commented_out_is_not_a_setting() {
        let mut payload = job("rover", "base");
        payload["config"] = json!("# inpfile-rover = /etc/passwd\npos1-posmode = static\n");
        // Refused only because no engine is installed, not because of the
        // comment: the same request with the line uncommented stops earlier.
        let failure = run(Path::new("/nonexistent"), None, &payload).unwrap_err();
        assert_eq!(failure.status, 409);
    }

    #[test]
    fn a_missing_configuration_is_refused() {
        let mut payload = job("rover", "base");
        payload["config"] = json!("");
        let failure = run(Path::new("/nonexistent"), None, &payload).unwrap_err();
        assert_eq!(failure.message, "The RTKLIB configuration is missing.");
    }

    #[test]
    fn more_than_eight_navigation_files_are_refused() {
        let mut payload = job("rover", "base");
        payload["nav"] = json!(vec![json!({ "text": "nav" }); 9]);
        let failure = run(Path::new("/nonexistent"), None, &payload).unwrap_err();
        assert_eq!(
            failure.message,
            "Attach no more than eight navigation files."
        );
    }

    #[test]
    fn an_engine_that_is_not_there_is_reported_as_409() {
        let failure = run(Path::new("/nonexistent"), None, &job("rover", "base")).unwrap_err();
        assert_eq!(failure.status, 409);
        assert!(failure.message.starts_with("RTKLIB is not installed"));
    }

    /// The other half of the batch's check, on a real job: the bundled engine
    /// runs a rover against a NOAA base station and writes a `.pos`.
    ///
    ///     NORTHSTAR_ROVER=rover.obs NORTHSTAR_BASE=base.obs \
    ///       NORTHSTAR_NAV=base.nav NORTHSTAR_SP3=orbit.sp3 \
    ///       cargo test --lib -- --ignored the_bundled_engine
    ///
    /// The configuration is the option set the interface builds, trimmed to the
    /// lines the engine reads for a static solution.
    #[test]
    #[ignore]
    fn the_bundled_engine_corrects_a_real_job_to_a_pos() {
        let (Ok(rover), Ok(base), Ok(nav)) = (
            std::env::var("NORTHSTAR_ROVER"),
            std::env::var("NORTHSTAR_BASE"),
            std::env::var("NORTHSTAR_NAV"),
        ) else {
            eprintln!("set NORTHSTAR_ROVER, NORTHSTAR_BASE and NORTHSTAR_NAV to run this");
            return;
        };
        let sp3 = std::env::var("NORTHSTAR_SP3").ok();
        let read = |path: &str| std::fs::read_to_string(path).expect("the fixture reads");
        let bundle = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("rtklib")
            .join(if cfg!(target_os = "windows") { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "linux" });
        if !rtklib::bundle_bin(&bundle).is_dir() {
            eprintln!("no bundled RTKLIB for this platform; nothing to run");
            return;
        }

        // A receiver that records L1 only, like a GeoXT, cannot run the
        // dual-frequency default: the interface warns about that and asks for
        // L1 only, so the same choice is made here through the environment
        // rather than by editing the test.
        let single_frequency = std::env::var("NORTHSTAR_FREQUENCY")
            .map(|value| value == "l1")
            .unwrap_or(false);
        let (frequency, iono) = if single_frequency {
            ("1", "brdc")
        } else {
            ("l2", "dual-freq")
        };

        // The option lines are formatted the way `rtkOption` in postprocess.js
        // formats them: RTKLIB does not trim the space after `=`, so the name is
        // padded and the value follows the sign directly.
        let config: String = [
            ("pos1-posmode", "static"),
            ("pos1-frequency", frequency),
            ("pos1-soltype", "forward"),
            ("pos1-elmask", "15"),
            ("pos1-snrmask_r", "off"),
            ("pos1-snrmask_b", "off"),
            ("pos1-ionoopt", iono),
            ("pos1-tropopt", "saas"),
            ("pos1-sateph", "brdc"),
            ("pos1-navsys", "5"),
            ("pos2-armode", "continuous"),
            ("pos2-gloarmode", "on"),
            ("pos2-arthres", "3"),
            ("ant1-postype", "rinexhead"),
            ("ant2-postype", "rinexhead"),
        ]
        .iter()
        .map(|(name, value)| format!("{name:<19}={value}"))
        .collect::<Vec<_>>()
        .join("\n");
        let payload = json!({
            "confirm": true,
            "rover": { "name": "rover.obs", "text": read(&rover) },
            "base": { "name": "base.obs", "text": read(&base) },
            "nav": [{ "name": "base.nav", "text": read(&nav) }],
            "sp3": sp3.map(|path| json!({ "name": "orbit.sp3", "text": read(&path) })),
            "config": config,
        });
        let result = run(Path::new("/nonexistent"), Some(&bundle), &payload)
            .expect("the bundled engine finishes the correction");

        let pos = result["pos"].as_str().unwrap();
        assert!(pos.starts_with("% program"), "{pos:.200}");
        let rows: Vec<&str> = pos
            .lines()
            .filter(|line| !line.starts_with('%'))
            .filter(|line| !line.trim().is_empty())
            .collect();
        // The solution quality column: 1 fixed, 2 float, 4 DGPS, 5 single.
        let quality: Vec<&str> = rows
            .iter()
            .filter_map(|row| row.split_whitespace().nth(5))
            .collect();
        let fixed = quality.iter().filter(|value| **value == "1").count();
        eprintln!(
            "{} epochs, {} fixed, {} ms, warnings: {:?}",
            rows.len(),
            fixed,
            result["elapsedMs"],
            result["warnings"]
        );
        assert!(!rows.is_empty(), "the job produced no position rows");
        assert!(
            quality.iter().all(|value| matches!(*value, "1" | "2" | "4" | "5" | "6")),
            "a row has an unreadable quality column: {quality:?}"
        );
        assert_eq!(result["fileName"], json!("northstar.pos"));
        // For the parity check against the web build's Python engine: write the
        // result where the caller asked for it.
        if let Ok(path) = std::env::var("NORTHSTAR_POS_OUT") {
            std::fs::write(path, pos).expect("the result writes");
        }
    }
}
