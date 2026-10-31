# The batch plan

Northstar runs in a browser today, served by a Python script. This plan turns it into a desktop app without rewriting the interface, and splits the work so each batch can be built, tested and pushed on its own.

State: batch 0 done, batch 1 next.

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

Goal. Every map behaviour works from local files, with no CDN request and no service worker.

- Vendor Leaflet, MapLibre, the MapLibre Leaflet bridge, Turf, RBush, GeographicLib and proj4 into `src/vendor`, and load the Cesium script and its assets from disk when the globe is chosen.
- Write the content security policy for the tile hosts, imagery servers, terrain services and parcel services the basemap picker and overlays already use.
- Remove the last traces of the service worker and the cache-busting query strings that only mattered to it.

Check. All three engines render. A covered state loads parcel lines. The historical year filter changes labels. The blank grid stays editable with networking disabled. No request leaves for a CDN, and a request log proves it.

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
- Fonts on disk.
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
