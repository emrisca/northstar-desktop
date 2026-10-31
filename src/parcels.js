// Free US parcel boundaries for Northstar.
//
// Each entry is a public ArcGIS REST layer that answered a GeoJSON query from a
// browser origin without a key when this list was checked (October 2026). Parcel
// data are assessor/tax maps, not surveys: every source carries its own accuracy
// and coverage caveat, and coverage is not nationwide. States with no free
// statewide service are simply absent, and the overlay says so on the map.
//
// The overlay queries the visible extent (never the whole state) at 2,000-record
// steps, draws only outlines in the northstarParcels pane, and caches the last few
// extents so panning back is instant.
(function () {
  const ZOOM_MIN = 12;
  const QUERY_TIMEOUT = 25000;
  const CACHE_MAX = 10;

  // bbox is [west, south, east, north] and is only used to pick a source and to
  // clip the request; it does not claim every acre inside is covered.
  const SOURCES = [
    { id: 'CA', state: 'California', name: 'Assessor parcels', url: 'https://gis.water.ca.gov/arcgis/rest/services/Planning/i15_Parcels_Assessor_Lightbox/MapServer/0', bbox: [-124.6, 32.4, -114.0, 42.1], attribution: 'CA Department of Water Resources' },
    { id: 'HI', state: 'Hawaii', name: 'Statewide TMKs', url: 'https://geodata.hawaii.gov/arcgis/rest/services/ParcelsZoning/MapServer/25', bbox: [-160.4, 18.8, -154.6, 22.3], attribution: 'Hawaii Statewide GIS Program' },
    { id: 'MD', state: 'Maryland', name: 'Parcel boundaries', url: 'https://mdgeodata.md.gov/imap/rest/services/PlanningCadastre/MD_ParcelBoundaries/MapServer/0', bbox: [-79.6, 37.8, -74.9, 39.8], attribution: 'MD iMAP, MDP, SDAT' },
    { id: 'NE', state: 'Nebraska', name: 'Statewide parcels', url: 'https://giscat.ne.gov/enterprise/rest/services/StatewideParcelsExternal/FeatureServer/0', bbox: [-104.1, 39.9, -95.2, 43.1], attribution: 'Nebraska county assessors' },
    { id: 'NC', state: 'North Carolina', name: 'Parcels, all 100 counties', url: 'https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/FeatureServer/1', bbox: [-84.4, 33.8, -75.4, 36.6], attribution: 'NC OneMap' },
    { id: 'OH', state: 'Ohio', name: 'Statewide parcels', url: 'https://services2.arcgis.com/MlJ0G8iWUyC7jAmu/arcgis/rest/services/OhioStatewidePacels_full_view/FeatureServer/0', bbox: [-84.9, 38.3, -80.4, 42.0], attribution: 'OGRIP' },
    { id: 'VT', state: 'Vermont', name: 'Parcels and Grand List', url: 'https://services.arcgis.com/XG15cJAlne2vxtgt/ArcGIS/rest/services/VT_Parcel/FeatureServer/665', bbox: [-73.5, 42.7, -71.4, 45.1], attribution: 'Vermont municipalities, VCGI', caveat: 'Town participation varies.' },
    { id: 'WI', state: 'Wisconsin', name: 'Statewide parcel database', url: 'https://services3.arcgis.com/n6uYoouQZW75n5WI/arcgis/rest/services/Wisconsin_Statewide_Parcels_DB/FeatureServer/0', bbox: [-93.0, 42.4, -86.7, 47.2], attribution: 'Wisconsin State Cartographer\u2019s Office' },
    { id: 'MA', state: 'Massachusetts', name: 'Property tax parcels', url: 'https://services1.arcgis.com/hGdibHYSPO59RG1h/arcgis/rest/services/Massachusetts_Property_Tax_Parcels/FeatureServer/0', bbox: [-73.6, 41.2, -69.8, 42.9], attribution: 'MassGIS', caveat: 'Boston is mapped separately.' },
    { id: 'MT', state: 'Montana', name: 'Cadastral parcels', url: 'https://gis.dnrc.mt.gov/arcgis/rest/services/DNRALL/Cadastral/FeatureServer/0', bbox: [-116.1, 44.3, -104.0, 49.1], attribution: 'Montana State Library, MT Dept. of Revenue', caveat: 'Some public-land areas are missing.' },
    { id: 'AK', state: 'Alaska', name: 'Parcel compilation', url: 'https://services1.arcgis.com/7HDiw78fcUiM2BWn/arcgis/rest/services/AK_Parcels/FeatureServer/0', bbox: [-179.3, 51.2, -129.9, 71.5], attribution: 'Alaska DFFP', caveat: 'Non-authoritative, coverage varies by borough.' },
    { id: 'ID', state: 'Idaho', name: 'Parcels, participating counties', url: 'https://services1.arcgis.com/CNPdEkvnGl65jCX8/ArcGIS/rest/services/Public_Idaho_Parcels_/FeatureServer/7', bbox: [-117.3, 42.0, -111.0, 49.1], attribution: 'Idaho Parcel Data Exchange', caveat: 'County participation is still growing.' },
    { id: 'IN', state: 'Indiana', name: 'Parcel boundaries', url: 'https://gisdata.in.gov/server/rest/services/Hosted/Parcel_Boundaries_of_Indiana_Current/FeatureServer/0', bbox: [-88.2, 37.7, -84.7, 41.8], attribution: 'Indiana Geographic Information Office' },
    { id: 'WA', state: 'Washington', name: 'Current tax parcels', url: 'https://services.arcgis.com/jsIt88o09Q0r1j8h/arcgis/rest/services/Current_Parcels/FeatureServer/0', bbox: [-125.0, 45.5, -116.9, 49.1], attribution: 'Washington State Parcels Project', caveat: 'Counties without digital parcels are absent.' },
    { id: 'NY', state: 'New York', name: 'Public tax parcels, 38 counties', url: 'https://services6.arcgis.com/EbVsqZ18sv1kVJ3k/arcgis/rest/services/NYS_Tax_Parcels_Public/FeatureServer/1', bbox: [-79.9, 40.4, -71.8, 45.1], attribution: 'NYS ITS and ORPTS', caveat: 'Only counties that authorised public release.' },
    { id: 'PA', state: 'Pennsylvania', name: 'Parcels, compiled counties', url: 'https://apps.pasda.psu.edu/arcgis/rest/services/PA_Parcels/MapServer/1', bbox: [-80.6, 39.6, -74.6, 42.4], attribution: 'PASDA, Penn State', caveat: 'Incomplete; counties are added as submitted.' },
    { id: 'CO', state: 'Colorado', name: 'Public parcel composite', url: 'https://gis.colorado.gov/public/rest/services/Address_and_Parcel/Colorado_Public_Parcels/FeatureServer/0', bbox: [-109.1, 36.9, -102.0, 41.1], attribution: 'State of Colorado' },
    { id: 'VA', state: 'Virginia', name: 'Statewide parcels', url: 'https://vginmaps.vdem.virginia.gov/arcgis/rest/services/VA_Base_Layers/VA_Parcels/FeatureServer/0', bbox: [-83.7, 36.5, -75.2, 39.5], attribution: 'Virginia Geographic Information Network', caveat: 'Not edge-matched across municipal lines.' },
    { id: 'TN', state: 'Tennessee', name: 'Property boundaries, 86 counties', url: 'https://services1.arcgis.com/YuVBSS7Y1of2Qud1/arcgis/rest/services/Tennessee_Property_Boundaries_Public_Use/FeatureServer/0', bbox: [-90.4, 34.9, -81.6, 36.7], attribution: 'TN Comptroller, Division of Property Assessments', caveat: 'Nine counties excluded; reference use only.' },
    { id: 'MN', state: 'Minnesota', name: 'Open parcels, opt-in counties', url: 'https://utility.arcgis.com/usrsvcs/servers/1627519e8d3f42bcb55532d48e9a61e5/rest/services/OpenParcels/plan_parcels_open/MapServer/0', bbox: [-97.3, 43.4, -89.4, 49.4], attribution: 'MnGeo', caveat: 'Only counties that opted into open data.' },
    { id: 'AR', state: 'Arkansas', name: 'Parcels with CAMA records', url: 'https://gis.arkansas.gov/arcgis/rest/services/FEATURESERVICES/Planning_Cadastre/FeatureServer/6', bbox: [-94.7, 33.0, -89.6, 36.5], attribution: 'Arkansas GIS Office', caveat: 'Partial county coverage; not topologically enforced.' },
    { id: 'MS-E', state: 'Mississippi', name: 'Parcels, east framework', url: 'https://gis.mississippi.edu/server/rest/services/Cadastral/MS_MDEQPARCELS_East_2024/MapServer/0', bbox: [-89.6, 30.1, -87.9, 35.0], attribution: 'MARIS / MDEQ' },
    { id: 'MS-W', state: 'Mississippi', name: 'Parcels, west framework', url: 'https://gis.mississippi.edu/server/rest/services/Cadastral/MS_MDEQPARCELS_West_2024/MapServer/0', bbox: [-91.7, 30.1, -89.6, 35.0], attribution: 'MARIS / MDEQ' }
  ];

  let map = null;
  let layer = null;
  let render = null;
  let enabled = false;
  let selectedId = 'auto';
  let onStatus = null;
  let currentId = '';
  let currentBox = null;
  let abort = null;
  let timer = 0;
  let lastKey = '';
  let lastMessage = '';
  const cache = new Map();

  function sources() {
    return SOURCES.map(s => ({ id: s.id, state: s.state, name: s.name, caveat: s.caveat || '', attribution: s.attribution }));
  }

  function get(id) {
    return SOURCES.find(s => s.id === id) || null;
  }

  function inside(box, lat, lon) {
    return lon >= box[0] && lon <= box[2] && lat >= box[1] && lat <= box[3];
  }

  function sourceAt(lat, lon) {
    return SOURCES.find(s => inside(s.bbox, lat, lon)) || null;
  }

  function clip(view, box) {
    const w = Math.max(view[0], box[0]);
    const s = Math.max(view[1], box[1]);
    const e = Math.min(view[2], box[2]);
    const n = Math.min(view[3], box[3]);
    return e > w && n > s ? [w, s, e, n] : null;
  }

  function status(text, detail) {
    if (onStatus) onStatus(text, detail);
    lastMessage = text;
  }

  function clear() {
    if (render) {
      if (layer && layer.hasLayer(render)) layer.removeLayer(render);
      render = null;
    }
    currentBox = null;
  }

  function ensureLayer() {
    if (!map) return null;
    if (!map.getPane('northstarParcels')) {
      const pane = map.createPane('northstarParcels');
      pane.style.zIndex = '430';
      pane.style.pointerEvents = 'none';
    }
    if (!layer) layer = L.layerGroup();
    if (!map.hasLayer(layer)) layer.addTo(map);
    return layer;
  }

  function queryUrl(src, box, fields) {
    const params = new URLSearchParams({
      where: '1=1',
      geometry: box.join(','),
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      outSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: fields || 'OBJECTID',
      returnGeometry: 'true',
      geometryPrecision: '6',
      maxAllowableOffset: '0.00002',
      f: 'geojson'
    });
    return src.url + '/query?' + params.toString();
  }

  function remember(key, data) {
    cache.set(key, data);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  function draw(src, data, box) {
    if (!ensureLayer()) return;
    if (render && layer.hasLayer(render)) layer.removeLayer(render);
    render = L.geoJSON(data, {
      pane: 'northstarParcels',
      interactive: false,
      style: { color: '#ff9100', weight: 1.1, opacity: 0.9, fill: false, lineJoin: 'round' },
      smoothFactor: 0.4
    });
    layer.addLayer(render);
    currentBox = box;
    const count = (data.features || []).length;
    const more = data.properties && data.properties.exceededTransferLimit;
    status((more ? 'Showing ' + count + ' parcels (subset \u2014 zoom in) \u00b7 ' : count + ' parcels \u00b7 ') + src.state + ' \u00b7 \u00a9 ' + src.attribution);
    if (window.northstarApp && window.northstarApp.draw) window.northstarApp.draw();
  }

  function noteSource(src) {
    if (!src || src.id === currentId) return;
    const changed = currentId !== '';
    currentId = src.id;
    if (changed && window.northstarApp && window.northstarApp.message) {
      window.northstarApp.message('Parcel source: ' + src.state + (src.caveat ? ' \u2014 ' + src.caveat : ''));
    }
  }

  async function fetchParcels(src, box, key) {
    if (abort) abort.abort();
    const controller = new AbortController();
    abort = controller;
    const timeout = setTimeout(() => controller.abort(), QUERY_TIMEOUT);
    status('Loading parcels \u2026 ' + src.state);
    try {
      let response = await fetch(queryUrl(src, box), { signal: controller.signal, mode: 'cors' });
      let data = response.ok ? await response.json() : null;
      // Some layers refuse an empty or named attribute list; retry once with every field.
      if (!response.ok || (data && data.error)) {
        response = await fetch(queryUrl(src, box, '*'), { signal: controller.signal, mode: 'cors' });
        data = response.ok ? await response.json() : null;
      }
      if (!response.ok) throw new Error('HTTP ' + response.status);
      if (!data || data.error) throw new Error((data && data.error && data.error.message) || 'ArcGIS error');
      clearTimeout(timeout);
      if (!enabled) return;
      lastKey = key;
      remember(key, data);
      noteSource(src);
      draw(src, data, box);
    } catch (err) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') return;
      clear();
      lastKey = '';
      status('Parcel source unavailable \u00b7 ' + src.state);
      if (window.northstarApp && window.northstarApp.message) window.northstarApp.message('Parcel lines: ' + err.message);
    } finally {
      if (abort === controller) abort = null;
    }
  }

  function refresh(force) {
    if (!enabled || !map) return;
    const zoom = map.getZoom();
    if (zoom < ZOOM_MIN) {
      clear();
      status('Zoom in for parcel lines');
      return;
    }
    const b = map.getBounds();
    const view = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    const centre = map.getCenter();
    const src = selectedId === 'auto' ? sourceAt(centre.lat, centre.lng) : get(selectedId);
    if (!src) {
      clear();
      status('No free statewide parcel source covers this area');
      return;
    }
    const box = clip(view, src.bbox);
    if (!box) {
      clear();
      status('Move the map into ' + src.state);
      return;
    }
    const key = src.id + ':' + box.map(v => v.toFixed(3)).join(',');
    if (!force && key === lastKey && render) return;
    if (!force && cache.has(key)) {
      noteSource(src);
      draw(src, cache.get(key), box);
      lastKey = key;
      return;
    }
    fetchParcels(src, box, key);
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => refresh(), 280);
  }

  function attach(leafletMap, options) {
    if (!leafletMap || !window.L) return;
    map = leafletMap;
    onStatus = options && options.onStatus;
    ensureLayer();
    map.on('moveend zoomend', schedule);
    if (enabled) refresh(true);
  }

  function setEnabled(on) {
    enabled = !!on;
    clearTimeout(timer);
    if (!enabled) {
      if (abort) abort.abort();
      clear();
      status('Parcel lines off');
      return;
    }
    refresh(true);
  }

  function setSource(id) {
    selectedId = id || 'auto';
    lastKey = '';
    currentId = '';
    if (enabled) refresh(true);
    else status(selectedId === 'auto' ? 'Parcel lines off' : 'Parcel lines off \u00b7 ' + (get(selectedId) || {}).state);
  }

  function currentSource() {
    return get(currentId) || null;
  }

  function statusText() {
    return lastMessage;
  }

  window.northstarParcels = { sources, attach, setEnabled, setSource, refresh, currentSource, statusText, ZOOM_MIN };
})();
