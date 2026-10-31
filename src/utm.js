// UTM coordinates for Northstar waypoints (WGS 84 datum, standard zones).
// Storage stays in WGS 84 latitude/longitude; UTM values are derived for display and export.
// Known limitation: the Norway (31V/32V) and Svalbard zone exceptions are not applied.
(function () {
  function zoneFor(lon) {
    return Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));
  }

  function epsgFor(lat, lon) {
    return (lat >= 0 ? 32600 : 32700) + zoneFor(lon);
  }

  function projDef(lat, lon) {
    return '+proj=utm +zone=' + zoneFor(lon) + (lat < 0 ? ' +south' : '') + ' +datum=WGS84 +units=m +no_defs';
  }

  // Returns { zone, hemisphere, epsg, easting, northing } or null when proj4js is unavailable.
  function forward(lat, lon) {
    if (!window.proj4 || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const [easting, northing] = window.proj4('WGS84', projDef(lat, lon), [lon, lat]);
    return {
      zone: zoneFor(lon),
      hemisphere: lat >= 0 ? 'N' : 'S',
      epsg: epsgFor(lat, lon),
      easting,
      northing
    };
  }

  function text(lat, lon) {
    const u = forward(lat, lon);
    if (!u) return '—';
    return u.zone + u.hemisphere + ' E ' + u.easting.toFixed(2) + ' m, N ' + u.northing.toFixed(2) + ' m';
  }

  window.northstarUTM = { zoneFor, epsgFor, projDef, forward, text };
})();
