//! The map tile cache.
//!
//! Batch 6 asks for a tile cache on disk, with a size cap and an eviction rule,
//! written by the shell rather than the webview. The map asks for
//! `northstar-tile://cache/?u=<encoded url>`; the protocol handler in `lib.rs`
//! turns that into a cache hit or a fetch, and the answer is an ordinary image
//! response. The webview never opens the folder itself, so the cache survives a
//! cleared webview profile and the policy stays the shell's business.
//!
//! Two rules bound it: a byte cap and least-recently-used eviction. The file's
//! modification time is the access record — a hit touches it — so the eviction
//! order is the order the map last asked, and no index has to be kept in step
//! with the files.

use sha2::{Digest, Sha256};
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// The custom scheme the webview asks. Registered in `lib.rs`.
pub const SCHEME: &str = "northstar-tile";

/// The disk budget. Raster tiles are 10–40 KB and vector tiles 20–80 KB, so a
/// gigabyte holds a county-sized field area over the zoom levels a survey uses
/// with room to spare.
pub const DEFAULT_CAP_BYTES: u64 = 1024 * 1024 * 1024;

/// A single response larger than this is not a tile; refuse it rather than let
/// one odd answer fill the budget.
const MAX_TILE_BYTES: u64 = 6 * 1024 * 1024;

const FETCH_TIMEOUT: Duration = Duration::from_secs(20);

/// The hosts the cache will fetch from: the basemap, imagery and overlay hosts
/// the picker offers. The scheme is reachable from the webview, so this list is
/// what stops it being an open proxy standing beside `connect-src`.
const ALLOWED_HOSTS: &[&str] = &[
    "tile.openstreetmap.org",
    "tile.openstreetmap.fr",
    "tiles.openfreemap.org",
    "tile.opentopomap.org",
    "tiles.maps.eox.at",
    "basemap.nationalmap.gov",
    "elevation.nationalmap.gov",
    "hydro.nationalmap.gov",
    "server.arcgisonline.com",
    "clarity.maptiles.arcgis.com",
    "tiles.arcgis.com",
    "tiles.macrostrat.org",
    "static-tiles.openhistoricalmap.org",
    "vtiles.openhistoricalmap.org",
    "apps.geo.fpac.usda.gov",
    "apps.fs.usda.gov",
    "gis.blm.gov",
];

pub struct TileCache {
    dir: PathBuf,
    cap: u64,
}

pub struct Cached {
    pub bytes: Vec<u8>,
    pub mime: String,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Stats {
    pub files: usize,
    pub bytes: u64,
    pub cap: u64,
}

impl TileCache {
    pub fn open(dir: impl Into<PathBuf>, cap: u64) -> io::Result<Self> {
        let dir = dir.into();
        fs::create_dir_all(&dir)?;
        Ok(Self { dir, cap })
    }

