# Northstar Field CAD, desktop

Northstar is a field survey tool: waypoints on a map, property boundaries, distances and areas, parcel splits, GNSS corrections, and a calculator for the field. The web build lives in [emrisca/Northstar](https://github.com/emrisca/Northstar) and runs from a Python server in a browser tab.

This repository is the desktop build. It is the same interface in a native window, with the Python server replaced by Rust commands, so there is no terminal to start, no localhost, and no Python on the machine.

Status: **batch 4**. The window opens on the current interface, the map, waypoint, line and measurement code all work, nothing loads from a content delivery network, a project is a file on disk instead of a webview's storage, and all nine endpoints that used to come from `serve.py` answer from Rust. RTKLIB ships inside the build, so converting a raw log and running a correction need neither Python nor a compiler. [docs/plan.md](docs/plan.md) tracks each batch.

## Run it

You need Node 20 or newer for the Tauri CLI, and a Rust toolchain (stable) for the shell.

```sh
npm install
npm run dev
```

`npm run dev` compiles the shell and opens the window. The first build downloads the Rust dependencies and takes a few minutes. Later builds are seconds.

`npm run build` produces a release binary. Bundling is off until batch 7, which adds icons, signing and the installer.

## How it is put together

```text
src/               the interface: plain HTML, CSS and JavaScript, no bundler
  native.js        the bridge between the interface and the Rust shell
  vendor/          the seven libraries, Cesium and the fonts, with versions and hashes recorded
src-tauri/         the window, the Rust commands, and the Tauri configuration
src-tauri/src/store.rs   the project and settings files
src-tauri/src/noaa.rs    the NGS station search, station metadata and UFCORS base download
src-tauri/src/preflight.rs   the readiness report
src-tauri/src/rtklib.rs  where the bundled tools are, and how a child process is run
src-tauri/src/convert.rs the convbin conversion
src-tauri/src/correct.rs the rnx2rtkp correction
src-tauri/src/install.rs the RTKLIB recovery installer
src-tauri/src/failure.rs a command refusal, with the status the proxy used
src-tauri/src/lib.rs     the window, the commands and the boot payload
src-tauri/resources/rtklib/<platform>/   the RTKLIB build this app ships
docs/              the inventory, the port analysis and the batch plan
```

## Where projects live

One project is one file, `<name>.northstar.json`, in the app's data folder:

```text
~/Library/Application Support/com.emrisca.northstar/projects/
~/Library/Application Support/com.emrisca.northstar/settings.json
```

The Project menu offers Open project (a native file dialog), Recent projects (the list, which is also what a first launch shows), New project, Save now and Save a copy. A project dragged onto the window opens in the window that is already running, and so does a second launch that names a file. Saving happens on its own 400 ms after the last change, and the dot beside the project name says whether the file is current.

The project file keeps the shape the web build exports, plus a `version`. A file without one is version 1 and is migrated on read, so a project exported from the web build opens here, and a project saved here opens there.

## RTKLIB

Converting a receiver log and running a correction are the two things that used to need an install. The web build downloaded RTKLIB 2.4.3 b34 and built it from source, which needed `make` and a C compiler on the machine. This build carries the tools instead: `src-tauri/resources/rtklib/<platform>/bin` holds `rnx2rtkp` and `convbin` for the platform it was built for, with the BSD licence and a `BUNDLED.json` recording the version and a SHA-256 per file, and `tauri.conf.json` copies that folder into the app's resources.

The engine lookup reads the bundle first, then a copy the installer placed in the data folder, then `PATH`, then the folders the web build searched, so an existing install keeps working.

Refreshing the bundle is one command, run on the platform whose binaries are wanted:

```sh
scripts/bundle-rtklib.sh ../northstar/tools/rtklib
```

The installer the post-processing card offers stays as the recovery path for a build whose bundle is empty: it downloads the one pinned official archive, verifies its SHA-256, and writes only inside the app's data folder. Nothing is installed system-wide and no administrator password is requested.

## Offline

The web build fetched Leaflet, MapLibre, Turf, RBush, GeographicLib, proj4 and the two font families from five CDNs, and loaded Cesium from a CDN the first time the globe was chosen. All of it is now in `src/vendor`, at the versions the page already pinned, with [src/vendor/README.md](src/vendor/README.md) recording where each file came from and a SHA-256 over its bytes.

The content security policy in `src-tauri/tauri.conf.json` replaced a `null` value, so the webview enforces it. It allows scripts only from the app itself, plus Cesium's two needs: `'unsafe-eval'` for its shader code, `'wasm-unsafe-eval'` for its transcoders, and `blob:` because it and MapLibre build workers from blob URLs. Network access is limited to the map, imagery, terrain, overlay and parcel hosts the picker offers. No remote origin is in `script-src`, so a substituted script cannot run even if a page were tricked into asking for one.

Measured over HTTP with the policy sent as a header: 109 requests, none to a CDN, with the globe loaded from disk and an empty console.

Tauri loads `src/` directly. There is no build step for the interface, which keeps the port honest: the files here are the files the web build shipped, minus the service worker and the Python-only paths.

## The documents

| File | What it answers |
| --- | --- |
| [docs/features.md](docs/features.md) | Every behaviour the app has now, grouped, with the file that implements it |
| [docs/analysis.md](docs/analysis.md) | What each server endpoint becomes, which browser features have no desktop equivalent, and the rules that keep numbers identical |
| [docs/plan.md](docs/plan.md) | The batches, what each one finishes, and the state of each |
| [src/vendor/README.md](src/vendor/README.md) | Each vendored library's version, source and recorded hash |

## What has not changed

The interface, the light and dark themes, the project file format and the geodesic maths are the web build's. The port moves them, it does not redesign them. A distance, an area or a partition result from the desktop build has to equal the web build's on the same project, and that comparison is part of every batch.

## Licensing

Northstar bundles RTKLIB 2.4.3 (BSD 2-Clause) from batch 4. The licence travels with the tools and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) records it. Map services keep their own attribution, which the interface displays in the map corner.
