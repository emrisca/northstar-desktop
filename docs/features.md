# What Northstar does

Every behaviour in the web build, grouped by where the person meets it. The file in backticks is where the behaviour lives in `src/`. Each section ends with the batch in [plan.md](plan.md) that makes it work in the desktop build, because moving a feature is a separate job from having it.

## 1. The map

- Two rendering engines, chosen in the basemap picker: a 2D map where every basemap, raster tiles or vector style, is drawn by MapLibre GL through the Leaflet bridge so zoom is continuous, and a 3D globe built on CesiumJS. `mapstyles.js`, `cesium-view.js`, `app.js`
- About eighteen basemap entries across street, satellite, aerial, topographic, historical and blank. The picker names the active one. `mapstyles.js`
- OpenHistoricalMap group with four looks at the same data (OpenHistoricalMap, Woodblock, Japanese scroll, Railway), each obeying a year slider from 1700 to 2026 that filters features by `start_decdate` and `end_decdate`. `app.js`, `mapstyles.js`
- Live changeset watch while a historical basemap is selected: one request a minute for newly closed OpenHistoricalMap changesets, refreshed only when one overlaps the current view, paused while the tab is hidden. `app.js`
- Blank grid: a real latitude and longitude graticule drawn from the same projection as the online map, labelled to position, spacing tied to zoom, with selection, dragging and drawing working offline. `app.js`
- Zoom controls, a zoom percentage readout, and Fit to waypoints. `app.js`
- Refresh button for tiles that stop showing, plus the map error banner with Retry. `app.js`
- Status bar with cursor coordinates (click to copy), zoom, scale, map center and waypoint count. `app.js`
- Cesium World Terrain behind an optional free Cesium ion token, stored locally, with the globe usable on a smooth ellipsoid without one. `cesium-view.js`

## 2. Overlays

- Assessor parcel lines from free statewide services, picked per viewport from a registry covering 22 states, with a source pin, zoom limit at level 12, a subset notice on busy viewports, and stale request aborts. `parcels.js`
- Terrain overlays: hillshade, slope and contours, each with an opacity slider. `mapstyles.js`
- Geology from Macrostrat, water features from USGS hydrography, PLSS from BLM, public lands from PAD-US. `mapstyles.js`
- NOAA coastal data as an external link to the Data Access Viewer. `app.js`

## 3. Drawing and editing

- Point tool, which stays active for several points, and Add point, which takes a typed name and a coordinate in five formats. `app.js`, `coords.js`
- Line tool that connects two waypoints, and Poly line that keeps adding connected waypoints, rings the last vertex, draws a snapping rubber band with a live distance, and closes into a parcel when you click the first vertex of three or more. `app.js`
- Measure tool that joins any two map clicks with a dashed amber line and its distance in the project units, snapping an end to a waypoint within 14 pixels, listing each measure under Measures in the object tree, and leaving lines, boundaries and side tags untouched. The same measures render on the 2D canvas, the Leaflet basemaps and the Cesium globe, with endpoint dots and the distance label, following snapped waypoints and rebuilding only when the data or selection changes. `app.js`, `cesium-view.js`
- Rectangle tool through Terra Draw, one undoable feature that saves with the project. `app.js`
- Select tool, with waypoint dragging that updates coordinates and recalculates dependent parcels and measurements on release, as one undo step. `app.js`
- Boundary side editing: delete a side (a closed parcel reopens, an open line splits or disappears), and add a break by clicking a side with the Point tool. `app.js`
- Offset line tool. `offset.js`
- Undo and redo over waypoints, lines, parcels, measurements, moves, partitions, side edits and clears. `app.js`
- Object tree with selection, removal, and a per-row menu for symbol and label. `app.js`
- Properties panel per selection type, with rename, remove, coordinate editing, Zoom to, and the partition entry. `app.js`
- Point symbols (circle, pin, square, triangle, diamond, star, cross, flag) and persistent map labels carrying name and coordinates. `app.js`

## 4. Measuring

