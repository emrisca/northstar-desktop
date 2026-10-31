// Coordinate reference systems for Northstar.
//
// Waypoints are always stored as WGS 84 latitude/longitude (EPSG:4326) - that is the
// geometry CRS. A project CRS only changes how coordinates are shown and typed, and an
// import CRS says how to read numeric columns that are not latitude/longitude.
//
// Transformations use proj4js. The North American geographic definitions carry no
// datum shift (EPSG's own HARN-to-WGS 84 operation is a 1 m approximation), so a
// NAD83-family point is treated as WGS 84 on the same numbers. That is fine for
// display and for turning projected grid coordinates back into lat/lon, but it is
// not a survey-grade datum transformation.
(function () {
  const STORAGE_EPSG = 'EPSG:4326';

  const GEOGRAPHIC = [
    {
      id: 'EPSG:4326',
      name: 'WGS 84',
      group: 'Geographic (latitude / longitude)',
      kind: 'geographic',
      units: '°',
      def: '+proj=longlat +datum=WGS84 +no_defs +type=crs',
      note: 'Global GPS datum. 2 m ensemble accuracy.'
    },
    {
      id: 'EPSG:4152',
      name: 'NAD83(HARN)',
      group: 'Geographic (latitude / longitude)',
      kind: 'geographic',
      units: '°',
      def: '+proj=longlat +ellps=GRS80 +no_defs +type=crs',
      note: 'North American plate-fixed frame. About 1–2 m from WGS 84.'
    },
    {
      id: 'EPSG:6318',
      name: 'NAD83(2011)',
      group: 'Geographic (latitude / longitude)',
      kind: 'geographic',
      units: '°',
      def: '+proj=longlat +ellps=GRS80 +no_defs +type=crs',
      note: 'Current realization of NAD83, epoch 2010.0.'
    },
    {
      id: 'EPSG:4269',
      name: 'NAD83 (legacy)',
      group: 'Geographic (latitude / longitude)',
      kind: 'geographic',
      units: '°',
      def: '+proj=longlat +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +no_defs +type=crs',
      note: 'Original NAD83. Superseded for work needing better than 1 m.'
    }
  ];

  // California State Plane (Lambert conformal conic). The six zones share one parameter
  // set per zone; only the units and false easting/northing differ between metres (EPSG
  // 2766-2771) and US survey feet (EPSG 2870-2875).
  const CA_ZONES = [
    { zone: 1, lat0: 39.3333333333333, lon0: -122, lat1: 41.6666666666667, lat2: 40, m: 2766, ft: 2870 },
    { zone: 2, lat0: 37.6666666666667, lon0: -122, lat1: 39.8333333333333, lat2: 38.3333333333333, m: 2767, ft: 2871 },
    { zone: 3, lat0: 36.5, lon0: -120.5, lat1: 38.4333333333333, lat2: 37.0666666666667, m: 2768, ft: 2872 },
    { zone: 4, lat0: 35.3333333333333, lon0: -119, lat1: 37.25, lat2: 36, m: 2769, ft: 2873 },
    { zone: 5, lat0: 33.5, lon0: -118, lat1: 35.4666666666667, lat2: 34.0333333333333, m: 2770, ft: 2874 },
    { zone: 6, lat0: 32.1666666666667, lon0: -116.25, lat1: 33.8833333333333, lat2: 32.7833333333333, m: 2771, ft: 2875 }
  ];

  // x_0/y_0 are metres in PROJ parameters even when the output is in feet, so the
  // feet variants carry the exact metric value of a round 2,000,000 ft / 500,000 ft
  // false origin. y_0 is 500,000 m for every zone.
  function lccDef(z, units) {
    const easting = units === 'm' ? '2000000' : '2000000.0001016';
    const northing = units === 'm' ? '500000' : '500000.0001016';
    return '+proj=lcc +lat_0=' + z.lat0 + ' +lon_0=' + z.lon0 +
      ' +lat_1=' + z.lat1 + ' +lat_2=' + z.lat2 +
      ' +x_0=' + easting + ' +y_0=' + northing +
      ' +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=' + units + ' +no_defs +type=crs';
  }

  const PROJECTED = [];
  CA_ZONES.forEach(z => {
    PROJECTED.push({
      id: 'EPSG:' + z.m,
      name: 'CA State Plane zone ' + z.zone + ' (metres)',
      group: 'California State Plane — NAD83(HARN)',
      kind: 'projected',
      units: 'm',
      def: lccDef(z, 'm'),
      note: 'Lambert conformal conic, zone ' + z.zone + '.'
    });
    PROJECTED.push({
      id: 'EPSG:' + z.ft,
      name: 'CA State Plane zone ' + z.zone + ' (US ft)',
      group: 'California State Plane — NAD83(HARN)',
      kind: 'projected',
      units: 'US ft',
      def: lccDef(z, 'us-ft'),
      note: 'California law specifies US survey feet for this zone.'
    });
  });

  // National grids outside North America. Definitions come from the EPSG registry via
  // epsg.io. Datums that differ from WGS 84 carry the published Helmert parameters, so
  // these are approximations (metres, not centimetres) rather than grid-shift results.
  const INTERNATIONAL = [
    {
      id: 'EPSG:27700',
      name: 'British National Grid',
      group: 'United Kingdom & Ireland',
      kind: 'projected',
      units: 'm',
      def: '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs +type=crs',
      note: 'OSGB36 datum. Helmert shift, about 2 m; OSTN15 grid files are not bundled.'
    },
    {
      id: 'EPSG:2157',
      name: 'Irish Transverse Mercator',
      group: 'United Kingdom & Ireland',
      kind: 'projected',
      units: 'm',
      def: '+proj=tmerc +lat_0=53.5 +lon_0=-8 +k=0.99982 +x_0=600000 +y_0=750000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs',
      note: 'ETRS89-based, ITM easting and northing in metres.'
    },
    {
      id: 'EPSG:2154',
      name: 'Lambert-93',
      group: 'Europe',
      kind: 'projected',
      units: 'm',
      def: '+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs',
      note: 'RGF93 / ETRS89, the standard French projected grid.'
    },
    {
      id: 'EPSG:28992',
      name: 'RD New',
      group: 'Europe',
      kind: 'projected',
      units: 'm',
      def: '+proj=sterea +lat_0=52.1561605555556 +lon_0=5.38763888888889 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +towgs84=565.4171,50.3319,465.5524,1.9342,-1.6677,9.1019,4.0725 +units=m +no_defs +type=crs',
      note: 'Amersfoort / Bessel datum, Dutch national grid.'
    },
    {
      id: 'EPSG:25830',
      name: 'ETRS89 / UTM 30N',
      group: 'Europe',
      kind: 'projected',
      units: 'm',
      def: '+proj=utm +zone=30 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs',
      note: 'Spain (mainland west), ETRS89.'
    },
    {
      id: 'EPSG:25832',
      name: 'ETRS89 / UTM 32N',
      group: 'Europe',
      kind: 'projected',
      units: 'm',
      def: '+proj=utm +zone=32 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs',
      note: 'Germany west and central, ETRS89.'
    },
    {
      id: 'EPSG:25833',
      name: 'ETRS89 / UTM 33N',
      group: 'Europe',
      kind: 'projected',
      units: 'm',
      def: '+proj=utm +zone=33 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs',
      note: 'Germany east, Norway, Poland and Sweden, ETRS89.'
    },
    {
      id: 'EPSG:3006',
      name: 'SWEREF 99 TM',
      group: 'Europe',
      kind: 'projected',
      units: 'm',
      def: '+proj=utm +zone=33 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs',
      note: 'Swedish national grid, ETRS89.'
    },
    {
      id: 'EPSG:3067',
      name: 'TM35FIN',
      group: 'Europe',
      kind: 'projected',
      units: 'm',
      def: '+proj=utm +zone=35 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs',
      note: 'Finnish national grid, ETRS89 / EUREF-FIN.'
    },
    {
      id: 'EPSG:26917',
      name: 'NAD83 / UTM 17N',
      group: 'Americas',
      kind: 'projected',
      units: 'm',
      def: '+proj=utm +zone=17 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs',
      note: 'Eastern Canada and the eastern United States.'
    },
    {
      id: 'EPSG:26918',
      name: 'NAD83 / UTM 18N',
      group: 'Americas',
      kind: 'projected',
      units: 'm',
      def: '+proj=utm +zone=18 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs',
      note: 'Ontario, Quebec and the north-eastern United States.'
    },
    {
      id: 'EPSG:31983',
      name: 'SIRGAS 2000 / UTM 23S',
      group: 'Americas',
      kind: 'projected',
      units: 'm',
      def: '+proj=utm +zone=23 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs',
      note: 'Brazil (south-east), SIRGAS 2000.'
    },
    {
      id: 'EPSG:28355',
      name: 'GDA94 / MGA 55',
      group: 'Australia & New Zealand',
      kind: 'projected',
      units: 'm',
      def: '+proj=utm +zone=55 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs',
      note: 'Map Grid of Australia, GDA94. Superseded by GDA2020 for new work.'
    },
    {
      id: 'EPSG:7855',
      name: 'GDA2020 / MGA 55',
      group: 'Australia & New Zealand',
      kind: 'projected',
      units: 'm',
      def: '+proj=utm +zone=55 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs',
      note: 'Current Australian national grid realisation, south-east zone.'
    },
    {
      id: 'EPSG:2193',
      name: 'NZTM2000',
      group: 'Australia & New Zealand',
      kind: 'projected',
      units: 'm',
      def: '+proj=tmerc +lat_0=0 +lon_0=173 +k=0.9996 +x_0=1600000 +y_0=10000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs',
      note: 'New Zealand Transverse Mercator, NZGD2000.'
    }
  ];

  // WGS 84 / UTM zones for everywhere else: 60 north and 60 south.
  const WORLD = [];
  for (let zone = 1; zone <= 60; zone++) {
    WORLD.push({
      id: 'EPSG:' + (32600 + zone),
      name: 'UTM zone ' + zone + 'N',
      group: 'World — WGS 84 / UTM north',
      kind: 'projected',
      units: 'm',
      def: '+proj=utm +zone=' + zone + ' +datum=WGS84 +units=m +no_defs +type=crs',
      note: 'Universal Transverse Mercator on WGS 84, northern hemisphere.'
    });
    WORLD.push({
      id: 'EPSG:' + (32700 + zone),
      name: 'UTM zone ' + zone + 'S',
      group: 'World — WGS 84 / UTM south',
      kind: 'projected',
      units: 'm',
      def: '+proj=utm +zone=' + zone + ' +south +datum=WGS84 +units=m +no_defs +type=crs',
      note: 'Universal Transverse Mercator on WGS 84, southern hemisphere.'
    });
  }

  const LIST = GEOGRAPHIC.concat(PROJECTED, INTERNATIONAL, WORLD);
  const BY_ID = new Map(LIST.map(c => [c.id, c]));
  let registered = false;

  function register() {
    if (registered || !window.proj4) return;
    try {
      LIST.forEach(c => window.proj4.defs(c.id, c.def));
      registered = true;
    } catch (err) {
      registered = false;
    }
  }

  function list() {
    return LIST.slice();
  }

  function get(id) {
    return BY_ID.get(String(id || '').toUpperCase()) || null;
  }

  function name(id) {
    const c = get(id);
    return c ? c.name : String(id || '');
  }

  function label(id) {
    const c = get(id);
    return c ? c.id + ' · ' + c.name : String(id || '');
  }

  function isProjected(id) {
    const c = get(id);
    return !!c && c.kind === 'projected';
  }

  function units(id) {
    const c = get(id);
    return c ? c.units : '';
  }

  function note(id) {
    const c = get(id);
    return c ? c.note : '';
  }

  // Short one-line description for the settings hints.
  function summary(id) {
    const c = get(id);
    if (!c) return '';
    return c.kind === 'geographic'
      ? c.name + ' · latitude/longitude · degrees'
      : c.name + ' · projected · ' + c.units;
  }

  // Numeric pair in the given CRS -> { lat, lon } in WGS 84, or null.
  function toWGS84(id, x, y) {
    const c = get(id);
    const a = Number(x);
    const b = Number(y);
    if (!c || !Number.isFinite(a) || !Number.isFinite(b)) return null;
    if (c.kind === 'geographic') {
      // x is longitude, y is latitude.
      if (Math.abs(b) > 90 || Math.abs(a) > 180) return null;
      return { lat: b, lon: a };
    }
    register();
    if (!window.proj4) return null;
    try {
      const out = window.proj4(c.def, 'WGS84', [a, b]);
      if (!out || !Number.isFinite(out[1]) || !Number.isFinite(out[0])) return null;
      if (Math.abs(out[1]) > 90 || Math.abs(out[0]) > 180) return null;
      return { lat: out[1], lon: out[0] };
    } catch (err) {
      return null;
    }
  }

  // WGS 84 lat/lon -> { x, y } numeric pair in the given CRS, or null.
  function fromWGS84(id, lat, lon) {
    const c = get(id);
    const la = Number(lat);
    const lo = Number(lon);
    if (!c || !Number.isFinite(la) || !Number.isFinite(lo)) return null;
    if (c.kind === 'geographic') return { x: lo, y: la };
    register();
    if (!window.proj4) return null;
    try {
      const out = window.proj4('WGS84', c.def, [lo, la]);
      if (!out || !Number.isFinite(out[0]) || !Number.isFinite(out[1])) return null;
      return { x: out[0], y: out[1] };
    } catch (err) {
      return null;
    }
  }

  function fixed(value, places) {
    const parts = Number(value).toFixed(places).split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.join('.');
  }

  // Human-readable coordinate pair in the given CRS.
  function format(id, lat, lon) {
    const c = get(id);
    if (!c) return '—';
    const p = fromWGS84(id, lat, lon);
    if (!p) return '—';
    if (c.kind === 'geographic') {
      return fixed(Math.abs(p.y), 7) + '° ' + (p.y >= 0 ? 'N' : 'S') + ', ' +
        fixed(Math.abs(p.x), 7) + '° ' + (p.x >= 0 ? 'E' : 'W');
    }
    return fixed(p.x, 2) + ' E, ' + fixed(p.y, 2) + ' N ' + c.units;
  }

  function shortPair(id, lat, lon) {
    const p = fromWGS84(id, lat, lon);
    if (!p) return '';
    const c = get(id);
    if (!c || c.kind === 'geographic') return p.y.toFixed(7) + ', ' + p.x.toFixed(7);
    return p.x.toFixed(2) + ', ' + p.y.toFixed(2);
  }

  // Searchable picker for the 150+ systems. Markup:
  //   <div class="crs-picker"><input class="crs-picker-input"><input class="crs-picker-value" type="hidden"><div class="crs-picker-list"></div></div>
  // Returns { value, set(id), close() }. onChange fires only for user choices.
  function picker(root, onChange) {
    if (!root) return null;
    const input = root.querySelector('.crs-picker-input');
    const value = root.querySelector('.crs-picker-value');
    const list = root.querySelector('.crs-picker-list');
    if (!input || !value || !list) return null;
    let current = STORAGE_EPSG;
    let shown = [];
    let active = -1;

    function labelFor(id) {
      const c = get(id);
      return c ? c.id + ' · ' + c.name : '';
    }

    function close() {
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      active = -1;
    }

    function choose(id) {
      if (!get(id)) return;
      current = id;
      value.value = id;
      input.value = labelFor(id);
      close();
      if (onChange) onChange(id);
    }

    function draw(query) {
      const words = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
      shown = LIST.filter(c => {
        if (!words.length) return true;
        const hay = (c.id + ' ' + c.name + ' ' + c.group).toLowerCase();
        return words.every(word => hay.indexOf(word) >= 0);
      });
      if (!shown.length) {
        list.innerHTML = '<div class="crs-picker-empty">No coordinate system matches</div>';
      } else {
        let html = '';
        let group = '';
        shown.forEach((c, i) => {
          if (c.group !== group) {
            group = c.group;
            html += '<div class="crs-picker-group">' + group + '</div>';
          }
          html += '<button type="button" class="crs-picker-item" role="option" data-i="' + i + '" aria-selected="' + (c.id === current) + '">' +
            '<b>' + c.name + '</b><small>' + c.id + ' · ' + (c.kind === 'projected' ? c.units : 'degrees') + '</small></button>';
        });
        list.innerHTML = html;
      }
      active = -1;
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    }

    input.addEventListener('focus', () => draw(''));
    input.addEventListener('click', () => { if (list.hidden) draw(''); });
    input.addEventListener('input', () => draw(input.value));
    input.addEventListener('blur', () => {
      setTimeout(() => {
        if (document.activeElement !== input) {
          input.value = labelFor(current);
          close();
        }
      }, 120);
    });
    input.addEventListener('keydown', e => {
      const items = Array.from(list.querySelectorAll('.crs-picker-item'));
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (list.hidden) return draw('');
        active = Math.max(0, Math.min(items.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1)));
        items.forEach((button, i) => button.classList.toggle('active', i === active));
        if (items[active]) items[active].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        if (!list.hidden && active >= 0 && items[active] && shown[active]) {
          e.preventDefault();
          choose(shown[active].id);
        }
      } else if (e.key === 'Escape') {
        if (!list.hidden) {
          e.stopPropagation();
          input.value = labelFor(current);
          close();
        }
      } else if (e.key === 'Tab') {
        close();
      }
    });
    list.addEventListener('mousedown', e => e.preventDefault());
    list.addEventListener('click', e => {
      const button = e.target.closest('.crs-picker-item');
      if (button) choose(shown[Number(button.dataset.i)].id);
    });
    document.addEventListener('mousedown', e => {
      if (!root.contains(e.target) && !list.hidden) {
        input.value = labelFor(current);
        close();
      }
    });

    input.value = labelFor(current);
    value.value = current;

    return {
      get value() { return current; },
      set(id, silent) {
        const next = get(id) ? id : STORAGE_EPSG;
        current = next;
        value.value = next;
        input.value = labelFor(next);
        if (!silent && onChange) onChange(next);
      },
      close
    };
  }

  // Grouped <option> markup for the CRS pickers.
  function optionsHTML(selected) {
    const groups = [];
    LIST.forEach(c => {
      let g = groups.find(entry => entry.name === c.group);
      if (!g) {
        g = { name: c.group, items: [] };
        groups.push(g);
      }
      g.items.push(c);
    });
    return groups.map(g => '<optgroup label="' + g.name + '">' +
      g.items.map(c => '<option value="' + c.id + '"' + (c.id === selected ? ' selected' : '') + '>' +
        c.id + ' · ' + c.name + '</option>').join('') +
      '</optgroup>').join('');
  }

  window.northstarCRS = {
    STORAGE_EPSG,
    list,
    get,
    name,
    label,
    note,
    summary,
    isProjected,
    units,
    toWGS84,
    fromWGS84,
    format,
    shortPair,
    optionsHTML,
    picker,
    register
  };
})();
