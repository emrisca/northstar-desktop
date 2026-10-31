# The port, endpoint by endpoint

What the web build asks a Python server for, what replaces it, and which parts of the browser have no desktop equivalent. The batches are in [plan.md](plan.md).

## 1. The server

`serve.py` does four jobs: it serves static files from `app/`, it proxies NOAA's CORS endpoints, it runs the readiness check, and it runs the RTKLIB install, conversion and correction jobs as subprocesses with a small HTTP API and a set of guards (loopback client, matching origin, and an action header per mutating route).

In the desktop build Tauri serves the files, so job one disappears. Jobs two to four become Rust commands. The guards go with them, because a command is reachable only from the app's own window; there is no port for a browser on the machine to reach.

| Endpoint | Replaced by | Batch |
| --- | --- | --- |
| `GET /api/preflight` | `preflight` command, same report shape | 3 |
| `GET /api/noaa/nearby` | `noaa_nearby` | 3 |
| `GET /api/noaa/station` | `noaa_station` | 3 |
| `GET /api/noaa/base` | `noaa_base` | 3 |
| `GET /api/rtklib/install/info` | `rtklib_install_info` | 4 |
| `GET /api/rtklib/install/status` | `rtklib_install_status` | 4 |
| `POST /api/rtklib/install` | `rtklib_install` with progress events | 4 |
| `POST /api/rtklib/convert` | `rtklib_convert` | 4 |
| `POST /api/rtklib/run` | `rtklib_run` | 4 |

Until a command exists, the endpoint answers 503 with a body naming the command and the batch that replaces it. `src/native.js` holds that table, and each entry is deleted as its command lands.

The NOAA work is worth stating plainly, because it is the reason the backend exists at all. NOAA's services do not send browser-readable cross-origin headers, so the web build asked its own server to make the requests. A Tauri command has no origin and therefore no such limit, so batch 3 keeps the same three fixed URLs and drops the proxy hop. The consequence is that the request no longer leaves from a browser at all, which matters for how NOAA sees the traffic.

## 2. What the browser gave the app, and what replaces it

| Browser feature | Desktop replacement | Batch |
| --- | --- | --- |
| `localStorage` for the project | one `.northstar.json` per project in the app data folder, written by a command | 2 |
| `localStorage` for settings, dock sizes, calculator state | a settings file next to the projects | 2 |
| Service worker cache of the shell and libraries | nothing, the files are local | 1 |
| Scripts and styles from five CDNs | vendored into `src/vendor` | 1 |
| `download` attribute and blob URLs for exports | native save dialog through the dialog plugin | 2 for projects, 5 for reports |
| `<input type="file">` for imports | the same input, plus drop handling on the window | 2 |
| `window.print` for the PDF report | the system print dialog through the shell | 5 |
| Cesium loaded from jsDelivr on demand | Cesium from disk, loaded when the globe is chosen | 1 |
| Google Fonts | the same font files on disk | 6 |
| Fixed window size and browser chrome | a real window with saved size, position and menu | 5 |

## 3. Decisions that change behaviour

**RTKLIB ships inside the app.** The web build downloads RTKLIB and, on macOS and Linux, compiles it with `make` and a C compiler. A desktop app can carry the built tools for each platform instead, which removes both the download and the compiler from the user's machine. RTKLIB is BSD 2-Clause, so redistributing the binaries is allowed as long as the licence travels with them. The installer stays as the recovery path when a bundled binary fails to run, which is also how a user can move to a newer RTKLIB than the one shipped.

**The first launch imports the old project.** Anyone who has used the web build has work in `localStorage` under the same origin the desktop build would use if it kept a webview origin. Batch 2 reads it once, writes it to a file, and reports what it found. The browser copy is left alone.

**The project file keeps its shape.** The desktop build writes the same `.northstar.json` the web build exports, so either build can open the other's file. Batch 2 adds a version field and a migration path, and nothing else changes about it.

**Stored geometry stays in EPSG:4326.** The global CRS remains a display and import setting. A port that started transforming stored coordinates would break every saved project and every comparison against the web build.

## 4. What must stay identical

These are the invariants a reviewer should check on every batch.

- Distances and areas come from the same geodesic calls and agree with the web build on the fixture project to the millimetre.
- Partition results agree vertex for vertex, including the auto fit search and the ground-value conversions.
- Coordinate parsing accepts the same five formats with the same S band rule.
- The CRS list and its projections are the same set, so a projected readout matches.
- RINEX parsing reports the same epoch counts and satellite lists for the same file.
- The corrected result averages only fixed epochs and rejects a result with none, exactly as before.
- The project file round-trips through both builds.
- The interface, its themes and its accent colours are unchanged.

## 5. Constraints the shell imposes

The webview is not a browser. Four consequences are worth knowing before batch 1.

Content security policy. The globe and the map styles fetch from tile hosts, Cesium assets and terrain endpoints. The configuration currently sets no policy, which keeps development simple and is not acceptable for release; batch 5 or 7 writes the host list the basemaps actually use.

Asset embedding. `frontendDist` is read when the shell compiles, so an edit to `src/` needs another compile. That is fine for a port in seven batches and would be annoying for daily interface work, so a watcher or a tiny static server belongs in whichever batch first edits the interface for its own sake.

Browser globals. Leaflet, MapLibre, Turf, RBush, GeographicLib, proj4 and Cesium all install themselves on `window`, and the ported scripts read them from there. This works in a webview unchanged, and it is also why the front end stays script-tag based rather than becoming modules.

File paths. Everything in `src/` is loaded with a relative URL, so it works from the asset protocol. Absolute paths of the form `/api/...` are the one exception, and `native.js` intercepts exactly those.

## 6. What batch 0 proved, and what it did not

Proved. The window opens on the moved interface, the shell compiles, and the five places that used to name the launcher or `serve.py` now name the desktop backend.

Not proved. Nothing about the backend, because none of it exists yet. The nine endpoints answer 503. Rendered output in the native window has not been checked against the browser build because this machine has no way to capture a native window here; the interface itself was checked in a browser, which is the same HTML, CSS and JavaScript the shell loads.

## 7. Open questions

Whether the map tiles should be cached on disk by the shell rather than by the webview, which decides how much of batch 6 belongs in Rust.

Whether the interface should keep its script tag loading or move to modules with a bundler, which changes nothing for the user and a lot for the build.

Where the settings file lives once projects can live anywhere, since the current design has one settings file for the app rather than one per project.
