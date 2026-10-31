// Geodesy methods for Northstar measurements.
// New measurements default to 'geographiclib'. Saved records without a method stay 'turf', so existing results do not change.
// 'geographiclib' uses the WGS 84 ellipsoid via geographiclib-geodesic (window.geodesic).
(function () {
  const METHODS = {
    turf: 'Turf (spherical)',
    geographiclib: 'GeographicLib (WGS 84 ellipsoid)'
  };

  function ellipsoid() {
    return window.geodesic && window.geodesic.Geodesic ? window.geodesic.Geodesic.WGS84 : null;
  }

  function resolveMethod(method) {
    return method === 'geographiclib' && ellipsoid() ? 'geographiclib' : 'turf';
  }

  // a, b: [lon, lat]
  function lengthMeters(method, a, b) {
    if (resolveMethod(method) === 'geographiclib') return ellipsoid().Inverse(a[1], a[0], b[1], b[0]).s12;
    return turf.length(turf.lineString([a, b]), { units: 'meters' });
  }

  // a, b: [lon, lat]; returns forward azimuth in degrees from north, [-180, 180].
  function forwardAzimuth(method, a, b) {
    if (resolveMethod(method) === 'geographiclib') return ellipsoid().Inverse(a[1], a[0], b[1], b[0]).azi1;
    const la = a[1] * Math.PI / 180, lb = b[1] * Math.PI / 180, dl = (b[0] - a[0]) * Math.PI / 180;
    const y = Math.sin(dl) * Math.cos(lb);
    const x = Math.cos(la) * Math.sin(lb) - Math.sin(la) * Math.cos(lb) * Math.cos(dl);
    return Math.atan2(y, x) * 180 / Math.PI;
  }

  // ring: [[lon, lat], ...], open or closed. Returns unsigned area in square meters.
  function areaSquareMeters(method, ring) {
    const pts = ring.slice();
    if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
    if (resolveMethod(method) === 'geographiclib') {
      const poly = ellipsoid().Polygon(false);
      pts.forEach(([lon, lat]) => poly.AddPoint(lat, lon));
      return Math.abs(poly.Compute(false, true).area);
    }
    return turf.area(turf.polygon([[...pts, pts[0]]]));
  }

  window.northstarGeodesy = {
    METHODS,
    isAvailable: method => resolveMethod(method) === method,
    label: method => METHODS[resolveMethod(method)],
    lengthMeters,
    forwardAzimuth,
    areaSquareMeters
  };
})();
