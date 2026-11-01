//! The project and settings files.
//!
//! Batch 2 moves the project out of the webview's `localStorage` and into files
//! the person can find, back up and hand to someone else. One project is one
//! `.northstar.json` file, written to a temporary name and renamed into place so
//! a killed process leaves the previous file whole.
//!
//! Two things are deliberately kept apart:
//!
//! - The project document keeps the shape the web build exports, so either
//!   build opens the other's file. `version` is added and the reader accepts a
//!   file without one, which is what makes a migration path possible later.
//! - The settings file holds whatever the interface keeps in `localStorage`
//!   (theme, units, dock sizes, calculator state). Rust stores the keys and
//!   stamps the version; it does not interpret them, so adding an interface
//!   setting needs no change here.

use serde::Serialize;
use serde_json::{json, Value};
use std::fmt;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process;
use std::time::{SystemTime, UNIX_EPOCH};

/// The marker the web build writes and reads.
pub const PROJECT_FORMAT: &str = "NorthStar Project";

/// The document version this build writes. A file without a version is 1.
pub const PROJECT_VERSION: u64 = 2;

/// The settings file version. Rising this is the migration hook.
pub const SETTINGS_VERSION: u64 = 1;

/// A project file's identity, for the recent list.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub name: String,
    pub path: String,
    pub modified: u64,
    pub bytes: u64,
}

/// What can go wrong while reading or writing a project.
#[derive(Debug)]
pub enum StoreError {
    Io(io::Error),
    /// The file is readable JSON but not a Northstar project.
    Format(String),
    /// An id or name that would leave the projects folder.
    Escape(String),
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::Io(error) => write!(f, "{error}"),
            StoreError::Format(why) => write!(f, "{why}"),
            StoreError::Escape(name) => write!(f, "\"{name}\" is not a usable project name"),
        }
    }
}

impl From<io::Error> for StoreError {
    fn from(error: io::Error) -> Self {
        StoreError::Io(error)
    }
}

pub type Result<T> = std::result::Result<T, StoreError>;

/// The app's data folder: projects beside a settings file.
pub struct Store {
    root: PathBuf,
}

