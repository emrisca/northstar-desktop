//! The National Geodetic Survey lookups, ported from `serve.py`.
//!
//! The web build asked its own Python server to make these three requests
//! because NOAA sends no cross-origin headers. A Tauri command has no origin
//! and needs no proxy hop, so this calls the same three fixed URLs directly and
//! keeps every choice `serve.py` made: the projection to ECEF, the four decimal
//! places in the query, the station id rule, the UFCORS form fields and their
//! order, the member selection inside the archive, and the wording of each
//! error. The front end reads the same keys it always did.

use regex::Regex;
use serde_json::{json, Value};
use std::io::Read;
use std::time::Duration;
use std::time::Instant;

pub const NEARBY_URL: &str = "https://geodesy.noaa.gov/api/nde/ncors";
pub const STATION_URL: &str = "https://geodesy.noaa.gov/api/nde/cors";
pub const UFCORS_URL: &str = "https://geodesy.noaa.gov/UFCORS/ufcors";
pub const USER_AGENT: &str = "Northstar-Field-CAD/1.0 (local GNSS workflow)";
const TIMEOUT: Duration = Duration::from_secs(35);
const MAX_DOWNLOAD: usize = 30 * 1024 * 1024;

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(TIMEOUT)
        .user_agent(USER_AGENT)
        .build()
}

/// A failure the person can act on, with the wording the web build used.
fn fetch(url: &str, form: Option<&str>) -> Result<(Vec<u8>, String), String> {
    let agent = agent();
    let request = if form.is_some() {
        agent
            .post(url)
            .set("Accept", "application/json,application/zip,text/plain,*/*")
            .set("Content-Type", "application/x-www-form-urlencoded")
    } else {
        agent.get(url).set(
            "Accept",
            "application/json,application/zip,text/plain,*/*",
        )
    };
    let response = if let Some(body) = form {
        request.send_string(body)
    } else {
        request.call()
    };
    let response = match response {
        Ok(response) => response,
        Err(ureq::Error::Status(code, _)) => {
            return Err(format!("NOAA returned HTTP {code}."));
        }
        Err(error) => {
            let text = error.to_string();
            if text.to_lowercase().contains("timed out") || text.to_lowercase().contains("timeout") {
                return Err("NOAA did not answer before the timeout.".into());
            }
            return Err(format!("Could not reach NOAA: {text}"));
        }
    };
    let content_type = response
        .header("content-type")
        .unwrap_or("application/octet-stream")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    let mut payload = Vec::new();
    response
        .into_reader()
        .take(MAX_DOWNLOAD as u64 + 1)
        .read_to_end(&mut payload)
        .map_err(|error| format!("Could not read the NOAA answer: {error}"))?;
    if payload.len() > MAX_DOWNLOAD {
        return Err("NOAA returned more than 30 MB; narrow the time window.".into());
    }
    Ok((payload, content_type))
}

fn text(payload: &[u8]) -> String {
    String::from_utf8_lossy(payload).to_string()
}

fn station_list(payload: &[u8], unreadable: &str, unexpected: &str) -> Result<Vec<Value>, String> {
    match serde_json::from_str::<Value>(&text(payload)) {
        Ok(Value::Array(items)) => Ok(items),
        Ok(_) => Err(unexpected.to_string()),
        Err(_) => Err(unreadable.to_string()),
    }
}

/// WGS 84 latitude, longitude and ellipsoidal height to ECEF, with the same
/// flattening and the same expression order as `serve.py`.
pub fn ecef_from_llh(lat: f64, lon: f64, height: f64) -> (f64, f64, f64) {
    let a = 6_378_137.0;
    let f = 1.0 / 298.257_223_563;
    let e2 = f * (2.0 - f);
    let lat_r = lat.to_radians();
    let lon_r = lon.to_radians();
    let sin_lat = lat_r.sin();
    let cos_lat = lat_r.cos();
    let n = a / (1.0 - e2 * sin_lat * sin_lat).sqrt();
    let x = (n + height) * cos_lat * lon_r.cos();
    let y = (n + height) * cos_lat * lon_r.sin();
    let z = (n * (1.0 - e2) + height) * sin_lat;
    (x, y, z)
}

