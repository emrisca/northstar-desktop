// Terrain profiles for Northstar lines, sampled from the USGS 3DEP elevation service.
// The service is public, CORS-enabled and covers the United States and territories.
// Values are metres above the source DEM's vertical datum (commonly NAVD88); they are
// reference elevations, not survey-grade ground heights.
(function () {
  const ENDPOINT = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/getSamples';
  const EARTH_RADIUS = 6371008.8;
  const MAX_SAMPLES = 160;
  const CACHE_LIMIT = 24;
  const cache = new Map();

  function distanceMeters(a, b) {
    const lat1 = a.lat * Math.PI / 180;
    const lat2 = b.lat * Math.PI / 180;
    const dLat = lat2 - lat1;
    const dLon = (b.lon - a.lon) * Math.PI / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  function pathLength(points) {
    let total = 0;
    for (let i = 1; i < points.length; i++) total += distanceMeters(points[i - 1], points[i]);
    return total;
  }

  function sampleCountFor(lengthMeters) {
    return Math.max(16, Math.min(MAX_SAMPLES, Math.ceil(lengthMeters / 5) + 1));
  }

  function cacheKey(points, count) {
    return count + '|' + points.map(p => p.lon.toFixed(7) + ',' + p.lat.toFixed(7)).join('|');
  }

  function remember(key, value) {
    cache.set(key, value);
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  }

  // points: [{lat, lon}, ...]. Returns a profile ordered along the line.
  async function profile(points) {
    if (!Array.isArray(points) || points.length < 2) throw new Error('Choose a line with at least two waypoints.');
    const count = sampleCountFor(pathLength(points));
    const key = cacheKey(points, count);
    if (cache.has(key)) return cache.get(key);

    const geometry = {
      paths: [points.map(p => [p.lon, p.lat])],
      spatialReference: { wkid: 4326 }
    };
    const url = ENDPOINT +
      '?geometry=' + encodeURIComponent(JSON.stringify(geometry)) +
      '&geometryType=esriGeometryPolyline' +
      '&sampleCount=' + count +
      '&interpolation=RSP_BilinearInterpolation' +
      '&f=json';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let body;
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('The elevation service returned HTTP ' + response.status + '.');
      body = await response.json();
    } catch (error) {
      if (error && error.name === 'AbortError') throw new Error('The elevation service took too long to answer. Try again.');
      throw new Error('Could not reach the USGS elevation service. Check your connection.');
    } finally {
      clearTimeout(timer);
    }
    if (body && body.error) {
      const message = body.error.message || 'The elevation service rejected this line.';
      if (/invalid or missing input parameters/i.test(message)) {
        throw new Error('USGS 3DEP has no elevation here. The service covers the United States and its territories.');
      }
      throw new Error(message);
    }

    const raw = (body.samples || [])
      .map(sample => ({
        lon: Number(sample.location && sample.location.x),
        lat: Number(sample.location && sample.location.y),
        elevation: Number(sample.value),
        resolution: Number(sample.resolution) || 0
      }))
      .filter(sample => Number.isFinite(sample.lon) && Number.isFinite(sample.lat) && Number.isFinite(sample.elevation) && sample.elevation > -1000 && sample.elevation < 10000);
    if (raw.length < 2) throw new Error('USGS 3DEP has no elevation here. The service covers the United States and its territories.');

    const samples = [];
    let travelled = 0;
    for (let i = 0; i < raw.length; i++) {
      const sample = raw[i];
      if (i) travelled += distanceMeters(raw[i - 1], sample);
      samples.push({ distance: travelled, elevation: sample.elevation, resolution: sample.resolution, lon: sample.lon, lat: sample.lat });
    }
    const trueLength = pathLength(points);
    const scale = travelled > 0 ? trueLength / travelled : 1;
    samples.forEach(sample => { sample.distance *= scale; });

    let min = Infinity;
    let max = -Infinity;
    let gain = 0;
    let loss = 0;
    let resolution = 0;
    samples.forEach((sample, i) => {
      min = Math.min(min, sample.elevation);
      max = Math.max(max, sample.elevation);
      if (sample.resolution > 0 && (!resolution || sample.resolution < resolution)) resolution = sample.resolution;
      if (i) {
        const delta = sample.elevation - samples[i - 1].elevation;
        if (delta > 0) gain += delta;
        else loss -= delta;
      }
    });

    const result = {
      samples,
      length: trueLength,
      min,
      max,
      gain,
      loss,
      resolution,
      relief: max - min,
      source: 'USGS 3DEP'
    };
    remember(key, result);
    return result;
  }

  window.northstarTerrain = { profile, pathLength, sampleCountFor };
})();
