# Third-party notices

Northstar Field CAD, desktop, ships one third-party program inside it. Everything else it uses is either written for the project, vendored as a library with its licence beside it in `src/vendor`, or fetched from a map service that keeps its own attribution.

## RTKLIB 2.4.3 b34

- What: `rnx2rtkp`, the GNSS post-processing engine, and `convbin`, the receiver-log to RINEX converter.
- Where: `src-tauri/resources/rtklib/<platform>/bin`. Copied into the app's resources at build time by `src-tauri/tauri.conf.json`, and looked for before anything on `PATH`.
- Source: <https://github.com/tomojitakasu/RTKLIB>, release `v2.4.3-b34`, archive `RTKLIB_2.4.3_b34.zip` (SHA-256 `5f2eacee05e9f90cdc3604e48a906222c8832000056be9000f7ee3627bb18874`).
- Version and platform: recorded in `src-tauri/resources/rtklib/<platform>/BUNDLED.json`, with a SHA-256 for each file.
- Licence: BSD 2-Clause. The full text travels with the binaries as `LICENSE.txt` in the same folder, which is what the licence requires you to pass on.

RTKLIB is distributed "AS IS", without warranty of any kind. Northstar prepares and checks jobs; it does not make survey-accuracy guarantees, and a corrected position is only as good as the observations, the base station data and the configuration that produced it.

## Vendored libraries

Leaflet, MapLibre GL JS and its Leaflet bridge, Turf, RBush, geographiclib-geodesic, proj4, Cesium and the two font families are in `src/vendor`. [src/vendor/README.md](src/vendor/README.md) records each version, where it came from, and a SHA-256 over its bytes; each library's own licence file sits beside it.

## Map services

The basemap, imagery, terrain, hydrography, parcel and geocoding hosts keep their own attribution, which the interface shows in the map corner and in the source list. No map data is bundled.
