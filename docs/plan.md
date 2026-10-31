# The batch plan

Northstar runs in a browser today, served by a Python script. This plan turns it into a desktop app without rewriting the interface, and splits the work so each batch can be built, tested and pushed on its own.

State: batches 0 and 1 done, batch 2 next.

## How a batch finishes

A batch is done when its own check passes, the commit is pushed, and the line below is updated. A batch does not start before the one above it runs.

## Batch 0. The repository and the shell

Delivered.

- This repository, private, with the interface moved from `app/` to `src/` unchanged except for the four edits listed below.
- A Tauri v2 shell in `src-tauri/` with one window, no commands, and no bundler.
- An application icon, drawn with the standard library and expanded to the platform set by the Tauri CLI.
- `src/native.js`, the bridge that answers the nine server endpoints with a 503 naming the command and batch that replace each one.
- These four documents.

The four edits to the moved interface: the service worker registration is replaced by the bridge script, and five messages that told the reader to start Northstar with its launcher or `serve.py` now say that the desktop backend did not answer.

Check. `npm run dev` compiles the shell and opens the window on the interface; the map, waypoints, lines, measurements and the calculator work; the GNSS cards state that the backend is not built yet instead of failing silently. Passed on 30 October 2026: the first launch is [batch-0-window.png](batch-0-window.png), with the street basemap drawn, the toolbar, the object tree and the status bar in place.

## Batch 1. The map, offline

Delivered.

- Seven libraries, the Cesium build and the two font families moved into `src/vendor`, loaded by relative path. Leaflet 1.9.4, MapLibre 3.6.2 with its Leaflet bridge 0.0.20, Turf 7.2.0, RBush 3.0.1, geographiclib-geodesic 2.2.0 and proj4 2.15.0, all at the versions the page already pinned. [vendor/README.md](../src/vendor/README.md) records each version, source and a SHA-256 over the vendored bytes.
- Cesium 1.146.0 loads from `src/vendor/cesium` when the globe is chosen. The published build carries `index.js` and `index.cjs` for bundlers; dropping those two saved 9.6 MB and nothing else was trimmed, because the workers and assets are loaded by name at runtime.
- The content security policy replaced `null` in `tauri.conf.json`. It names 34 hosts across basemaps, imagery, terrain, overlays and the assessor parcel services, and allows inline styles, blob and data images, blob workers, and for scripts only Cesium's needs: `'unsafe-eval'`, `'wasm-unsafe-eval'` and `blob:`. No remote origin appears in `script-src`, which is what keeps a CDN payload out.
- The service worker registration went with `sw.js` in batch 0, and the cache-busting query strings stay because they cost nothing.

Check. All three engines render, and so does the globe from disk. A California viewport loads assessor parcel lines from the state service. The historical basemap fetches its style and shows the year slider. The blank grid renders and stays editable.

Measured on 30 October 2026, page served over HTTP with the policy sent as a header so it was enforced during the run:

- 109 resource requests since navigation, none to `unpkg`, `jsdelivr`, `cdnjs`, `fonts.googleapis` or `fonts.gstatic`. The only hosts were the five tile and style services, plus `127.0.0.1` for the vendored files, which include two font files and every Cesium asset.
- The globe reported Cesium 1.146.0 active with its canvas present, and the console logged nothing at all during that load.
- The Tauri window renders the street basemap, the toolbar and the status bar with the policy in force.

Two notes for later batches. Cesium and MapLibre both build workers from blob URLs and Cesium compiles WebAssembly, which is why `script-src` is broader than `'self'`; isolating the globe would be the way to narrow it again. And one OpenHistoricalMap tile returned 404 during the run, which is the upstream tile service, not a local path.

## Batch 2. Projects as files

Goal. A project is a file the person can find, back up and hand to someone else.

