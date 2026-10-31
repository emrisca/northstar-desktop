# Northstar Field CAD, desktop

Northstar is a field survey tool: waypoints on a map, property boundaries, distances and areas, parcel splits, GNSS corrections, and a calculator for the field. The web build lives in [emrisca/Northstar](https://github.com/emrisca/Northstar) and runs from a Python server in a browser tab.

This repository is the desktop build. It is the same interface in a native window, with the Python server replaced by Rust commands, so there is no terminal to start, no localhost, and no Python on the machine.

Status: **batch 1**. The window opens on the current interface, the map, waypoint, line and measurement code all work, and nothing loads from a content delivery network. Every script, stylesheet, font and Cesium asset is in `src/vendor` and served from disk, under a content security policy that names only the map tile services. The nine endpoints that used to come from `serve.py` answer with a message until their batch lands. [docs/plan.md](docs/plan.md) tracks each batch.

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
docs/              the inventory, the port analysis and the batch plan
```

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
