# Release notes

## 0.1.9 — measure tool

A Measure tool now sits beside Select, Line, Poly line and Point. Click anywhere
on the map twice: Northstar draws a dashed amber line between the two clicks and
labels it with the distance in the project units, measured on the WGS 84
ellipsoid like every other length in the app. No waypoint is needed first, which
is what makes it useful for checking a span before deciding to survey it.

An end snaps to a waypoint when the click lands within 14 pixels of one, so a
measure can run from point to point and follow those points when they move. Each
measure is its own item in the object tree, under Measures, with its distance on
the row, and it can be renamed or removed from the inspector. Measures save with
the project and travel in the `.northstar.json` file, and they take part in undo.

The tool keeps to itself: it never adds a vertex, never closes a boundary and
never writes a side measurement tag, so pressing C while measuring leaves an open
poly line exactly as it was.

## 0.1.8 — Linux build fix

The 0.1.7 Linux job stopped while building RTKLIB: `rnx2rtkp` links
`lib/iers/gcc/iers.a`, and the bundle script had not built that library. The
script now builds the IERS library with `gfortran` first, and the Linux runner
installs `gfortran` and `libfuse2`. macOS and Windows artifacts are otherwise
unchanged from 0.1.7.

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
