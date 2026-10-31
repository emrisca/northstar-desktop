// Coordinate search: decimal degrees, DDM, DMS, UTM and MGRS (WGS 84).
// Self-contained so the parser can be exercised outside the browser.
(function () {
  const A = 6378137;
  const F = 1 / 298.257223563;
  const E2 = F * (2 - F);
  const EP2 = E2 / (1 - E2);
  const K0 = 0.9996;
  const BANDS = 'CDEFGHJKLMNPQRSTUVWX';
  const ROWS = 'ABCDEFGHJKLMNPQRSTUV';
  const COLS = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'];

  function finite(n) {
    return typeof n === 'number' && Number.isFinite(n);
  }

  function zoneFor(lat, lon) {
    if (lon === 180) lon = 179.9999999999;
    let zone = Math.floor((lon + 180) / 6) + 1;
    zone = Math.min(60, Math.max(1, zone));
    if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) return 32;
    if (lat >= 72 && lat <= 84) {
      if (lon >= 0 && lon < 9) return 31;
      if (lon >= 9 && lon < 21) return 33;
      if (lon >= 21 && lon < 33) return 35;
      if (lon >= 33 && lon < 42) return 37;
    }
    return zone;
  }

  function bandFor(lat) {
    if (!finite(lat) || lat < -80 || lat > 84) return null;
    return BANDS[Math.min(19, Math.floor((lat + 80) / 8))];
  }

  function hemisphereForBand(band) {
    const i = BANDS.indexOf(band);
    if (i < 0) return null;
    return i < 10 ? 'S' : 'N'; // C..M south, N..X north
  }

  function utmForward(lat, lon, zone) {
    zone = zone || zoneFor(lat, lon);
    const lat0 = lat * Math.PI / 180;
    const lon0 = ((zone - 1) * 6 - 180 + 3) * Math.PI / 180;
    const dlon = lon * Math.PI / 180 - lon0;
    const sin = Math.sin(lat0), cos = Math.cos(lat0), tan = Math.tan(lat0);
    const n = A / Math.sqrt(1 - E2 * sin * sin);
    const t = tan * tan;
    const c = EP2 * cos * cos;
    const a = cos * dlon;
    const m = A * ((1 - E2 / 4 - 3 * E2 * E2 / 64 - 5 * E2 * E2 * E2 / 256) * lat0
      - (3 * E2 / 8 + 3 * E2 * E2 / 32 + 45 * E2 * E2 * E2 / 1024) * Math.sin(2 * lat0)
      + (15 * E2 * E2 / 256 + 45 * E2 * E2 * E2 / 1024) * Math.sin(4 * lat0)
      - (35 * E2 * E2 * E2 / 3072) * Math.sin(6 * lat0));
    const easting = K0 * n * (a + (1 - t + c) * a * a * a / 6
      + (5 - 18 * t + t * t + 72 * c - 58 * EP2) * Math.pow(a, 5) / 120) + 500000;
    let northing = K0 * (m + n * tan * (a * a / 2
      + (5 - t + 9 * c + 4 * c * c) * Math.pow(a, 4) / 24
      + (61 - 58 * t + t * t + 600 * c - 330 * EP2) * Math.pow(a, 6) / 720));
    if (lat < 0) northing += 10000000;
    return { zone, hemisphere: lat < 0 ? 'S' : 'N', easting, northing };
  }

  function utmInverse(zone, hemisphere, easting, northing) {
    const x = easting - 500000;
    const y = hemisphere === 'S' ? northing - 10000000 : northing;
    const m = y / K0;
    const mu = m / (A * (1 - E2 / 4 - 3 * E2 * E2 / 64 - 5 * E2 * E2 * E2 / 256));
    const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
    const phi1 = mu + (3 * e1 / 2 - 27 * Math.pow(e1, 3) / 32) * Math.sin(2 * mu)
      + (21 * e1 * e1 / 16 - 55 * Math.pow(e1, 4) / 32) * Math.sin(4 * mu)
      + (151 * Math.pow(e1, 3) / 96) * Math.sin(6 * mu)
      + (1097 * Math.pow(e1, 4) / 512) * Math.sin(8 * mu);
    const sin = Math.sin(phi1), cos = Math.cos(phi1), tan = Math.tan(phi1);
    const c1 = EP2 * cos * cos;
    const t1 = tan * tan;
    const n1 = A / Math.sqrt(1 - E2 * sin * sin);
    const r1 = A * (1 - E2) / Math.pow(1 - E2 * sin * sin, 1.5);
    const d = x / (n1 * K0);
    const lat = phi1 - (n1 * tan / r1) * (d * d / 2
      - (5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * EP2) * Math.pow(d, 4) / 24
      + (61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * EP2 - 3 * c1 * c1) * Math.pow(d, 6) / 720);
    const lon = ((zone - 1) * 6 - 180 + 3) * Math.PI / 180
      + (d - (1 + 2 * t1 + c1) * Math.pow(d, 3) / 6
        + (5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * EP2 + 24 * t1 * t1) * Math.pow(d, 5) / 120) / cos;
    return { lat: lat * 180 / Math.PI, lon: lon * 180 / Math.PI };
  }

  function pad(value, width) {
    return String(value).padStart(width, '0');
  }

  function toMGRS(lat, lon, precision) {
    precision = Math.max(1, Math.min(5, precision || 5));
    const band = bandFor(lat);
    if (!band) return null;
    const zone = zoneFor(lat, lon);
    const u = utmForward(lat, lon, zone);
    const colSet = COLS[(zone - 1) % 3];
    const colIndex = Math.floor(u.easting / 100000) - 1;
    if (colIndex < 0 || colIndex > 7) return null;
    const rowOffset = zone % 2 === 0 ? 5 : 0;
    const rowIndex = (Math.floor(u.northing / 100000) + rowOffset) % 20;
    const cell = Math.pow(10, 5 - precision);
    return String(zone).padStart(2, '0') + band + colSet[colIndex] + ROWS[rowIndex]
      + pad(Math.floor((u.easting % 100000) / cell), precision)
      + pad(Math.floor((u.northing % 100000) / cell), precision);
  }

  function fromMGRS(zone, band, square, digits) {
    zone = Number(zone);
    if (!(zone >= 1 && zone <= 60) || BANDS.indexOf(band) < 0) return null;
    const precision = digits.length / 2;
    if (!Number.isInteger(precision) || precision < 1 || precision > 5) return null;
    const colSet = COLS[(zone - 1) % 3];
    const col = colSet.indexOf(square[0]);
    const row = ROWS.indexOf(square[1]);
    if (col < 0 || row < 0) return null;
    const cell = Math.pow(10, 5 - precision);
    const easting = (col + 1) * 100000 + Number(digits.slice(0, precision)) * cell + cell / 2;
    const rowOffset = zone % 2 === 0 ? 5 : 0;
    const baseRow = ((row - rowOffset) % 20 + 20) % 20;
    const bandIndex = BANDS.indexOf(band);
    const lower = -80 + bandIndex * 8;
    const upper = band === 'X' ? 84 : lower + 8;
    const hemisphere = hemisphereForBand(band);
    let fallback = null;
    for (let k = 0; k < 6; k++) {
      const northing = (baseRow + 20 * k) * 100000 + Number(digits.slice(precision)) * cell + cell / 2;
      if (northing < 0 || northing > 10000000) continue;
      if (hemisphere === 'S' && northing > 10000000) continue;
      const p = utmInverse(zone, hemisphere, easting, northing);
      if (!finite(p.lat) || !finite(p.lon)) continue;
      if (p.lat >= lower && p.lat < upper) return { lat: p.lat, lon: p.lon };
      if (!fallback) fallback = p;
    }
    return fallback;
  }

  function parseUTM(text) {
    const withLetter = text.match(/^\s*(?:utm\s*)?(?:zone\s*)?(\d{1,2})\s*([C-X])\s*,?\s*(\d+(?:\.\d+)?)\s*m?\s*e?\s*,?\s*(\d+(?:\.\d+)?)\s*m?\s*n?\s*$/i);
    if (!withLetter) return null;
    const zone = Number(withLetter[1]);
    const letter = withLetter[2].toUpperCase();
    const easting = Number(withLetter[3]);
    const northing = Number(withLetter[4]);
    if (!(zone >= 1 && zone <= 60) || zoneFor(0, (zone - 1) * 6 - 177) !== zone) return null;
    if (!(easting >= 100000 && easting < 1000000) || !(northing >= 0 && northing <= 10000000)) {
      return { error: 'UTM easting must be 100000–999999 m and northing 0–10000000 m.' };
    }
    let hemisphere;
    let band = null;
    if (letter === 'N') hemisphere = 'N';
    else if (letter === 'S') {
      // 'S' is ambiguous: southern hemisphere, or latitude band S (32-40 N) as many handheld
      // GPS units print it. Prefer the band reading when it is the only one that lands in band S.
      const south = utmInverse(zone, 'S', easting, northing);
      const north = utmInverse(zone, 'N', easting, northing);
      const inBandS = q => finite(q.lat) && bandFor(q.lat) === 'S';
      if (!inBandS(south) && inBandS(north)) { hemisphere = 'N'; band = 'S'; }
      else hemisphere = 'S';
    }
    else {
      band = letter;
      hemisphere = hemisphereForBand(band);
    }
    const p = utmInverse(zone, hemisphere, easting, northing);
    if (!finite(p.lat) || !finite(p.lon) || p.lat < -80 || p.lat > 84 || Math.abs(p.lon) > 180) {
      return { error: 'That UTM coordinate does not fall inside zone ' + zone + '.' };
    }
    if (band) {
      const i = BANDS.indexOf(band);
      const lower = -80 + i * 8, upper = band === 'X' ? 84 : lower + 8;
      if (p.lat < lower || p.lat >= upper) {
        return { error: 'That northing is outside band ' + band + '; check the zone letter.' };
      }
    }
    return { lat: p.lat, lon: p.lon };
  }

  function parseMGRS(text) {
    const m = text.match(/^\s*(?:mgrs\s*)?(\d{1,2})\s*([C-HJ-NP-X])\s*([A-HJ-NP-Z])\s*([A-HJ-NP-Z])\s*(\d{1,10})(?:\s+(\d{1,5}))?\s*$/i);
    if (!m) return null;
    const zone = Number(m[1]);
    const band = m[2].toUpperCase();
    const square = (m[3] + m[4]).toUpperCase();
    let digits = m[5];
    if (m[6] != null) {
      if (m[5].length !== m[6].length) return { error: 'MGRS easting and northing need the same number of digits.' };
      digits = m[5] + m[6];
    }
    if (digits.length % 2 !== 0 || digits.length > 10) {
      return { error: 'MGRS needs an even number of digits, up to 5 per axis (for example 10SEG5067781617).' };
    }
    const p = fromMGRS(zone, band, square, digits);
    if (!p) return { error: 'That MGRS reference is not valid in zone ' + zone + '.' };
    return p;
  }

  function clean(text) {
    return String(text == null ? '' : text)
      .replace(/[º°˚]/g, '°')
      .replace(/[′’‘]/g, "'")
      .replace(/[″“”]/g, '"')
      .trim();
  }

  function tokenize(text) {
    const tokens = [];
    const re = /([NSEW])|(-?\d+(?:\.\d+)?)|([°'"])|([,;])/gi;
    let match;
    while ((match = re.exec(text))) {
      if (match[1]) tokens.push({ type: 'hemi', value: match[1].toUpperCase() });
      else if (match[2]) tokens.push({ type: 'num', value: Number(match[2]), unit: null });
      else if (match[3]) tokens.push({ type: 'unit', value: match[3] });
      else tokens.push({ type: 'sep' });
    }
    return tokens;
  }

  function groupValue(group) {
    if (!group || !group.nums.length || group.nums.length > 3) return null;
    const deg = group.nums[0].value;
    const min = group.nums[1] ? group.nums[1].value : 0;
    const sec = group.nums[2] ? group.nums[2].value : 0;
    if (!finite(deg) || !finite(min) || !finite(sec) || min < 0 || sec < 0 || min >= 60 || sec >= 60) return null;
    let value = Math.abs(deg) + min / 60 + sec / 3600;
    if (group.hemi === 'S' || group.hemi === 'W') value = -value;
    else if (group.hemi === 'N' || group.hemi === 'E') value = Math.abs(value);
    else if (deg < 0) value = -value;
    return value;
  }

  function sexagesimal(text) {
    const raw = clean(text);
    const latPos = raw.search(/\b(latitude|lat)\b/i);
    const lonPos = raw.search(/\b(longitude|long|lon|lng)\b/i);
    const lonFirst = lonPos >= 0 && (latPos < 0 || lonPos < latPos);
    const body = raw
      .replace(/\b(latitude|lat|longitude|long|lon|lng)\b/gi, ' ')
      .replace(/[;,]/g, ' , ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!body) return null;
    const tokens = tokenize(body);
    if (!tokens.some(t => t.type === 'num')) return null;
    const groups = [];
    let current = null;
    let pendingHemi = null;
    const push = hemi => {
      if (!current || !current.nums.length) return false;
      current.hemi = hemi || current.hemi || null;
      groups.push(current);
      current = null;
      return true;
    };
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.type === 'hemi') {
        if (current && current.nums.length && current.hemi) {
          push(current.hemi);
          pendingHemi = token.value;
        } else if (!push(token.value)) {
          if (pendingHemi) return null;
          pendingHemi = token.value;
        }
      } else if (token.type === 'num') {
        const last = current && current.nums.length ? current.nums[current.nums.length - 1] : null;
        if (last && last.unit != null) {
          const next = tokens[i + 1];
          const nextUnit = next && next.type === 'unit' ? next.value : null;
          const continues = (last.unit === '°' && nextUnit === "'") || (last.unit === "'" && nextUnit === '"');
          if (!continues) push(pendingHemi);
        }
        if (!current) current = { nums: [], units: [], hemi: null };
        current.nums.push(token);
        if (pendingHemi) {
          current.hemi = pendingHemi;
          pendingHemi = null;
        }
      } else if (token.type === 'unit') {
        if (current && current.nums.length) current.nums[current.nums.length - 1].unit = token.value;
      } else if (token.type === 'sep') {
        if (!current) continue;
        if (current.nums.length) push(current.hemi || pendingHemi);
        pendingHemi = null;
      }
    }
    if (current && current.nums.length) push(pendingHemi);
    if (!groups.length) return null;

    let a;
    let b;
    if (groups.length === 1) {
      const nums = groups[0].nums;
      const unitless = nums.every(n => n.unit == null);
      if (groups[0].hemi || !unitless || nums.length === 1) return null;
      if (nums.length === 2) {
        a = { nums: [nums[0]], hemi: null };
        b = { nums: [nums[1]], hemi: null };
      } else if (nums.length === 4) {
        a = { nums: nums.slice(0, 2), hemi: null };
        b = { nums: nums.slice(2), hemi: null };
      } else if (nums.length === 6) {
        a = { nums: nums.slice(0, 3), hemi: null };
        b = { nums: nums.slice(3), hemi: null };
      } else {
        return null;
      }
    } else if (groups.length === 2) {
      a = groups[0];
      b = groups[1];
    } else {
      return null;
    }

    const va = groupValue(a);
    const vb = groupValue(b);
    if (va == null || vb == null) return null;
    const axis = h => h === 'N' || h === 'S' ? 'lat' : h === 'E' || h === 'W' ? 'lon' : null;
    let axisA = axis(a.hemi);
    let axisB = axis(b.hemi);
    if (axisA && axisB && axisA === axisB) return null;
    if (!axisA && !axisB) {
      axisA = lonFirst ? 'lon' : 'lat';
      axisB = axisA === 'lat' ? 'lon' : 'lat';
    } else if (!axisA) {
      axisA = axisB === 'lat' ? 'lon' : 'lat';
    } else if (!axisB) {
      axisB = axisA === 'lat' ? 'lon' : 'lat';
    }
    const out = {};
    if (axisA === 'lat') { out.lat = va; out.lon = vb; } else { out.lat = vb; out.lon = va; }
    if (!finite(out.lat) || !finite(out.lon)) return null;
    if (Math.abs(out.lat) > 90 || Math.abs(out.lon) > 180) return null;
    out.components = Math.max(a.nums.length, b.nums.length);
    return out;
  }

  function toDMS(lat, lon) {
    function one(value, positive, negative, max) {
      const hemi = value < 0 ? negative : positive;
      let total = Math.abs(value);
      let deg = Math.floor(total);
      let min = Math.floor((total - deg) * 60);
      let sec = ((total - deg) * 60 - min) * 60;
      if (sec >= 59.9995) { sec = 0; min += 1; }
      if (min >= 60) { min = 0; deg += 1; }
      return deg + '°' + String(min).padStart(2, '0') + "'" + sec.toFixed(1) + '"' + hemi;
    }
    return one(lat, 'N', 'S', 90) + ' ' + one(lon, 'E', 'W', 180);
  }

  function toDDM(lat, lon) {
    function one(value, positive, negative) {
      const hemi = value < 0 ? negative : positive;
      const total = Math.abs(value);
      let deg = Math.floor(total);
      let min = (total - deg) * 60;
      if (min >= 59.9995) { min = 0; deg += 1; }
      return deg + '°' + min.toFixed(3) + "'" + hemi;
    }
    return one(lat, 'N', 'S') + ' ' + one(lon, 'E', 'W');
  }

  function formatUTM(lat, lon) {
    const u = utmForward(lat, lon);
    return u.zone + u.hemisphere + ' ' + Math.round(u.easting) + 'E ' + Math.round(u.northing) + 'N';
  }

  // Returns { lat, lon, format, label } or { error }.
  function parse(text) {
    const raw = clean(text);
    if (!raw) return null;
    let p = parseMGRS(raw);
    if (p) {
      if (p.error) return p;
      const label = toMGRS(p.lat, p.lon, 5) || '';
      return { lat: p.lat, lon: p.lon, format: 'MGRS', label };
    }
    p = parseUTM(raw);
    if (p) {
      if (p.error) return p;
      return { lat: p.lat, lon: p.lon, format: 'UTM', label: formatUTM(p.lat, p.lon) };
    }
    p = sexagesimal(raw);
    if (p) {
      const format = p.components === 3 ? 'DMS' : p.components === 2 ? 'DDM' : 'Decimal';
      const label = format === 'DMS' ? toDMS(p.lat, p.lon)
        : format === 'DDM' ? toDDM(p.lat, p.lon)
        : p.lat.toFixed(6) + ', ' + p.lon.toFixed(6);
      return { lat: p.lat, lon: p.lon, format, label };
    }
    return null;
  }

  const api = { parse, toMGRS, fromMGRS, utmForward, utmInverse, zoneFor, bandFor, toDMS, toDDM, formatUTM };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.northstarCoords = api;
})();