- Side length and parcel area from geodesic maths on the WGS 84 ellipsoid, through GeographicLib. `geodesy.js`, `app.js`
- Units for area and length with memory across parcels, three significant digits for small values, up to two decimals for large ones. `app.js`
- Invalid-shape detection for figure eights, self-touching outlines and repeated vertices, shown as Not valid, with partitioning refused. `app.js`
- Saved measurements that follow later geometry edits, stored with the unit and the ground setting they were created with. `app.js`
- Global outside tag placement in Settings: one checkbox moves side measurement tags outside their lines. Side tags stay horizontal, clear the boundary, and use a short leader back to the measurement instead of rotating; parcel area tags remain centered in the parcel. `app.js`

## 5. Ground values and terrain

- Ground reduction with the R/(R+h) distance factor and its square for area, applied to new measurements and to the selected parcel summary, with a per-measurement override. `app.js`
- Project height in feet or metres, with a button that copies the selected line's terrain mean into it. `app.js`
- Terrain profile for a selected line, parcel or side: sampled from USGS 3DEP, drawn as a chart with low, high, gain and loss figures in the current length unit, sample spacing, and a note about the source cell size. `terrain.js`, `app.js`

## 6. Parcel partition

- Area split, cutting one part of a typed target area. `app.js`
- Equal parts from 2 to 20, with a cut direction of Free, Vertical, Horizontal or between two named sides. `app.js`
- Cut between two vertices, a straight line between two corners. `app.js`
- Drawn line across the parcel, with Free, north and south, or east and west direction locking, spans cut only where the drawn line reaches, extension along its own direction, and multi-span cuts on concave shapes. `app.js`
- Equal parts from the drawn line, sliding cuts between the two crossed sides. `app.js`
- Options for frontage side, cut angle, measurement origin, minimum area and minimum frontage, and whether failing parts are allowed. `app.js`
- Auto fit, which tries every frontage course and, without square mode, every angle from 0 to 177 degrees in 3 degree steps then refines to a tenth, ranking by failing parts, worst shape, frontage spread and course length. `app.js`
- Preview, accepted-part summaries, and map area tags use the same WGS 84 GeographicLib area basis, so a cut's displayed areas agree after acceptance. `app.js`, `geodesy.js`
- Ground-valued targets and minimums with a label on accepted parts, and one undo step for the accepted result. `app.js`

## 7. Coordinates

- Storage always in EPSG:4326, with the geometry CRS stated in Settings. `app.js`
- A global CRS for readouts and as the default for table imports, chosen from a searchable picker covering roughly 150 systems: the NAD83 family, six California State Plane zones in metres and US survey feet, British National Grid, Irish Transverse Mercator, Lambert-93, RD New, three ETRS89 UTM zones, SWEREF 99 TM, TM35FIN, two NAD83 UTM zones, SIRGAS 2000 UTM 23S, GDA94 and GDA2020 MGA 55, NZTM2000, and every WGS 84 UTM zone. `crs.js`
- The datum approximations are documented in the interface: NAD83 treated as coincident with WGS 84, Helmert-only shifts for the European grids, no OSTN15 grid files. `crs.js`
- Parsing of decimal degrees, degrees and decimal minutes, degrees minutes seconds, UTM with zone and band letters including the S band ambiguity, and MGRS at any of the five precisions. `coords.js`
- UTM zone, easting and northing shown per waypoint, with matching CSV export columns. `utm.js`, `app.js`
- Coordinate converter tool with a paste field that reports the format it read. `app.js`, `coords.js`

## 8. Import and export

- Import of CSV, TXT, GeoJSON, GPX, KML and DXF points. `app.js`, `dxf.js`
- Table import for files without latitude and longitude columns: pick easting and northing columns, an optional name column, and the CRS, with a preview of the first converted row. `crsimport.js`
- Project export and import as `.northstar.json`, covering the object tree, basemaps, the historical year, saved jobs and accepted results. `app.js`, `postprocess.js`
- Selected-point export as PDF report, DXF, KML, GPX, GeoJSON, CSV or LandXML, with a chooser for which waypoints to include. `app.js`, `dxf.js`
- CSV export with UTM columns. `app.js`

## 9. Search

- Coordinate search in five formats, centering the map and dropping a temporary pin that clears on the next search, Escape, or 30 seconds. `coords.js`, `app.js`
- Address and place search through Nominatim, one request at a time, results cached for the session, multiple matches offered as a list. `app.js`
- Assessor parcel address match: house number plus street words searched against the parcel service within about two kilometres of the geocoder answer or the ZIP, landing on the parcel center and naming the parcel and its APN. `parcels.js`, `app.js`