    #[allow(dead_code)] // Read by the stats command a later batch adds.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    #[allow(dead_code)] // Used by the tests today, and by the settings panel later.
    pub fn stats(&self) -> Stats {
        let mut files = 0;
        let mut bytes = 0;
        if let Ok(entries) = fs::read_dir(&self.dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|value| value.to_str()) != Some("bin") {
                    continue;
                }
                if let Ok(meta) = entry.metadata() {
                    files += 1;
                    bytes += meta.len();
                }
            }
        }
        Stats {
            files,
            bytes,
            cap: self.cap,
        }
    }

    /// A hit is served from disk and stamps the file as used, which is what
    /// keeps a tile someone keeps looking at out of the eviction order.
    pub fn get(&self, url: &str) -> Option<Cached> {
        let (data, meta) = self.paths(url);
        let bytes = fs::read(&data).ok().filter(|bytes| !bytes.is_empty())?;
        let mime = fs::read_to_string(&meta)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())?;
        touch(&data);
        Some(Cached { bytes, mime })
    }

    /// Write through a temporary name so a reader never sees half a tile, then
    /// apply the cap.
    pub fn put(&self, url: &str, bytes: &[u8], mime: &str) -> io::Result<()> {
        if bytes.is_empty() {
            return Ok(());
        }
        let (data, meta) = self.paths(url);
        let temporary = data.with_extension("bin.tmp");
        fs::write(&temporary, bytes)?;
        fs::rename(&temporary, &data)?;
        fs::write(&meta, mime)?;
        self.evict()?;
        Ok(())
    }

    /// Drop the least recently used tiles until the folder is under the cap.
    /// Returns the bytes freed.
    pub fn evict(&self) -> io::Result<u64> {
        let mut entries: Vec<(SystemTime, u64, PathBuf)> = Vec::new();
        for entry in fs::read_dir(&self.dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("bin") {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            let used = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            entries.push((used, meta.len(), path));
        }
        let mut total: u64 = entries.iter().map(|(_, size, _)| *size).sum();
        if total <= self.cap {
            return Ok(0);
        }
        entries.sort_by_key(|(used, _, _)| *used);
        let mut freed = 0;
        for (_, size, path) in entries {
            if total <= self.cap {
                break;
            }
            if fs::remove_file(&path).is_ok() {
                let _ = fs::remove_file(path.with_extension("type"));
                total = total.saturating_sub(size);
                freed += size;
            }
        }
        Ok(freed)
    }

    fn paths(&self, url: &str) -> (PathBuf, PathBuf) {
        let mut hasher = Sha256::new();
        hasher.update(url.as_bytes());
        let key: String = hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        (
            self.dir.join(format!("{key}.bin")),
            self.dir.join(format!("{key}.type")),
        )
    }
}

/// Mark a tile as used without rewriting it.
fn touch(path: &Path) {
    if let Ok(file) = fs::OpenOptions::new().write(true).open(path) {
        let _ = file.set_modified(SystemTime::now());
    }
}

/// The URL a request stands for, or the reason it is refused.
///
/// The prefix is `northstar-tile://cache/?u=` and the value is percent encoded,
/// because a tile URL carries its own query string.
pub fn target(uri: &str) -> Result<String, String> {
    let query = uri
        .split_once("?u=")
        .map(|(_, value)| value)
        .ok_or_else(|| "the tile request has no url".to_string())?;
    let url = decode(query);
    check(&url)?;
    Ok(url)
}

/// Only https on a known host, so the scheme cannot be pointed anywhere else.
pub fn check(url: &str) -> Result<(), String> {
    let rest = url
        .strip_prefix("https://")
        .ok_or_else(|| format!("only https tile urls are fetched: {url}"))?;
    let host = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if host.is_empty() {
        return Err(format!("the tile url has no host: {url}"));
    }
    let known = ALLOWED_HOSTS
        .iter()
        .any(|allowed| host == *allowed || host.ends_with(&format!(".{allowed}")));
    if !known {
        return Err(format!("{host} is not a map tile host"));
    }
    Ok(())
}

/// Percent decoding, the way `encodeURIComponent` writes it.
fn decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                match (hex(bytes[index + 1]), hex(bytes[index + 2])) {
                    (Some(high), Some(low)) => {
                        out.push(high * 16 + low);
                        index += 3;
                    }
                    _ => {
                        out.push(bytes[index]);
                        index += 1;
                    }
                }
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Fetch a tile the cache does not hold.
pub fn download(url: &str) -> Result<(Vec<u8>, String), String> {
    check(url)?;
    let response = ureq::get(url)
        .timeout(FETCH_TIMEOUT)
        .call()
        .map_err(|error| format!("the tile source did not answer: {error}"))?;
    let mime = response
        .header("Content-Type")
        .map(str::to_string)
        .unwrap_or_else(|| guess_mime(url));
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(MAX_TILE_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("the tile body could not be read: {error}"))?;
    Ok((bytes, mime))
}