/// The nearby query, with the four decimal places NOAA expects.
pub fn nearby_url(lat: f64, lon: f64, height: f64) -> String {
    let (x, y, z) = ecef_from_llh(lat, lon, height);
    format!("{NEARBY_URL}?x={x:.4}&y={y:.4}&z={z:.4}")
}

pub fn nearby(lat: f64, lon: f64, height: f64) -> Result<Value, String> {
    if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) {
        return Err("Latitude or longitude is outside its valid range.".into());
    }
    let (payload, _) = fetch(&nearby_url(lat, lon, height), None)?;
    let stations = station_list(
        &payload,
        "NOAA returned an unreadable station list.",
        "NOAA returned an unexpected station list.",
    )?;
    Ok(json!({ "ok": true, "stations": stations }))
}

/// A station id is four letters or digits, and NOAA wants it lower case.
pub fn station_id(station: &str) -> Result<String, String> {
    if !Regex::new(r"^[A-Za-z0-9]{4}$").unwrap().is_match(station) {
        return Err("Station ID must be four letters or digits.".into());
    }
    Ok(station.to_lowercase())
}

pub fn station(station: &str) -> Result<Value, String> {
    let id = station_id(station)?;
    let (payload, _) = fetch(&format!("{STATION_URL}?id={id}"), None)?;
    let records = station_list(
        &payload,
        "NOAA returned unreadable station metadata.",
        "NOAA returned unexpected station metadata.",
    )?;
    Ok(json!({ "ok": true, "stations": records }))
}

/// The window a base download covers. The date rule is the one `date.fromisoformat`
/// enforced, which is ISO with four digit years and no time.
pub fn window(day: &str, start: &str, hours: i64, interval: i64) -> Result<(i64, u32), String> {
    let date = Regex::new(r"^(\d{4})-(\d{2})-(\d{2})$")
        .unwrap()
        .captures(day)
        .ok_or_else(|| "Date must be YYYY-MM-DD.".to_string())?;
    let year: i64 = date[1].parse().map_err(|_| "Date must be YYYY-MM-DD.")?;
    let month: u32 = date[2].parse().map_err(|_| "Date must be YYYY-MM-DD.")?;
    let day_of_month: u32 = date[3].parse().map_err(|_| "Date must be YYYY-MM-DD.")?;
    let valid = (1..=12).contains(&month) && (1..=31).contains(&day_of_month) && {
        // Reject a day the month does not have, the way date.fromisoformat did.
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        let last = match month {
            1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
            4 | 6 | 9 | 11 => 30,
            2 if leap => 29,
            2 => 28,
            _ => 0,
        };
        day_of_month <= last
    };
    if !valid {
        return Err("Date must be YYYY-MM-DD.".into());
    }
    if !Regex::new(r"^(?:[01]\d|2[0-3]):[0-5]\d$")
        .unwrap()
        .is_match(start)
    {
        return Err("Start time must be HH:MM in UTC.".into());
    }
    if !(1..=24).contains(&hours) {
        return Err("Hours must be between 1 and 24.".into());
    }
    if !(1..=30).contains(&interval) {
        return Err("Interval must be between 1 and 30.".into());
    }
    if ![1, 5, 15, 30].contains(&interval) {
        return Err("Interval must be 1, 5, 15 or 30 seconds.".into());
    }
    let doy = day_of_year(year, month, day_of_month);
    Ok((year, doy))
}

fn day_of_year(year: i64, month: u32, day: u32) -> u32 {
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let starts = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    let mut doy = starts[(month - 1) as usize] + day;
    if leap && month > 2 {
        doy += 1;
    }
    doy
}

