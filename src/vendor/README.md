# Vendored files

Everything the interface used to fetch from a CDN, in the version it was
pinned to. `index.html` and `cesium-view.js` load from here, so the app makes
no request to a content delivery network at any point, and none of this
changes with a network connection.

368 files, 15.7 MB. The bulk is Cesium.

| Folder | Version | Files | Source |
| --- | --- | --- | --- |
| `leaflet/` | 1.9.4 | leaflet.js, leaflet.css and the five default marker images | https://unpkg.com/leaflet@1.9.4/dist/ |
| `maplibre/` | 3.6.2 / bridge 0.0.20 | maplibre-gl.js, maplibre-gl.css and the Leaflet bridge | https://unpkg.com/maplibre-gl@3.6.2/dist/ and https://unpkg.com/@maplibre/maplibre-gl-leaflet@0.0.20/ |
| `turf/` | 7.2.0 | turf.min.js, the spherical fallback for measurements | https://cdn.jsdelivr.net/npm/@turf/turf@7.2.0/turf.min.js |
| `rbush/` | 3.0.1 | rbush.min.js, the spatial index for selection | https://cdn.jsdelivr.net/npm/rbush@3.0.1/rbush.min.js |
| `geographiclib/` | 2.2.0 | geographiclib-geodesic.min.js, which installs window.geodesic | https://cdn.jsdelivr.net/npm/geographiclib-geodesic@2.2.0/geographiclib-geodesic.min.js |
| `proj4/` | 2.15.0 | proj4.js, the projections behind the CRS list | https://cdn.jsdelivr.net/npm/proj4@2.15.0/dist/proj4.js |
| `cesium/` | 1.146.0 | the Cesium build: Cesium.js, Workers, ThirdParty, Widgets and Assets, without the two module builds that a script tag never reads | https://registry.npmjs.org/cesium (Build/Cesium in the published package) |
| `fonts/` | Roboto 400 to 800, Material Symbols Rounded | the Google Fonts stylesheet with its woff2 files rewritten to local names | https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@20..48,400,0..1,0&family=Roboto:wght@400;500;600;700;800&display=swap |

## Recorded hashes

One line per library: the file count, the total size and a SHA-256 over the
concatenated bytes of its files in path order. Rerunning the fetch should
reproduce these, and a mismatch means the upstream artifact moved.

```text
leaflet/            7 files      164.9 KB  371c782e11f66a22e4b26ac8c4ccb0af80b1b044535dddd1dc008d08d870375a
maplibre/           3 files      817.3 KB  1e29c73d934260a9d1ce75ee759202e1307d85f16b595b7818fb0c2330da3470
turf/               1 files      550.3 KB  d5786c08ae4e988b37aa5c26de32b051ec2e4680f602f2a98ca3bc4b328e3432
rbush/              1 files        6.3 KB  1a914eba5022a943e50673779dae2fcda38db9344b02146279c22cac48e40aa3
geographiclib/      1 files       31.4 KB  06e3512904b346575f475f14d0b27ea0979dbcd2b0eddebf5f1eeefd234395b5
proj4/              1 files       91.3 KB  5c73f2719b0c33c8d8e709fc3d71056b39623d5f9182fb06a7b8e5173cfd8651
cesium/           343 files    12817.6 KB  18b85459cf399b64281ed3106270352d74c7f486c621adc165050f0e513423c6
fonts/             11 files     1575.2 KB  9ec33e760d40f95e768330a3aa51a6b33fe14a6f9318807270fa3913595ceff9
```

## Why Cesium is trimmed

The published build carries `index.js` and `index.cjs` beside `Cesium.js`.
Those two are the module builds, for a bundler, and a script tag never
reads them. Dropping them saved 9.6 MB; the rest is kept whole because
the workers and assets are loaded by name at runtime and trimming them
by guess would break the globe in a way the tests would only catch later.

## Fonts

`fonts.css` is the Google Fonts stylesheet with every `fonts.gstatic.com`
URL replaced by the file beside it. The symbol font is one variable file
and carries the icons the interface shows as ligatures; the Roboto files
are the subsets that stylesheet listed, and a browser fetches only the
subsets whose unicode range a page uses.
