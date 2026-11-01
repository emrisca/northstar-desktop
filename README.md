# Northstar Field CAD, desktop

Northstar is a field survey tool: waypoints on a map, property boundaries, distances and areas, parcel splits, GNSS corrections, and a calculator for the field. The web build lives in [emrisca/Northstar](https://github.com/emrisca/Northstar) and runs from a Python server in a browser tab.

This repository is the desktop build. It is the same interface in a native window, with the Python server replaced by Rust commands, so there is no terminal to start, no localhost, and no Python on the machine.

Status: **batch 7, release hardening**. The window opens on the current interface, the map, waypoint, line and measurement code all work, nothing loads from a content delivery network, a project is a file on disk instead of a webview's storage, and all nine endpoints that used to come from `serve.py` answer from Rust. RTKLIB ships inside the build, so converting a raw log and running a correction need neither Python nor a compiler. The native shell now has a window-state plugin, a `.northstar.json` file association, a native application menu, About with third-party notices, a system-print report, and crash and frontend logs at a documented path. `npm test` runs the browser and Rust suites. Linux `.deb` and AppImage packages are built by the release workflow, with a Linux RTKLIB bundle built on the runner. macOS notarisation and Windows Authenticode signing remain open. [docs/plan.md](docs/plan.md) tracks each batch, and [docs/packaged-verification.md](docs/packaged-verification.md) is the installed-app release gate.

## Run it

You need Node 20 or newer for the Tauri CLI, and a Rust toolchain (stable) for the shell.

```sh
npm ci
npm run dev
```

`npm run dev` compiles the shell and opens the window. The first build downloads the Rust dependencies and takes a few minutes. Later builds are seconds.

`npm run build` produces the app bundle, its installer, and the signed updater artifact. The build needs the updater signing key; see [Updates](#updates).

### Partition regression harness

`npm run test:partition` serves `src/` on loopback and runs the real desktop interface in the installed Chrome through Playwright. It covers area split, equal parts, cut between two vertices, and drawn cut, plus the Line and Poly line tools, DXF import/export, and the project units. For each partition method it accepts the partition, checks every preview area against the GeographicLib area of the accepted part, and then saves and checks the matching map tag. Chrome must be installed; no browser is downloaded by the harness. `npm test` runs this suite and then the Rust suite.

### Windows

Windows needs the MSVC Rust host and the Visual Studio C++ tools; the WebView2 runtime is already part of Windows 10 and 11.

1. Install Node 20 or newer.
2. Install Rust from <https://rustup.rs/> and keep the default `x86_64-pc-windows-msvc` host.
3. Install **Visual Studio Build Tools 2022** and tick **Desktop development with C++**, which supplies `link.exe`, the MSVC libraries and the Windows SDK.

Then, from PowerShell in this folder:

```powershell
npm ci
npm run dev
```

For a release build, run the script. It checks those prerequisites, runs `npm test`, builds the installer, runs the packaged-artifact checks, and leaves the executable at `src-tauri\target\release\northstar.exe`:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1
```

`-SkipTests` skips the frontend and Rust suites. The script produces the portable executable, the NSIS installer and the updater artifact. The Windows RTKLIB bundle is committed in `src-tauri/resources/rtklib/windows`, so conversion and correction need neither a compiler nor an RTKLIB install. `npm run verify:package` checks the produced artifact and its bundled resources.

### Linux

Linux needs the WebKitGTK 4.1 and GTK development packages, `make`, C and Fortran compilers, and the usual Rust and Node toolchains. On Debian or Ubuntu:

```sh
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libappindicator3-dev librsvg2-dev patchelf build-essential gfortran libfuse2 curl unzip
npm ci
scripts/build-linux.sh
```

The script builds the pinned RTKLIB bundle for the runner's glibc and WebKit stack, runs `npm test`, builds a `.deb` and an AppImage, and runs `npm run verify:package`. The output is under `src-tauri/target/release/bundle/`; `--skip-tests` is available when the suites have already run.

## Updates

Northstar checks `https://github.com/emrisca/northstar-desktop/releases/latest/download/latest.json` about ten seconds after launch, every six hours while open, and whenever **Check for updates** is pressed in Settings. When a newer version is waiting, a pill appears in the top bar; it opens one dialog with the version and notes. **Update now** downloads, verifies the minisign signature, installs and restarts. Nothing installs without that click, and a failed check is silent.

The public key in `src-tauri/tauri.conf.json` belongs to the signing key. The private key is not in this repository: on this machine it is under `.secrets/`, which Git ignores. Move it to a password manager, and set these two variables for a release build:

```sh
TAURI_SIGNING_PRIVATE_KEY=/path/to/northstar-updater.key
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=the-key-password
npm run build
```

The same two values are the GitHub Actions secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` for the release workflow. Pushing a tag such as `v0.1.8` builds macOS, Windows and Linux on hosted runners, publishes the installers, and writes `latest.json` beside them. The source repository is public, so the app reads that file without a token.

## How it is put together

```text
src/               the interface: plain HTML, CSS and JavaScript, no bundler
  native.js        the bridge between the interface and the Rust shell
  vendor/          the seven libraries, Cesium and the fonts, with versions and hashes recorded
src-tauri/         the window, the Rust commands, and the Tauri configuration
src-tauri/src/store.rs   the project and settings files
src-tauri/src/update.rs  the update check, install and notification
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

Windows uses the same two files under `%APPDATA%\com.emrisca.northstar\`.

The Project menu offers Open project (a native file dialog), Recent projects (the list, which is also what a first launch shows), New project, Save now and Save a copy. A project dragged onto the window opens in the window that is already running, and so does a second launch that names a file. Saving happens on its own 400 ms after the last change, and the dot beside the project name says whether the file is current.

The project file keeps the shape the web build exports, plus a `version`. A file without one is version 1 and is migrated on read, so a project exported from the web build opens here, and a project saved here opens there. The bundle declares a `.northstar.json` document type and hands a launched path to the running window. Windows and Linux packages declare the suffix in their installer metadata. On macOS, the custom UTI is registered, but LaunchServices resolves a sample `.northstar.json` to `public.json`; the default handler and a bare `open` therefore stay with the system JSON handler, and Northstar is not in the `public.json` handler list. Use **File > Open Project…**, or an explicit `open -a Northstar <file>`. [docs/file-association.md](docs/file-association.md) records the exact variants and the observed limits.

## Desktop integration

- **Native menu.** macOS gets the standard application menu with About, Settings, Services, Hide and Quit; all platforms get File, View and Help menus. File carries Open, Recent, New, Save, Save a Copy, Print and Close. The shortcuts use `Cmd/Ctrl` modifiers, so the map's `V`, `P`, `L`, `C` and `D` shortcuts are untouched.
- **Window state.** `tauri-plugin-window-state` restores the window's size, position, maximized and full-screen state on the next launch.
- **Printing.** **File > Print Selected-Points Report…** builds the selected-points report and opens the system print dialog. The report carries the project name, lines, saved measurements and each waypoint's WGS 84 coordinates.
- **About.** The About box reports the installed version, platform, RTKLIB version, exact log paths and the compiled-in third-party notices.
- **Logs.** The shell writes `northstar.log` for startup and frontend errors and `crash.log` for Rust panics. The About box and **Help > Open Log Folder** reveal the platform path. On macOS it is `~/Library/Logs/com.emrisca.northstar`, on Windows `%LOCALAPPDATA%\com.emrisca.northstar\logs`, and on Linux under `$XDG_DATA_HOME/com.emrisca.northstar/logs`.

The installed-app checks that cannot be driven from a browser are listed in [docs/packaged-verification.md](docs/packaged-verification.md). `npm run verify:package` checks the artifact, the file association and the platform's RTKLIB bundle before those steps are recorded.

## RTKLIB

Converting a receiver log and running a correction are the two things that used to need an install. The web build downloaded RTKLIB 2.4.3 b34 and built it from source, which needed `make` and a C compiler on the machine. This build carries the tools instead: `src-tauri/resources/rtklib/<platform>/bin` holds `rnx2rtkp` and `convbin` for the platform it was built for, with the BSD licence and a `BUNDLED.json` recording the version and a SHA-256 per file, and `tauri.conf.json` copies that folder into the app's resources.

The engine lookup reads the bundle first, then a copy the installer placed in the data folder, then `PATH`, then the folders the web build searched, so an existing install keeps working. The macOS and Windows bundles are committed; the Windows folder carries the two console tools and the licence, not RTKLIB's GUI programs. The Linux bundle is built by `scripts/bundle-rtklib-linux.sh` on the Linux release runner from the same pinned archive, with the same SHA-256 check, because its binaries depend on that runner's glibc and WebKit stack.

Refreshing the bundle is one command. Run it on the platform whose binaries are wanted:

```sh
scripts/bundle-rtklib.sh ../northstar/tools/rtklib
```

When the folder holds another platform's native binaries — the official Windows archive unpacked on a Mac, for example — name the platform:

```sh
scripts/bundle-rtklib.sh --platform windows /path/to/RTKLIB_2.4.3_b34
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
| [docs/packaged-verification.md](docs/packaged-verification.md) | The installed-app release gate: artifact checks plus the native dialogs, menu, update, printing and RTKLIB checks |
| [docs/file-association.md](docs/file-association.md) | What macOS LaunchServices does with `.northstar.json`, the variants tested and the observed result |
| [docs/release-notes.md](docs/release-notes.md) | The current release's user-visible changes and the file-association caveat |
| [src/vendor/README.md](src/vendor/README.md) | Each vendored library's version, source and recorded hash |

## What has not changed

The interface, the light and dark themes, the project file format and the geodesic maths are the web build's. The port moves them, it does not redesign them. A distance, an area or a partition result from the desktop build has to equal the web build's on the same project, and that comparison is part of every batch.

## Licensing

Northstar bundles RTKLIB 2.4.3 (BSD 2-Clause) from batch 4. The licence travels with the tools and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) records it. Map services keep their own attribution, which the interface displays in the map corner.
