# The batch plan

Northstar runs in a browser today, served by a Python script. This plan turns it into a desktop app without rewriting the interface, and splits the work so each batch can be built, tested and pushed on its own.

State: batches 0 to 5 implemented. Batch 7 release hardening is partly delivered; batch 6, macOS notarisation and Windows Authenticode remain open.

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

Delivered.

- `src-tauri/src/store.rs` holds the file half: one `projects/<name>.northstar.json` per project under the app's data folder, written to a temporary name in the same folder and renamed into place so a write that does not finish leaves the previous file intact. The folder is `~/Library/Application Support/com.emrisca.northstar` on macOS.
- `src/native.js` is now the whole bridge. It seeds `localStorage` from an initialisation script the shell builds before the window loads, so the first paint is already the saved project, and then mirrors every `northstar-` write back to disk, coalescing to one write per 400 ms.
- The Project menu gained Open project, Recent projects, New project, Save now and Save a copy. Opening a file goes through the interface's existing importer, so an opened project and an imported one take the same path.
- Recent projects is the welcome screen: the shell opens the list on a launch that has no projects, and the Project menu opens it at any time.
- Drag and drop and a second launch both end in the same place. The shell reads the path, then calls `window.northstarOpenPath` in the window it already has, so there is never a second store writing the same files.
- The settings file holds whatever the interface keeps in `localStorage`: theme, units, dock sizes, calculator state, and the project that was last open. Rust stores the keys without interpreting them.
- A project file now carries `version: 2` beside the web build's `format` marker. A file without a version is version 1, migration 1 to 2 adds the field and leaves every value alone, and a file from a newer version is refused rather than guessed at.
- The batch 0 project, if this webview still has one, is written to a file on first launch and reported. The browser copy stays where it is.

Check. The twelve store tests cover the guarantees: a saved project reads back with every value the web build wrote, a file without a version migrates, a newer version is refused, a write that cannot finish leaves the previous file and no temporary file, an id cannot leave the projects folder, the recent list is newest first, a damaged project is skipped rather than failing the list, and a damaged settings file does not stop the app.

In the shell, measured on 30 October 2026: a first launch created the data folder, the `projects/` folder and `settings.json` with the keys the interface touched, and showed the welcome list. A project placed in the folder with `lastProject` set was open in the window after a relaunch, with its two waypoints, its line and its saved map centre, and a green Saved dot beside its name.

What this pass could not click: the native open and save dialogs, and a real edit in the native window. The write half was exercised through the same code path in a browser harness with the shell stubbed (rename a project, watch one coalesced `project_save` carry the new document), and the settings write was exercised in the real window. A project edit made with the mouse in the packaged app is still unproven.

## Batch 3. NOAA and the readiness check

Delivered.

- `src-tauri/src/noaa.rs` makes the three requests `serve.py` used to relay: the same two NGS endpoints and the UFCORS form endpoint, called directly instead of through a local server, because a command has no origin to violate. It keeps `serve.py`'s choices: the WGS 84 to ECEF projection, four decimal places in the query, the four character station id, the UFCORS field order and form encoding, the archive member patterns with `re.IGNORECASE`, the 30 MB cap, the 35 second timeout, and the wording of every error.
- `src-tauri/src/preflight.rs` builds the readiness report. It keeps the shape the card reads and drops the `python` block, which no longer applies. `app` now covers the data folder's writability, because the interface is compiled into the binary and there are no loose files to miss. RTKLIB discovery looks in the bundle's resource folder, on `PATH`, and in the folders the web build searched, and it still ignores an `INSTALLED.json` that names another platform or a binary that is not there.
- The four commands are `preflight`, `noaa_nearby`, `noaa_station` and `noaa_base`. Each runs its blocking work on a worker thread, so the window keeps painting while NOAA is asked.
- `src/native.js` answers those four paths from the commands and keeps 503 for the five RTKLIB paths, which batch 4 replaces. A command failure comes back as 502 with `{ok: false, error}`, the status and body the Python proxy used for the same failure.

Check. 30 tests pass, four of them live. The last one walks the whole chain the way the job builder does, for two rover files whose approximate positions come from their own headers:

| Rover | Position | Session | Nearest station | Archive |
| --- | --- | --- | --- | --- |
| KINGS.obs | 36.0060 N, 120.1226 W | 2026-10-25 01:36 UTC | P283, 26.5 km | `p2832980.26o`, `p283_20.coord.txt`, `igr24420.sp3` |
| HUD RANGERS.obs | 42.7776 N, 71.4025 W | 2022-03-18 13:30 UTC | ZBW1, 7.9 km | `zbw10770.22o`, `zbw1_20.coord.txt`, `igs22015.sp3` |