fn guess_mime(url: &str) -> String {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    match path.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "pbf" | "mvt" => "application/x-protobuf",
        "json" => "application/json",
        _ => "application/octet-stream",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "northstar-tiles-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn age(path: &Path, seconds: u64) {
        let file = fs::OpenOptions::new().write(true).open(path).unwrap();
        file.set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(seconds))
            .unwrap();
    }

    #[test]
    fn a_tile_round_trips_and_a_hit_stamps_it_as_used() {
        let dir = scratch("roundtrip");
        let cache = TileCache::open(&dir, DEFAULT_CAP_BYTES).unwrap();
        let url = "https://tile.openstreetmap.org/12/654/1583.png";
        assert!(cache.get(url).is_none());

        cache.put(url, b"png bytes", "image/png").unwrap();
        let hit = cache.get(url).expect("a stored tile is a hit");
        assert_eq!(hit.bytes, b"png bytes");
        assert_eq!(hit.mime, "image/png");

        let stamp = cache.paths(url).0;
        age(&stamp, 1_000);
        assert!(cache.get(url).is_some());
        let used = fs::metadata(&stamp).unwrap().modified().unwrap();
        assert!(
            used > SystemTime::UNIX_EPOCH + Duration::from_secs(1_000),
            "a hit moves the tile out of the oldest slot"
        );

        assert_eq!(cache.stats(), Stats { files: 1, bytes: 9, cap: DEFAULT_CAP_BYTES });
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_eviction_rule_drops_the_least_recently_used_first() {
        let dir = scratch("evict");
        // Fill under a cap that does not bite, so the three tiles exist at once.
        let roomy = TileCache::open(&dir, 1_000).unwrap();
        let urls = [
            "https://tile.openstreetmap.org/1/0/0.png",
            "https://tile.openstreetmap.org/2/1/1.png",
            "https://tile.openstreetmap.org/3/2/2.png",
        ];
        for url in urls {
            roomy.put(url, b"0123456789", "image/png").unwrap();
        }
        let (first, _) = roomy.paths(urls[0]);
        let (second, _) = roomy.paths(urls[1]);
        let (third, _) = roomy.paths(urls[2]);
        age(&first, 10);
        age(&third, 20);
        age(&second, 30);

        // Two tiles fit; the third has to go, and it is the one used longest ago.
        let tight = TileCache::open(&dir, 20).unwrap();
        let freed = tight.evict().unwrap();
        assert_eq!(freed, 10, "one ten-byte tile makes room for the cap");
        assert!(!first.exists(), "the least recently used tile goes first");
        assert!(third.exists(), "the middle tile stays");
        assert!(second.exists(), "the newest tile stays");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_cache_refuses_a_url_it_should_not_fetch() {
        assert!(check("https://tile.openstreetmap.org/1/0/0.png").is_ok());
        assert!(check("https://a.tile.openstreetmap.fr/osmfr/1/0/0.png").is_ok());
        assert!(check("http://tile.openstreetmap.org/1/0/0.png").is_err());
        assert!(check("https://example.com/tile.png").is_err());
        assert!(check("file:///etc/passwd").is_err());
    }

    #[test]
    fn a_request_names_the_url_it_stands_for() {
        let url = "https://tiles.openfreemap.org/planet/20250101_001001_pt/12/654/1583.pbf?x=1&y=2";
        let encoded: String = url
            .bytes()
            .map(|byte| match byte {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    (byte as char).to_string()
                }
                _ => format!("%{byte:02X}"),
            })
            .collect();
        let uri = format!("northstar-tile://cache/?u={encoded}");
        assert_eq!(target(&uri).as_deref(), Ok(url));
        assert!(target("northstar-tile://cache/").is_err());
    }

    #[test]
    fn the_mime_comes_from_the_extension_when_the_source_says_nothing() {
        assert_eq!(guess_mime("https://x/y.png?token=1"), "image/png");
        assert_eq!(guess_mime("https://x/y.pbf"), "application/x-protobuf");
        assert_eq!(guess_mime("https://x/y"), "application/octet-stream");
    }
}