## 10. GNSS intake

- RINEX observation inspection for one or more files, with a summary (files, epochs, time span, constellations) and per-file properties (format, marker name and number, observer, agency, receiver, antenna and delta, time system, first and last observation, duration, epochs, interval, satellites, observation codes, carrier phase, L1 and L2, approximate position, ellipsoid height). `rinex-inspect.js`, `rinex.js`
- Marker plotting from a readable header, with a per-file checkbox, waypoints added with symbols and labels, and station-number marker names replaced by the file name. `rinex-inspect.js`
- Conversion of RINEX 3 to RINEX 2.11, CSV and GeoJSON, with the loss of signals RINEX 2 cannot store stated in the interface. `convert.js`, `rinex.js`
- Format identification across RINEX observation, RINEX navigation, Hatanaka, processed `.pos`, binary receiver logs and closed formats, with a refusal and an explanation for the last. `convert.js`, `rinex.js`
- Binary log conversion through RTKLIB convbin for UBX, SBF, RT17, OEM3, OEM4/6/7, RTCM 2/3, BINEX, GREIS, BIN, STQ, BINR and SS2, with a manual format override, a 48 MB input cap, and gzip decompression in the browser first. `convert.js`, `rtklib_convert`
- Use as rover from a converted observation, which opens the post-processing wizard at its base step. `convert.js`, `postprocess.js`

## 11. Post-processing

- Four steps: rover file, base station, processing options, review. `postprocess.js`
- Rover checks for carrier phase, L2, session length and approximate position, with missing carrier phase blocking the job. `postprocess.js`, `rinex.js`
- NOAA CORS search for the nine nearest stations, station detail, and base window download including observations, navigation, precise SP3 and the station coordinate file. `postprocess.js`, `serve.py` proxy
- Manual base entry with observation, navigation and optional SP3 files. `postprocess.js`
- Base frame choice between NAD83(2011) and ITRF2020, with velocity propagation to the session epoch when NGS publishes one, and no silent transformations. `postprocess.js`
- Processing options with conservative defaults: static, L1 and L2, 10 degree mask, continuous ambiguity resolution, broadcast navigation, combined forward and backward. `postprocess.js`
- Checks in review: epoch overlap, baseline length, session length, antenna metadata, attached ephemeris coverage per constellation, and the foreign navigation file warning. `postprocess.js`
- Job package download containing the configuration, the observations and a README with the exact command. `postprocess.js`
- Corrected `.pos` import, averaging only fixed (Q=1) epochs, with the result written to a waypoint carrying provenance. `postprocess.js`, `gnss.js`
- Saved jobs, up to twenty, with a read-only review of the checks, base, result and command, a plain-text report download, and deletion that leaves accepted waypoints alone. `postprocess.js`
- Readiness card with tool discovery, the NOAA reachability request, and the rover checks in one place. `postprocess.js`, `preflight`

## 12. RTKLIB

- RTKLIB 2.4.3 b34 ships inside the build, one folder per platform, with the BSD licence and a `BUNDLED.json` recording the version and a SHA-256 per file. macOS and Windows bundles are committed; Linux is built by `scripts/bundle-rtklib-linux.sh` in the Linux release runner. `scripts/bundle-rtklib.sh`, `src-tauri/resources/rtklib`
- Engine lookup in this order: the bundle, a copy the installer placed in the data folder, `PATH`, then the folders the web build searched. `rtklib.rs`, `preflight`
- Recovery installer for a build with no bundle: the one pinned official archive, SHA-256 verified, written only inside the app's data folder, with a stated method (official Windows binaries, or a source build with `make` and a C compiler). `postprocess.js`, `rtklib_install`
- Install progress with percentage and step text, polled from a background job. `postprocess.js`, `rtklib_install`
- Install record naming the platform and the installed binaries, trusted only when those binaries still resolve in this installation. `rtklib_install`, `preflight`
- Local correction run with `rnx2rtkp` in a temporary folder, returning the `.pos` and deleting the temporaries. `postprocess.js`, `rtklib_run`
- The `setup.py` command-line check and installer, which the desktop build replaces with the same readiness command. `setup.py`

## 13. Calculator