/// The UFCORS form, field for field and in the order `serve.py` sent it.
pub fn ufcors_form(station: &str, year: i64, doy: u32, start: &str, hours: i64, interval: i64) -> String {
    let fields = [
        ("yearday", format!("{year}|{doy:03}")),
        ("yearday_year", year.to_string()),
        ("yearday_doy", format!("{doy:03}")),
        ("starttime", start.to_string()),
        ("timezone", "UTC".to_string()),
        ("duration", hours.to_string()),
        ("siteselection", station.to_lowercase()),
        ("epochInterval", interval.to_string()),
        ("coordinatefile", "yes".to_string()),
        ("datasheets", "yes".to_string()),
        ("orbits", "yes".to_string()),
        ("SUBMIT", "get CORS data file".to_string()),
    ];
    fields
        .iter()
        .map(|(key, value)| format!("{}={}", key, encode(value)))
        .collect::<Vec<_>>()
        .join("&")
}

/// The form encoding Python's `urlencode` produced: spaces become `+` and only
/// the characters that matter in a form body are escaped.
fn encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b' ' => out.push('+'),
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'*' => {
                out.push(byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// The archive members the job builder needs, chosen the way `serve.py` chose
/// them: first match in the archive's own order, patterns case insensitive.
pub struct Members {
    pub obs: Option<String>,
    pub nav: Vec<String>,
    pub sp3: Option<String>,
    pub coord: Option<String>,
    pub readme: Option<String>,
}

pub fn pick_members(names: &[String]) -> Members {
    // The web build compiled every one of these with re.IGNORECASE, because a
    // RINEX 3 name ends in upper case, so the flag is part of the rule.
    let first = |pattern: &str| -> Option<String> {
        let regex = Regex::new(&format!("(?i){pattern}")).unwrap();
        names
            .iter()
            .find(|name| regex.is_match(name))
            .map(|name| name.clone())
    };
    let nav = Regex::new(r"(?i)\.\d{2}[ngl]$|\.nav$").unwrap();
    Members {
        obs: first(r"\.\d{2}o$|\.obs$|\.rnx$"),
        nav: names
            .iter()
            .filter(|name| nav.is_match(name))
            .map(|name| name.clone())
            .collect(),
        sp3: first(r"\.sp3$"),
        coord: first(r"\.coord\.txt$"),
        readme: first(r"^readme\.txt$"),
    }
}

pub fn base(station: &str, day: &str, start: &str, hours: i64, interval: i64) -> Result<Value, String> {
    let id = station_id(station)?;
    let (year, doy) = window(day, start, hours, interval)?;
    let (payload, content_type) = fetch(&UFCORS_URL, Some(&ufcors_form(&id, year, doy, start, hours, interval)))?;
    let looks_zipped = payload.len() >= 2 && &payload[..2] == b"PK";
    if !content_type.to_lowercase().contains("zip") && !looks_zipped {
        let message = if contains(&payload, b"UFCORS Error") {
            "NOAA UFCORS rejected that station or time window."
        } else {
            "NOAA has no base file for that station and time window."
        };
        return Err(message.into());
    }
    archive(&payload, &id, day, start, hours, interval)
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

/// Read the archive into the shape the job builder expects. The texts are
/// decoded the way the web build decoded them, so a station with odd bytes
/// still opens.
pub fn archive(
    payload: &[u8],
    station: &str,
    day: &str,
    start: &str,
    hours: i64,
    interval: i64,
) -> Result<Value, String> {
    let reader = std::io::Cursor::new(payload);
    let mut zip = zip::ZipArchive::new(reader)
        .map_err(|_| "NOAA returned a file that was not a readable ZIP archive.".to_string())?;
    let names: Vec<String> = (0..zip.len())
        .filter_map(|index| zip.by_index(index).ok().map(|file| file.name().to_string()))
        .collect();
    let picked = pick_members(&names);
    let obs_name = picked
        .obs
        .ok_or_else(|| "The NOAA archive did not contain a RINEX observation file.".to_string())?;

    let mut read = |name: &str| -> Result<String, String> {
        let mut file = zip
            .by_name(name)
            .map_err(|error| format!("The NOAA archive could not be read: {error}"))?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|error| format!("The NOAA archive could not be read: {error}"))?;
        Ok(String::from_utf8_lossy(&bytes).to_string())
    };

    let obs = read(&obs_name)?;
    let mut nav = Vec::new();
    for name in &picked.nav {
        nav.push(json!({ "name": name, "text": read(name)? }));
    }
    let sp3 = match &picked.sp3 {
        Some(name) => json!({ "name": name, "text": read(name)? }),
        None => Value::Null,
    };
    let coord = match &picked.coord {
        Some(name) => read(name)?,
        None => String::new(),
    };
    let readme = match &picked.readme {
        Some(name) => read(name)?,
        None => String::new(),
    };
    Ok(json!({
        "ok": true,
        "station": station.to_uppercase(),
        "date": day,
        "start": start,
        "hours": hours,
        "interval": interval,
        "obs": { "name": obs_name, "text": obs },
        "nav": nav,
        "sp3": sp3,
        "coordText": coord,
        "readme": readme,
    }))
}

/// The NOAA reachability check the readiness card runs: one fixed station,
/// six seconds, and the same three outcomes as `preflight.py`.
pub fn reachability(timeout: Duration) -> Value {
    let url = "https://geodesy.noaa.gov/api/nde/cors?id=1lsu";
    let agent = ureq::AgentBuilder::new().timeout(timeout).build();
    let started = Instant::now();
    let response = agent
        .get(url)
        .set("User-Agent", USER_AGENT)
        .set("Accept", "application/json")
        .call();
    match response {
        Ok(response) => {
            let elapsed = started.elapsed().as_millis() as u64;
            let mut payload = Vec::new();
            let _ = response
                .into_reader()
                .take(4096)
                .read_to_end(&mut payload);
            match serde_json::from_slice::<Value>(&payload) {
                Ok(Value::Array(_)) => json!({
                    "ok": true,
                    "latencyMs": elapsed,
                    "message": format!("NOAA CORS answered in {elapsed} ms."),
                }),
                Ok(_) => json!({
                    "ok": false,
                    "latencyMs": elapsed,
                    "message": "NOAA answered with an unexpected station response.",
                }),
                Err(_) => json!({
                    "ok": false,
                    "latencyMs": elapsed,
                    "message": "NOAA answered, but the station response was not readable JSON.",
                }),
            }
        }
        Err(ureq::Error::Status(code, _)) => json!({
            "ok": false,
            "latencyMs": Value::Null,
            "message": format!("NOAA returned HTTP {code}."),
        }),
        Err(error) => json!({
            "ok": false,
            "latencyMs": Value::Null,
            "message": format!("Could not reach NOAA: {error}"),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-6
    }

    #[test]
    fn ecef_matches_the_python_constants() {
        let (x, y, z) = ecef_from_llh(0.0, 0.0, 0.0);
        assert!(close(x, 6_378_137.0), "{x}");
        assert!(close(y, 0.0), "{y}");
        assert!(close(z, 0.0), "{z}");
        // A point at the pole: the semi minor axis, which is a - a*f.
        let (_, _, z) = ecef_from_llh(90.0, 0.0, 0.0);
        assert!(close(z, 6_356_752.314_245_179), "{z}");
    }

    #[test]
    fn the_nearby_query_carries_four_decimal_places() {
        let url = nearby_url(38.5, -121.7, 12.0);
        assert!(url.starts_with(NEARBY_URL), "{url}");
        let fields: Vec<&str> = url.split(['?', '&']).skip(1).collect();
        assert_eq!(fields.len(), 3, "three axes: {url}");
        // West longitude puts the Y axis in the western hemisphere.
        let y = fields[1].split('=').nth(1).unwrap();
        assert!(y.starts_with('-'), "{y} in {url}");
        let z = fields[2].split('=').nth(1).unwrap();
        assert!(z.starts_with('3'), "a northern latitude is positive: {z}");
        let numbers: Vec<&str> = url.split(['?', '&']).skip(1).map(|p| p.split('=').nth(1).unwrap()).collect();
        for number in numbers {
            let decimals = number.split('.').nth(1).unwrap_or("");
            assert_eq!(decimals.len(), 4, "{number} in {url}");
        }
    }

    #[test]
    fn a_station_id_is_four_characters_and_goes_lower_case() {
        assert_eq!(station_id("1LSU").unwrap(), "1lsu");
        assert_eq!(station_id("p123").unwrap(), "p123");
        for bad in ["", "P12", "P1234", "P 23", "P-23"] {
            assert!(station_id(bad).is_err(), "{bad} was accepted");
        }
    }

    #[test]
    fn the_window_rules_match_the_web_build() {
        assert_eq!(window("2026-10-29", "13:00", 3, 30).unwrap(), (2026, 302));
        assert_eq!(window("2026-01-01", "00:00", 1, 1).unwrap(), (2026, 1));
        assert_eq!(window("2024-12-31", "23:59", 24, 5).unwrap(), (2024, 366));
        assert!(window("2026-02-29", "00:00", 1, 30).is_err(), "2026 is not a leap year");
        assert!(window("2024-02-29", "00:00", 1, 30).is_ok());
        assert!(window("29-10-2026", "00:00", 1, 30).is_err());
        assert!(window("2026-13-01", "00:00", 1, 30).is_err());
        assert!(window("2026-10-29", "24:00", 1, 30).is_err());
        assert!(window("2026-10-29", "9:00", 1, 30).is_err());
        assert!(window("2026-10-29", "09:00", 0, 30).is_err());
        assert!(window("2026-10-29", "09:00", 25, 30).is_err());
        assert!(window("2026-10-29", "09:00", 1, 10).is_err());
        assert_eq!(
            window("2026-10-29", "09:00", 1, 10).unwrap_err(),
            "Interval must be 1, 5, 15 or 30 seconds."
        );
    }

    #[test]
    fn the_ufcors_form_is_the_one_python_sent() {
        let form = ufcors_form("1lsu", 2026, 302, "13:00", 3, 30);
        assert_eq!(
            form,
            "yearday=2026%7C302&yearday_year=2026&yearday_doy=302&starttime=13%3A00\
             &timezone=UTC&duration=3&siteselection=1lsu&epochInterval=30\
             &coordinatefile=yes&datasheets=yes&orbits=yes\
             &SUBMIT=get+CORS+data+file"
        );
    }

    #[test]
    fn the_archive_members_are_chosen_the_way_the_web_build_chose_them() {
        let names: Vec<String> = [
            "readme.txt",
            "1lsu3020.26o",
            "1lsu3020.26n",
            "1lsu3020.26g",
            "igs3020.sp3",
            "1lsu.coord.txt",
            "notes.txt",
        ]
        .iter()
        .map(|name| name.to_string())
        .collect();
        let picked = pick_members(&names);
        assert_eq!(picked.obs.as_deref(), Some("1lsu3020.26o"));
        assert_eq!(picked.nav.len(), 2);
        assert_eq!(picked.sp3.as_deref(), Some("igs3020.sp3"));
        assert_eq!(picked.coord.as_deref(), Some("1lsu.coord.txt"));
        assert_eq!(picked.readme.as_deref(), Some("readme.txt"));

        // Case does not matter, and a RINEX 3 name counts too.
        let names: Vec<String> = ["1LSU.26O", "README.TXT"].iter().map(|n| n.to_string()).collect();
        let picked = pick_members(&names);
        assert_eq!(picked.obs.as_deref(), Some("1LSU.26O"));
        assert_eq!(picked.readme.as_deref(), Some("README.TXT"));
    }

    fn sample_archive() -> Vec<u8> {
        let mut buffer = std::io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buffer);
            let options: zip::write::FileOptions<'_, ()> =
                zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            for (name, body) in [
                ("readme.txt", "UFCORS export\n"),
                ("1lsu3020.26o", "     3.04           OBSERVATION DATA    M (MIXED)\n"),
                ("1lsu3020.26n", "     3.04           NAVIGATION DATA     GPS\n"),
                ("1lsu.coord.txt", "ITRF2020 1LSU\n"),
            ] {
                zip.start_file(name, options).unwrap();
                zip.write_all(body.as_bytes()).unwrap();
            }
            zip.finish().unwrap();
        }
        buffer.into_inner()
    }

    #[test]
    fn an_archive_comes_back_in_the_shape_the_job_builder_reads() {
        let value = archive(&sample_archive(), "1lsu", "2026-10-29", "13:00", 3, 30).unwrap();
        assert_eq!(value["station"], json!("1LSU"));
        assert_eq!(value["ok"], json!(true));
        assert_eq!(value["obs"]["name"], json!("1lsu3020.26o"));
        assert!(value["obs"]["text"].as_str().unwrap().contains("OBSERVATION DATA"));
        assert_eq!(value["nav"][0]["name"], json!("1lsu3020.26n"));
        assert_eq!(value["sp3"], Value::Null);
        assert!(value["coordText"].as_str().unwrap().contains("ITRF2020"));
        assert!(value["readme"].as_str().unwrap().contains("UFCORS"));
        assert_eq!(value["date"], json!("2026-10-29"));
    }

    #[test]
    fn an_archive_without_an_observation_file_is_refused() {
        let mut buffer = std::io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buffer);
            let options: zip::write::FileOptions<'_, ()> =
                zip::write::FileOptions::default();
            zip.start_file("readme.txt", options).unwrap();
            zip.write_all(b"nothing here").unwrap();
            zip.finish().unwrap();
        }
        let error = archive(&buffer.into_inner(), "1lsu", "2026-10-29", "13:00", 3, 30).unwrap_err();
        assert_eq!(
            error,
            "The NOAA archive did not contain a RINEX observation file."
        );
    }

    /* The tests below talk to NOAA. They are skipped unless asked for:

         cargo test --lib -- --ignored

       They are the only way to know the port still agrees with the service,
       because the shapes above are recorded by hand. */

    #[test]
    #[ignore = "talks to NOAA"]
    fn live_the_station_search_finds_nine_stations_and_their_coordinates() {
        let value = nearby(38.52, -121.71, 12.0).unwrap();
        let stations = value["stations"].as_array().unwrap();
        assert_eq!(stations.len(), 9, "NOAA answers this search with nine");
        for item in stations {
            assert!(item.get("corsId").and_then(Value::as_str).is_some(), "{item}");
            assert!(item.get("distance").and_then(Value::as_str).is_some(), "{item}");
        }
        // The search carries ids and distances; the coordinates come from the
        // metadata call, which is the second half of the same workflow.
        let id = stations[0]["corsId"].as_str().unwrap();
        let records = station(id).unwrap();
        let record = &records["stations"][0];
        let lat: f64 = record["lat"].as_str().unwrap().parse().unwrap();
        let lon: f64 = record["lon"].as_str().unwrap().parse().unwrap();
        assert!((37.0..39.0).contains(&lat), "{id} latitude {lat}");
        assert!((-123.0..-120.0).contains(&lon), "{id} longitude {lon}");
    }

    #[test]
    #[ignore = "talks to NOAA"]
    fn live_station_metadata_names_the_station_it_was_asked_for() {
        let value = station("1LSU").unwrap();
        let records = value["stations"].as_array().unwrap();
        assert!(!records.is_empty(), "no metadata came back");
        let text = records[0].to_string().to_uppercase();
        assert!(text.contains("1LSU"), "{text}");
    }

    #[test]
    #[ignore = "talks to NOAA"]
    fn live_a_base_window_downloads_and_parses() {
        // Three days back is far enough for the archive to have closed the day.
        let days = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            / 86_400
            - 3;
        let day = civil_date(days as i64);
        let value = base("1LSU", &day, "00:00", 1, 30).unwrap();
        assert_eq!(value["ok"], json!(true));
        let obs = value["obs"]["text"].as_str().unwrap();
        assert!(obs.contains("RINEX") || obs.contains("OBSERVATION"), "{obs:.80}");
        assert!(value["obs"]["name"].as_str().unwrap().len() > 4);
    }

    /// The whole chain against two real rover sessions, the way the job builder
    /// walks it: the approximate position from the RINEX header finds the
    /// nearby stations, the nearest one gives its coordinates, and its archive
    /// for the session hour comes back as text the parser can read.
    #[test]
    #[ignore = "talks to NOAA"]
    fn live_two_rover_sessions_find_a_near_base_and_download_it() {
        // Approximate positions taken from the APPROX POSITION XYZ line of each
        // header, converted to latitude, longitude and ellipsoidal height.
        let rovers = [
            ("KINGS.obs", 36.005_977_5, -120.122_577_9, 215.271, "2026-10-25", "01:00"),
            ("HUD RANGERS.obs", 42.777_557_4, -71.402_544_9, 62.273, "2022-03-18", "13:00"),
        ];
        for (name, lat, lon, height, day, start) in rovers {
            let found = nearby(lat, lon, height).unwrap();
            let stations = found["stations"].as_array().unwrap();
            assert_eq!(stations.len(), 9, "{name}");
            let id = stations[0]["corsId"].as_str().unwrap().to_string();

            let records = station(&id).unwrap();
            let record = &records["stations"][0];
            let base_lat: f64 = record["lat"].as_str().unwrap().parse().unwrap();
            let base_lon: f64 = record["lon"].as_str().unwrap().parse().unwrap();
            let kilometres = (lat - base_lat).hypot(lon - base_lon) * 111.0;
            assert!(
                kilometres < 150.0,
                "{name} picked {id}, {kilometres:.0} km away"
            );

            let window = base(&id, day, start, 1, 30).unwrap();
            let obs = window["obs"]["text"].as_str().unwrap();
            assert!(obs.contains("OBSERVATION") || obs.contains("RINEX"), "{name}: {obs:.80}");
            assert_eq!(window["station"], json!(id.to_uppercase()));
            assert_eq!(window["date"], json!(day));

            // The coordinate file is what the job builder reads the NAD83 and
            // ITRF frames from, and the orbit file is what it carries into the
            // engine, so an archive missing either is not a working download.
            let coord = window["coordText"].as_str().unwrap();
            assert!(
                coord.contains("ITRF") || coord.contains("NAD"),
                "{name} coordinate file: {coord:.80}"
            );
            assert!(
                window["sp3"].get("name").is_some(),
                "{name} came without an orbit file"
            );
        }
    }

    /// Days since the Unix epoch to a calendar date, so the live test does not
    /// need a date library.
    fn civil_date(days: i64) -> String {
        let z = days + 719_468;
        let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
        let doe = z - era * 146_097;
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let y = yoe + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let m = if mp < 10 { mp + 3 } else { mp - 9 };
        let y = if m <= 2 { y + 1 } else { y };
        format!("{y:04}-{m:02}-{d:02}")
    }

    #[test]
    fn something_that_is_not_an_archive_is_refused_with_the_python_wording() {
        let error = archive(b"not a zip at all", "1lsu", "2026-10-29", "13:00", 3, 30).unwrap_err();
        assert_eq!(
            error,
            "NOAA returned a file that was not a readable ZIP archive."
        );
    }
}
