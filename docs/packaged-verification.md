# Packaged-app verification

This is the release gate for the behaviours that only exist in the installed
application. `npm test` covers the interface and the Rust commands;
`npm run verify:package` covers the artifacts. The steps below cover the
operating-system dialogs and the installed-updater path that a browser harness
cannot reach.

Run this on the platform being released, from a checkout that has just been
built with `npm run build`. Record the result in the release notes or the
release checklist. A check that was not performed is not a pass.

## Automated artifact checks

```sh
npm run build
npm run verify:package
```

The command fails unless it finds a packaged artifact, the
`.northstar.json` file association in `src-tauri/tauri.conf.json`, and this
platform's RTKLIB bundle with both tools, `BUNDLED.json` and `LICENSE.txt`.
It prints the interactive checklist below when those pass.

## Interactive checks

1. **Clean install.** Install the artifact on a machine that has never had
   Northstar, Python or RTKLIB. Launch it from the installed application, not
   from the checkout.
2. **Native open dialog.** Choose **File > Open Project…**. Select a
   `.northstar.json` project. The project opens in the current window. Cancel
   the dialog once and confirm nothing changes.
3. **Native save dialog.** Choose **File > Save a Copy…**, save to a new
   folder, reopen that copy, and confirm the project contents.
4. **File association.** Quit Northstar. On Windows, double-click a
   `.northstar.json` project in Explorer and confirm it opens in Northstar.
   On Linux, install the `.deb` and confirm the desktop entry lists Northstar for
   JSON projects. On macOS, run the audit below; the observed result is that
   LaunchServices resolves the sample to `public.json`, so direct double-click
   and bare `open` do not reach Northstar. Use **File > Open Project…** for the
   supported path, and record that direct association is not supported. In every
   case, with Northstar already running, open a second project and confirm it
   uses the existing window rather than starting a second instance.
5. **Window state.** Resize and move the window, maximize it, quit, and launch
   again. The size, position and maximized state return. Repeat after a
   display or scale change and confirm the window remains reachable.
6. **Native menu and shortcuts.** Confirm **File**, **View** and **Help** appear
   in the OS menu (macOS also has the Northstar application menu). Use
   `Cmd/Ctrl+O`, `Cmd/Ctrl+S`, `Cmd/Ctrl+Shift+S`, `Cmd/Ctrl+N` and
   `Cmd/Ctrl+P`. Then confirm the map shortcuts still work: `V`, `P`, `L`, `C`
   and `D`.
7. **About and logs.** Open **About Northstar** from the application or Help
   menu. It shows the installed version, the RTKLIB version, the exact log
   paths, and the third-party notices. Choose **Open log folder** and confirm
   the file manager opens that folder.
8. **Printing.** With waypoints in the project, choose
   **File > Print Selected-Points Report…**. The system print dialog opens.
   The preview contains the project name, lines, saved measurements, every
   selected waypoint's name, latitude and longitude, and the project-reference
   footnote. Cancel the dialog and confirm the app remains usable.
9. **Update installation.** Install the previous release. Open Settings, choose
   **Check for updates**, and install the new version. Confirm the signature is
   accepted, the app restarts (or the Windows installer completes), and the
   reported version is the new one. A deliberately corrupted update must be
   refused.
10. **Readiness and RTKLIB.** Open the post-processing dialog with a rover file.
    Press the readiness check. It reports the bundled RTKLIB version and the
    NOAA result. Run a conversion from the Convert card and a correction from
    the review step. The `.pos` result should carry the expected epochs; the
    bundled tools must not require Python, a compiler or an RTKLIB install.
11. **Crash log.** Confirm `northstar.log` contains the startup line from this
    launch. In a debug build, trigger a frontend exception and confirm
    `northstar.log` records it. A Rust panic writes `crash.log` in the same
    folder. Do not cause a panic in a release candidate unless the release
    owner asks for it.

## Where the logs are

The About dialog shows the exact path on the installed machine. The defaults
are:

| Platform | Log folder |
| --- | --- |
| macOS | `~/Library/Logs/com.emrisca.northstar` |
| Windows | `%LOCALAPPDATA%\com.emrisca.northstar\logs` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/com.emrisca.northstar/logs` |

`northstar.log` receives startup and frontend errors. `crash.log` receives
Rust panics with a backtrace and the panic location. An explicit file-open
records `INFO project: opened <path>` after the project has been read.

## macOS file-association audit

The full experiment log is in [file-association.md](file-association.md). To
repeat the current result:

```sh
APP=src-tauri/target/debug/bundle/macos/Northstar.app
SAMPLE=.tmp/association-test.northstar.json
plutil -p "$APP/Contents/Info.plist" | grep -A12 CFBundleDocumentTypes
mdls -name kMDItemContentType -name kMDItemContentTypeTree "$SAMPLE"
open "$SAMPLE"
```

On macOS 26.6.2, `mdls` reports `public.json`, the LaunchServices default is the
system JSON editor, and no Northstar process or `project: opened` log line is
created. The bundle's own `.northstar.json` UTI and Owner claim are present in
`lsregister -dump`, but a compound filename suffix is not resolved to that UTI.
This is a platform limitation, not an unchecked application path.

## Linux release check

Run the Linux job's artifact through the same checks, plus:

```sh
scripts/bundle-rtklib-linux.sh
npm test
npm run verify:package
```

The script builds RTKLIB's `lib/iers/gcc/iers.a` with `gfortran` before
linking `rnx2rtkp`; the release runner installs `gfortran` for that step. The
Linux bundle is built in the release runner from the pinned RTKLIB archive
because its binaries depend on that runner's glibc and WebKit stack. The job
must leave a `.deb` and an `.AppImage`, and the AppImage must launch with the
bundled `rnx2rtkp` and `convbin`.