Each search returns nine stations, the nearest is within 30 km, and its archive for the session hour comes back with an observation file, a coordinate file carrying the ITRF and NAD83 frames, and an orbit file.

Two of the 30 go through Tauri's own invoke path on the mock runtime, so the command names and the argument names the bridge sends are exercised rather than assumed. They use arguments that are refused before a request leaves, which keeps them off the network.

The other live tests cover the search for a fixed California position and the metadata behind it (38.4735 N, 121.6464 W for P268), and a base window from three days back.

Driven in a browser with the shell stubbed, the shim mapped `/api/preflight?noaa=0` to `{ noaa: false }`, the search to the three axis arguments, the base window to `station`, `date`, `start`, `hours` and `interval`, and turned each refusal into a 502 with the same sentence the Python proxy sent.

Not exercised. The readiness card in the packaged window, which needs the post-processing dialog opened and its check button pressed. The report shape and the NOAA calls behind it are covered by the tests above, but the card rendering the result with a rover file attached was not clicked through.

## Batch 4. RTKLIB

Delivered.

- The tools ship inside the app. `scripts/bundle-rtklib.sh` copies a working build into `src-tauri/resources/rtklib/<platform>/` with its BSD licence and a `BUNDLED.json` naming the version, the platform and a SHA-256 per file; `tauri.conf.json` copies that folder into the app's resources. The macOS bundle is committed: `rnx2rtkp` (833 KB) and `convbin` (657 KB) from the same 2.4.3 b34 source the web build built, so a checkout runs both jobs without a compiler.
- `src-tauri/src/rtklib.rs` owns the lookup order and the process runner. The bundle is read first, then a copy the installer placed in the data folder, then `PATH`, then the folders the web build searched, so an existing install keeps working. `preflight.rs` reports from the same list and takes the version from `BUNDLED.json` when the bundle is what answered.
- `src-tauri/src/convert.rs` is `rtklib_convert`, a port of `rtklib_convert.py`: the same format table and signature checks, the same 48 MB input and 64 MB output caps, the same temporary folder, the same refusal for a closed format such as SSF, and the same sentences.
- `src-tauri/src/correct.rs` is `rtklib_run`, a port of `rtklib_run.py`: the same 48 MB payload, 20 MB per file, 64 KB configuration and 25 MB output caps, no more than eight navigation files, a configuration that names a `file` or `path` setting refused, and the engine's own complaint passed through.
- `src-tauri/src/install.rs` is the recovery path (`rtklib_install_info`, `rtklib_install_status`, `rtklib_install`): the one pinned archive, SHA-256 verified, extracted on Windows or built from source on macOS and Linux, placed in the data folder with the install record, and refused outright when the bundle already provides the tools. The panel polls the job, so the job is the channel: step, percentage, log lines and end state.
- `src-tauri/src/failure.rs` carries the status a refusal used to have. `src/native.js` turns it back into the proxy's status, reads the query string and the body the way `serve.py` did, and sends a file as base64 because an array of forty million numbers would serialise to four times the bytes.

Check. 66 tests pass, seven are opt-in. Two of those seven drive the bundled engine:

| What | Result |
| --- | --- |
| A UBX log written to the published RXM-RAW layout, eight satellites, 120 epochs | RINEX 3.03 with 120 epochs, in 31 ms, from the bundled `convbin` |
| The NOAA ZBW1 archive for 18 March 2022 with its navigation file and SP3, through the bundled `rnx2rtkp` | A `.pos` with the header and both solution rows |
| KINGS.obs (a single-frequency GeoXT), the P283 archive for 25 October 2026 with its navigation file and the IGR orbit, run with `NORTHSTAR_FREQUENCY=l1` | A `.pos` with 249 epochs, 12 of them fixed, in 114 ms. The same job at the dual-frequency default produced no position rows at all, which is what the interface's frequency warning is for: an L1-only receiver has to be told to use L1 |

The first two were then run a second time through the web build's Python (`convert_bytes` and `run_correction`) on the same bytes, and the results are byte-identical: the observation file and the `.pos` match, including line endings. That is the parity the batch was for, because the arithmetic is the engine's and the port's job is to feed it exactly what the web build fed it.

None of the three needed a compiler: both ran from `src-tauri/resources/rtklib/macos/bin` and nothing invoked `make` or `cc`. The shell launches with the resources copied to `target/debug/rtklib/macos`, which is the first place the lookup now reads.