impl Store {
    pub fn open(root: PathBuf) -> Result<Self> {
        let store = Store { root };
        fs::create_dir_all(store.projects_dir())?;
        Ok(store)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn projects_dir(&self) -> PathBuf {
        self.root.join("projects")
    }

    pub fn settings_path(&self) -> PathBuf {
        self.root.join("settings.json")
    }

    /// Every project file, newest first. A file that cannot be read as a
    /// project is skipped rather than failing the list, because one damaged
    /// file should not hide the rest.
    pub fn list(&self) -> Vec<Entry> {
        let mut entries: Vec<Entry> = fs::read_dir(self.projects_dir())
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|dir| self.entry_for(&dir.path()).ok())
            .collect();
        entries.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| a.name.cmp(&b.name)));
        entries
    }

    pub fn entry_for(&self, path: &Path) -> Result<Entry> {
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            return Err(StoreError::Format("not a project file".into()));
        }
        let text = fs::read_to_string(path)?;
        let document = parse_document(&text)?;
        let meta = fs::metadata(path)?;
        Ok(Entry {
            id: file_stem(path),
            name: project_name(&document),
            path: path.display().to_string(),
            modified: modified_millis(&meta),
            bytes: meta.len(),
        })
    }

    /// The path for an id, refusing anything that would leave the folder.
    pub fn project_path(&self, id: &str) -> Result<PathBuf> {
        if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
            return Err(StoreError::Escape(id.to_string()));
        }
        Ok(self.projects_dir().join(format!("{id}.northstar.json")))
    }

    pub fn read(&self, id: &str) -> Result<(PathBuf, String)> {
        let path = self.project_path(id)?;
        let text = fs::read_to_string(&path)?;
        parse_document(&text)?;
        Ok((path, text))
    }

    /// Read a project from anywhere on disk, which is what the drop handler and
    /// a second instance's launch argument need.
    pub fn read_any(&self, path: &Path) -> Result<String> {
        let text = fs::read_to_string(path)?;
        parse_document(&text)?;
        Ok(text)
    }

    /// Write a project into the projects folder under a name derived from its
    /// own workspace name. Saving the same project twice keeps one file.
    pub fn save(&self, existing: Option<&Path>, document: &Value) -> Result<Entry> {
        let document = migrate(document.clone())?;
        // A project opened from elsewhere keeps writing where it came from;
        // one that was never written chooses a name inside the folder.
        let path = match existing {
            Some(path) => path.to_path_buf(),
            None => self.path_for_name(&project_name(&document)),
        };
        write_atomic(&path, &serialize(&document))?;
        self.stamp_newest(&path);
        self.entry_for(&path)
    }

    pub fn save_as(&self, path: &Path, document: &Value) -> Result<Entry> {
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            return Err(StoreError::Format("a project file ends in .json".into()));
        }
        let document = migrate(document.clone())?;
        write_atomic(path, &serialize(&document))?;
        self.entry_for(path)
    }

    /// Two saves inside the same millisecond would tie in `list`, which then
    /// falls back to the project names and shows the older file first. Move this
    /// file one millisecond past the newest project when that happened, so the
    /// recent list keeps following the saves. Best effort on purpose: a stamp is
    /// a nicety and must not fail a save.
    fn stamp_newest(&self, path: &Path) {
        if path.parent() != Some(self.projects_dir().as_path()) {
            return;
        }
        let Ok(own) = fs::metadata(path).and_then(|meta| meta.modified()) else {
            return;
        };
        let newest = fs::read_dir(self.projects_dir())
            .into_iter()
            .flatten()
            .flatten()
            .filter(|entry| entry.path() != path)
            .filter_map(|entry| fs::metadata(entry.path()).ok()?.modified().ok())
            .max();
        let Some(newest) = newest else {
            return;
        };
        if newest < own {
            return;
        }
        let stamp = newest + std::time::Duration::from_millis(1);
        if let Ok(file) = fs::OpenOptions::new().write(true).open(path) {
            let _ = file.set_times(fs::FileTimes::new().set_modified(stamp));
        }
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        let path = self.project_path(id)?;
        fs::remove_file(path)?;
        Ok(())
    }

    /// A file name from the project's own name, with a number if that name is
    /// taken by a different project.
    pub fn path_for_name(&self, name: &str) -> PathBuf {
        let stem = slug(name);
        let mut path = self.projects_dir().join(format!("{stem}.northstar.json"));
        let mut n = 2;
        while path.exists() {
            let taken = fs::read_to_string(&path)
                .ok()
                .and_then(|text| parse_document(&text).ok())
                .map(|document| project_name(&document) == name)
                .unwrap_or(false);
            if taken {
                break;
            }
            path = self.projects_dir().join(format!("{stem}-{n}.northstar.json"));
            n += 1;
        }
        path
    }

    /// The settings file, or an empty document. A settings file that cannot be
    /// read is treated as absent: losing the interface's preferences is
    /// recoverable, refusing to open the app is not.
    pub fn settings(&self) -> Value {
        let text = fs::read_to_string(self.settings_path()).unwrap_or_default();
        let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        match value {
            Value::Object(mut map) if map.get("keys").map(Value::is_object).unwrap_or(false) => {
                map.entry("version").or_insert(json!(SETTINGS_VERSION));
                Value::Object(map)
            }
            _ => json!({ "version": SETTINGS_VERSION, "keys": {}, "lastProject": Value::Null }),
        }
    }

    pub fn save_settings(&self, document: &Value) -> Result<Value> {
        let Value::Object(mut map) = document.clone() else {
            return Err(StoreError::Format("settings must be an object".into()));
        };
        let Value::Object(keys) = map.remove("keys").unwrap_or_else(|| json!({})) else {
            return Err(StoreError::Format("settings keys must be an object".into()));
        };
        let last = map.get("lastProject").cloned().unwrap_or(Value::Null);
        let last = match last {
            Value::String(id) if !id.is_empty() => Value::String(id),
            _ => Value::Null,
        };
        let document = json!({
            "version": SETTINGS_VERSION,
            "lastProject": last,
            "keys": Value::Object(keys),
        });
        let mut bytes = serde_json::to_vec_pretty(&document)
            .map_err(|error| StoreError::Format(error.to_string()))?;
        bytes.push(b'\n');
        write_atomic(&self.settings_path(), &bytes)?;
        Ok(document)
    }
}

