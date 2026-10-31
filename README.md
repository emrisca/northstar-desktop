# Northstar Field CAD, desktop

Northstar is a field survey tool: waypoints on a map, property boundaries, distances and areas, parcel splits, GNSS corrections, and a calculator for the field. The web build lives in [emrisca/Northstar](https://github.com/emrisca/Northstar) and runs from a Python server in a browser tab.

This repository is the desktop build. It is the same interface in a native window, with the Python server replaced by Rust commands, so there is no terminal to start, no localhost, and no Python on the machine.

Status: **batch 0**. The window opens on the current interface and the map, waypoint, line and measurement code all work. The nine endpoints that used to come from `serve.py` answer with a message until their batch lands. [docs/plan.md](docs/plan.md) tracks each batch.

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
src-tauri/         the window, the Rust commands, and the Tauri configuration
docs/              the inventory, the port analysis and the batch plan
```

Tauri loads `src/` directly. There is no build step for the interface, which keeps the port honest: the files here are the files the web build shipped, minus the service worker and the Python-only paths.

## The documents

| File | What it answers |
| --- | --- |
| [docs/features.md](docs/features.md) | Every behaviour the app has now, grouped, with the file that implements it |
| [docs/analysis.md](docs/analysis.md) | What each server endpoint becomes, which browser features have no desktop equivalent, and the rules that keep numbers identical |
| [docs/plan.md](docs/plan.md) | The batches, what each one finishes, and the state of each |

## What has not changed

The interface, the light and dark themes, the project file format and the geodesic maths are the web build's. The port moves them, it does not redesign them. A distance, an area or a partition result from the desktop build has to equal the web build's on the same project, and that comparison is part of every batch.

## Licensing

Northstar bundles RTKLIB 2.4.3 (BSD 2-Clause) from batch 4. The licence travels with the tools and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) records it. Map services keep their own attribution, which the interface displays in the map corner.