- One `.northstar.json` per project under the app data folder, written to a temporary file and renamed into place.
- Autosave on change, a recent list on the welcome screen, open, save, and save as through native dialogs.
- Drag a project file onto the window, and open a second instance's file in the running window.
- A one-time import of the old `localStorage` project, reported to the person, leaving the browser copy in place.
- Settings, dock sizes and calculator state move to a settings file beside the projects.
- A version field in the project file with a migration path.

Check. A project survives a quit and a reopen, a killed process during a write leaves the previous file intact, and a project exported from the web build opens with no loss.

## Batch 3. NOAA and the readiness check

Goal. The four endpoints that talk to the outside world answer again, this time from Rust.

- `preflight` with the same report shape as `serve.py`: Python no longer applies, so the check reports the tools, the app files and the NOAA reachability only.
- `noaa_nearby`, `noaa_station` and `noaa_base` against the same three fixed URLs, with the same station ordering, window selection, frame handling and ITRF velocity propagation.

Check. A search returns nine stations with real coordinates. A base window downloads and parses. The readiness card reports the same checks as the web build on the same rover file.

## Batch 4. RTKLIB

Goal. Conversion and correction run without Python and without a compiler on the machine.

- Bundle the built tools per platform, with the licence, and record what is bundled.
- `rtklib_convert` and `rtklib_run` with the existing 48 MB input and 64 MB output caps and the same temporary folder behaviour.
- `rtklib_install`, `rtklib_install_info` and `rtklib_install_status` as the recovery path, emitting progress events to the existing installer panel.
- The install record keeps its rule: a record only counts when its platform matches and its binaries still resolve.

Check. A real `.ubx` log converts to RINEX 3.03. A prepared job runs to a `.pos`, only fixed epochs are averaged, and the accepted waypoint matches the web build on the same inputs. A machine without a compiler completes both jobs.

## Batch 5. The native shell

Goal. The app behaves like a desktop app rather than a page in a frame.

- An application menu, with the map shortcuts left alone.
- Window size, position and state restored between launches.
- A `.northstar.json` file association, and opening a file from Finder or Explorer.
- About, with the version and the third-party notices.
- Printing the selected-points report through the system dialog.

Check. Double-clicking a project opens it in the running window, every shortcut still reaches the map, and the printed report matches the PDF the web build produced.

## Batch 6. Offline and speed

Goal. A field machine with no connection is a first-class case.

- A tile cache on disk with a size cap and an eviction rule, written by the shell rather than the webview.
- A measured cold-start budget and an index rebuild budget on a ten thousand waypoint fixture.

Check. The app starts with networking off, cached tiles and the blank grid both work, cold start is under two seconds, and dragging stays responsive on the fixture.

## Batch 7. Release

Goal. An install someone else can run.

- Signed and notarised macOS build, and a Windows installer.
- An updater feed.
- A documented crash log location.
- One command that runs the test suites.
- The README rewritten for the desktop app, with the web build pointed at as the older option.

Check. A build from a clean clone installs and runs on a machine that has never had Python.

## Rules that hold across every batch

Numbers match the web build. The fixture project, its distances, areas, partition results and converted coordinates are compared between the two builds, and a difference is a defect in the port.

The look does not change. This is a port, so the CSS, the themes and the layout stay as they are. A redesign would be its own decision, taken after parity.

The project file format does not change. The web build opens what this build writes and the reverse, apart from the version field added in batch 2.

No new service. The map sources, NOAA, Nominatim and the currency rates are the ones already in use, and their attribution stays visible where it already is.

## Risks

Cesium, proj4 and Turf expect browser globals, and the content security policy has to allow the tile and terrain hosts or the globe fails with a blank canvas.

The map's keyboard shortcuts will collide with the application menu until batch 5 decides which layer owns them.

Bundled RTKLIB binaries change where the readiness check looks, so the `tools/rtklib` path has to go in one step rather than drift.

Atomic writes are the only protection against a corrupted project file, and a rename over an open file works only within one volume.

## Out of scope

No framework rewrite, no cloud sync, no multi-user server, no mobile build. The web build stays in `emrisca/Northstar` for anyone who wants it.