/// The project document a file holds, left as it was found.
pub fn parse_document(text: &str) -> Result<Value> {
    let value: Value =
        serde_json::from_str(text).map_err(|error| StoreError::Format(error.to_string()))?;
    let Value::Object(map) = &value else {
        return Err(StoreError::Format("a project file holds an object".into()));
    };
    let project = match map.get("project") {
        Some(Value::Object(project)) => project.clone(),
        Some(_) => return Err(StoreError::Format("project is not an object".into())),
        None => map.clone(),
    };
    Ok(Value::Object(project))
}

/// Bring a project document up to the version this build writes.
///
/// The web build wrote no version, so a file without one is version 1. The
/// step to 2 adds the version field and leaves every value alone: the port's
/// rule is that a stored project opens unchanged, and a migrated file has to
/// keep agreeing with the web build.
pub fn migrate(document: Value) -> Result<Value> {
    let Value::Object(mut project) = document else {
        return Err(StoreError::Format("a project is an object".into()));
    };
    let mut version = project
        .get("version")
        .and_then(Value::as_u64)
        .unwrap_or(1);
    if version > PROJECT_VERSION {
        return Err(StoreError::Format(format!(
            "this file is version {version}; this build reads up to {PROJECT_VERSION}"
        )));
    }
    while version < PROJECT_VERSION {
        match version {
            1 => {}
            other => {
                return Err(StoreError::Format(format!("no migration from version {other}")));
            }
        }
        version += 1;
    }
    project.insert("version".into(), json!(version));
    project.entry("points").or_insert(json!([]));
    Ok(Value::Object(project))
}

/// The document as it is written: the web build's envelope, plus the version.
fn serialize(project: &Value) -> Vec<u8> {
    let document = json!({
        "format": PROJECT_FORMAT,
        "version": PROJECT_VERSION,
        "project": project,
    });
    let mut bytes = serde_json::to_vec_pretty(&document).unwrap_or_else(|_| b"{}".to_vec());
    bytes.push(b'\n');
    bytes
}

fn project_name(project: &Value) -> String {
    project
        .get("workspaceName")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("Survey workspace")
        .to_string()
}

