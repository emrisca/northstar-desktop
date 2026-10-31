// Northstar GNSS post-processing job builder.
// This module prepares a free RTKLIB correction job. It does not pretend to
// perform differential correction in the browser; RTKLIB runs outside the app.
(function () {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const STEPS = [
    { title: 'Rover file', hint: 'The observations collected in the field' },
    { title: 'Base station', hint: 'A station recording at the same time' },
    { title: 'Processing', hint: 'Static or kinematic, frequencies, limits' },
    { title: 'Review', hint: 'Validate, export, and accept the correction' }
  ];
  const SYSTEM_NAMES = { G: 'GPS', R: 'GLONASS', E: 'Galileo', C: 'BeiDou', J: 'QZSS', I: 'NavIC', S: 'SBAS' };
  const SYSTEM_BITS = { G: 1, S: 2, R: 4, E: 8, J: 16, C: 32, I: 64 };
  const DEFAULTS = {
    posMode: 'static',
    frequency: 'l1+l2',
    elevationMask: 10,
    arMode: 'continuous',
    ephemeris: 'brdc',
    maxAge: 30,
    solutionType: 'combined'
  };

  const state = {
    step: 0,
    baseTab: 'noaa',
    rover: null,
    base: null,
    baseStation: null,
    baseSource: '',
    basePosition: null,
    baseFrames: {},
    baseFrame: '',
    nav: [],
    sp3: null,
    coordText: '',
    stations: [],
    stationMeta: null,
    stationBusy: false,
    baseBusy: false,
    stationError: '',
    baseError: '',
    roverError: '',
    busy: '',
    options: { ...DEFAULTS },
    job: null,
    persistedSignature: '',
    resultOnly: false,
    result: null,
    resultName: '',
    resultTarget: 'new',
    resultError: '',
    resultAccepted: false,
    jobsSelectedId: null,
    jobsDeleteConfirm: false,
    preflight: {
      server: null,
      busy: false,
      error: '',
      checkedAt: 0
    },
    installer: {
      open: false,
      info: null,
      busy: false,
      error: '',
      job: null,
      accepted: false,
      poll: 0
    },
    engine: {
      loading: false,
      checked: false,
      found: false,
      version: '',
      path: '',
      error: ''
    },
    run: {
      busy: false,
      error: '',
      elapsedMs: 0,
      engine: '',
      warnings: '',
      completed: false
    }
  };

  let renderedScroll = 0;

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[character]));
  }

  function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '—';
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
    return Math.round(bytes) + ' B';
  }

  function formatNumber(value, digits) {
    if (!Number.isFinite(value)) return '—';
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: digits == null ? 3 : digits }).format(value);
  }

  function formatDate(milliseconds, withTime) {
    if (!Number.isFinite(milliseconds)) return '—';
    const date = new Date(milliseconds);
    if (!Number.isFinite(date.getTime())) return '—';
    const base = date.toISOString().slice(0, 10);
    if (!withTime) return base;
    return base + ' ' + date.toISOString().slice(11, 19);
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '—';
    if (seconds < 60) return Math.round(seconds) + ' s';
    if (seconds < 3600) return Math.round(seconds / 60) + ' min';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.round((seconds - hours * 3600) / 60);
    return hours + ' h' + (minutes ? ' ' + minutes + ' min' : '');
  }

  function formatDistance(meters) {
    if (!Number.isFinite(meters)) return '—';
    if (meters < 1000) return Math.round(meters) + ' m';
    return (meters / 1000).toFixed(meters < 100000 ? 2 : 1) + ' km';
  }

  function systemLabel(code) {
    return SYSTEM_NAMES[code] || code || 'GNSS';
  }

  const HEADER_LABELS = [
    'RINEX VERSION / TYPE', 'PGM / RUN BY / DATE', 'MARKER NAME', 'MARKER NUMBER',
    'OBSERVER / AGENCY', 'REC # / TYPE / VERS', 'ANT # / TYPE', 'APPROX POSITION XYZ',
    'ANTENNA: DELTA H/E/N', 'INTERVAL', 'TIME OF FIRST OBS', 'TIME OF LAST OBS',
    '# / TYPES OF OBSERV', 'SYS / # / OBS TYPES', 'COMMENT', 'END OF HEADER'
  ];

  function splitHeaderLine(line) {
    if (line.length >= 60) {
      const direct = line.slice(60).trim();
      if (direct) return direct;
    }
    const trimmed = line.replace(/\s+$/, '');
    for (const label of HEADER_LABELS) {
      if (trimmed.endsWith(label)) return label;
    }
    return '';
  }

  function dateFromParts(year, month, day, hour, minute, second) {
    const milliseconds = Date.UTC(+year, +month - 1, +day, +hour, +minute, Math.floor(+second), Math.round((+second % 1) * 1000));
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }

  function ecefToGeodetic(x, y, z) {
    if (![x, y, z].every(Number.isFinite)) return null;
    const a = 6378137.0;
    const f = 1 / 298.257223563;
    const e2 = f * (2 - f);
    const lon = Math.atan2(y, x);
    const p = Math.hypot(x, y);
    let lat = Math.atan2(z, p * (1 - e2));
    for (let i = 0; i < 8; i += 1) {
      const sin = Math.sin(lat);
      const n = a / Math.sqrt(1 - e2 * sin * sin);
      const h = p / Math.cos(lat) - n;
      lat = Math.atan2(z, p * (1 - (e2 * n) / (n + h)));
    }
    const sin = Math.sin(lat);
    const n = a / Math.sqrt(1 - e2 * sin * sin);
    const height = p / Math.cos(lat) - n;
    return { lat: lat * 180 / Math.PI, lon: lon * 180 / Math.PI, height };
  }

  function dmsToDecimal(degrees, minutes, seconds, hemisphere) {
    let value = Math.abs(+degrees) + (+minutes) / 60 + (+seconds) / 3600;
    if (/[SW]/i.test(hemisphere)) value = -value;
    return value;
  }

  function parseCoordText(text) {
    const output = {};
    const source = String(text || '');
    const block = (label, frame, epoch) => {
      const expression = new RegExp(
        label + '[\\s\\S]{0,900}?X\\s*=\\s*([-\\d.]+)\\s*m[\\s\\S]{0,260}?'
        + 'latitude\\s*=\\s*(\\d{1,3})\\s+(\\d{1,2})\\s+([\\d.]+)\\s*([NS])[\\s\\S]{0,220}?'
        + 'longitude\\s*=\\s*(\\d{1,3})\\s+(\\d{1,2})\\s+([\\d.]+)\\s*([EW])[\\s\\S]{0,220}?'
        + 'ellipsoid height\\s*=\\s*([-\\d.]+)',
        'i'
      );
      const match = source.match(expression);
      if (!match) return null;
      const tail = source.slice(match.index || 0, (match.index || 0) + 2200);
      const yMatch = tail.match(/\bY\s*=\s*([-\d.]+)\s*m/i);
      const zMatch = tail.match(/\bZ\s*=\s*([-\d.]+)\s*m/i);
      const vx = tail.match(/VX\s*=\s*([-\d.]+)\s*m\/yr/i);
      const vy = tail.match(/VY\s*=\s*([-\d.]+)\s*m\/yr/i);
      const vz = tail.match(/VZ\s*=\s*([-\d.]+)\s*m\/yr/i);
      const velocity = vx && vy && vz
        ? { x: +vx[1], y: +vy[1], z: +vz[1] }
        : null;
      return {
        lat: dmsToDecimal(match[2], match[3], match[4], match[5]),
        lon: dmsToDecimal(match[6], match[7], match[8], match[9]),
        height: +match[10],
        x: +match[1],
        y: yMatch ? +yMatch[1] : null,
        z: zMatch ? +zMatch[1] : null,
        frame,
        epoch,
        sourceEpoch: epoch,
        ...(velocity ? { velocity } : {})
      };
    };
    const itrf = block('ITRF2020 POSITION', 'ITRF2020', '2020.0');
    if (itrf) output.itrf = itrf;
    const nad = block('NAD_83 \\(2011\\) POSITION', 'NAD83(2011)', '2010.0');
    if (nad) output.nad83 = nad;
    return output;
  }

  function decimalYear(milliseconds) {
    if (!Number.isFinite(milliseconds)) return null;
    const date = new Date(milliseconds);
    const year = date.getUTCFullYear();
    const start = Date.UTC(year, 0, 1);
    const end = Date.UTC(year + 1, 0, 1);
    return year + (milliseconds - start) / (end - start);
  }

  function positionAtEpoch(frame, milliseconds) {
    if (!frame) return null;
    if (frame.frame !== 'ITRF2020' || !frame.velocity || !Number.isFinite(Number(frame.sourceEpoch))) {
      return { ...frame };
    }
    const epoch = decimalYear(milliseconds);
    if (!Number.isFinite(epoch)) return { ...frame };
    const years = epoch - Number(frame.sourceEpoch);
    const x = frame.x + frame.velocity.x * years;
    const y = frame.y + frame.velocity.y * years;
    const z = frame.z + frame.velocity.z * years;
    const geodetic = ecefToGeodetic(x, y, z);
    return {
      ...frame,
      x,
      y,
      z,
      lat: geodetic ? geodetic.lat : frame.lat,
      lon: geodetic ? geodetic.lon : frame.lon,
      height: geodetic ? geodetic.height : frame.height,
      epoch: epoch.toFixed(2),
      propagated: Math.abs(years) > 0.001
    };
  }

  function validBasePosition(position) {
    return !!position
      && [position.lat, position.lon, position.height].every((value) => Number.isFinite(Number(value)))
      && Math.abs(Number(position.lat)) <= 90
      && Math.abs(Number(position.lon)) <= 180;
  }

  function antennaType(observation) {
    const type = observation && observation.antennaType ? String(observation.antennaType).trim() : '';
    return type ? type.split(/\s+/)[0] : '*';
  }

  function normalizeFrame(value) {
    return String(value || '').trim().replace(/^NAD\s*83/i, 'NAD83');
  }

  function parseRinex(text, fileName) {
    const name = String(fileName || 'RINEX file');
    const lowerName = name.toLowerCase();
    if (/\.(ssf|cor)$/.test(lowerName)) {
      return {
        ok: false,
        error: {
          code: 'proprietary',
          title: 'This is a proprietary receiver file, not RINEX',
          message: 'Convert it with the receiver manufacturer\'s free RINEX export utility or field software. Then drop the resulting observation file (.obs, .rnx or .??o) here. The Convert GNSS files tool can check the result and open it in post-processing.'
        }
      };
    }
    if (/\.z$/.test(lowerName) && !/\.gz$/.test(lowerName)) {
      return {
        ok: false,
        error: {
          code: 'compress',
          title: 'UNIX .Z compression is not supported in the browser',
          message: 'Decompress the file with uncompress or 7-Zip, then drop the .rnx, .obs or .??o file here.'
        }
      };
    }
    const source = String(text || '');
    if (!source.trim()) {
      return { ok: false, error: { code: 'empty', title: 'The file is empty', message: 'Choose the RINEX observation file exported from the receiver.' } };
    }
    if (/CRINEX VERS\s*\/\s*TYPE/i.test(source)) {
      return {
        ok: false,
        error: {
          code: 'hatanaka',
          title: 'This RINEX file is Hatanaka-compressed',
          message: 'Decompress it with CRX2RNX first, then drop the resulting .rnx or .??o file here. NOAA CORS downloads made by Northstar are already ordinary RINEX.'
        }
      };
    }
    const lines = source.split(/\r?\n/);
    const header = {
      version: null,
      versionLabel: 'RINEX',
      fileType: '',
      system: '',
      markerName: '',
      markerNumber: '',
      observer: '',
      agency: '',
      receiver: '',
      antenna: '',
      antennaNumber: '',
      antennaType: '',
      antennaDelta: { h: 0, e: 0, n: 0 },
      approx: null,
      interval: null,
      firstHeader: null,
      lastHeader: null,
      timeSystem: 'GPS',
      obsTypes: [],
      sysObs: {},
      obsCount: 0,
      headerEnd: -1,
      comments: []
    };
    let currentSystem = '';
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line) continue;
      const label = splitHeaderLine(line);
      if (!label) {
        if (/END OF HEADER\s*$/i.test(line)) {
          header.headerEnd = i;
          break;
        }
        continue;
      }
      const body = line.slice(0, 60);
      if (label === 'RINEX VERSION / TYPE') {
        header.version = parseFloat(body.slice(0, 9));
        header.versionLabel = 'RINEX ' + (header.version || '');
        header.fileType = body.slice(20, 21).trim().toUpperCase();
        header.system = body.slice(40, 60).trim().toUpperCase();
      } else if (label === 'MARKER NAME') {
        header.markerName = body.trim();
      } else if (label === 'MARKER NUMBER') {
        header.markerNumber = body.trim();
      } else if (label === 'OBSERVER / AGENCY') {
        header.observer = body.slice(0, 20).trim();
        header.agency = body.slice(20, 60).trim();
      } else if (label === 'REC # / TYPE / VERS') {
        header.receiver = [body.slice(0, 20).trim(), body.slice(20, 40).trim(), body.slice(40, 60).trim()].filter(Boolean).join(' ');
      } else if (label === 'ANT # / TYPE') {
        header.antennaNumber = body.slice(0, 20).trim();
        header.antennaType = body.slice(20, 40).trim();
        header.antenna = [header.antennaNumber, header.antennaType].filter(Boolean).join(' ');
      } else if (label === 'APPROX POSITION XYZ') {
        const values = body.trim().split(/\s+/).map(Number);
        if (values.length >= 3 && values.slice(0, 3).every(Number.isFinite)) {
          const geodetic = ecefToGeodetic(values[0], values[1], values[2]);
          header.approx = { x: values[0], y: values[1], z: values[2], ...(geodetic || {}) };
        }
      } else if (label === 'ANTENNA: DELTA H/E/N') {
        const values = body.trim().split(/\s+/).map(Number);
        if (values.length >= 3 && values.slice(0, 3).every(Number.isFinite)) {
          header.antennaDelta = { h: values[0], e: values[1], n: values[2] };
        }
      } else if (label === 'INTERVAL') {
        const value = parseFloat(body.slice(0, 10));
        if (Number.isFinite(value)) header.interval = value;
      } else if (label === 'TIME OF FIRST OBS') {
        const values = body.trim().split(/\s+/);
        if (values.length >= 6) header.firstHeader = dateFromParts(values[0], values[1], values[2], values[3], values[4], values[5]);
        header.timeSystem = body.slice(48, 51).trim() || 'GPS';
      } else if (label === 'TIME OF LAST OBS') {
        const values = body.trim().split(/\s+/);
        if (values.length >= 6) header.lastHeader = dateFromParts(values[0], values[1], values[2], values[3], values[4], values[5]);
      } else if (label === '# / TYPES OF OBSERV') {
        const count = parseInt(body.slice(0, 6), 10);
        if (Number.isFinite(count)) header.obsCount = count;
        const types = body.slice(6).trim().split(/\s+/).filter(Boolean);
        header.obsTypes.push(...types);
      } else if (label === 'SYS / # / OBS TYPES') {
        const code = body.slice(0, 1).trim().toUpperCase();
        if (/[A-Z]/.test(code)) currentSystem = code;
        if (!currentSystem) continue;
        if (!header.sysObs[currentSystem]) header.sysObs[currentSystem] = [];
        const types = body.slice(7).trim().split(/\s+/).filter((item) => /^[A-Z]/.test(item));
        header.sysObs[currentSystem].push(...types);
      } else if (label === 'COMMENT') {
        if (header.comments.length < 12) header.comments.push(body.trim());
      }
      if (label === 'END OF HEADER') {
        header.headerEnd = i;
        break;
      }
    }
    if (header.headerEnd < 0) {
      return {
        ok: false,
        error: {
          code: 'header',
          title: 'No RINEX header was found',
          message: 'The file does not end its header with END OF HEADER. It may be a navigation file, a text export, or a damaged file.'
        }
      };
    }
    if (header.fileType && header.fileType !== 'O') {
      return {
        ok: false,
        error: {
          code: 'not-observation',
          title: 'This is not an observation file',
          message: 'The file is RINEX type ' + header.fileType + '. A rover correction needs an observation file (type O) and navigation data separately.'
        }
      };
    }
    if (!header.version || header.version < 2) {
      return {
        ok: false,
        error: {
          code: 'version',
          title: 'Unsupported RINEX version',
          message: 'Northstar reads RINEX 2, 3 and 4 observation files. Re-export the file as RINEX 2.11 or RINEX 3.'
        }
      };
    }
    const observed = scanEpochs(lines, header);
    if (!observed.times.length) {
      return {
        ok: false,
        error: {
          code: 'no-epochs',
          title: 'No observation epochs were found',
          message: 'The header is readable, but no satellite observations could be read. Check that the file contains observation records, not only metadata.'
        }
      };
    }
    const types = header.obsTypes.concat(...Object.values(header.sysObs));
    const uniqueTypes = Array.from(new Set(types));
    const systems = Array.from(new Set(observed.systems.length ? observed.systems : (header.sysObs && Object.keys(header.sysObs)) || []));
    const firstMs = observed.times[0];
    const lastMs = observed.times[observed.times.length - 1];
    const interval = header.interval || observed.interval;
    const duration = (lastMs - firstMs) / 1000;
    const warnings = [];
    if (!header.approx || !Number.isFinite(header.approx.lat) || !Number.isFinite(header.approx.lon)) {
      warnings.push('No approximate position is in the header, so Northstar cannot search for a nearby base station.');
    }
    if (!header.markerName) warnings.push('The header has no marker name.');
    if (!interval) warnings.push('The observation interval is not stated; Northstar estimated it from the first epochs.');
    if (!uniqueTypes.some((type) => /^L\d/i.test(type))) warnings.push('No carrier-phase observation types were found. RTKLIB needs phase observations for a fixed solution.');
    return {
      ok: true,
      name,
      fileType: 'observation',
      size: source.length,
      version: header.version,
      versionLabel: header.versionLabel,
      timeSystem: header.timeSystem,
      markerName: header.markerName,
      markerNumber: header.markerNumber,
      observer: header.observer,
      agency: header.agency,
      receiver: header.receiver,
      antenna: header.antenna,
      antennaType: header.antennaType,
      antennaDelta: header.antennaDelta,
      approx: header.approx,
      interval: interval || null,
      firstMs,
      lastMs,
      duration,
      epochCount: observed.times.length,
      systems: systems.sort(),
      satelliteIds: observed.satellites || [],
      obsTypes: uniqueTypes,
      hasPhase: uniqueTypes.some((type) => /^L\d/i.test(type)),
      hasL2: uniqueTypes.some((type) => /^L2/i.test(type) || type === 'L2'),
      warnings,
      header
    };
  }

  // RINEX 2 may write bare two-digit PRNs for GPS; RINEX 3 always prefixes the
  // system letter. Return whichever form the line uses, normalised to Gnn.
  function satelliteIdsFromText(text) {
    const source = String(text || '');
    const prefixed = source.match(/[GRECJSI]\d{2}/g);
    if (prefixed) return prefixed;
    return (source.match(/(?:^|\s)(\d{1,2})(?=\s|$)/g) || []).map((value) => 'G' + value.trim().padStart(2, '0'));
  }

  function scanEpochs(lines, header) {
    const times = [];
    const systems = new Set();
    const satellites = new Set();
    let differences = [];
    const version3 = (header.version || 0) >= 3;
    if (version3) {
      let i = header.headerEnd + 1;
      while (i < lines.length) {
        const line = lines[i];
        if (line && line.startsWith('>')) {
          const fields = line.slice(1).trim().split(/\s+/);
          const time = fields.length >= 6 ? dateFromParts(fields[0], fields[1], fields[2], fields[3], fields[4], fields[5]) : null;
          const flag = parseInt(fields[6], 10) || 0;
          const satelliteCount = parseInt(fields[7], 10) || 0;
          if (time && (flag === 0 || flag === 1) && satelliteCount > 0) {
            times.push(time);
            if (times.length > 1) differences.push((times[times.length - 1] - times[times.length - 2]) / 1000);
          }
          i += 1;
          if (flag === 0 || flag === 1) {
            for (let satellite = 0; satellite < satelliteCount; satellite += 1) {
              const satelliteLine = lines[i] || '';
              const system = satelliteLine.trim().slice(0, 1).toUpperCase();
              if (/[A-Z]/.test(system)) systems.add(system);
              const satelliteId = satelliteLine.slice(0, 3).trim().toUpperCase();
              if (/^[GRECJSI]\d{2}$/.test(satelliteId)) satellites.add(satelliteId);
              const count = (header.sysObs[system] || header.obsTypes).length || header.obsCount || 1;
              i += Math.max(1, Math.ceil(count / 5));
            }
          } else if (flag >= 2 && flag <= 6) {
            i += satelliteCount;
          }
        } else {
          i += 1;
        }
      }
    } else {
      let i = header.headerEnd + 1;
      const epochPattern = /^\s*(\d{2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2}(?:\.\d+)?)\s+([0-6])\s+(\d{1,2})(.*)$/;
      const obsLines = Math.max(1, Math.ceil((header.obsCount || header.obsTypes.length || 1) / 5));
      while (i < lines.length) {
        const line = lines[i];
        const match = line.match(epochPattern);
        if (!match) {
          i += 1;
          continue;
        }
        const year = +match[1] < 80 ? 2000 + +match[1] : 1900 + +match[1];
        const time = dateFromParts(year, match[2], match[3], match[4], match[5], match[6]);
        const flag = parseInt(match[7], 10) || 0;
        const satelliteCount = parseInt(match[8], 10) || 0;
        const firstSatelliteLine = match[9] || '';
        for (const id of satelliteIdsFromText(firstSatelliteLine)) {
          systems.add(id[0]);
          satellites.add(id);
        }
        let next = i + 1;
        const continuation = Math.max(0, Math.ceil(satelliteCount / 12) - 1);
        for (let extra = 0; extra < continuation; extra += 1) {
          for (const id of satelliteIdsFromText(lines[next] || '')) {
            systems.add(id[0]);
            satellites.add(id);
          }
          next += 1;
        }
        if (time && (flag === 0 || flag === 1) && satelliteCount > 0) {
          times.push(time);
          if (times.length > 1) differences.push((times[times.length - 1] - times[times.length - 2]) / 1000);
          next += satelliteCount * obsLines;
        } else if (flag >= 2 && flag <= 6) {
          next += satelliteCount;
        }
        i = next;
      }
    }
    differences = differences.filter((value) => Number.isFinite(value) && value > 0 && value < 3600);
    differences.sort((a, b) => a - b);
    return {
      times,
      systems: Array.from(systems),
      satellites: Array.from(satellites).sort(),
      interval: differences.length ? differences[Math.floor(differences.length / 2)] : null
    };
  }

  // RINEX 2 navigation files hold one constellation, so the file type names the
  // system. RINEX 3 records carry the system letter in front of the PRN.
  const NAV_SYSTEM_BY_TYPE = { N: 'G', G: 'R', L: 'E', E: 'E', J: 'J', C: 'C', H: 'H', I: 'I' };


  function parseNavigation(text, name) {
    const source = String(text || '');
    const fail = (title, message) => ({ ok: false, error: { title, message } });
    if (!source.trim()) return fail('The navigation file is empty', 'Choose the broadcast navigation file that matches this session.');
    const lines = source.split(/\r?\n/);
    const versionLine = lines.slice(0, 80).find((line) => /RINEX VERSION \/ TYPE/i.test(line));
    if (!versionLine) return fail('No RINEX navigation header', 'The file does not start with a RINEX VERSION / TYPE line.');
    const version = parseFloat(versionLine.slice(0, 9));
    const type = versionLine.slice(20, 21).trim().toUpperCase();
    if (!['N', 'G', 'L', 'E', 'J', 'C', 'H', 'I'].includes(type)) {
      return fail('This is not a navigation file', 'The file is RINEX type ' + (type || 'unknown') + ', not broadcast ephemeris.');
    }
    const headerEnd = lines.findIndex((line) => /END OF HEADER\s*$/i.test(line));
    if (headerEnd < 0) return fail('Incomplete navigation file', 'The header has no END OF HEADER line.');
    // RINEX 2 navigation names its constellation in column 41 ("NAVIGATION DATA
    // G (GLONASS)") and keeps type N; a GPS file often leaves that column
    // blank, which means GPS. RINEX 3 records carry the letter themselves.
    const headerSystem = ((versionLine.slice(40, 60).match(/[GRECJSI]/) || [])[0]) || '';
    const fallbackSystem = headerSystem || (type === 'N' ? 'G' : NAV_SYSTEM_BY_TYPE[type] || null);
    const v3Record = /^([GRECJSI])(\d{2})\s+(\d{4})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2}(?:\.\d+)?)/;
    const v2Record = /^\s*(\d{1,2})\s+(\d{2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2}(?:\.\d+)?)/;
    const records = [];
    for (let index = headerEnd + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line || !line.trim()) continue;
      if (version >= 3) {
        const match = line.match(v3Record);
        if (!match) continue;
        const toeMs = dateFromParts(match[3], match[4], match[5], match[6], match[7], match[8]);
        if (Number.isFinite(toeMs)) records.push({ id: match[1] + match[2], toeMs });
      } else {
        const match = line.match(v2Record);
        if (!match || !fallbackSystem) continue;
        const year = +match[2] < 80 ? 2000 + +match[2] : 1900 + +match[2];
        const toeMs = dateFromParts(year, match[3], match[4], match[5], match[6], match[7]);
        if (Number.isFinite(toeMs)) records.push({ id: fallbackSystem + String(+match[1]).padStart(2, '0'), toeMs });
      }
    }
    const satellites = Array.from(new Set(records.map((record) => record.id))).sort();
    const times = records.map((record) => record.toeMs);
    return {
      ok: true,
      name,
      version,
      versionLabel: 'RINEX ' + (version || ''),
      type,
      fallbackSystem,
      recordCount: records.length,
      satellites,
      systems: Array.from(new Set(satellites.map((id) => id[0]))).sort(),
      firstMs: times.length ? Math.min(...times) : null,
      lastMs: times.length ? Math.max(...times) : null,
      epochs: records
    };
  }

  // RTKLIB interpolates a satellite position from broadcast ephemeris, so the
  // only thing Northstar has to verify is that ephemeris exists near the
  // session. The usable age differs by constellation: GPS and the regional
  // systems are re-broadcast every two hours, GLONASS every 30 minutes, and
  // Galileo every four hours. A single two-hour rule would wrongly accept a
  // stale GLONASS record, so keep them separate.
  const MINUTE_MS = 60 * 1000;
  const EPHEMERIS_WINDOW_MS = {
    G: 120 * MINUTE_MS,
    J: 120 * MINUTE_MS,
    C: 120 * MINUTE_MS,
    I: 120 * MINUTE_MS,
    E: 240 * MINUTE_MS,
    R: 30 * MINUTE_MS,
    S: 60 * MINUTE_MS
  };
  const DEFAULT_EPHEMERIS_WINDOW_MS = 120 * MINUTE_MS;

  function navCoverage(rover, files) {
    const observed = rover && Array.isArray(rover.satelliteIds) ? rover.satelliteIds : [];
    if (!observed.length) return null;
    const entries = (files || []).filter((file) => file && file.summary && Array.isArray(file.summary.epochs));
    if (!entries.length) return null;
    const bySatellite = new Map();
    let recordCount = 0;
    entries.forEach((file) => {
      file.summary.epochs.forEach((record) => {
        recordCount += 1;
        if (!bySatellite.has(record.id)) bySatellite.set(record.id, []);
        bySatellite.get(record.id).push(record.toeMs);
      });
    });
    if (!recordCount) return null;
    const covered = [];
    const stale = [];
    const missing = [];
    observed.forEach((id) => {
      const toes = bySatellite.get(id);
      if (!toes) {
        missing.push(id);
        return;
      }
      const window = EPHEMERIS_WINDOW_MS[id[0]] || DEFAULT_EPHEMERIS_WINDOW_MS;
      const usable = toes.some((toe) => toe >= rover.firstMs - window && toe <= rover.lastMs + window);
      if (usable) covered.push(id);
      else stale.push(id);
    });
    return {
      observed: observed.length,
      covered: covered.length,
      coveredIds: covered,
      missing,
      stale,
      recordCount,
      systems: Array.from(new Set(entries.flatMap((file) => file.summary.systems || []))).sort()
    };
  }

  function describeSatellites(ids) {
    const list = ids.slice(0, 8).join(', ');
    return ids.length > 8 ? list + ' and ' + (ids.length - 8) + ' more' : list;
  }

  async function decompressIfNeeded(buffer) {
    const bytes = new Uint8Array(buffer);
    if (!(bytes[0] === 0x1f && bytes[1] === 0x8b)) return new Uint8Array(buffer);
    if (typeof DecompressionStream !== 'function') {
      throw new Error('This browser cannot open .gz files. Decompress the file first, then drop the .rnx or .??o.');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function readTextFile(file) {
    const buffer = await file.arrayBuffer();
    const bytes = await decompressIfNeeded(buffer);
    return new TextDecoder('utf-8').decode(bytes);
  }

  async function readObservation(file) {
    try {
      const text = await readTextFile(file);
      const parsed = parseRinex(text, file.name);
      if (!parsed.ok) {
        parsed.error = parsed.error || { title: 'Unreadable observation file', message: 'Northstar could not read this file.' };
        return parsed;
      }
      parsed.size = file.size || text.length;
      parsed.text = text;
      return parsed;
    } catch (error) {
      return { ok: false, error: { code: 'read', title: 'Could not read the file', message: error && error.message ? error.message : 'The browser could not open this file.' } };
    }
  }

  async function readAuxiliary(file) {
    const text = await readTextFile(file);
    if (/\.sp3$/i.test(file.name)) return { ok: true, kind: 'sp3', name: file.name, text };
    const header = text.split(/\r?\n/).slice(0, 80).find((line) => /RINEX VERSION \/ TYPE/i.test(line));
    if (!header) throw new Error('No RINEX navigation header was found in ' + file.name + '.');
    const type = header.slice(20, 21).trim().toUpperCase();
    if (!['N', 'G', 'H', 'J', 'L', 'C'].includes(type)) {
      throw new Error(file.name + ' is not a navigation or SP3 file.');
    }
    return navEntry(file.name, text, 'user');
  }

  function navEntry(name, text, source) {
    const summary = parseNavigation(text, name);
    return { ok: true, kind: 'nav', name, text, source: source || 'user', summary: summary.ok ? summary : null };
  }

  function summarizeObservation(observation) {
    if (!observation) return null;
    return {
      name: observation.name,
      markerName: observation.markerName,
      versionLabel: observation.versionLabel,
      timeSystem: observation.timeSystem,
      interval: observation.interval,
      firstMs: observation.firstMs,
      lastMs: observation.lastMs,
      duration: observation.duration,
      epochCount: observation.epochCount,
      systems: observation.systems,
      hasPhase: observation.hasPhase,
      hasL2: observation.hasL2,
      antennaType: observation.antennaType,
      antennaDelta: observation.antennaDelta
    };
  }

  function geodesicDistance(a, b) {
    if (!a || !b || [a.lat, a.lon, b.lat, b.lon].some((value) => !Number.isFinite(+value))) return null;
    if (window.northstarGeodesy && typeof window.northstarGeodesy.lengthMeters === 'function') {
      const distance = window.northstarGeodesy.lengthMeters('geographiclib', [a.lon, a.lat], [b.lon, b.lat]);
      if (Number.isFinite(distance)) return distance;
    }
    const radius = 6371008.8;
    const toRad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * toRad;
    const dLon = (b.lon - a.lon) * toRad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
    return 2 * radius * Math.asin(Math.sqrt(h));
  }

  function evaluateJob(rover, base, options, extras) {
    const detail = extras || {};
    const basePosition = detail.basePosition !== undefined ? detail.basePosition : state.basePosition;
    const hasBasePosition = validBasePosition(basePosition);
    const navCount = detail.navCount == null ? (detail.nav ? detail.nav.length : state.nav.length) : detail.navCount;
    const hasSp3 = detail.sp3 == null ? !!state.sp3 : !!detail.sp3;
    const checks = [];
    const add = (key, label, status, text) => checks.push({ key, label, status, text });

    if (!rover) {
      add('rover', 'Rover observations', 'fail', 'Choose the rover RINEX observation file.');
    } else {
      add('rover', 'Rover observations', 'pass', rover.epochCount + ' epochs · ' + formatDuration(rover.duration) + ' · ' + rover.versionLabel);
      if (!rover.hasPhase) add('phase', 'Carrier phase', 'fail', 'No L1/L2 phase types were found. Only a code-only solution is possible, not a fixed survey coordinate.');
      else add('phase', 'Carrier phase', 'pass', 'Phase observations are present.');
      if (rover.duration < 120) add('duration', 'Session length', 'fail', 'Shorter than two minutes. Collect more time before correcting.');
      else if (rover.duration < 600) add('duration', 'Session length', 'warn', 'Under ten minutes. A fixed solution may be weak; 10–30 minutes is better for a point.');
      else add('duration', 'Session length', 'pass', 'Long enough for a static point.');
      if (rover.interval && rover.interval > 30) add('interval', 'Rover interval', 'warn', rover.interval.toFixed(0) + ' s. This is coarse for a moving track, but acceptable for a static point.');
    }

    let overlap = 0;
    let distance = null;
    if (!base) {
      add('base', 'Base observations', 'fail', 'Choose a base station or import a base RINEX file.');
    } else {
      add('base', 'Base observations', 'pass', base.epochCount + ' epochs · ' + formatDuration(base.duration) + ' · ' + base.versionLabel);
      if (!base.hasPhase) add('base-phase', 'Base carrier phase', 'fail', 'The base file has no carrier-phase observations.');
      if (rover) {
        overlap = Math.max(0, (Math.min(rover.lastMs, base.lastMs) - Math.max(rover.firstMs, base.firstMs)) / 1000);
        if (overlap <= 0) {
          add('overlap', 'Time overlap', 'fail', 'The base and rover do not share any observation time.');
        } else if (overlap < Math.min(600, rover.duration * 0.95)) {
          add('overlap', 'Time overlap', 'warn', 'Only ' + formatDuration(overlap) + ' overlaps the ' + formatDuration(rover.duration) + ' rover session.');
        } else {
          add('overlap', 'Time overlap', 'pass', formatDuration(overlap) + ' of shared observations.');
        }
        if (rover.systems.length && base.systems.length) {
          const missing = rover.systems.filter((system) => !base.systems.includes(system));
          if (missing.length) add('systems', 'Constellation match', 'warn', 'The base does not list ' + missing.map(systemLabel).join(', ') + '. Those satellites cannot be used.');
          else add('systems', 'Constellation match', 'pass', 'Both files share ' + rover.systems.map(systemLabel).join(', ') + '.');
        }
        distance = hasBasePosition && rover.approx ? geodesicDistance(rover.approx, basePosition) : null;
        if (Number.isFinite(distance)) {
          if (distance > 150000) add('distance', 'Base distance', 'fail', formatDistance(distance) + ' is too far for a reliable short-baseline correction.');
          else if (distance > 30000) add('distance', 'Base distance', 'warn', formatDistance(distance) + '. Accuracy falls as the baseline grows; use a closer station when possible.');
          else add('distance', 'Base distance', 'pass', formatDistance(distance) + ' from the rover.');
        } else {
          add('distance', 'Base distance', 'warn', 'The rover or base position is missing, so the baseline length cannot be checked.');
        }
      }
    }

    if (navCount > 0 || hasSp3) {
      add('navigation', 'Navigation data', 'pass', [navCount ? navCount + ' navigation file' + (navCount === 1 ? '' : 's') : '', hasSp3 ? 'precise SP3 orbit' : ''].filter(Boolean).join(' + '));
    } else {
      add('navigation', 'Navigation data', 'fail', 'No navigation file or SP3 orbit. RTKLIB cannot compute satellite positions without ephemerides.');
    }

    // Navigation files from the user's own computer go to RTKLIB byte for byte.
    // Some receiver exports (a Trimble GeoXT RINEX 2 file is the known case) make
    // RTKLIB stop with "no average of base station position", so flag them before
    // a run instead of letting the engine fail without an explanation.
    const userNav = (detail.nav || state.nav).filter((file) => file && file.source === 'user');
    if (userNav.length) {
      add('nav-source', 'Navigation files', 'warn', userNav.map((file) => file.name).join(', ')
        + ' comes from your computer, not the base station. RTKLIB reads it directly; a few receiver exports make it stop with "no average of base station position". If that happens, remove the file and run again with the base station navigation.');
    }

    const coverage = navCoverage(rover, detail.nav || state.nav);
    if (coverage) {
      const unusable = coverage.missing.concat(coverage.stale);
      if (!coverage.covered) {
        add('ephemeris', 'Satellite ephemeris', 'fail', 'The navigation data has no record near this session for any of the ' + coverage.observed + ' observed satellites. Check that the file covers the same day and constellation.');
      } else if (unusable.length) {
        add('ephemeris', 'Satellite ephemeris', 'warn', coverage.covered + ' of ' + coverage.observed + ' observed satellites have ephemeris recent enough for the session. Not usable: ' + describeSatellites(unusable) + '. RTKLIB will drop those satellites.');
      } else {
        add('ephemeris', 'Satellite ephemeris', 'pass', 'All ' + coverage.covered + ' observed satellites have broadcast ephemeris covering the session.');
      }
    }

    if (hasBasePosition) {
      const frame = basePosition.frame ? ' · ' + basePosition.frame : '';
      const epoch = basePosition.epoch ? ' · epoch ' + basePosition.epoch : '';
      if (basePosition.source === 'rinex') add('reference', 'Base reference position', 'warn', 'Using the RINEX header position' + frame + '. It is approximate; use the station published coordinate or enter a surveyed position.');
      else add('reference', 'Base reference position', 'pass', (basePosition.label || 'Published or manually entered') + frame + epoch + '. This frame is inherited by the corrected point.');
    } else if (base) {
      add('reference', 'Base reference position', 'fail', 'Enter the base station published latitude, longitude and ellipsoid height. A zero or missing base position shifts every corrected point.');
    }

    if (options && options.frequency === 'l1+l2') {
      if (rover && !rover.hasL2) add('frequency', 'Dual frequency', 'warn', 'The rover file has no L2 observations. Choose L1 only for this receiver.');
      else if (base && !base.hasL2) add('frequency', 'Dual frequency', 'warn', 'The base file has no L2 observations. Choose L1 only or use a dual-frequency base.');
      else add('frequency', 'Dual frequency', 'pass', 'L1 and L2 are available.');
    }
    if (options && options.ephemeris === 'precise' && !hasSp3) add('ephemeris', 'Precise orbit', 'warn', 'Precise SP3 was requested but no SP3 file is attached. RTKLIB will fall back to broadcast navigation.');
    if (rover && !rover.antennaType) add('rover-antenna', 'Rover antenna', 'warn', 'The RINEX header has no antenna type. RTKLIB can still process the file, but the phase-center correction may be incomplete.');
    if (base && !base.antennaType) add('base-antenna', 'Base antenna', 'warn', 'The base RINEX header has no antenna type. Check the station log before relying on the height.');

    const fail = checks.some((check) => check.status === 'fail');
    const warn = checks.some((check) => check.status === 'warn');
    return {
      checks,
      status: fail ? 'fail' : warn ? 'warn' : 'pass',
      overlapSeconds: overlap,
      distance,
      basePositionValid: hasBasePosition
    };
  }

  function navSystemMask(rover, base) {
    const systems = Array.from(new Set([...(rover ? rover.systems : []), ...(base ? base.systems : [])]));
    let mask = 0;
    for (const system of systems) mask |= SYSTEM_BITS[system] || 0;
    return mask || 1;
  }

  function rtkOption(name, value) {
    // RTKLIB's options parser does not trim spaces after '=', and enum values
    // must match exactly. Keep the name padded, then the value immediately
    // after the equals sign so every option is applied instead of ignored.
    return name.padEnd(19, ' ') + '=' + value;
  }

  function buildRtkConfig(rover, base, options, extras) {
    const detail = extras || {};
    const basePosition = detail.basePosition !== undefined ? detail.basePosition : state.basePosition;
    const position = basePosition || {};
    const navsys = navSystemMask(rover, base);
    const sateph = (detail.sp3 || state.sp3) && options.ephemeris === 'precise' ? 'precise' : 'brdc';
    const frequency = options.frequency === 'l1' ? 1 : options.frequency === 'l1+l2+l5' ? 3 : 2;
    const iono = frequency === 1 ? 'brdc' : 'dual-freq';
    const baseLat = Number(position.lat);
    const baseLon = Number(position.lon);
    const baseUp = Number(position.height);
    const frame = position.frame || 'unknown';
    const epoch = position.epoch ? ' at epoch ' + position.epoch : '';
    return [
      '# Northstar GNSS correction job',
      '# Generated ' + new Date().toISOString(),
      '# RTKLIB 2.4.3 or newer.',
      '# Base position frame: ' + frame + epoch + '. The corrected .pos inherits this frame.',
      '# Heights are ellipsoidal. The station coordinate is the antenna reference point (ARP).',
      rtkOption('pos1-posmode', options.posMode),
      rtkOption('pos1-frequency', frequency),
      rtkOption('pos1-soltype', options.solutionType),
      rtkOption('pos1-elmask', options.elevationMask),
      rtkOption('pos1-snrmask_r', 'off'),
      rtkOption('pos1-snrmask_b', 'off'),
      rtkOption('pos1-ionoopt', iono),
      rtkOption('pos1-tropopt', 'saas'),
      rtkOption('pos1-sateph', sateph),
      rtkOption('pos1-navsys', navsys),
      rtkOption('pos1-posopt1', 'off'),
      rtkOption('pos1-posopt2', 'off'),
      rtkOption('pos2-armode', options.arMode),
      rtkOption('pos2-gloarmode', 'on'),
      rtkOption('pos2-arthres', '3'),
      rtkOption('pos2-arlockcnt', '5'),
      rtkOption('pos2-arelmask', options.elevationMask),
      rtkOption('pos2-elmaskhold', '0'),
      rtkOption('pos2-aroutcnt', '5'),
      rtkOption('pos2-maxage', options.maxAge),
      '# The rover position, antenna type and antenna delta come from the RINEX header.',
      rtkOption('ant1-postype', 'rinexhead'),
      rtkOption('ant1-anttype', '*'),
      rtkOption('ant1-antdele', '0'),
      rtkOption('ant1-antdeln', '0'),
      rtkOption('ant1-antdelu', '0'),
      rtkOption('ant2-postype', 'llh'),
      rtkOption('ant2-pos1', Number.isFinite(baseLat) ? baseLat.toFixed(10) : '0'),
      rtkOption('ant2-pos2', Number.isFinite(baseLon) ? baseLon.toFixed(10) : '0'),
      rtkOption('ant2-pos3', Number.isFinite(baseUp) ? baseUp.toFixed(4) : '0'),
      rtkOption('ant2-anttype', '*'),
      rtkOption('ant2-antdele', '0'),
      rtkOption('ant2-antdeln', '0'),
      rtkOption('ant2-antdelu', '0'),
      rtkOption('out-solformat', 'llh'),
      rtkOption('out-outhead', 'on'),
      rtkOption('out-outopt', 'on'),
      rtkOption('out-timesys', 'gpst'),
      rtkOption('out-timeform', 'hms'),
      rtkOption('out-timendec', '3'),
      rtkOption('out-degform', 'deg'),
      rtkOption('out-height', 'ellipsoid'),
      rtkOption('out-solstatic', 'all'),
      rtkOption('out-nmeaintv1', '0'),
      rtkOption('out-nmeaintv2', '0'),
      rtkOption('out-outstat', 'residual'),
      rtkOption('stats-eratio1', '100'),
      rtkOption('stats-eratio2', '100')
    ].join('\n') + '\n';
  }

  function shellQuote(name) {
    return /^[A-Za-z0-9._-]+$/.test(name) ? name : "'" + String(name).replace(/'/g, "'\\''") + "'";
  }

  function outputName(rover) {
    const source = (rover && rover.name ? rover.name : 'northstar').replace(/\.[^.]+$/, '');
    return (source.replace(/[^A-Za-z0-9._-]+/g, '_') || 'northstar') + '.pos';
  }

  function buildCommand(rover, base, nav, sp3, outName) {
    const inputs = [];
    if (rover && rover.name) inputs.push(rover.name);
    if (base && base.name) inputs.push(base.name);
    for (const file of nav || []) if (file.name) inputs.push(file.name);
    if (sp3 && sp3.name) inputs.push(sp3.name);
    return 'rnx2rtkp -k northstar_job.conf ' + inputs.map(shellQuote).join(' ') + ' -o ' + shellQuote(outName || 'northstar.pos');
  }

  function buildBrief(rover, base, options, evaluation, extras) {
    const detail = extras || {};
    const basePosition = detail.basePosition || state.basePosition || {};
    const command = buildCommand(rover, base, detail.nav || state.nav, detail.sp3 || state.sp3, outputName(rover));
    const station = detail.baseStation || state.baseStation;
    const lines = [
      'NORTHSTAR GNSS CORRECTION JOB',
      '=============================',
      '',
      'Created: ' + new Date().toISOString(),
      'Rover:   ' + (rover ? rover.name : '—'),
      'Marker:  ' + (rover && rover.markerName ? rover.markerName : '—'),
      'Window:  ' + (rover ? formatDate(rover.firstMs, true) + ' to ' + formatDate(rover.lastMs, true) + ' UTC-like ' + rover.timeSystem : '—'),
      'Base:    ' + (station ? station.corsId + ' · ' + station.name : (base ? base.name : '—')),
      'Baseline: ' + (evaluation && Number.isFinite(evaluation.distance) ? formatDistance(evaluation.distance) : 'not checked'),
      'Reference position: ' + (basePosition.label || basePosition.source || '—'),
      'Reference frame: ' + (basePosition.frame || 'not stated') + (basePosition.epoch ? ' · epoch ' + basePosition.epoch : ''),
      'Output frame: ' + (basePosition.frame || 'not stated') + ' · heights ellipsoidal',
      'Base coordinate: ARP (antenna reference point)',
      'Mode:    ' + options.posMode + ' · ' + options.frequency + ' · elevation mask ' + options.elevationMask + '°',
      '',
      'Checks',
      '------',
      ...evaluation.checks.map((check) => '[' + check.status.toUpperCase() + '] ' + check.label + ': ' + check.text),
      '',
      'How to run',
      '----------',
      '1. Install free RTKLIB 2.4.3 or newer: https://www.rtklib.com/',
      '2. Put the files in this package in one folder with rnx2rtkp available.',
      '3. Run:',
      '',
      '   ' + command,
      '',
      '4. Open the resulting .pos in Northstar: Tools → Coordinate post-processing → Review → Corrected result.',
      '',
      'What this does not do',
      '---------------------',
      'Northstar prepared and checked the job. RTKLIB performs the differential',
      'correction. Only fixed epochs (Q=1) are accepted as a survey coordinate.',
      'The result is not a legal survey, and the reference frame/epoch must be',
      'checked before recording it as an authoritative coordinate.',
      '',
      'Data sources',
      '------------',
      state.baseSource === 'noaa'
        ? 'NOAA CORS / UFCORS provided the base observations, navigation data, precise orbit and published station coordinate. Review the NOAA terms and the station log before relying on the result.'
        : 'The base observations, navigation data, SP3 orbit and base coordinate were supplied by the user. Check the station log, frame and antenna metadata before relying on the result.',
      '',
      'Northstar job ID: ' + (state.job ? state.job.id : 'not yet saved')
    ];
    return lines.join('\n') + '\n';
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) {
      crc ^= bytes[i];
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function zipBlob(files) {
    const encoder = new TextEncoder();
    const chunks = [];
    const central = [];
    let offset = 0;
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    for (const file of files) {
      const name = encoder.encode(file.name);
      const data = typeof file.data === 'string' ? encoder.encode(file.data) : file.data;
      const crc = crc32(data);
      const local = new Uint8Array(30 + name.length);
      const localView = new DataView(local.buffer);
      localView.setUint32(0, 0x04034b50, true);
      localView.setUint16(4, 20, true);
      localView.setUint16(6, 0x0800, true);
      localView.setUint16(8, 0, true);
      localView.setUint16(10, dosTime, true);
      localView.setUint16(12, dosDate, true);
      localView.setUint32(14, crc, true);
      localView.setUint32(18, data.length, true);
      localView.setUint32(22, data.length, true);
      localView.setUint16(26, name.length, true);
      localView.setUint16(28, 0, true);
      local.set(name, 30);
      chunks.push(local, data);
      const entry = new Uint8Array(46 + name.length);
      const entryView = new DataView(entry.buffer);
      entryView.setUint32(0, 0x02014b50, true);
      entryView.setUint16(4, 20, true);
      entryView.setUint16(6, 20, true);
      entryView.setUint16(8, 0x0800, true);
      entryView.setUint16(10, 0, true);
      entryView.setUint16(12, dosTime, true);
      entryView.setUint16(14, dosDate, true);
      entryView.setUint32(16, crc, true);
      entryView.setUint32(20, data.length, true);
      entryView.setUint32(24, data.length, true);
      entryView.setUint16(28, name.length, true);
      entryView.setUint16(30, 0, true);
      entryView.setUint16(32, 0, true);
      entryView.setUint16(34, 0, true);
      entryView.setUint16(36, 0, true);
      entryView.setUint32(38, 0, true);
      entryView.setUint32(42, offset, true);
      entry.set(name, 46);
      central.push(entry);
      offset += local.length + data.length;
    }
    const centralSize = central.reduce((sum, item) => sum + item.length, 0);
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(4, 0, true);
    endView.setUint16(6, 0, true);
    endView.setUint16(8, central.length, true);
    endView.setUint16(10, central.length, true);
    endView.setUint32(12, centralSize, true);
    endView.setUint32(16, offset, true);
    endView.setUint16(20, 0, true);
    return new Blob([...chunks, ...central, end], { type: 'application/zip' });
  }

  function downloadBlob(name, blob) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function safeName(name) {
    return String(name || 'file').replace(/[\\/:*?"<>|]+/g, '_');
  }

  function downloadJobPackage() {
    if (!state.rover || !state.base) return message('Choose the rover and base files first.');
    const evaluation = ensureJob();
    if (evaluation.status === 'fail') {
      const blocker = evaluation.checks.find((check) => check.status === 'fail');
      return message('Resolve the blockers in Review before downloading' + (blocker ? ': ' + blocker.text : '.'));
    }
    const files = [
      { name: 'README.txt', data: buildBrief(state.rover, state.base, state.options, evaluation) },
      { name: 'northstar_job.conf', data: buildRtkConfig(state.rover, state.base, state.options) },
      { name: 'job.json', data: JSON.stringify(state.job, null, 2) },
      { name: safeName(state.rover.name), data: state.rover.text }
    ];
    if (state.base.text) files.push({ name: safeName(state.base.name), data: state.base.text });
    for (const file of state.nav) files.push({ name: safeName(file.name), data: file.text });
    if (state.sp3 && state.sp3.text) files.push({ name: safeName(state.sp3.name), data: state.sp3.text });
    downloadBlob('northstar_' + (state.rover.markerName || 'gnss').replace(/[^A-Za-z0-9_-]+/g, '_').toLowerCase() + '_job.zip', zipBlob(files));
    message('Correction package downloaded · unzip and run the command in README.txt');
  }

  function copyCommand() {
    if (!state.rover || !state.base) return message('Choose the rover and base files first.');
    const evaluation = evaluateJob(state.rover, state.base, state.options);
    if (evaluation.status === 'fail') return message('Resolve the blockers in Review before copying the command.');
    const command = buildCommand(state.rover, state.base, state.nav, state.sp3, outputName(state.rover));
    navigator.clipboard?.writeText(command).then(() => message('RTKLIB command copied')).catch(() => message('Copy failed'));
  }

  function formatTimestamp(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '—';
    return date.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit'
    });
  }

  function jobStatusInfo(job) {
    if (job && (job.status === 'complete' || job.result)) return { label: 'Complete', className: 'ok' };
    if (job && job.status === 'fail') return { label: 'Blocked', className: 'fail' };
    if (job && job.status === 'warn') return { label: 'Review', className: 'warn' };
    return { label: 'Ready', className: 'ok' };
  }

  function savedJobs() {
    const app = window.northstarApp;
    const list = app && app.S && Array.isArray(app.S.gnssJobs) ? app.S.gnssJobs : [];
    return list
      .filter((job) => job && typeof job === 'object' && job.id)
      .slice()
      .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
  }

  function jobBaseLabel(job) {
    const station = job.baseStation || {};
    if (station.corsId) return 'NOAA CORS ' + station.corsId + (station.name ? ' · ' + station.name : '');
    if (job.base && job.base.name) return job.base.name;
    return 'Manual base';
  }

  function jobIssueText(job) {
    const checks = Array.isArray(job.checks) ? job.checks : [];
    const blockers = checks.filter((check) => check.status === 'fail').length;
    const warnings = checks.filter((check) => check.status === 'warn').length;
    if (blockers) return blockers + ' ' + (blockers === 1 ? 'blocker' : 'blockers');
    if (warnings) return warnings + ' ' + (warnings === 1 ? 'warning' : 'warnings');
    return '';
  }

  function jobOptionsText(options) {
    const value = options || {};
    const parts = [];
    if (value.posMode) parts.push(value.posMode === 'static' ? 'Static point' : 'Kinematic track');
    if (value.frequency) parts.push(value.frequency === 'l1+l2' ? 'L1 + L2' : 'L1 only');
    if (Number.isFinite(Number(value.elevationMask))) parts.push(value.elevationMask + '° mask');
    if (value.arMode) parts.push(value.arMode === 'continuous' ? 'Continuous AR' : 'Fix and hold');
    if (value.ephemeris) parts.push(value.ephemeris === 'precise' ? 'Precise SP3' : 'Broadcast nav');
    if (value.solutionType) parts.push(value.solutionType === 'combined' ? 'Combined solution' : 'Forward solution');
    return parts.join(' · ') || '—';
  }

  function jobChecksHtml(job) {
    const checks = Array.isArray(job.checks) ? job.checks : [];
    if (!checks.length) return '<div class="pp-note">No checks were saved with this job.</div>';
    return '<div class="pp-checks">' + checks.map((check) => {
      const status = check.status === 'fail' ? 'fail' : check.status === 'warn' ? 'warn' : 'pass';
      const icon = status === 'fail' ? 'error' : status === 'warn' ? 'warning' : 'check_circle';
      return '<div class="pp-check-row ' + status + '"><span class="material-symbols pp-check-icon">' + icon + '</span>'
        + '<div class="pp-check-copy"><b>' + esc(check.label || check.key || 'Check') + '</b><small>' + esc(check.text || '') + '</small></div>'
        + '<span class="pp-chip ' + (status === 'pass' ? '' : status) + '">' + esc(status) + '</span></div>';
    }).join('') + '</div>';
  }

  function jobResultHtml(job) {
    if (!job.result) return '<div class="pp-note">No corrected result has been accepted for this job yet.</div>';
    const result = job.result;
    const accepted = result.accepted || {};
    const counts = Object.entries(result.counts || {}).map(([key, value]) => value + ' ' + key).join(' · ') || '—';
    const spread = (Number.isFinite(result.horizontal) ? '±' + result.horizontal.toFixed(3) + ' m H' : '—')
      + (Number.isFinite(result.vertical) ? ' · ±' + result.vertical.toFixed(3) + ' m V' : '');
    return '<div class="pp-grid">'
      + '<div class="pp-row"><span>Result file</span><b>' + esc(result.fileName || '—') + '</b></div>'
      + '<div class="pp-row"><span>Execution</span><b>' + esc(result.execution === 'northstar-local' ? 'Northstar local engine' : 'Imported .pos') + '</b></div>'
      + '<div class="pp-row"><span>Fixed epochs</span><b>' + esc(String(result.fixed == null ? '—' : result.fixed)) + '</b></div>'
      + '<div class="pp-row"><span>Epoch status</span><b>' + esc(counts) + '</b></div>'
      + '<div class="pp-row"><span>Reported spread</span><b>' + esc(spread) + '</b></div>'
      + '<div class="pp-row"><span>Latitude</span><b>' + (Number.isFinite(Number(accepted.lat)) ? Number(accepted.lat).toFixed(7) + '°' : '—') + '</b></div>'
      + '<div class="pp-row"><span>Longitude</span><b>' + (Number.isFinite(Number(accepted.lon)) ? Number(accepted.lon).toFixed(7) + '°' : '—') + '</b></div>'
      + '<div class="pp-row"><span>Ellipsoid height</span><b>' + (Number.isFinite(Number(accepted.height)) ? Number(accepted.height).toFixed(3) + ' m' : '—') + '</b></div>'
      + '<div class="pp-row"><span>Fixed epoch count</span><b>' + esc(String(accepted.epochCount == null ? '—' : accepted.epochCount)) + '</b></div>'
      + '</div>';
  }

  function jobReportText(job) {
    const status = jobStatusInfo(job);
    const rover = job.rover || {};
    const base = job.base || {};
    const position = job.basePosition || {};
    const hasPosition = [position.lat, position.lon, position.height].every((value) => Number.isFinite(Number(value)));
    const lines = [
      'Northstar GNSS job report',
      '=========================',
      '',
      'Job ID: ' + (job.id || '—'),
      'Status: ' + status.label,
      'Created: ' + formatTimestamp(job.createdAt),
      'Saved: ' + formatTimestamp(job.updatedAt || job.createdAt),
      '',
      'ROVER',
      '  Marker: ' + (rover.markerName || '—'),
      '  File: ' + (rover.name || '—') + ' (reattach required to rerun)',
      '  Window: ' + (Number.isFinite(rover.firstMs) ? formatDate(rover.firstMs, true) : '—') + ' to ' + (Number.isFinite(rover.lastMs) ? formatDate(rover.lastMs, true) : '—'),
      '  Duration: ' + formatDuration(rover.duration),
      '  Epochs: ' + (rover.epochCount == null ? '—' : rover.epochCount),
      '  Antenna: ' + (rover.antennaType || 'not stated'),
      '',
      'BASE',
      '  Source: ' + jobBaseLabel(job),
      '  File: ' + (base.name || 'manual base or not stored') + ' (reattach required to rerun)',
      '  Frame: ' + (job.baseFrame || position.frame || '—'),
      '  Position: ' + (hasPosition
        ? Number(position.lat).toFixed(7) + ', ' + Number(position.lon).toFixed(7) + ' · ellipsoid ' + Number(position.height).toFixed(3) + ' m'
        : '—'),
      '  Baseline: ' + (Number.isFinite(job.distanceM) ? formatDistance(job.distanceM) : '—'),
      '  Overlap: ' + (Number.isFinite(job.overlapSeconds) ? formatDuration(job.overlapSeconds) : '—'),
      '',
      'OPTIONS',
      '  ' + jobOptionsText(job.options),
      '',
      'CHECKS'
    ];
    const checks = Array.isArray(job.checks) ? job.checks : [];
    if (!checks.length) lines.push('  No checks were saved.');
    for (const check of checks) {
      lines.push('  [' + String(check.status || '—').toUpperCase() + '] ' + (check.label || check.key || 'Check') + ': ' + (check.text || ''));
    }
    lines.push('', 'RESULT');
    if (job.result) {
      const result = job.result;
      const accepted = result.accepted || {};
      lines.push('  File: ' + (result.fileName || '—'));
      lines.push('  Execution: ' + (result.execution === 'northstar-local' ? 'Northstar local engine' : 'Imported .pos'));
      lines.push('  Fixed epochs: ' + (result.fixed == null ? '—' : result.fixed));
      lines.push('  Epoch status: ' + (Object.entries(result.counts || {}).map(([key, value]) => value + ' ' + key).join(' · ') || '—'));
      lines.push('  Latitude: ' + (Number.isFinite(Number(accepted.lat)) ? Number(accepted.lat).toFixed(9) : '—'));
      lines.push('  Longitude: ' + (Number.isFinite(Number(accepted.lon)) ? Number(accepted.lon).toFixed(9) : '—'));
      lines.push('  Ellipsoid height: ' + (Number.isFinite(Number(accepted.height)) ? Number(accepted.height).toFixed(3) + ' m' : '—'));
      lines.push('  Reported spread: ' + (Number.isFinite(result.horizontal) ? '±' + result.horizontal.toFixed(3) + ' m H' : '—') + (Number.isFinite(result.vertical) ? ' · ±' + result.vertical.toFixed(3) + ' m V' : ''));
    } else {
      lines.push('  No corrected result has been accepted yet.');
    }
    lines.push('', 'COMMAND', '  ' + (job.command || '—'), '', 'NOTES');
    lines.push('  Raw observation, navigation and SP3 files are not stored by Northstar.');
    lines.push('  To rerun this job, start a new job and attach the original files.');
    lines.push('  The saved review is a record, not a legal survey.');
    return lines.join('\n') + '\n';
  }

  function jobListHtml(jobs) {
    if (!jobs.length) {
      return '<div class="gnss-jobs-empty"><span class="material-symbols">history</span><b>No saved jobs yet</b>'
        + '<small>Finish or review a post-processing job and Northstar keeps its checked record here. Raw receiver files are never stored.</small>'
        + '<button class="primary-button" type="button" data-job-new>Start a job</button></div>';
    }
    const complete = jobs.filter((job) => job.result || job.status === 'complete').length;
    return '<div class="gnss-jobs-summary"><span><b>' + jobs.length + '</b> saved ' + (jobs.length === 1 ? 'job' : 'jobs') + '</span><span><b>' + complete + '</b> complete</span><span>Saved in this browser</span></div>'
      + '<div class="gnss-jobs-list">' + jobs.map((job) => {
        const status = jobStatusInfo(job);
        const marker = (job.rover && job.rover.markerName) || 'Unnamed rover';
        const frame = job.baseFrame || (job.basePosition && job.basePosition.frame) || '';
        const result = job.result ? job.result.fixed + ' fixed ' + (job.result.fixed === 1 ? 'epoch' : 'epochs') : 'No result yet';
        const side = [result, jobIssueText(job)].filter(Boolean).join(' · ');
        return '<button type="button" class="gnss-job-row" data-job-open="' + esc(job.id) + '">'
          + '<span class="gnss-job-dot ' + status.className + '"></span>'
          + '<span class="gnss-job-main"><b>' + esc(marker) + '</b><small>' + esc(formatTimestamp(job.updatedAt || job.createdAt)) + ' · ' + esc(jobBaseLabel(job)) + (frame ? ' · ' + esc(frame) : '') + '</small></span>'
          + '<span class="gnss-job-side"><span class="pp-chip ' + status.className + '">' + status.label + '</span><small>' + esc(side) + '</small></span>'
          + '<span class="material-symbols gnss-job-chevron" aria-hidden="true">chevron_right</span></button>';
      }).join('') + '</div>';
  }

  function jobDetailHtml(job) {
    const status = jobStatusInfo(job);
    const rover = job.rover || {};
    const base = job.base || {};
    const position = job.basePosition || {};
    const rows = [
      ['Saved', formatTimestamp(job.updatedAt || job.createdAt)],
      ['Rover marker', rover.markerName || '—'],
      ['Rover file', (rover.name || '—') + ' · reattach'],
      ['Base', jobBaseLabel(job)],
      ['Base file', (base.name || 'manual base or not stored') + ' · reattach'],
      ['Base frame', job.baseFrame || position.frame || '—'],
      ['Base epoch', job.baseEpoch || position.epoch || '—'],
      ['Baseline', Number.isFinite(job.distanceM) ? formatDistance(job.distanceM) : '—'],
      ['Overlap', Number.isFinite(job.overlapSeconds) ? formatDuration(job.overlapSeconds) : '—'],
      ['Options', jobOptionsText(job.options)]
    ];
    return '<button type="button" class="pp-link gnss-job-back" data-job-back><span class="material-symbols">arrow_back</span> All jobs</button>'
      + '<div class="gnss-job-detail-head"><div><span class="pp-kicker">Saved GNSS job</span><h3 class="pp-title">' + esc(rover.markerName || 'Unnamed rover') + '</h3>'
      + '<p class="pp-copy">' + esc(formatTimestamp(job.updatedAt || job.createdAt)) + ' · ' + esc(job.id) + '</p></div><span class="pp-chip ' + status.className + '">' + status.label + '</span></div>'
      + '<div class="pp-subhead">Job record</div><div class="pp-grid">'
      + rows.map(([label, value]) => '<div class="pp-row"><span>' + esc(label) + '</span><b>' + esc(value) + '</b></div>').join('')
      + '</div>'
      + '<div class="pp-subhead">Saved review</div>' + jobChecksHtml(job)
      + '<div class="pp-subhead">Corrected result</div>' + jobResultHtml(job)
      + '<div class="pp-subhead">RTKLIB command</div><div class="gnss-job-command"><code>' + esc(job.command || '—') + '</code>'
      + '<button class="secondary-button" type="button" data-job-copy="' + esc(job.id) + '">Copy command</button></div>'
      + '<div class="pp-note"><b>Raw files are not stored.</b> To run this job again, start a new job and attach <b>' + esc(rover.name || 'the rover file') + '</b> and <b>' + esc(base.name || 'the base data') + '</b>. The saved review and report stay available.</div>'
      + '<div class="gnss-job-actions"><button class="primary-button" type="button" data-job-report="' + esc(job.id) + '">Download report</button>'
      + '<button class="secondary-button" type="button" data-job-new>Start a new job</button>'
      + '<button class="remove-button" type="button" data-job-delete="' + esc(job.id) + '">Delete job</button></div>'
      + (state.jobsDeleteConfirm ? '<div class="gnss-job-confirm"><div><b>Delete this saved job?</b><small>The accepted waypoint and all project data stay untouched. This only removes the saved job record.</small></div><div class="gnss-job-confirm-actions"><button class="secondary-button" type="button" data-job-delete-cancel>Keep job</button><button class="remove-button" type="button" data-job-delete-confirm>Delete job</button></div></div>' : '');
  }

  function renderJobs() {
    const body = $('#gnssJobsBody');
    if (!body) return;
    const jobs = savedJobs();
    const selected = state.jobsSelectedId ? jobs.find((job) => job.id === state.jobsSelectedId) : null;
    if (state.jobsSelectedId && !selected) {
      state.jobsSelectedId = null;
      state.jobsDeleteConfirm = false;
    }
    body.innerHTML = state.jobsSelectedId && selected ? jobDetailHtml(selected) : jobListHtml(jobs);
    const note = $('#gnssJobsFootNote');
    if (note) {
      note.innerHTML = jobs.length
        ? '<b>Saved in this browser.</b> Raw receiver files are not stored. ' + jobs.length + ' ' + (jobs.length === 1 ? 'job' : 'jobs') + ' available.'
        : '<b>Saved in this browser.</b> Ops reports and job records stay on this computer.';
    }
  }

  function openJobs() {
    const dialog = $('#gnssJobsDialog');
    if (!dialog) return;
    state.jobsSelectedId = null;
    state.jobsDeleteConfirm = false;
    renderJobs();
    if (!dialog.open) dialog.showModal();
  }

  function closeJobs() {
    const dialog = $('#gnssJobsDialog');
    if (dialog && dialog.open) dialog.close();
  }

  function startNewJob() {
    closeJobs();
    state.step = 0;
    state.rover = null;
    state.base = null;
    state.baseStation = null;
    state.baseSource = '';
    state.basePosition = null;
    state.baseFrames = {};
    state.baseFrame = '';
    state.nav = [];
    state.sp3 = null;
    state.coordText = '';
    state.stations = [];
    state.stationMeta = null;
    state.stationBusy = false;
    state.baseBusy = false;
    state.stationError = '';
    state.baseError = '';
    state.roverError = '';
    state.busy = '';
    state.options = { ...DEFAULTS };
    state.job = null;
    state.persistedSignature = '';
    state.resultOnly = false;
    state.result = null;
    state.resultName = '';
    state.resultTarget = 'new';
    state.resultError = '';
    state.resultAccepted = false;
    state.jobsSelectedId = null;
    state.jobsDeleteConfirm = false;
    state.preflight = { server: null, busy: false, error: '', checkedAt: 0 };
    state.installer = { open: false, info: null, busy: false, error: '', job: null, accepted: false, poll: 0 };
    state.run = { busy: false, error: '', elapsedMs: 0, engine: '', warnings: '', completed: false };
    openDialog(0);
  }

  function deleteSavedJob(job) {
    const app = window.northstarApp;
    if (!app || !app.S) return;
    app.S.gnssJobs = (Array.isArray(app.S.gnssJobs) ? app.S.gnssJobs : []).filter((item) => item && item.id !== job.id);
    if (state.job && state.job.id === job.id) {
      state.job = null;
      state.persistedSignature = '';
    }
    app.save();
    state.jobsSelectedId = null;
    state.jobsDeleteConfirm = false;
    renderJobs();
    message('Saved GNSS job deleted. Accepted waypoints stay in the project.');
  }

  function downloadJobReport(job) {
    const filename = 'northstar_gnss_' + String(job.id || 'job').replace(/[^A-Za-z0-9_-]+/g, '_') + '_report.txt';
    downloadBlob(filename, new Blob([jobReportText(job)], { type: 'text/plain' }));
    message('GNSS job report downloaded');
  }

  function copySavedJobCommand(job) {
    navigator.clipboard?.writeText(job.command || '').then(() => message('RTKLIB command copied')).catch(() => message('Copy failed'));
  }

  function parseResult(text, fileName) {
    if (!window.northstarGNSS) throw new Error('The GNSS solution reader is not loaded.');
    const parsed = window.northstarGNSS.parsePos(text);
    if (!parsed.epochs.length) throw new Error('No solution epochs were found in that .pos file.');
    const fixed = parsed.epochs.filter((epoch) => epoch.status === 1);
    const accepted = window.northstarGNSS.acceptFixed(parsed.epochs);
    const horizontal = fixed.length
      ? Math.sqrt(fixed.reduce((sum, epoch) => sum + (epoch.sdn ** 2 + epoch.sde ** 2) / 2, 0) / fixed.length)
      : null;
    const vertical = fixed.length
      ? Math.sqrt(fixed.reduce((sum, epoch) => sum + (epoch.sdu ** 2), 0) / fixed.length)
      : null;
    return {
      fileName,
      epochs: parsed.epochs,
      header: parsed.header,
      fixed,
      accepted,
      counts: window.northstarGNSS.statusCounts(parsed.epochs),
      horizontal,
      vertical
    };
  }

  function summarizeResult(result, execution) {
    if (!result) return null;
    return {
      fileName: result.fileName,
      fixed: result.fixed.length,
      counts: result.counts,
      accepted: result.accepted,
      horizontal: result.horizontal,
      vertical: result.vertical,
      execution: execution || 'imported'
    };
  }

  function defaultResultName() {
    const marker = state.rover && state.rover.markerName ? state.rover.markerName : 'GNSS';
    const day = state.rover && state.rover.firstMs ? formatDate(state.rover.firstMs) : new Date().toISOString().slice(0, 10);
    return marker + ' corrected ' + day;
  }

  function ensureJob() {
    const evaluation = evaluateJob(state.rover, state.base, state.options);
    const job = {
      id: state.job ? state.job.id : 'gnss-' + Date.now().toString(36),
      createdAt: state.job ? state.job.createdAt : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: evaluation.status,
      rover: summarizeObservation(state.rover),
      base: summarizeObservation(state.base),
      baseStation: state.baseStation ? {
        corsId: state.baseStation.corsId,
        name: state.baseStation.name,
        distance: state.baseStation.distance,
        lat: state.basePosition ? state.basePosition.lat : null,
        lon: state.basePosition ? state.basePosition.lon : null,
        height: state.basePosition ? state.basePosition.height : null,
        datum: state.baseStation.posDatum || '',
        frame: state.basePosition ? state.basePosition.frame : ''
      } : null,
      basePosition: state.basePosition ? { ...state.basePosition } : null,
      baseFrame: state.basePosition ? state.basePosition.frame || '' : '',
      baseEpoch: state.basePosition ? state.basePosition.epoch || '' : '',
      nav: state.nav.map((file) => file.name),
      sp3: state.sp3 ? state.sp3.name : null,
      options: { ...state.options },
      checks: evaluation.checks,
      distanceM: evaluation.distance,
      overlapSeconds: evaluation.overlapSeconds,
      command: buildCommand(state.rover, state.base, state.nav, state.sp3, outputName(state.rover))
    };
    state.job = job;
    return evaluation;
  }

  function persistJob() {
    if (!state.job) return;
    const signature = JSON.stringify(state.job);
    if (signature === state.persistedSignature) return;
    const app = window.northstarApp;
    if (!app || !app.S) return;
    const jobs = Array.isArray(app.S.gnssJobs) ? app.S.gnssJobs : [];
    app.S.gnssJobs = [state.job, ...jobs.filter((job) => job.id !== state.job.id)].slice(0, 20);
    state.persistedSignature = signature;
    app.save();
  }

  function message(text) {
    if (window.northstarApp && window.northstarApp.message) window.northstarApp.message(text);
  }

  function setStep(step) {
    const target = clamp(step, 0, STEPS.length - 1);
    if (target > 0 && !state.rover) return message('Choose a rover RINEX file first');
    if (target > 1 && !state.base) return message('Choose a base station or base file first');
    if (target === 3 && !state.resultOnly) {
      ensureJob();
      persistJob();
    }
    state.step = target;
    render();
    if (target === 3) loadEngine();
  }

  function canOpenStep(index) {
    if (index === 0) return true;
    if (index === 1) return !!state.rover;
    if (index === 2) return !!state.rover && !!state.base;
    return state.resultOnly || (!!state.rover && !!state.base);
  }

  function renderSteps() {
    return STEPS.map((step, index) => {
      const done = (index === 0 && state.rover && state.step > 0)
        || (index === 1 && state.base && state.step > 1)
        || (index === 2 && state.base && state.step > 2)
        || (index === 3 && state.resultAccepted);
      return '<button type="button" class="pp-step' + (state.step === index ? ' active' : '') + (done ? ' done' : '')
        + '" data-pp-step="' + index + '"' + (canOpenStep(index) ? '' : ' disabled') + '>'
        + '<span class="pp-step-num">' + (done ? '✓' : index + 1) + '</span>'
        + '<span class="pp-step-copy"><b>' + esc(step.title) + '</b><small>' + esc(step.hint) + '</small></span>'
        + '</button>';
    }).join('');
  }

  function errorNote(error) {
    if (!error) return '';
    return '<div class="pp-note error"><b>' + esc(error.title || 'Could not read this file') + '</b><br>' + esc(error.message || '') + '</div>';
  }

  function observationRows(observation) {
    return [
      ['Format', observation.versionLabel + (observation.timeSystem ? ' · ' + observation.timeSystem : '')],
      ['Time', formatDate(observation.firstMs, true) + ' to ' + formatDate(observation.lastMs, true)],
      ['Duration', formatDuration(observation.duration)],
      ['Epochs', formatNumber(observation.epochCount, 0)],
      ['Interval', observation.interval ? observation.interval.toFixed(0) + ' s' : 'not stated'],
      ['Marker', observation.markerName || '—'],
      ['Receiver', observation.receiver || '—'],
      ['Antenna', observation.antenna || '—'],
      ['Antenna delta h/e/n', observation.antennaDelta ? observation.antennaDelta.h.toFixed(3) + ' / ' + observation.antennaDelta.e.toFixed(3) + ' / ' + observation.antennaDelta.n.toFixed(3) + ' m' : '—'],
      ['Position', observation.approx && Number.isFinite(observation.approx.lat) ? observation.approx.lat.toFixed(6) + ', ' + observation.approx.lon.toFixed(6) : 'not in header']
    ].map(([label, value]) => '<div class="pp-row"><span>' + esc(label) + '</span><b>' + esc(value) + '</b></div>').join('');
  }

  function observationCard(observation, heading) {
    if (!observation) return '';
    const systems = observation.systems.map((system) => '<span class="pp-system">' + esc(systemLabel(system)) + '</span>').join('');
    return '<div class="pp-card"><div class="pp-card-head"><div><b>' + esc(heading || observation.name) + '</b><small>'
      + esc(observation.name) + '</small></div><span class="pp-chip ok">Read</span></div><div class="pp-card-body">'
      + '<div class="pp-grid">' + observationRows(observation) + '</div>'
      + (systems ? '<div class="pp-systems">' + systems + '</div>' : '')
      + (observation.warnings.length ? '<div class="pp-note warn">' + observation.warnings.map(esc).join('<br>') + '</div>' : '')
      + '</div></div>';
  }

  function preflightAgeText() {
    const checkedAt = state.preflight.checkedAt;
    if (!checkedAt) return '';
    const age = Date.now() - checkedAt;
    if (age < 60000) return 'Checked just now';
    if (age < 3600000) return 'Checked ' + Math.round(age / 60000) + ' min ago';
    return 'Checked earlier — run again';
  }

  function preflightRow(status, label, text) {
    const icon = status === 'fail' ? 'error' : status === 'warn' ? 'warning' : status === 'pass' ? 'check_circle' : 'radio_button_unchecked';
    const chipClass = status === 'pass' ? 'ok' : status === 'warn' ? 'warn' : status === 'fail' ? 'fail' : '';
    const chip = status === 'pass' ? 'Ready' : status === 'warn' ? 'Review' : status === 'fail' ? 'Blocked' : 'Not checked';
    return '<div class="pp-check-row ' + status + '"><span class="material-symbols pp-check-icon">' + icon + '</span>'
      + '<div class="pp-check-copy"><b>' + esc(label) + '</b><small>' + esc(text) + '</small></div>'
      + '<span class="pp-chip ' + chipClass + '">' + chip + '</span></div>';
  }

  function preflightRowsHtml() {
    const rows = [];
    const preflight = state.preflight;
    if (preflight.error) {
      rows.push(preflightRow('fail', 'Local setup service', preflight.error));
    } else if (preflight.server) {
      if (preflight.server.ok === false) {
        rows.push(preflightRow('fail', 'Northstar files', 'The app folder is incomplete: ' + ((preflight.server.app && preflight.server.app.missing) || []).join(', ')));
      }
      const rtklib = preflight.server.rtklib || {};
      if (rtklib.found) {
        const engine = rtklib.binaries && rtklib.binaries.rnx2rtkp ? rtklib.binaries.rnx2rtkp : {};
        rows.push(preflightRow('pass', 'RTKLIB', 'rnx2rtkp found' + (rtklib.release ? ' · RTKLIB ' + rtklib.release : engine.version ? ' · ' + engine.version : '') + (rtklib.converterFound ? ' · convbin available' : '')));
      } else {
        rows.push(preflightRow('warn', 'RTKLIB', 'rnx2rtkp was not found on this computer. The job package can still be built, but RTKLIB must be installed to run it. Run Setup Northstar for install help.'));
      }
      const noaa = preflight.server.noaa || {};
      rows.push(preflightRow(noaa.ok ? 'pass' : 'warn', 'NOAA CORS', noaa.message || 'NOAA was not reachable. A manual base file still works.'));
    } else if (!preflight.busy) {
      rows.push(preflightRow('idle', 'Computer setup', 'Run the check to look for RTKLIB, test the NOAA connection, and check this rover session.'));
    }

    if (state.rover) {
      if (state.rover.hasPhase) {
        rows.push(preflightRow(state.rover.hasL2 ? 'pass' : 'warn', 'Carrier phase', state.rover.hasL2
          ? 'L1 and L2 carrier phase are present.'
          : 'L1 phase is present but L2 is missing. Choose L1 only in Processing.'));
      } else {
        rows.push(preflightRow('fail', 'Carrier phase', 'No L1 or L2 carrier phase was found. A fixed survey coordinate is not possible from this file.'));
      }
      const duration = state.rover.duration;
      rows.push(preflightRow(duration < 120 ? 'fail' : duration < 600 ? 'warn' : 'pass', 'Session length',
        duration < 120 ? 'Shorter than two minutes. Collect more time before correcting.'
          : duration < 600 ? 'Under ten minutes. A fixed solution may be weak; 10–30 minutes is better.'
            : formatDuration(duration) + ' is enough for a static point.'));
      if (!state.rover.approx) {
        rows.push(preflightRow('warn', 'Approximate position', 'The RINEX header has no approximate position. The NOAA station search needs one; a manual base can still be used.'));
      }
    } else {
      rows.push(preflightRow('idle', 'Rover file', 'Attach a RINEX observation file to check carrier phase and session length.'));
    }
    return rows.join('');
  }

  function installerPanelHtml() {
    const installer = state.installer;
    const missing = state.preflight.server && state.preflight.server.rtklib && !state.preflight.server.rtklib.found;
    if (!installer.open && !(missing && !installer.job)) return '';

    if (!installer.open) {
      return '<div class="pp-install-callout" id="ppInstaller"><div class="pp-install-callout-copy"><b>Add the free correction engine</b>'
        + '<small>Install the official RTKLIB release into this project. No administrator password, no system-wide changes.</small></div>'
        + '<button class="secondary-button" type="button" data-pp-action="rtklib-install">Install RTKLIB</button></div>';
    }

    if (installer.busy && !installer.info && !installer.job) {
      return '<div class="pp-install" id="ppInstaller"><div class="pp-install-head"><div><b>Checking this computer</b><small>Looking for the build tools Northstar needs.</small></div><span class="pp-spinner"></span></div></div>';
    }

    if (installer.error && !installer.job && !installer.info) {
      return '<div class="pp-install" id="ppInstaller"><div class="pp-install-head"><div><b>Installer unavailable</b><small>' + esc(installer.error) + '</small></div>'
        + '<button class="secondary-button" type="button" data-pp-action="rtklib-install-close">Close</button></div></div>';
    }

    const job = installer.job;
    if (job) {
      const done = job.status === 'done';
      const failed = job.status === 'error';
      const lines = Array.isArray(job.log) ? job.log.slice(-24) : [];
      const chip = done ? '<span class="pp-chip ok">Ready</span>' : failed ? '<span class="pp-chip fail">Stopped</span>' : '<span class="pp-chip warn">Installing</span>';
      return '<div class="pp-install" id="ppInstaller"><div class="pp-install-head"><div><b>'
        + (done ? 'RTKLIB is installed' : failed ? 'Installation did not finish' : 'Installing RTKLIB ' + esc((installer.info && installer.info.version) || ''))
        + '</b><small>' + esc(job.message || '') + '</small></div>' + chip + '</div>'
        + '<div class="pp-install-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + esc(job.progress || 0) + '"><i style="width:' + esc(Math.max(0, Math.min(100, Number(job.progress) || 0))) + '%"></i></div>'
        + '<div class="pp-install-status"><span>' + esc(job.message || '') + '</span><b>' + esc(Math.round(Number(job.progress) || 0)) + '%</b></div>'
        + (failed && job.error ? '<div class="pp-note fail">' + esc(job.error) + '</div>' : '')
        + (installer.error ? '<div class="pp-note warn">' + esc(installer.error) + '</div>' : '')
        + (lines.length ? '<details class="pp-install-log"' + (failed ? ' open' : '') + '><summary>Installer details</summary><pre>' + esc(lines.join('\n')) + '</pre></details>' : '')
        + '<div class="pp-install-actions">'
        + (done ? '<span class="pp-install-path">Installed in <code>tools/rtklib/bin</code></span><button class="primary-button" type="button" data-pp-action="rtklib-install-close">Done</button>'
          : failed ? '<button class="secondary-button" type="button" data-pp-action="rtklib-install-close">Close</button><button class="primary-button" type="button" data-pp-action="rtklib-install-retry">Try again</button>'
            : '<span class="pp-foot-note">You can hide this panel; the installation continues in the background.</span><button class="secondary-button" type="button" data-pp-action="rtklib-install-close">Hide</button>')
        + '</div></div>';
    }

    const info = installer.info;
    if (!info) return '';
    if (info.installed) {
      return '<div class="pp-install" id="ppInstaller"><div class="pp-install-head"><div><b>RTKLIB is already available</b><small>' + esc(info.enginePath || 'Northstar found the correction engine on this computer.') + '</small></div>'
        + '<button class="secondary-button" type="button" data-pp-action="rtklib-install-close">Close</button></div></div>';
    }
    const sourceBuild = info.method === 'source-build';
    const methodText = sourceBuild ? 'Build from the official source' : 'Official Windows binaries';
    const sizeText = formatBytes(info.asset && info.asset.bytes);
    const hash = (info.asset && info.asset.sha256) || '';
    const hashShort = hash ? hash.slice(0, 12) + '…' + hash.slice(-8) : '—';
    const reason = !info.canInstall && info.reason ? '<div class="pp-note warn">' + esc(info.reason) + '</div>' : '';
    return '<div class="pp-install" id="ppInstaller"><div class="pp-install-head"><div><b>Install RTKLIB ' + esc(info.version) + '</b><small>Free, official and uncompromised by a third-party build.</small></div><span class="pp-chip">Opt-in</span></div>'
      + '<div class="pp-install-meta">'
      + '<div><span>Source</span><b>github.com/tomojitakasu/RTKLIB</b></div>'
      + '<div><span>Method</span><b>' + esc(methodText) + '</b></div>'
      + '<div><span>Download</span><b>' + esc(sizeText) + '</b></div>'
      + '<div><span>SHA-256</span><b class="pp-install-hash" title="' + esc(hash) + '">' + esc(hashShort) + '</b></div>'
      + '</div>'
      + '<div class="pp-note">' + (sourceBuild
        ? 'Your computer builds <b>rnx2rtkp</b> and <b>convbin</b> from the verified source. This normally takes about a minute and needs <b>make</b> and a C compiler.'
        : 'Northstar copies the official <b>rnx2rtkp</b> and <b>convbin</b> programs and their runtime files into this project.')
      + ' Nothing is installed system-wide and no administrator password is requested. The RTKLIB BSD license is kept beside the binaries.</div>'
      + (installer.error ? '<div class="pp-note fail">' + esc(installer.error) + '</div>' : '')
      + reason
      + '<label class="pp-install-accept"><input type="checkbox" id="ppInstallAccept" data-pp-install-accept' + (installer.accepted ? ' checked' : '') + (info.canInstall ? '' : ' disabled') + '>'
      + '<span><b>Download and install into this Northstar folder.</b><small>I understand the download comes from the official RTKLIB GitHub release and is checked against the SHA-256 above.</small></span></label>'
      + '<div class="pp-install-actions"><button class="secondary-button" type="button" data-pp-action="rtklib-install-close">Not now</button>'
      + '<button class="primary-button" type="button" data-pp-action="rtklib-install-start"' + (info.canInstall && installer.accepted && !installer.busy ? '' : ' disabled') + '>'
      + (installer.busy ? 'Starting…' : 'Download and install') + '</button></div></div>';
  }

  function refreshInstallerPanel() {
    const host = document.querySelector('#ppInstaller');
    if (!host) return;
    const markup = installerPanelHtml();
    if (markup) host.outerHTML = markup;
    else host.remove();
  }

  async function openInstaller() {
    if (state.installer.busy) return;
    state.installer.open = true;
    state.installer.info = null;
    state.installer.busy = true;
    state.installer.error = '';
    state.installer.job = null;
    state.installer.accepted = false;
    render();
    try {
      const infoResponse = await fetch('/api/rtklib/install/info', { cache: 'no-store' });
      if (!infoResponse.ok) throw new Error('The desktop backend did not answer the installer check.');
      const info = await infoResponse.json();
      if (!info || typeof info !== 'object') throw new Error('The desktop backend returned an unreadable installer answer.');
      state.installer.info = info;
      const statusResponse = await fetch('/api/rtklib/install/status', { cache: 'no-store' });
      if (statusResponse.ok) {
        const status = await statusResponse.json();
        if (status && status.job && status.job.status === 'running') {
          state.installer.job = status.job;
          state.installer.busy = false;
          state.installer.poll += 1;
          const token = state.installer.poll;
          render();
          pollInstaller(status.job.id, token);
          return;
        }
      }
    } catch (error) {
      state.installer.error = error && error.message ? error.message : 'The installer check failed.';
    } finally {
      state.installer.busy = false;
      render();
    }
  }

  function closeInstaller() {
    state.installer.open = false;
    state.installer.job = null;
    state.installer.info = null;
    state.installer.error = '';
    state.installer.accepted = false;
    state.installer.busy = false;
    state.installer.poll += 1;
    render();
  }

  async function startRtklibInstall() {
    if (state.installer.busy || !state.installer.info || !state.installer.info.canInstall || !state.installer.accepted) return;
    state.installer.busy = true;
    state.installer.error = '';
    render();
    try {
      const response = await fetch('/api/rtklib/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Northstar-Action': 'install-rtklib' },
        body: JSON.stringify({ confirm: true })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'The installer did not start.');
      if (!result.job || !result.job.id) throw new Error('The installer did not return a job.');
      state.installer.job = result.job;
      state.installer.busy = false;
      state.installer.poll += 1;
      const token = state.installer.poll;
      render();
      pollInstaller(result.job.id, token);
    } catch (error) {
      state.installer.busy = false;
      state.installer.error = error && error.message ? error.message : 'The installer did not start.';
      render();
    }
  }

  async function pollInstaller(jobId, token) {
    if (!state.installer.open || state.installer.poll !== token) return;
    try {
      const response = await fetch('/api/rtklib/install/status', { cache: 'no-store' });
      if (!response.ok) throw new Error('The desktop backend stopped answering the installer.');
      const payload = await response.json();
      const job = payload && payload.job;
      if (!job || job.id !== jobId || state.installer.poll !== token) return;
      state.installer.job = job;
      state.installer.error = '';
      refreshInstallerPanel();
      if (job.status === 'done') {
        state.installer.busy = false;
        await runPreflight();
        await loadEngine(true);
        refreshInstallerPanel();
        return;
      }
      if (job.status === 'running' && state.installer.open && state.installer.poll === token) {
        setTimeout(() => pollInstaller(jobId, token), 850);
      }
    } catch (error) {
      if (state.installer.poll !== token) return;
      state.installer.error = error && error.message ? error.message : 'The installer status could not be read.';
      refreshInstallerPanel();
    }
  }

  function preflightCardHtml() {
    const preflight = state.preflight;
    const age = preflightAgeText();
    return '<div class="pp-card pp-preflight" id="ppPreflight"><div class="pp-card-head"><div><b>Readiness check</b><small>RTKLIB, NOAA and this rover session</small></div>'
      + '<button class="secondary-button" type="button" data-pp-action="preflight"' + (preflight.busy ? ' disabled' : '') + '>'
      + (preflight.busy ? 'Checking…' : preflight.checkedAt ? 'Check again' : 'Run check') + '</button></div>'
      + '<div class="pp-card-body"><div class="pp-checks">' + preflightRowsHtml() + '</div>'
      + '<div class="pp-note">' + (age ? '<b>' + esc(age) + '.</b> ' : '')
      + 'The check is local. It looks for RTKLIB on this computer and makes one NOAA request; it never uploads a project or rover file. Run <b>Setup Northstar</b> for install-level detail.</div>'
      + installerPanelHtml() + '</div></div>';
  }

  async function runPreflight() {
    if (state.preflight.busy) return;
    state.preflight.busy = true;
    state.preflight.error = '';
    render();
    try {
      const response = await fetch('/api/preflight?noaa=1', { cache: 'no-store' });
      if (!response.ok) throw new Error('The desktop backend did not answer the setup check.');
      const report = await response.json();
      if (!report || typeof report !== 'object') throw new Error('The setup check returned an unreadable answer.');
      state.preflight.server = report;
      state.preflight.checkedAt = Date.now();
    } catch (error) {
      state.preflight.server = null;
      state.preflight.error = error && error.message ? error.message : 'The setup check failed.';
    } finally {
      state.preflight.busy = false;
      render();
    }
  }

  async function loadEngine(force) {
    if (state.engine.loading || (state.engine.checked && !force)) return;
    state.engine.loading = true;
    // The result-only review never shows engine status, and rebuilding its body
    // mid-interaction detaches the hidden file input, which silently drops a
    // file the user just chose.
    const showsEngine = () => state.step === 3 && !state.resultOnly;
    if (showsEngine()) render();
    try {
      const response = await fetch('/api/rtklib/install/info', { cache: 'no-store' });
      if (!response.ok) throw new Error('The desktop backend did not answer the engine check.');
      const info = await response.json();
      state.engine = {
        loading: false,
        checked: true,
        found: !!info.installed,
        version: info.version || '',
        path: info.enginePath || '',
        error: ''
      };
    } catch (error) {
      state.engine = {
        loading: false,
        checked: true,
        found: false,
        version: '',
        path: '',
        error: (error && error.message ? error.message : 'The local engine check failed.')
      };
    }
    if (showsEngine()) render();
  }

  async function runCorrectionHere() {
    if (state.run.busy) return;
    if (!state.rover || !state.base) return message('Choose the rover and base files first.');
    const evaluation = ensureJob();
    if (evaluation.status === 'fail') {
      const blocker = evaluation.checks.find((check) => check.status === 'fail');
      return message('Resolve the blockers in Review before running' + (blocker ? ': ' + blocker.text : '.'));
    }
    if (!state.engine.found) {
      return message(state.engine.checked
        ? 'RTKLIB is not installed. Use the readiness check in Step 1 to install it.'
        : 'Checking the local RTKLIB engine. Try again in a moment.');
    }
    state.run = { busy: true, error: '', elapsedMs: 0, engine: '', warnings: '', completed: false };
    state.result = null;
    state.resultAccepted = false;
    state.resultError = null;
    render();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 360000);
    try {
      const payload = {
        confirm: true,
        rover: { name: state.rover.name, text: state.rover.text },
        base: { name: state.base.name, text: state.base.text },
        nav: state.nav.map((file) => ({ name: file.name, text: file.text })),
        sp3: state.sp3 && state.sp3.text ? { name: state.sp3.name, text: state.sp3.text } : null,
        config: buildRtkConfig(state.rover, state.base, state.options)
      };
      const response = await fetch('/api/rtklib/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Northstar-Action': 'run-rtklib' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'The local correction failed.');
      if (!result.pos) throw new Error('The local engine returned no position output.');
      state.result = parseResult(result.pos, outputName(state.rover));
      state.resultName = defaultResultName();
      state.resultTarget = 'new';
      state.resultAccepted = false;
      state.run = {
        busy: false,
        error: '',
        elapsedMs: Number(result.elapsedMs) || 0,
        engine: result.engine && result.engine.version ? result.engine.version : state.engine.version,
        warnings: result.warnings || '',
        completed: true
      };
      message(state.result.fixed.length
        ? 'Correction complete · ' + state.result.fixed.length + ' fixed epochs'
        : 'Correction finished with no fixed epochs · review the warnings');
    } catch (error) {
      state.run = {
        busy: false,
        error: error && error.name === 'AbortError'
          ? 'The local correction took longer than six minutes and was stopped.'
          : (error && error.message ? error.message : 'The local correction failed.')
            + (error && /no average of base station position|station pos computation/i.test(error.message || '')
              ? ' RTKLIB could not read the navigation data. Remove your navigation file in step 2 and run again with the base station navigation.'
              : '')
            + (error && /no solution epochs/i.test(error.message || '') && state.rover && !state.rover.hasL2 && state.options.frequency !== 'l1'
              ? ' This rover has no L2 observations, so the dual-frequency job had nothing to solve. Choose L1 only in step 3 and run again.'
              : ''),
        elapsedMs: 0,
        engine: state.engine.version,
        warnings: '',
        completed: false
      };
    } finally {
      clearTimeout(timer);
      render();
      if (state.run.completed) {
        requestAnimationFrame(() => {
          const resultCard = $('#ppBody') && $('#ppBody').querySelector('[data-pp-result-card]');
          if (resultCard) resultCard.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        });
      }
    }
  }

  function renderRoverStep() {
    return '<div class="pp-kicker">Step 1 · Rover</div><h3 class="pp-title">Start with the observations from the field</h3>'
      + '<p class="pp-copy">Drop the <strong>rover observation file</strong> from your receiver. Northstar reads the header, checks the session, and keeps the file untouched.</p>'
      + '<div class="pp-drop" data-pp-drop="rover" tabindex="0" role="button"><span class="pp-drop-icon material-symbols">satellite_alt</span>'
      + '<div class="pp-drop-copy"><b>Drop the rover RINEX file here</b><small>.obs, .rnx, .??o or .gz · an observation file, not a proprietary raw file</small></div>'
      + '<button class="secondary-button" type="button" data-pp-action="browse-rover">Choose file</button>'
      + '      <input id="ppRoverInput" type="file" accept=".rnx,.obs,.txt,.gz,.26o,.25o,.24o,.23o,.22o,.21o,.20o,.19o" hidden></div>'
      + '<div class="pp-note"><b>Need RINEX?</b> Use the receiver manufacturer\'s export or conversion utility, or open <b>Tools → Convert GNSS files</b> to check the file and see the next step. A proprietary raw file cannot be corrected directly.</div>'
      + errorNote(state.roverError)
      + (state.rover ? observationCard(state.rover, 'Rover observations') : '')
      + preflightCardHtml()
      + '<button type="button" class="pp-link pp-hint-link" data-pp-action="result-only">Already have a corrected .pos file? Review it instead →</button>';
  }

  function stationRows() {
    if (!state.stations.length) return '';
    return '<div class="pp-station-list">' + state.stations.map((station) => {
      const selected = state.baseStation && state.baseStation.corsId === station.corsId;
      const distance = Number(station.distance);
      return '<button type="button" class="pp-station' + (selected ? ' selected' : '') + '" data-pp-station="' + esc(station.corsId) + '">'
        + '<span class="pp-station-dot"></span><span class="pp-station-copy"><b>' + esc(station.corsId) + '</b><small>' + esc(station.name) + '</small></span>'
        + '<span class="pp-station-distance">' + esc(Number.isFinite(distance) ? formatDistance(distance) : '') + '</span></button>';
    }).join('') + '</div>';
  }

  function stationDetail() {
    const station = state.baseStation;
    if (!station) return '';
    const meta = state.stationMeta || {};
    return '<div class="pp-card pp-station-detail"><div class="pp-card-head"><div><b>' + esc(station.corsId) + ' · ' + esc(station.name || 'NOAA CORS') + '</b>'
      + '<small>Free NOAA CORS station · ' + esc(Number.isFinite(Number(station.distance)) ? formatDistance(Number(station.distance)) : 'distance unknown') + '</small></div>'
      + '<span class="pp-chip ' + (meta.lat ? 'ok' : 'warn') + '">' + (meta.lat ? 'Metadata' : 'Selected') + '</span></div><div class="pp-card-body">'
      + '<div class="pp-grid">'
      + (meta.lat ? '<div class="pp-row"><span>Published position</span><b>' + esc((+meta.lat).toFixed(7) + ', ' + (+meta.lon).toFixed(7)) + '</b></div>' : '')
      + (meta.ellipHeight != null ? '<div class="pp-row"><span>Ellipsoid height</span><b>' + esc((+meta.ellipHeight).toFixed(3) + ' m') + '</b></div>' : '')
      + (meta.posDatum ? '<div class="pp-row"><span>Datum</span><b>' + esc(meta.posDatum) + '</b></div>' : '')
      + (meta.stCounty ? '<div class="pp-row"><span>County</span><b>' + esc(meta.stCounty) + '</b></div>' : '')
      + '</div>'
      + '<div class="pp-note">Northstar requests the matching free UFCORS window, including ordinary RINEX observations, broadcast navigation, precise SP3 orbit, and the station coordinate file.</div>'
      + '<div class="pp-action-row"><button class="primary-button" type="button" data-pp-action="fetch-base"' + (state.baseBusy ? ' disabled' : '') + '>'
      + (state.baseBusy ? '<span class="pp-spinner"></span> Fetching…' : 'Fetch matching base window') + '</button>'
      + '<span class="pp-foot-note">' + esc(baseWindowText()) + '</span></div>'
      + '</div></div>';
  }

  function baseWindowText() {
    if (!state.rover || !state.rover.firstMs) return 'Rover time is missing';
    const hours = baseHours();
    const start = new Date(state.rover.firstMs);
    return 'UTC ' + start.toISOString().slice(0, 10) + ' ' + String(start.getUTCHours()).padStart(2, '0') + ':00 · ' + hours + ' h';
  }

  function baseHours() {
    if (!state.rover || !Number.isFinite(state.rover.duration)) return 1;
    return clamp(Math.ceil(state.rover.duration / 3600) + 1, 1, 24);
  }

  function baseInterval() {
    if (state.options.posMode === 'kinematic') return state.rover && state.rover.interval && state.rover.interval <= 1 ? 1 : 5;
    return 30;
  }

  function renderNoaaTab() {
    if (!state.rover) return '<div class="pp-note">Choose the rover file first. Its header sets the station search area and time window.</div>';
    if (!state.rover.approx || !Number.isFinite(state.rover.approx.lat)) {
      return '<div class="pp-note warn">The rover header has no approximate position, so Northstar cannot search for a nearby station. Import a base RINEX file instead, or use a receiver export that includes APPROX POSITION XYZ.</div>';
    }
    return '<p class="pp-copy">Northstar converts the rover position to the NOAA CORS search format and asks for the nine nearest stations. The station list and RINEX downloads are free; no account or API key is needed.</p>'
      + '<div class="pp-action-row"><button class="secondary-button" type="button" data-pp-action="search-stations"' + (state.stationBusy ? ' disabled' : '') + '>'
      + (state.stationBusy ? '<span class="pp-spinner pp-empty-spinner"></span> Searching…' : 'Find nearby NOAA CORS stations') + '</button>'
      + '<span class="pp-foot-note">Search centred on ' + esc(state.rover.approx.lat.toFixed(4) + ', ' + state.rover.approx.lon.toFixed(4)) + '</span></div>'
      + (state.stationError ? '<div class="pp-note error">' + esc(state.stationError) + '</div>' : '')
      + stationRows()
      + stationDetail()
      + (state.base && state.baseSource === 'noaa' ? '<div class="pp-note"><b>Base ready:</b> ' + esc(state.base.name) + ' · ' + esc(state.nav.length + (state.sp3 ? ' nav + SP3' : ' nav')) + ' attached.</div>' : '')
      + (state.base ? basePositionEditor() : '');
  }

  function renderManualTab() {
    const navRows = state.nav.map((file, index) => {
      const summary = file.summary;
      const meta = summary
        ? summary.recordCount + ' record' + (summary.recordCount === 1 ? '' : 's') + ' · ' + (summary.systems.length ? summary.systems.map(systemLabel).join(', ') : 'no satellite ids') + (file.source === 'base' ? ' · base station' : file.source === 'user' ? ' · your file' : '')
        : 'no readable ephemeris';
      return '<div class="pp-row"><span>' + esc(file.name) + '<small>' + esc(meta) + '</small></span><b><button type="button" class="pp-link" data-pp-remove-nav="' + index + '">Remove</button></b></div>';
    }).join('');
    return '<p class="pp-copy">Use a base RINEX file you already have. The base must have observations during the rover session. Navigation data and an orbit file are separate inputs.</p>'
      + '<div class="pp-drop" data-pp-drop="base" tabindex="0" role="button"><span class="pp-drop-icon material-symbols">cell_tower</span>'
      + '<div class="pp-drop-copy"><b>Drop the base RINEX file here</b><small>.??o, .obs, .rnx or .gz · ordinary RINEX, not Hatanaka</small></div>'
      + '<button class="secondary-button" type="button" data-pp-action="browse-base">Choose file</button>'
      + '      <input id="ppBaseInput" type="file" accept=".rnx,.obs,.txt,.gz,.26o,.25o,.24o,.23o,.22o,.21o,.20o,.19o" hidden></div>'
      + '<div class="pp-note">Hatanaka (.d / .crx) files must be decompressed with CRX2RNX first. Northstar rejects them instead of guessing at the data.</div>'
      + errorNote(state.baseError)
      + (state.base ? observationCard(state.base, 'Base observations') : '')
      + '<div class="pp-subhead">Navigation and precise orbit</div>'
      + '<div class="pp-drop" data-pp-drop="aux" tabindex="0" role="button"><span class="pp-drop-icon material-symbols">orbit</span>'
      + '<div class="pp-drop-copy"><b>Drop navigation or SP3 files</b><small>.??n, .nav, .sp3 · you can choose more than one</small></div>'
      + '<button class="secondary-button" type="button" data-pp-action="browse-aux">Choose files</button>'
      + '      <input id="ppAuxInput" type="file" accept=".26n,.25n,.24n,.23n,.22n,.21n,.20n,.nav,.sp3,.gz" multiple hidden></div>'
      + (navRows || state.sp3 ? '<div class="pp-card"><div class="pp-card-body">' + navRows + (state.sp3 ? '<div class="pp-row"><span>' + esc(state.sp3.name) + '</span><b><span class="pp-chip ok">SP3</span> <button type="button" class="pp-link" data-pp-remove-sp3>Remove</button></b></div>' : '') + '</div></div>' : '')
      + (state.base ? basePositionEditor() : '');
  }

  function basePositionEditor() {
    if (!state.base) return '';
    const position = state.basePosition || {};
    const published = Object.keys(state.baseFrames || {});
    const currentFrame = position.frame || state.baseFrame || '';
    const frames = Array.from(new Set([...published, currentFrame, 'NAD83(2011)', 'ITRF2020', 'WGS84', 'Unknown'].filter(Boolean)));
    const source = !validBasePosition(position) ? 'Missing' : position.source === 'rinex' ? 'Header' : position.source === 'ngs' ? 'Published' : 'Manual';
    const sourceClass = source === 'Published' ? 'ok' : source === 'Missing' ? 'fail' : 'warn';
    const fieldValue = (value) => Number.isFinite(Number(value)) ? String(value) : '';
    return '<div class="pp-subhead">Base reference position <span class="pp-chip ' + sourceClass + '">' + esc(source) + '</span></div>'
      + '<div class="pp-card"><div class="pp-card-body"><p class="pp-copy">The base coordinate is the anchor for the whole correction. Northstar uses the station\'s published ARP coordinate. NAD83(2011) is the usual U.S. survey frame; ITRF2020 is propagated to the session epoch when the station velocity is published.</p>'
      + '<label class="pp-field">Coordinate frame<select data-pp-base-frame>' + frames.map((frame) => '<option value="' + esc(frame) + '"' + (frame === currentFrame ? ' selected' : '') + '>' + esc(frame) + (published.includes(frame) ? ' · published' : '') + '</option>').join('') + '</select></label>'
      + '<div class="pp-field-grid three">'
      + '<label class="pp-field">Latitude<input type="number" step="any" data-pp-base-field="lat" value="' + esc(fieldValue(position.lat)) + '" placeholder="30.4074193"></label>'
      + '<label class="pp-field">Longitude<input type="number" step="any" data-pp-base-field="lon" value="' + esc(fieldValue(position.lon)) + '" placeholder="-91.1802542"></label>'
      + '<label class="pp-field">Ellipsoid height (m)<input type="number" step="any" data-pp-base-field="height" value="' + esc(fieldValue(position.height)) + '" placeholder="-5.204"></label>'
      + '</div><div class="pp-note"><b>' + esc(position.label || (validBasePosition(position) ? 'Manual reference position' : 'No base coordinate yet')) + '</b>'
      + (position.frame ? ' · ' + esc(position.frame) : '') + (position.epoch ? ' · epoch ' + esc(position.epoch) : '') + (position.sourceEpoch && position.sourceEpoch !== position.epoch ? ' · published at ' + esc(position.sourceEpoch) : '')
      + '<br>Choosing a published frame loads its coordinate. For a manual coordinate the frame is a label; Northstar never transforms it silently. The corrected point inherits this frame, and heights are ellipsoidal.</div>'
      + (!validBasePosition(position) ? '<div class="pp-note error">Enter the published latitude, longitude and ellipsoid height. Without a base coordinate the job is blocked.</div>' : '')
      + '</div></div>';
  }

  function renderBaseStep() {
    return '<div class="pp-kicker">Step 2 · Base</div><h3 class="pp-title">Find a station that was recording at the same time</h3>'
      + '<p class="pp-copy">A base station gives the correction a known point. <strong>You do not need your own base station.</strong> Northstar searches the free NOAA CORS network for a station near the rover, downloads a matching window, and records the station coordinate used. If you already have a base file, open the second tab.</p>'
      + '<div class="pp-tabs" role="tablist"><button type="button" class="pp-tab' + (state.baseTab === 'noaa' ? ' active' : '') + '" data-pp-tab="noaa">Find a NOAA station</button>'
      + '<button type="button" class="pp-tab' + (state.baseTab === 'file' ? ' active' : '') + '" data-pp-tab="file">Use my base file</button></div>'
      + (state.baseTab === 'noaa' ? renderNoaaTab() : renderManualTab());
  }

  function renderOptionsStep() {
    const rtk = 'RTKLIB runs outside Northstar. These settings are written into a standard .conf file.';
    return '<div class="pp-kicker">Step 3 · Processing</div><h3 class="pp-title">Choose the correction strategy</h3>'
      + '<p class="pp-copy">Static is right for a point feature. Kinematic follows a moving receiver. The defaults are deliberately conservative for a single point occupation.</p>'
      + '<div class="pp-field-grid"><label class="pp-field">Positioning mode<select data-pp-option="posMode"><option value="static"' + (state.options.posMode === 'static' ? ' selected' : '') + '>Static point</option><option value="kinematic"' + (state.options.posMode === 'kinematic' ? ' selected' : '') + '>Kinematic track</option></select></label>'
      + '<label class="pp-field">Frequency<select data-pp-option="frequency"><option value="l1+l2"' + (state.options.frequency === 'l1+l2' ? ' selected' : '') + '>L1 + L2 (best)</option><option value="l1"' + (state.options.frequency === 'l1' ? ' selected' : '') + '>L1 only</option></select></label>'
      + '<label class="pp-field">Elevation mask (°)<input type="number" min="0" max="45" step="1" data-pp-option="elevationMask" value="' + esc(state.options.elevationMask) + '"></label>'
      + '<label class="pp-field">Ambiguity resolution<select data-pp-option="arMode"><option value="continuous"' + (state.options.arMode === 'continuous' ? ' selected' : '') + '>Continuous (safest)</option><option value="fix-and-hold"' + (state.options.arMode === 'fix-and-hold' ? ' selected' : '') + '>Fix and hold</option></select></label>'
      + '<label class="pp-field">Ephemeris<select data-pp-option="ephemeris"><option value="brdc"' + (state.options.ephemeris === 'brdc' ? ' selected' : '') + '>Broadcast navigation</option><option value="precise"' + (state.options.ephemeris === 'precise' ? ' selected' : '') + '>Precise SP3 orbit</option></select></label>'
      + '<label class="pp-field">Solution direction<select data-pp-option="solutionType"><option value="combined"' + (state.options.solutionType === 'combined' ? ' selected' : '') + '>Combined forward + backward</option><option value="forward"' + (state.options.solutionType === 'forward' ? ' selected' : '') + '>Forward only</option></select></label>'
      + '<label class="pp-field">Maximum base age (s)<input type="number" min="1" max="120" step="1" data-pp-option="maxAge" value="' + esc(state.options.maxAge) + '"></label>'
      + '</div>'
      + '<div class="pp-note"><b>Antenna:</b> ' + esc(state.rover && state.rover.antennaType ? state.rover.antennaType : 'not stated in the rover header') + ' · delta h/e/n '
      + esc(state.rover && state.rover.antennaDelta ? state.rover.antennaDelta.h.toFixed(3) + ' / ' + state.rover.antennaDelta.e.toFixed(3) + ' / ' + state.rover.antennaDelta.n.toFixed(3) + ' m' : 'not stated')
      + '. RTKLIB uses these RINEX header values. If the field antenna height is wrong, correct it in the RINEX export and reload the file.</div>'
      + '<div class="pp-note">' + esc(rtk) + ' Northstar does not silently switch datums or vertical references. The output height is ellipsoidal.</div>'
      + '<details class="pp-advanced"><summary>What do these choices mean?</summary><div class="pp-note"><b>Static</b> holds the receiver still and averages the fixed epochs. <b>Kinematic</b> estimates a position for every epoch. <b>Continuous</b> ambiguity resolution avoids holding a false fix. <b>SP3</b> uses the precise orbit from NOAA when it is available.</div></details>';
  }

  function checkRows(checks) {
    return '<div class="pp-checks">' + checks.map((check) => {
      const icon = check.status === 'fail' ? 'error' : check.status === 'warn' ? 'warning' : 'check_circle';
      return '<div class="pp-check-row ' + esc(check.status) + '"><span class="pp-check-icon material-symbols">' + icon + '</span>'
        + '<span class="pp-check-copy"><b>' + esc(check.label) + '</b><small>' + esc(check.text) + '</small></span>'
        + '<span class="pp-chip ' + esc(check.status) + '">' + esc(check.status === 'pass' ? 'OK' : check.status) + '</span></div>';
    }).join('') + '</div>';
  }

  function renderReviewStep() {
    if (state.resultOnly) {
      return '<div class="pp-kicker">Corrected result</div><h3 class="pp-title">Review a .pos solution</h3>'
        + '<p class="pp-copy">Import a corrected solution from RTKLIB or another processor. Northstar uses the mean of <strong>fixed epochs only</strong> and records the provenance on the waypoint.</p>'
        + renderResultCard()
        + '<button type="button" class="pp-link pp-hint-link" data-pp-action="new-job">Set up a new correction job instead →</button>';
    }
    const evaluation = ensureJob();
    const job = state.job;
    const ready = evaluation.status === 'pass' ? 'Ready to process' : evaluation.status === 'warn' ? 'Review the warnings before processing' : 'Needs attention before processing';
    const heroClass = evaluation.status === 'pass' ? '' : evaluation.status;
    const station = state.baseStation;
    const engine = state.engine;
    const engineReady = !!engine.found;
    const engineChecking = engine.loading || !engine.checked;
    const runDisabled = state.run.busy || !engineReady || evaluation.status === 'fail';
    const engineChip = engineChecking ? '<span class="pp-chip warn">Checking</span>'
      : engineReady ? '<span class="pp-chip ok">Ready</span>'
        : '<span class="pp-chip warn">Not installed</span>';
    return '<div class="pp-kicker">Step 4 · Review</div><h3 class="pp-title">Check the job, then run RTKLIB</h3>'
      + '<p class="pp-copy">Northstar checks the files and writes a standard RTKLIB configuration. Run the free engine here through the local backend, or export the package and run it yourself. The raw data stays on this computer.</p>'
      + '<div class="pp-readiness ' + heroClass + '"><span class="pp-readiness-icon material-symbols">' + (evaluation.status === 'fail' ? 'error' : evaluation.status === 'warn' ? 'warning' : 'verified') + '</span>'
      + '<div class="pp-readiness-copy"><b>' + esc(ready) + '</b><small>' + esc(evaluation.checks.filter((check) => check.status === 'fail').length + ' blockers · ' + evaluation.checks.filter((check) => check.status === 'warn').length + ' warnings') + '</small></div>'
      + '<span class="pp-chip ' + esc(evaluation.status) + '">' + esc(evaluation.status === 'pass' ? 'Ready' : evaluation.status === 'warn' ? 'Review' : 'Blocked') + '</span></div>'
      + '<div class="pp-subhead">Job checks</div>' + checkRows(evaluation.checks)
      + '<div class="pp-subhead">Correction summary</div>'
      + '<div class="pp-card"><div class="pp-card-body"><div class="pp-grid">'
      + '<div class="pp-row"><span>Rover</span><b>' + esc(state.rover.name) + '</b></div>'
      + '<div class="pp-row"><span>Base</span><b>' + esc(station ? station.corsId + ' · ' + station.name : state.base.name) + '</b></div>'
      + '<div class="pp-row"><span>Window</span><b>' + esc(formatDate(state.rover.firstMs, true) + ' to ' + formatDate(state.rover.lastMs, true)) + '</b></div>'
      + '<div class="pp-row"><span>Baseline</span><b>' + esc(Number.isFinite(evaluation.distance) ? formatDistance(evaluation.distance) : 'not checked') + '</b></div>'
      + '<div class="pp-row"><span>Mode</span><b>' + esc(state.options.posMode + ' · ' + state.options.frequency) + '</b></div>'
      + '<div class="pp-row"><span>Base position</span><b>' + esc(state.basePosition ? (state.basePosition.label || state.basePosition.source) : '—') + '</b></div>'
      + '<div class="pp-row"><span>Output frame</span><b>' + esc(state.basePosition && state.basePosition.frame ? state.basePosition.frame + (state.basePosition.epoch ? ' · epoch ' + state.basePosition.epoch : '') : 'not stated') + '</b></div>'
      + '</div></div></div>'
      + '<div class="pp-subhead">Run the correction</div>'
      + '<div class="pp-card pp-run-card"><div class="pp-card-head"><div><b>Run it on this computer</b><small>' + (engineReady
        ? (engine.version ? 'RTKLIB ' + esc(engine.version) + ' is ready' : 'The local engine is ready')
        : engineChecking ? 'Checking the local engine…' : 'The local engine is not available') + '</small></div>' + engineChip + '</div><div class="pp-card-body">'
      + '<p class="pp-copy">The local backend writes the checked job to a temporary folder, runs <b>rnx2rtkp</b>, and brings the <b>.pos</b> solution back here. The files are deleted after the run and are never uploaded.</p>'
      + '<div class="pp-action-row"><button class="primary-button" type="button" data-pp-action="run-correction"' + (runDisabled ? ' disabled' : '') + '>'
      + (state.run.busy ? '<span class="pp-spinner"></span> Correcting…' : 'Run correction here') + '</button>'
      + '<button class="secondary-button" type="button" data-pp-action="download-package">Download job package</button>'
      + '<button class="secondary-button" type="button" data-pp-action="download-config">Download RTKLIB config</button>'
      + '<button class="secondary-button" type="button" data-pp-action="copy-command">Copy command</button></div>'
      + (engineReady ? '' : '<div class="pp-note warn">' + (engineChecking
        ? 'Checking for the local correction engine.'
        : engine.error
          ? esc(engine.error)
          : 'RTKLIB is not installed. Open <b>Step 1 → Readiness check</b> and choose <b>Install RTKLIB</b>, or download the job package and run it with your own RTKLIB.') + '</div>')
      + (state.run.completed ? '<div class="pp-note"><b>Finished in ' + esc((state.run.elapsedMs / 1000).toFixed(1)) + ' s</b>'
        + (state.run.engine ? ' · ' + esc(state.run.engine) : '') + ' · ' + (state.result && state.result.fixed.length
          ? esc(state.result.fixed.length + ' fixed epochs')
          : 'no fixed epochs') + '. Review the result below before accepting it.</div>' : '')
      + (state.run.error && !state.run.busy ? '<div class="pp-note error"><b>The local correction did not finish</b><br>' + esc(state.run.error) + '</div>' : '')
      + (state.run.warnings ? '<details class="pp-install-log"><summary>Engine messages</summary><pre>' + esc(state.run.warnings) + '</pre></details>' : '')
      + '<code class="pp-code">' + esc(job.command) + '</code>'
      + '<p class="pp-note"><b>Manual option:</b> the package includes the rover, base, navigation, SP3, configuration, and a short README. Run the command with any RTKLIB 2.4.3 or newer install and bring the .pos back below. The output uses ellipsoidal heights in the base position frame.</p>'
      + '</div></div>'
      + '<div class="pp-subhead">Corrected result</div>' + renderResultCard();
  }

  function renderResultCard() {
    if (!state.result) {
      return '<div class="pp-card" data-pp-result-card><div class="pp-card-body"><div class="pp-drop" data-pp-drop="result" tabindex="0" role="button"><span class="pp-drop-icon material-symbols">fact_check</span>'
        + '<div class="pp-drop-copy"><b>Drop the corrected .pos file here</b><small>RTKLIB position output · fixed epochs are averaged</small></div>'
        + '<button class="secondary-button" type="button" data-pp-action="browse-result">Choose file</button>'
        + '<input id="ppResultInput" type="file" accept=".pos" hidden></div>'
        + errorNote(state.resultError)
        + '<div class="pp-note">A .pos result is not the corrected field file. It contains one position per epoch with a quality code. Northstar accepts only Q=1 (fixed) epochs.</div>'
        + '</div></div>';
    }
    const result = state.result;
    const accepted = result.accepted;
    const chips = Object.entries(result.counts).map(([label, count]) => '<span class="pp-chip ' + (label === 'Fixed' ? 'ok' : 'warn') + '">' + esc(count + ' ' + label) + '</span>').join('');
    const target = state.resultTarget;
    const selected = window.northstarApp && window.northstarApp.S && window.northstarApp.S.points.find((point) => point.id === window.northstarApp.S.selected);
    const canUpdate = !!selected;
    return '<div class="pp-card" data-pp-result-card><div class="pp-card-head"><div class="pp-result-head"><div><b>' + esc(result.fileName) + '</b><small>' + esc(result.fixed.length + ' fixed epochs · ' + (result.header.program ? result.header.program[0] : 'RTKLIB solution')) + '</small></div></div>'
      + '<span class="pp-chip ' + (result.fixed.length ? 'ok' : 'fail') + '">' + (result.fixed.length ? 'Fixed' : 'No fixed') + '</span></div><div class="pp-card-body">'
      + '<div class="pp-systems">' + chips + '</div>'
      + (accepted ? '<div class="pp-grid" style="margin-top:10px">'
        + '<div class="pp-row"><span>Mean latitude</span><b>' + esc(accepted.lat.toFixed(9)) + '</b></div>'
        + '<div class="pp-row"><span>Mean longitude</span><b>' + esc(accepted.lon.toFixed(9)) + '</b></div>'
        + '<div class="pp-row"><span>Ellipsoid height</span><b>' + esc(accepted.height.toFixed(3) + ' m') + '</b></div>'
        + '<div class="pp-row"><span>Base frame</span><b>' + esc((state.basePosition && state.basePosition.frame ? state.basePosition.frame : 'not stated') + (state.basePosition && state.basePosition.epoch ? ' · epoch ' + state.basePosition.epoch : '')) + '</b></div>'
        + '<div class="pp-row"><span>Spread (reported)</span><b>' + esc((Number.isFinite(result.horizontal) ? '±' + result.horizontal.toFixed(3) + ' m H' : '—') + (Number.isFinite(result.vertical) ? ' · ±' + result.vertical.toFixed(3) + ' m V' : '')) + '</b></div>'
        + '</div>' : '<div class="pp-note error">No fixed epochs. Adjust the processing options, use a closer base, or collect a longer session. Northstar will not turn float epochs into a survey coordinate.</div>')
      + (accepted ? '<div class="pp-subhead">Accept this position</div>'
        + '<label class="pp-check"><input type="radio" name="ppResultTarget" value="new"' + (target === 'new' ? ' checked' : '') + '> <span>Add a new waypoint<small>' + esc(state.resultName || defaultResultName()) + '</small></span></label>'
        + '<label class="pp-check"><input type="radio" name="ppResultTarget" value="update"' + (target === 'update' ? ' checked' : '') + (canUpdate ? '' : ' disabled') + '> <span>Update the selected waypoint' + (canUpdate ? '<small>' + esc(selected.name) + '</small>' : '<small>Select a waypoint in the project first.</small>') + '</span></label>'
        + (target === 'new' ? '<label class="pp-field" style="margin-top:8px">Waypoint name<input id="ppResultName" type="text" value="' + esc(state.resultName || defaultResultName()) + '"></label>' : '')
        + '<div class="pp-action-row"><button class="primary-button" type="button" data-pp-action="accept-result">Accept corrected position</button>'
        + '<button class="secondary-button" type="button" data-pp-action="browse-result">Replace .pos</button></div>' : '')
      + '</div></div>';
  }

  function renderBody() {
    if (state.step === 0) return renderRoverStep();
    if (state.step === 1) return renderBaseStep();
    if (state.step === 2) return renderOptionsStep();
    return renderReviewStep();
  }

  function render() {
    const body = $('#ppBody');
    if (!body) return;
    const scroll = body.scrollTop || renderedScroll;
    // A background check (for example the engine probe) can finish while the
    // user is typing a waypoint name or a base coordinate. Rebuilding the panel
    // must not discard what is in the focused field.
    const focused = document.activeElement;
    // File inputs throw when their selection is read, and number inputs report
    // no selection, so only text-like fields keep a caret to restore.
    let keep = null;
    if (focused && body.contains(focused) && focused.id && focused.tagName === 'INPUT' && focused.type !== 'file') {
      try {
        keep = { id: focused.id, value: focused.value, start: focused.selectionStart, end: focused.selectionEnd };
      } catch (error) {
        keep = null;
      }
    }
    $('#ppSteps').innerHTML = renderSteps();
    body.innerHTML = renderBody();
    body.scrollTop = scroll;
    renderedScroll = body.scrollTop;
    if (keep) {
      const input = $('#' + keep.id);
      if (input && input.tagName === 'INPUT') {
        if (input.value !== keep.value) input.value = keep.value;
        if (keep.id === 'ppResultName') state.resultName = keep.value;
        input.focus();
        try { input.setSelectionRange(keep.start, keep.end); } catch (error) {}
      }
    }
    const back = $('#ppBack');
    const next = $('#ppNext');
    const note = $('#ppFootNote');
    if (back) back.hidden = state.step === 0;
    if (next) {
      next.textContent = state.step === 3 ? 'Close' : state.step === 2 ? 'Review job' : 'Continue';
      next.disabled = !!state.busy || (state.step === 0 && !state.rover) || (state.step === 1 && !state.base) || (state.step === 2 && (!state.rover || !state.base));
    }
    if (note) {
      if (state.step === 3) note.innerHTML = state.resultOnly ? 'Result review only · no new correction job is created.' : '<b>Files stay in this tab.</b> The correction job is saved in project history.';
      else if (state.rover) note.innerHTML = '<b>' + esc(state.rover.name) + '</b> · ' + esc(formatDate(state.rover.firstMs) + ' · ' + formatDuration(state.rover.duration));
      else note.innerHTML = '<b>No file uploaded.</b> RINEX files stay on this computer.';
    }
  }

  function chooseBaseFrame(frameName, milliseconds) {
    const frame = state.baseFrames && state.baseFrames[frameName];
    if (!frame) return false;
    const position = positionAtEpoch(frame, milliseconds);
    if (!position) return false;
    const propagated = position.frame === 'ITRF2020' && position.propagated;
    state.baseFrame = frameName;
    state.basePosition = {
      lat: position.lat,
      lon: position.lon,
      height: position.height,
      x: position.x,
      y: position.y,
      z: position.z,
      source: 'ngs',
      label: 'NGS ' + frameName + ' · station coordinate' + (propagated ? ' · propagated to ' + position.epoch : ''),
      frame: frameName,
      epoch: position.epoch || '',
      sourceEpoch: position.sourceEpoch || '',
      propagated: !!propagated,
      velocity: position.velocity || null
    };
    return true;
  }

  function baseSourceFromStation(station, options) {
    if (!station) return;
    state.baseStation = {
      corsId: station.corsId,
      name: station.name,
      distance: station.distance,
      ...state.stationMeta
    };
    if (state.stationMeta && Number.isFinite(+state.stationMeta.lat)) {
      const frameName = normalizeFrame(state.stationMeta.posDatum) || 'NAD83(2011)';
      const frame = {
        lat: +state.stationMeta.lat,
        lon: +state.stationMeta.lon,
        height: +state.stationMeta.ellipHeight,
        frame: frameName,
        epoch: state.stationMeta.epoch || '',
        sourceEpoch: state.stationMeta.epoch || ''
      };
      state.baseFrames = { ...(state.baseFrames || {}), [frameName]: frame };
      if (!options || !options.keepPosition) chooseBaseFrame(frameName, state.rover ? state.rover.firstMs : null);
    }
  }

  async function searchStations() {
    if (!state.rover || !state.rover.approx) return message('The rover header has no approximate position');
    state.stationBusy = true;
    state.stationError = '';
    state.stations = [];
    render();
    try {
      const query = new URLSearchParams({
        lat: String(state.rover.approx.lat),
        lon: String(state.rover.approx.lon),
        height: String(state.rover.approx.height || 0)
      });
      const response = await fetch('/api/noaa/nearby?' + query.toString());
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || 'The NOAA station search failed.');
      state.stations = Array.isArray(data.stations) ? data.stations : [];
      if (!state.stations.length) state.stationError = 'NOAA returned no nearby stations for this position.';
    } catch (error) {
      state.stationError = /api\/noaa|Failed to fetch/i.test(error.message)
        ? 'The NOAA lookup needs the desktop backend, or import a base RINEX file instead.'
        : error.message;
    } finally {
      state.stationBusy = false;
      render();
    }
  }

  async function selectStation(corsId) {
    const station = state.stations.find((item) => item.corsId === corsId);
    if (!station) return;
    state.stationError = '';
    if (!state.baseStation || state.baseStation.corsId !== corsId) {
      state.base = null;
      state.nav = [];
      state.sp3 = null;
      state.basePosition = null;
      state.baseFrames = {};
      state.baseFrame = '';
      state.baseSource = '';
    }
    state.stationMeta = null;
    baseSourceFromStation(station);
    render();
    try {
      const response = await fetch('/api/noaa/station?id=' + encodeURIComponent(corsId));
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || 'NOAA station metadata failed.');
      state.stationMeta = Array.isArray(data.stations) && data.stations.length ? data.stations[0] : null;
      baseSourceFromStation(station);
    } catch (error) {
      state.stationError = error.message + ' The base window may still be available.';
    } finally {
      render();
    }
  }

  async function fetchBaseWindow() {
    const station = state.baseStation;
    if (!station) return message('Select a NOAA station first');
    if (!state.rover || !state.rover.firstMs) return message('The rover time window is missing');
    state.baseBusy = true;
    state.baseError = '';
    render();
    try {
      const first = new Date(state.rover.firstMs);
      const hours = baseHours();
      const params = new URLSearchParams({
        station: station.corsId,
        date: first.toISOString().slice(0, 10),
        start: String(first.getUTCHours()).padStart(2, '0') + ':00',
        hours: String(hours),
        interval: String(baseInterval())
      });
      const response = await fetch('/api/noaa/base?' + params.toString());
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || 'The NOAA base download failed.');
      const parsed = parseRinex(data.obs.text, data.obs.name);
      if (!parsed.ok) throw new Error(parsed.error ? parsed.error.title + ': ' + parsed.error.message : 'NOAA returned an unreadable base file.');
      parsed.text = data.obs.text;
      parsed.size = data.obs.text.length;
      state.base = parsed;
      state.nav = Array.isArray(data.nav)
        ? data.nav.filter((file) => file && typeof file.text === 'string').map((file) => navEntry(file.name || 'navigation.nav', file.text, 'base'))
        : [];
      state.sp3 = data.sp3 || null;
      state.coordText = data.coordText || '';
      const coordinates = parseCoordText(state.coordText);
      const frames = {};
      if (coordinates.nad83) frames['NAD83(2011)'] = coordinates.nad83;
      if (coordinates.itrf) frames['ITRF2020'] = coordinates.itrf;
      state.baseFrames = frames;
      state.baseFrame = '';
      state.basePosition = null;
      if (chooseBaseFrame(frames['NAD83(2011)'] ? 'NAD83(2011)' : 'ITRF2020', parsed.firstMs)) {
        // The published coordinate is the ARP. NAD83(2011) is the usual U.S. survey frame.
      } else if (state.stationMeta) {
        baseSourceFromStation(station);
      } else if (parsed.approx) {
        state.basePosition = { lat: parsed.approx.lat, lon: parsed.approx.lon, height: parsed.approx.height, source: 'rinex', label: 'RINEX header (approximate)', frame: '' };
      }
      state.baseSource = 'noaa';
      state.baseError = '';
      message('Base ready · ' + (data.obs.name || 'RINEX') + ' with ' + state.nav.length + ' navigation file' + (state.sp3 ? ' and SP3' : ''));
    } catch (error) {
      state.baseError = error.message;
      message('Base download failed: ' + error.message);
    } finally {
      state.baseBusy = false;
      render();
    }
  }

  function loadRoverObservation(parsed) {
    state.rover = parsed;
    // A single-frequency receiver cannot be solved at the dual-frequency
    // default: rnx2rtkp writes a .pos with no solution rows at all. Start the
    // job on the choice that can work for this file; step 3 can still change it.
    state.options.frequency = parsed.hasL2 ? 'l1+l2' : 'l1';
    state.roverError = '';
    state.stations = [];
    state.baseStation = null;
    state.stationMeta = null;
    state.base = null;
    state.basePosition = null;
    state.baseFrames = {};
    state.baseFrame = '';
    state.nav = [];
    state.sp3 = null;
    state.job = null;
    state.persistedSignature = '';
    state.result = null;
    state.resultOnly = false;
    state.resultError = '';
    render();
  }

  async function onRoverFile(file) {
    if (!file) return;
    state.roverError = '';
    state.busy = 'Reading rover file…';
    render();
    const parsed = await readObservation(file);
    state.busy = '';
    if (!parsed.ok) {
      state.rover = null;
      state.roverError = parsed.error;
      render();
      return;
    }
    loadRoverObservation(parsed);
  }

  function openWithRover(text, fileName, navFiles) {
    const parsed = parseRinex(text, fileName || 'converted.obs');
    if (!parsed.ok) return parsed;
    parsed.text = text;
    parsed.size = text.length;
    loadRoverObservation(parsed);
    if (Array.isArray(navFiles) && navFiles.length) {
      state.nav = navFiles
        .filter((file) => file && typeof file.text === 'string' && file.text.trim())
        .map((file) => navEntry(file.name || 'navigation.nav', file.text));
    }
    openDialog(1);
    return parsed;
  }

  async function onBaseFile(file) {
    if (!file) return;
    state.baseError = '';
    state.busy = 'Reading base file…';
    render();
    const parsed = await readObservation(file);
    state.busy = '';
    if (!parsed.ok) {
      state.base = null;
      state.basePosition = null;
      state.baseError = parsed.error;
      render();
      return;
    }
    state.base = parsed;
    state.baseSource = 'file';
    state.baseStation = null;
    state.baseFrames = {};
    state.baseFrame = '';
    state.basePosition = parsed.approx && Number.isFinite(parsed.approx.lat)
      ? { lat: parsed.approx.lat, lon: parsed.approx.lon, height: parsed.approx.height, source: 'rinex', label: 'RINEX header (approximate)', frame: '' }
      : null;
    state.job = null;
    state.persistedSignature = '';
    render();
  }

  async function onAuxFiles(files) {
    const list = Array.from(files || []);
    if (!list.length) return;
    state.baseError = '';
    for (const file of list) {
      try {
        const parsed = await readAuxiliary(file);
        if (parsed.kind === 'sp3') state.sp3 = parsed;
        else state.nav.push(parsed);
      } catch (error) {
        state.baseError = error.message;
      }
    }
    state.job = null;
    state.persistedSignature = '';
    render();
  }

  async function onResultFile(file) {
    if (!file) return;
    state.resultError = '';
    if (!state.run.busy) state.run = { busy: false, error: '', elapsedMs: 0, engine: '', warnings: '', completed: false };
    try {
      const text = await file.text();
      state.result = parseResult(text, file.name);
      state.resultName = defaultResultName();
      state.resultTarget = 'new';
      state.resultAccepted = false;
    } catch (error) {
      state.result = null;
      state.resultError = { title: 'Could not read the corrected solution', message: error.message };
    }
    render();
  }

  function setBasePositionField(field, value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return;
    const current = state.basePosition || {};
    state.basePosition = {
      ...current,
      lat: field === 'lat' ? numeric : Number(current.lat),
      lon: field === 'lon' ? numeric : Number(current.lon),
      height: field === 'height' ? numeric : Number(current.height),
      source: 'manual',
      label: 'Manual reference position',
      frame: current.frame || state.baseFrame || '',
      epoch: ''
    };
    state.baseFrame = '';
    state.job = null;
    state.persistedSignature = '';
  }

  function setBaseFrame(name) {
    if (name && state.baseFrames && state.baseFrames[name] && chooseBaseFrame(name, state.rover ? state.rover.firstMs : null)) {
      state.job = null;
      state.persistedSignature = '';
      return;
    }
    const current = state.basePosition || {};
    state.baseFrame = '';
    state.basePosition = {
      ...current,
      source: 'manual',
      label: validBasePosition(current) ? 'Manual reference position · ' + (name || 'frame not stated') : 'No base coordinate yet',
      frame: name || ''
    };
    state.job = null;
    state.persistedSignature = '';
  }

  function acceptResult() {
    if (!state.result || !state.result.accepted) return message('No fixed epochs to accept');
    const app = window.northstarApp;
    if (!app || !app.S) return message('The project is not ready');
    const accepted = state.result.accepted;
    const selected = app.S.points.find((point) => point.id === app.S.selected);
    let pointId = null;
    if (state.resultTarget === 'update' && selected) {
      app.pushHistory('accept GNSS result');
      selected.lat = accepted.lat;
      selected.lon = accepted.lon;
      selected.ellipsoidHeight = accepted.height;
      pointId = selected.id;
    } else {
      const added = app.add({
        name: state.resultName.trim() || defaultResultName(),
        lat: accepted.lat,
        lon: accepted.lon,
        symbol: 'circle',
        showLabel: false
      });
      if (!added) return message('Could not add the corrected waypoint');
      pointId = added.id;
    }
    app.S.accepted = Array.isArray(app.S.accepted) ? app.S.accepted : [];
    app.S.accepted.push({
      pointId,
      source: state.result.fileName,
      method: 'mean of fixed epochs (Q=1)',
      epochCount: accepted.epochCount,
      week: accepted.week,
      firstTow: accepted.firstTow,
      lastTow: accepted.lastTow,
      height: accepted.height,
      runProgram: (state.result.header.program || [''])[0] || 'RTKLIB',
      execution: state.run.completed ? 'northstar-local' : 'imported',
      engine: state.run.completed ? state.run.engine : '',
      acceptedAt: new Date().toISOString(),
      jobId: state.job ? state.job.id : null,
      baseStation: state.baseStation ? state.baseStation.corsId : null,
      basePosition: state.basePosition ? { ...state.basePosition } : null,
      referenceFrame: state.basePosition ? state.basePosition.frame || '' : '',
      referenceEpoch: state.basePosition ? state.basePosition.epoch || '' : '',
      posMode: state.options.posMode,
      frequency: state.options.frequency
    });
    if (state.job) {
      state.job.status = 'complete';
      state.job.result = summarizeResult(state.result, state.run.completed ? 'northstar-local' : 'imported');
      state.job.updatedAt = new Date().toISOString();
      persistJob();
    }
    state.resultAccepted = true;
    app.save();
    app.draw();
    app.inspect();
    closeDialog();
    message('Accepted ' + accepted.epochCount + ' fixed epochs as ' + (state.resultTarget === 'update' ? 'the selected waypoint' : 'a new waypoint') + (state.job ? ' · saved in GNSS jobs' : ''));
  }

  function closeDialog() {
    const dialog = $('#postprocessDialog');
    if (dialog && dialog.open) dialog.close();
  }

  function openDialog(startStep) {
    const dialog = $('#postprocessDialog');
    if (!dialog) return;
    state.step = Number.isInteger(startStep) && startStep > 0 ? startStep : 0;
    state.resultOnly = false;
    state.resultError = '';
    render();
    if (!dialog.open) dialog.showModal();
    loadEngine(true);
  }

  function bindEvents() {
    $('#postprocessDialog')?.addEventListener('click', (event) => {
      const stepButton = event.target.closest('[data-pp-step]');
      if (stepButton) {
        const target = +stepButton.dataset.ppStep;
        if (canOpenStep(target)) setStep(target);
        return;
      }
      const tab = event.target.closest('[data-pp-tab]');
      if (tab) {
        state.baseTab = tab.dataset.ppTab;
        render();
        return;
      }
      const station = event.target.closest('[data-pp-station]');
      if (station) {
        selectStation(station.dataset.ppStation);
        return;
      }
      const removeNav = event.target.closest('[data-pp-remove-nav]');
      if (removeNav) {
        state.nav.splice(+removeNav.dataset.ppRemoveNav, 1);
        state.job = null;
        state.persistedSignature = '';
        render();
        return;
      }
      if (event.target.closest('[data-pp-remove-sp3]')) {
        state.sp3 = null;
        state.job = null;
        state.persistedSignature = '';
        render();
        return;
      }
      const action = event.target.closest('[data-pp-action]');
      if (action) {
        const name = action.dataset.ppAction;
        if (name === 'browse-rover') $('#ppRoverInput')?.click();
        else if (name === 'preflight') runPreflight();
        else if (name === 'rtklib-install') openInstaller();
        else if (name === 'rtklib-install-close') closeInstaller();
        else if (name === 'rtklib-install-start') startRtklibInstall();
        else if (name === 'rtklib-install-retry') {
          state.installer.job = null;
          state.installer.error = '';
          state.installer.busy = false;
          render();
        }
        else if (name === 'browse-base') $('#ppBaseInput')?.click();
        else if (name === 'browse-aux') $('#ppAuxInput')?.click();
        else if (name === 'browse-result') $('#ppResultInput')?.click();
        else if (name === 'search-stations') searchStations();
        else if (name === 'fetch-base') fetchBaseWindow();
        else if (name === 'run-correction') runCorrectionHere();
        else if (name === 'download-package') downloadJobPackage();
        else if (name === 'check-engine') loadEngine(true);
        else if (name === 'download-config') {
          if (!state.rover || !state.base) return message('Choose the rover and base files first');
          const evaluation = ensureJob();
          if (evaluation.status === 'fail') return message('Resolve the blockers in Review before downloading the config.');
          downloadBlob('northstar_job.conf', new Blob([buildRtkConfig(state.rover, state.base, state.options)], { type: 'text/plain' }));
          message('RTKLIB config downloaded');
        } else if (name === 'copy-command') copyCommand();
        else if (name === 'accept-result') acceptResult();
        else if (name === 'result-only') {
          state.resultOnly = true;
          state.step = 3;
          state.job = null;
          state.result = null;
          state.resultError = '';
          render();
        } else if (name === 'new-job') {
          startNewJob();
        }
      }
    });
    $('#postprocessDialog')?.addEventListener('input', (event) => {
      if (event.target.id === 'ppResultName') state.resultName = event.target.value;
    });
    $('#postprocessDialog')?.addEventListener('change', (event) => {
      const target = event.target;
      if (target.id === 'ppRoverInput') onRoverFile(target.files && target.files[0]);
      else if (target.id === 'ppBaseInput') onBaseFile(target.files && target.files[0]);
      else if (target.id === 'ppAuxInput') onAuxFiles(target.files);
      else if (target.id === 'ppResultInput') onResultFile(target.files && target.files[0]);
      else if (target.id === 'ppInstallAccept') {
        state.installer.accepted = !!target.checked;
        refreshInstallerPanel();
      } else if (target.id === 'ppResultName') {
        state.resultName = target.value;
      } else if (target.name === 'ppResultTarget') {
        state.resultTarget = target.value;
        render();
      } else if (target.dataset.ppOption) {
        const key = target.dataset.ppOption;
        const numeric = ['elevationMask', 'maxAge', 'antennaHeight'].includes(key);
        if (numeric && !Number.isFinite(Number(target.value))) return;
        state.options[key] = numeric ? Number(target.value) : target.value;
        state.job = null;
        state.persistedSignature = '';
        render();
      } else if (target.dataset.ppBaseField) {
        setBasePositionField(target.dataset.ppBaseField, target.value);
        render();
      } else if (target.dataset.ppBaseFrame !== undefined) {
        setBaseFrame(target.value);
        render();
      }
      if (target.id === 'ppRoverInput' || target.id === 'ppBaseInput' || target.id === 'ppAuxInput' || target.id === 'ppResultInput') target.value = '';
    });
    $('#postprocessDialog')?.addEventListener('dragover', (event) => {
      const drop = event.target.closest('[data-pp-drop]');
      if (!drop) return;
      event.preventDefault();
      drop.classList.add('dragging');
    });
    $('#postprocessDialog')?.addEventListener('dragleave', (event) => {
      const drop = event.target.closest('[data-pp-drop]');
      if (drop) drop.classList.remove('dragging');
    });
    $('#postprocessDialog')?.addEventListener('drop', (event) => {
      const drop = event.target.closest('[data-pp-drop]');
      if (!drop) return;
      event.preventDefault();
      drop.classList.remove('dragging');
      const files = event.dataTransfer && event.dataTransfer.files;
      if (!files || !files.length) return;
      const kind = drop.dataset.ppDrop;
      if (kind === 'rover') onRoverFile(files[0]);
      else if (kind === 'base') onBaseFile(files[0]);
      else if (kind === 'aux') onAuxFiles(files);
      else if (kind === 'result') onResultFile(files[0]);
    });
    $('#ppClose')?.addEventListener('click', closeDialog);
    $('#ppBack')?.addEventListener('click', () => setStep(state.step - 1));
    $('#ppNext')?.addEventListener('click', () => {
      if (state.step === 3) {
        closeDialog();
        return;
      }
      if (state.step === 0 && !state.rover) return message('Choose a rover RINEX file first');
      if (state.step === 1 && !state.base) return message('Choose a base station or base file first');
      if (state.step === 2) {
        ensureJob();
        persistJob();
      }
      setStep(state.step + 1);
    });
    $('#postprocessDialog')?.addEventListener('click', (event) => {
      if (event.target === $('#postprocessDialog')) closeDialog();
    });

    const jobsDialog = $('#gnssJobsDialog');
    if (jobsDialog) {
      jobsDialog.addEventListener('click', (event) => {
        if (event.target === jobsDialog) return closeJobs();
        const open = event.target.closest('[data-job-open]');
        if (open) {
          state.jobsSelectedId = open.dataset.jobOpen;
          state.jobsDeleteConfirm = false;
          renderJobs();
          return;
        }
        if (event.target.closest('[data-job-back]')) {
          state.jobsSelectedId = null;
          state.jobsDeleteConfirm = false;
          renderJobs();
          return;
        }
        const job = savedJobs().find((item) => item.id === state.jobsSelectedId);
        if (event.target.closest('[data-job-report]')) {
          if (job) downloadJobReport(job);
          return;
        }
        if (event.target.closest('[data-job-copy]')) {
          if (job) copySavedJobCommand(job);
          return;
        }
        if (event.target.closest('[data-job-delete]')) {
          state.jobsDeleteConfirm = true;
          renderJobs();
          return;
        }
        if (event.target.closest('[data-job-delete-cancel]')) {
          state.jobsDeleteConfirm = false;
          renderJobs();
          return;
        }
        if (event.target.closest('[data-job-delete-confirm]')) {
          if (job) deleteSavedJob(job);
          return;
        }
        if (event.target.closest('[data-job-new]') || event.target.closest('#gnssJobsNew')) {
          startNewJob();
        }
      });
      $('#gnssJobsClose')?.addEventListener('click', closeJobs);
    }
  }

  function initialize() {
    if (!$('#postprocessDialog')) return;
    bindEvents();
    render();
  }

  window.northstarPostprocess = {
    open: openDialog,
    openJobs,
    close: closeDialog,
    parseRinex,
    parseNavigation,
    navCoverage,
    openWithRover,
    scanEpochs,
    parseCoordText,
    positionAtEpoch,
    validBasePosition,
    evaluateJob,
    buildRtkConfig,
    buildCommand,
    parseResult,
    downloadJobPackage,
    acceptResult,
    get state() { return state; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize);
  else initialize();
})();
