# Release notes

## 0.1.13 — offline tiles, one 2D engine, a macOS association that works

The map keeps its tiles on disk. `src-tauri/src/tilecache.rs` stores every raster,
terrain and overlay tile under the app data folder, keyed by URL, capped at 1 GiB
with least-recently-used eviction, and the page asks for a tile through the
`northstar-tile://` scheme so the webview never touches the folder. Only https
URLs on the tile hosts the picker offers are fetched. Vector basemaps keep their
direct URLs for now: their requests go through `fetch`, which has not been
measured on a custom scheme under WebKit.

The 2D map is one engine. Every basemap, raster tiles included, is drawn by
MapLibre GL through the Leaflet bridge, so the separate Leaflet raster engine and
its button are gone and the picker offers **2D map** and **3D globe**. The globe
now hands back to 2D with a message when a basemap has no equivalent there,
instead of quietly drawing a different one.

Measurement and angle tags stay on screen while zooming. Their rebuild stamp
included the map zoom, so every frame of a zoom tore the marker layers down and
rebuilt them; they now hold through the animation and rebuild once when it
settles.

Files open by double-click on macOS. The bundle declares `.northstar` as well as
the older `.northstar.json`, and LaunchServices resolves the single-dot suffix to
Northstar, which the compound one never did on this system. `.northstar.json`
files still open from **File > Open Project…**, and **Save a copy…** now writes
the single-dot name so the file it produces is the one Finder opens. The Windows
and Linux metadata name both suffixes.

Two switches moved. Address lookup on a map click is a Settings → Map option
instead of always on, and the parcel-lines switch now lives in the Overlays menu
next to the parcel source it belongs to.

The offline work ships with measured budgets: 507 ms to load a ten thousand
waypoint project, 7 ms to rebuild the hit index, 2.2 ms for the median frame,
with every non-local request blocked. `npm test` enforces the ceilings.

macOS and Windows builds remain unsigned. Notarisation and Authenticode both need
paid certificates, which are out of scope for a personal build, so macOS shows
the unidentified-developer warning once. The updater is signed separately with
the Tauri key and works.

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
- The bundle declares `.northstar` and the older `.northstar.json`, and the Windows and Linux package metadata name both.

### macOS file association

The bundle declares `.northstar` as well as the older `.northstar.json`. On macOS
26.6.2 LaunchServices resolves a `.northstar` sample to
`com.emrisca.northstar.project` and to Northstar, so Finder double-click and a
bare `open` reach the app. A compound `.northstar.json` still resolves to
`public.json` whatever the declaration says, so those files open with
**File > Open Project…** or an explicit `open -a`. **Save a copy…** writes the
single-dot name for that reason. [file-association.md](file-association.md)
records the probe output and the variants that failed.