- Five modes: basic, scientific, programmer, convert and RPN. `calculator.js`
- Basic arithmetic with percent, sign, square root, square, reciprocal, backspace and memory keys. `calculator.js`
- Scientific functions with a degree and radian switch, and Ans and Rand. `calculator.js`
- Programmer mode with 8, 16, 32 and 64 bit words, four bases, signed display, bitwise operations, shifts and modulus. `calculator.js`
- Unit conversion across length, area, volume, mass, temperature, speed, time, pressure, energy, power, data, angle, fuel economy and currency, the last using daily ECB rates when online. `calculator.js`
- RPN with a four-level stack. `calculator.js`
- Notes with one expression per line, variable assignment and a 2D graph. `calculator.js`
- History, copy result, a keyboard guide, drag to move, grip to resize, and remembered size, position, mode, history, notes and open state. `calculator.js`
- Keyboard mode switching, Enter, Backspace, Delete, Escape and the degree toggle. `calculator.js`

## 14. Settings and appearance

- Theme of Light, Dark or System, and four accent colours, with the header sun and moon toggle updating the same setting. `app.js`
- Terrain profile toggle. `app.js`
- Cesium World Terrain toggle and ion token field. `app.js`
- Ground reduction toggle, project height and its unit, and the terrain mean shortcut. `app.js`
- Global CRS picker. `crs.js`, `app.js`
- Reset to defaults. `app.js`

## 15. What the app remembers

- The project, autosaved on every change, including the basemap, the historical year, the map center and zoom. `app.js`
- Dock section sizes and visibility, and the panel width. `app.js`
- Every setting above, and the calculator's state. `app.js`, `calculator.js`
- Saved GNSS jobs, up to twenty per project. `postprocess.js`

The web build keeps all of this in `localStorage`. The desktop build keeps the project in its own file and the rest in `settings.json` beside the projects, mirrors every change to them 400 ms after it happens, and writes a batch 0 browser copy to a file once on first launch without deleting it.

## 16. Window and keyboard

- Header with the logo, editable workspace name, Project menu, Tools menu, undo and redo, theme toggle, calculator, and Settings. The desktop shell also installs a native application menu with File, View and Help; its commands dispatch to the same bridge functions. `app.js`, `index.html`, `src-tauri/src/menu.rs`
- Left panel with the object tree, properties and waypoint list, resizable by two drag bars, collapsible per section with a list of hidden sections. `app.js`
- Shortcuts: V, P, L for tools, C to close a line, D to partition, Escape to return to Select, Delete or Backspace to remove the selection, and the undo and redo modifiers. `app.js`
- Save status and version at the bottom left of the window. `app.js`

## 17. Desktop shell and logs

- Window size, position, maximized and full-screen state are restored by `tauri-plugin-window-state`. `src-tauri/src/lib.rs`
- The bundle declares a `.northstar.json` document type; Windows and Linux packages declare the suffix, and a second launch or dropped file opens in the running window. On macOS the custom UTI is registered, but LaunchServices classifies the compound suffix as `public.json`; macOS direct double-click and bare `open` therefore do not reach Northstar, while **File > Open Project…** and an explicit `open -a` do. `src-tauri/src/lib.rs`, `src-tauri/tauri.conf.json`, [file-association.md](file-association.md)
- About reports the version, platform, RTKLIB version, exact log paths and third-party notices. `src/native.js`, `src-tauri/src/lib.rs`
- `northstar.log` records startup and frontend exceptions; `crash.log` records Rust panics with a backtrace. Help > Open Log Folder reveals the platform log directory. `src-tauri/src/logging.rs`
- File > Print Selected-Points Report builds the report in the interface and opens the system print dialog. `src/app.js`
- `npm test` runs the browser regression suite and the Rust suite; `npm run verify:package` checks the built artifact, association and RTKLIB resources. `package.json`, `scripts/verify-package.mjs`

## 18. Working offline

- The web build caches its shell and mapping libraries with a service worker. The desktop build removes the service worker because the files are already local, and loads its libraries from disk in batch 1.
- The blank grid stays fully editable without a connection, and the offline banner offers it when tile requests fail. `app.js`
- Online tiles, terrain, parcel lines, the historical watch and NOAA searches need a connection. `app.js`, `parcels.js`, `terrain.js`, `postprocess.js`