/// Write, then rename. The rename is the moment the file changes, so a process
/// that dies mid-write leaves the previous file exactly as it was and at most a
/// temporary file behind.
fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let directory = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(directory)?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let name = file_stem(path);
    let temporary = directory.join(format!(".{name}.{stamp}.{}.tmp", process::id()));
    let write = (|| -> io::Result<()> {
        let mut file = fs::File::create(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()
    })();
    if let Err(error) = write {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(())
}

fn file_stem(path: &Path) -> String {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("project");
    name.strip_suffix(".northstar.json")
        .or_else(|| name.strip_suffix(".json"))
        .unwrap_or(name)
        .to_string()
}

/// A file name from a project name: lower case, hyphens, nothing that needs
/// escaping in a path.
pub fn slug(name: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for character in name.chars() {
        if character.is_ascii_alphanumeric() {
            out.push(character.to_ascii_lowercase());
            dash = false;
        } else if character.is_alphanumeric() {
            out.push(character);
            dash = false;
        } else if !out.is_empty() && !dash {
            out.push('-');
            dash = true;
        }
    }
    let out = out.trim_matches('-').to_string();
    if out.is_empty() {
        "survey".to_string()
    } else {
        out.chars().take(64).collect()
    }
}

fn modified_millis(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new(name: &str) -> Fixture {
            let root = std::env::temp_dir().join(format!("northstar-store-{name}-{}", process::id()));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(&root).unwrap();
            Fixture { root }
        }

        fn store(&self) -> Store {
            Store::open(self.root.clone()).unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn web_project() -> Value {
        serde_json::json!({
            "workspaceName": "Route 9 boundary",
            "center": { "lat": 38.5, "lon": -121.7 },
            "zoom": 16,
            "points": [{ "id": "p1", "name": "Corner", "lat": 38.5, "lon": -121.7 }],
            "lines": [{ "id": "l1", "name": "North", "ids": ["p1"], "closed": false }],
            "measurements": []
        })
    }

    #[test]
    fn a_saved_project_reads_back_identical() {
        let fixture = Fixture::new("round-trip");
        let store = fixture.store();
        let entry = store.save(None, &web_project()).unwrap();
        assert_eq!(entry.name, "Route 9 boundary");
        let (_, text) = store.read(&entry.id).unwrap();
        let read = parse_document(&text).unwrap();
        // Every value the web build wrote survives, and the version is added.
        for (key, value) in web_project().as_object().unwrap() {
            assert_eq!(read.get(key), Some(value), "{key} changed");
        }
        assert_eq!(read.get("version"), Some(&json!(PROJECT_VERSION)));
    }

    #[test]
    fn a_file_without_a_version_is_version_one_and_migrates() {
        let web_export = serde_json::json!({
            "format": PROJECT_FORMAT,
            "project": web_project(),
        });
        let migrated = migrate(parse_document(&web_export.to_string()).unwrap()).unwrap();
        assert_eq!(migrated["version"], json!(2));
        assert_eq!(migrated["workspaceName"], json!("Route 9 boundary"));
        assert_eq!(migrated["points"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn a_file_from_a_newer_build_is_refused_rather_than_guessed() {
        let ahead = serde_json::json!({ "workspaceName": "Future", "version": 99, "points": [] });
        let error = migrate(ahead).unwrap_err();
        assert!(error.to_string().contains("version 99"), "{error}");
    }

    /// A write that cannot finish must leave the file the person already has,
    /// and no temporary file behind. The folder is made read only, so the
    /// temporary file cannot be created at all, which is the same boundary a
    /// process killed mid-write stops at.
    #[cfg(unix)]
    #[test]
    fn a_write_that_does_not_finish_leaves_the_previous_file_whole() {
        use std::os::unix::fs::PermissionsExt;

        let fixture = Fixture::new("interrupted");
        let store = fixture.store();
        let entry = store.save(None, &web_project()).unwrap();
        let before = fs::read_to_string(&entry.path).unwrap();

        let mut broken = web_project();
        broken["workspaceName"] = json!("Should not land");

        let directory = store.projects_dir();
        let mut permissions = fs::metadata(&directory).unwrap().permissions();
        permissions.set_mode(0o555);
        fs::set_permissions(&directory, permissions).unwrap();
        let attempt = store.save(Some(Path::new(&entry.path)), &broken);
        let mut permissions = fs::metadata(&directory).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&directory, permissions).unwrap();

        assert!(attempt.is_err(), "a write into a read only folder reported success");
        let (_, text) = store.read(&entry.id).unwrap();
        assert_eq!(text, before, "the previous file changed after a failed write");
        let leftovers: Vec<_> = fs::read_dir(&directory)
            .unwrap()
            .flatten()
            .map(|dir| dir.file_name().to_string_lossy().to_string())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temporary files left behind: {leftovers:?}");
    }

    #[test]
    fn two_projects_with_different_names_get_two_files() {
        let fixture = Fixture::new("names");
        let store = fixture.store();
        let first = store.save(None, &web_project()).unwrap();
        let mut second = web_project();
        second["workspaceName"] = json!("Hilltop lot");
        let entry = store.save(None, &second).unwrap();
        assert_ne!(first.path, entry.path);
        assert_eq!(store.list().len(), 2);
    }

    #[test]
    fn an_id_cannot_leave_the_projects_folder() {
        let fixture = Fixture::new("escape");
        let store = fixture.store();
        for id in ["../secrets", "a/b", "a\\b", ""] {
            assert!(store.project_path(id).is_err(), "{id} was accepted");
        }
    }

    #[test]
    fn the_recent_list_is_newest_first() {
        let fixture = Fixture::new("recent");
        let store = fixture.store();
        let first = store.save(None, &web_project()).unwrap();
        let mut second = web_project();
        second["workspaceName"] = json!("Second lot");
        let latest = store.save(None, &second).unwrap();
        let listed = store.list();
        assert_eq!(listed[0].id, latest.id);
        assert!(listed.iter().any(|entry| entry.id == first.id));
    }

    #[test]
    fn a_save_next_to_a_same_millisecond_file_still_comes_first() {
        use std::time::{Duration, SystemTime};
        // The Linux runner saved two projects inside one millisecond, which tied
        // them in the recent list and left the older project first.
        let fixture = Fixture::new("tie");
        let store = fixture.store();
        let first = store.save(None, &web_project()).unwrap();
        let mut second = web_project();
        second["workspaceName"] = json!("Second lot");
        let tied = store.save(None, &second).unwrap();
        let stamp = SystemTime::now() + Duration::from_secs(5);
        for entry in [&first, &tied] {
            let file = fs::OpenOptions::new().write(true).open(&entry.path).unwrap();
            let _ = file.set_times(fs::FileTimes::new().set_modified(stamp));
        }
        let mut third = web_project();
        third["workspaceName"] = json!("Third lot");
        let saved = store.save(None, &third).unwrap();
        assert_eq!(store.list()[0].id, saved.id);
    }

    #[test]
    fn settings_round_trip_and_keep_their_version() {
        let fixture = Fixture::new("settings");
        let store = fixture.store();
        let empty = store.settings();
        assert_eq!(empty["version"], json!(SETTINGS_VERSION));
        assert!(empty["keys"].as_object().unwrap().is_empty());

        let written = store
            .save_settings(&json!({
                "version": 99,
                "lastProject": "route-9-boundary",
                "keys": {
                    "northstar-settings": { "theme": "dark" },
                    "northstar-dock-width": "360"
                }
            }))
            .unwrap();
        assert_eq!(written["version"], json!(SETTINGS_VERSION));
        let read = store.settings();
        assert_eq!(read["lastProject"], json!("route-9-boundary"));
        assert_eq!(read["keys"]["northstar-settings"]["theme"], json!("dark"));
        assert_eq!(read["keys"]["northstar-dock-width"], json!("360"));
    }

    #[test]
    fn a_damaged_settings_file_does_not_stop_the_app() {
        let fixture = Fixture::new("damaged-settings");
        let store = fixture.store();
        fs::write(store.settings_path(), b"{ not json").unwrap();
        let settings = store.settings();
        assert_eq!(settings["version"], json!(SETTINGS_VERSION));
        assert!(settings["keys"].as_object().unwrap().is_empty());
    }

    #[test]
    fn a_damaged_project_is_skipped_in_the_list() {
        let fixture = Fixture::new("damaged-project");
        let store = fixture.store();
        let good = store.save(None, &web_project()).unwrap();
        fs::write(store.projects_dir().join("broken.northstar.json"), b"[1,2,3").unwrap();
        let listed = store.list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, good.id);
    }

    #[test]
    fn a_file_that_is_not_a_project_is_refused() {
        let fixture = Fixture::new("not-a-project");
        let store = fixture.store();
        let path = fixture.root.join("notes.json");
        fs::write(&path, br#"{"hello":"world"}"#).unwrap();
        // A bare object is accepted as a project, which is what the web build
        // did; what is refused is a document that is not one at all.
        assert!(store.read_any(&path).is_ok());
        fs::write(&path, b"[1,2,3]").unwrap();
        assert!(store.read_any(&path).is_err());
    }

    #[test]
    fn a_name_becomes_a_file_name() {
        assert_eq!(slug("Route 9 boundary"), "route-9-boundary");
        assert_eq!(slug("  Hilltop lot!  "), "hilltop-lot");
        assert_eq!(slug("..."), "survey");
        assert_eq!(slug("Café Lot 4"), "café-lot-4");
    }
}
