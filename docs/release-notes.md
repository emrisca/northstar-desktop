# Release notes

## 0.1.7 — desktop hardening

- Window size, position, maximized and full-screen state restore between
  launches.
- Native File, View and Help menus, with the macOS application menu; the map's
  own shortcuts are unchanged.
- A documented log folder: `northstar.log` for startup and frontend errors,
  `crash.log` for Rust panics. About and **Help > Open Log Folder** show the
  exact path on the installed machine.
- **File > Print Selected-Points Report…** sends the report to the system print
  dialog.
- `npm test` runs the browser and Rust suites.
- Linux `.deb` and AppImage builds, with an RTKLIB bundle built from the pinned
  archive on the release runner.
- The bundle declares `.northstar.json` for Windows and Linux package metadata.

### macOS file association

On macOS, the bundle declares and registers a custom Northstar UTI, but
LaunchServices resolves a `.northstar.json` sample as `public.json`. A Finder
double-click or a bare `open sample.northstar.json` therefore does not reach
Northstar. Use **File > Open Project…**, or open the app explicitly with the
file. The custom UTI resolves correctly for a single-dot `.northstar` control
file, which isolates the failure to the compound suffix. The exact variants,
commands and observed results are in
[file-association.md](file-association.md).
