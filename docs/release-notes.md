# Release notes

## 0.1.12 — Linux releases are back

The Linux job returns to the release workflow, so a tag now publishes the `.deb`
and the AppImage next to the macOS and Windows installers, with their updater
signatures and a Linux entry in `latest.json`.

It failed twice for a reason that had nothing to do with packaging: the store test
that checks the recent list saved two projects inside the same millisecond, the
files tied on their modification stamp, and the tiebreaker put the older project
first. A save now lands one millisecond past the newest project in the folder when
the stamps collide, so the recent list follows the saves, and a test sets that
collision itself instead of hoping the clock supplies one.

## 0.1.11 — selectable measures, Linux release paused

Measures are now objects you can select. The Select tool hit-tests the amber
value tag first and then the dashed line within a few pixels, so clicking a
measure opens the properties panel with its length, endpoints and snapped-end
count, and renames or removes it from there. Delete and Backspace remove it the
same way they remove a waypoint or a line. A parcel side keeps its own tolerance
and priority, so a measure drawn along a boundary side does not take over side
selection; the tag stays the way back to it. The globe's pick handler was
extended the same way, so a click on a measure in the 3D view selects it instead
of clearing the selection.

The Linux release job is paused while its packaging is fixed. Releases now carry
macOS and Windows installers only, and `latest.json` lists no Linux entry, so an
existing Linux install is not offered this version. Nothing else changed on that
path: `npm run build:linux` and `scripts/build-linux.sh` still produce the `.deb`
and AppImage locally, and `docs/packaged-verification.md` keeps the Linux check
for when the job returns.

## 0.1.10 — measures on the 3D globe

Measures now render on the Cesium globe, so switching renderers no longer makes
them vanish. Each one is the same dashed amber segment as on the 2D map, with
white endpoint dots, the same 2.5 pixel weight when unselected and 5 pixels when
selected, and the distance in the project units at its midpoint. An end that is
snapped to a waypoint keeps following that waypoint on the globe, and the layer
rebuilds only when the project data, the selection or the units change, never on
a camera move.

The globe stays read-only for measuring: with the Measure tool active, a click on
the globe does not add a waypoint, a vertex or a boundary, and pressing C leaves
an open poly line unclosed.

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