The bridge's new half was exercised in a Node harness with the shell stubbed: a `POST` of a byte array for a conversion arrives as base64 with the name, format and timestamp, the correction payload arrives whole, the installer routes name their commands, a 409 refusal keeps its status and its sentence, an empty conversion body is 400, and an unknown path is 404.

Not exercised. The Convert card and the post-processing dialog with a real click in the packaged window, which is the same gap batch 3 recorded for the readiness card.

The recovery installer's own arc found a defect the unit tests could not: it downloaded the pinned archive, matched its SHA-256, and then refused the extraction with "The RTKLIB archive contained an unsafe path". The containment check canonicalised the destination while comparing it against a lexically joined member path, and on macOS the temporary folder sits behind the `/var` to `/private/var` symlink, so every member looked like it escaped. The check is now lexical (reject an absolute name, a drive prefix or any `..` component) and a test extracts through a symlinked destination, which is the shape of the real failure. After that fix the opt-in installer test downloads, verifies, places both binaries and writes a record the readiness check accepts, in 21 seconds.

The Windows bundle is committed too: the two console tools from the same official archive, with the BSD licence and their hashes, so a Windows build needs no compiler. `scripts/build-windows.ps1` checks the MSVC prerequisites, runs the full test command and produces the release executable and installer. The Linux bundle is built by `scripts/bundle-rtklib-linux.sh` inside the Linux release job, because its binaries depend on that runner's glibc and WebKit stack. Still open: a Windows build driven end to end as an installed app on a Windows machine.

## Batch 5. The native shell

Goal. The app behaves like a desktop app rather than a page in a frame.

- An application menu, with the map shortcuts left alone.
- Window size, position and state restored between launches.
- A `.northstar.json` file association, and opening a file from Finder or Explorer.
- About, with the version and the third-party notices.
- Printing the selected-points report through the system dialog.

Delivered in code: the native menu dispatches to the same bridge the in-window menus use; `tauri-plugin-window-state` restores size, position and state; the bundle declares the `.northstar.json` document type and handles `RunEvent::Opened` as well as second-launch arguments; About carries the version, RTKLIB version, log paths and third-party notices; and the system print dialog receives the selected-points report. The Windows and Linux bundle metadata name the compound suffix. On macOS the custom UTI is registered, but LaunchServices resolves `.northstar.json` to `public.json`; direct Finder double-click and bare `open` do not reach the app. Exported/imported declarations, `LSHandlerRank` Owner/Default, legacy `CFBundleTypeExtensions`, `public.json`/`public.data` bindings, `NSUtiquitousDocumentUserActivityType`, and local/user `lsregister` rescans were all tested; [file-association.md](file-association.md) records the exact commands and results. A single-dot `.northstar` control resolves correctly, which isolates the failure to the compound suffix.

Check. Double-clicking a project opens it in the running window, every shortcut still reaches the map, and the printed report matches the PDF the web build produced. The interactive checks are in [packaged-verification.md](packaged-verification.md).

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

Status. The app-side updater and the tag-driven release workflow are in place. The workflow now runs `npm test` and produces macOS, Windows and Linux artifacts; Linux carries a runner-built RTKLIB bundle. Crash and frontend logs are at a documented path, and `npm run verify:package` checks the artifact, association and resources. macOS is not yet notarised and Windows is not yet Authenticode-signed, so those warnings remain. The interactive release gate is [packaged-verification.md](packaged-verification.md).

Check. A build from a clean clone installs and runs on a machine that has never had Python.

## Rules that hold across every batch

Numbers match the web build. The fixture project, its distances, areas, partition results and converted coordinates are compared between the two builds, and a difference is a defect in the port.

The look does not change. This is a port, so the CSS, the themes and the layout stay as they are. A redesign would be its own decision, taken after parity.

The project file format does not change. The web build opens what this build writes and the reverse, apart from the version field added in batch 2.

No new service. The map sources, NOAA, Nominatim and the currency rates are the ones already in use, and their attribution stays visible where it already is.

## Risks

Cesium, proj4 and Turf expect browser globals, and the content security policy has to allow the tile and terrain hosts or the globe fails with a blank canvas.

The map's keyboard shortcuts will collide with the application menu until batch 5 decides which layer owns them.

Bundled RTKLIB binaries changed where the readiness check looks, and batch 4 did it in one step: the bundle is one entry in one list, and an existing `tools/rtklib` install is still found after it. A platform whose bundle is missing falls back to the recovery installer, which needs a compiler only on macOS and Linux.

Atomic writes are the only protection against a corrupted project file, and a rename over an open file works only within one volume.

## Out of scope

No framework rewrite, no cloud sync, no multi-user server, no mobile build. The web build stays in `emrisca/Northstar` for anyone who wants it.
