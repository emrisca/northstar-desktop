/*
 * RINEX observation reading and conversion.
 *
 * This module intentionally handles only the open RINEX formats. It reads
 * RINEX 2 and 3 observation records, reports what is in a file, converts to
 * RINEX 2.11 for older software, and exports an observation table or the
 * header's approximate marker position. It never claims to decode a closed
 * receiver format.
 */
(() => {
  'use strict';

  const HEADER_LABELS = [
    'RINEX VERSION / TYPE', 'PGM / RUN BY / DATE', 'MARKER NAME', 'MARKER NUMBER',
    'OBSERVER / AGENCY', 'REC # / TYPE / VERS', 'ANT # / TYPE', 'APPROX POSITION XYZ',
    'ANTENNA: DELTA H/E/N', 'INTERVAL', 'TIME OF FIRST OBS', 'TIME OF LAST OBS',
    '# / TYPES OF OBSERV', 'SYS / # / OBS TYPES', 'COMMENT', 'END OF HEADER'
  ];
  const SYSTEM = /^[GRECJSI]$/;

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

  function headerLine(body, label) {
    return String(body || '').padEnd(60).slice(0, 60) + label;
  }

  function dateFromParts(year, month, day, hour, minute, second) {
    const value = Date.UTC(+year, +month - 1, +day, +hour, +minute, Math.floor(+second), Math.round((+second % 1) * 1000));
    return Number.isFinite(value) ? value : null;
  }

  function partsFromMilliseconds(milliseconds) {
    const date = new Date(milliseconds);
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
      second: date.getUTCSeconds() + date.getUTCMilliseconds() / 1000
    };
  }

  function formatUtc(milliseconds, withTime) {
    if (!Number.isFinite(milliseconds)) return '';
    const date = new Date(milliseconds);
    const day = date.toISOString().slice(0, 10);
    return withTime ? day + 'T' + date.toISOString().slice(11, 19) + 'Z' : day;
  }

  function ecefToGeodetic(x, y, z) {
    if (![x, y, z].every(Number.isFinite)) return null;
    const a = 6378137.0;
    const f = 1 / 298.257223563;
    const e2 = f * (2 - f);
    const lon = Math.atan2(y, x);
    const p = Math.hypot(x, y);
    let lat = Math.atan2(z, p * (1 - e2));
    for (let index = 0; index < 8; index += 1) {
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

  function parseHeader(lines) {
    const header = {
      version: null,
      versionLabel: 'RINEX',
      fileType: '',
      system: '',
      markerName: '',
      markerNumber: '',
      observer: '',
      agency: '',
      receiverNumber: '',
      receiverType: '',
      receiverVersion: '',
      antennaNumber: '',
      antennaType: '',
      antennaDelta: { h: 0, e: 0, n: 0 },
      approx: null,
      interval: null,
      firstMs: null,
      lastMs: null,
      timeSystem: 'GPS',
      obsTypes: [],
      sysObs: {},
      comments: [],
      headerEnd: -1
    };

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line) continue;
      const label = splitHeaderLine(line);
      if (!label) {
        if (/END OF HEADER\s*$/i.test(line)) {
          header.headerEnd = index;
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
        header.receiverNumber = body.slice(0, 20).trim();
        header.receiverType = body.slice(20, 40).trim();
        header.receiverVersion = body.slice(40, 60).trim();
      } else if (label === 'ANT # / TYPE') {
        header.antennaNumber = body.slice(0, 20).trim();
        header.antennaType = body.slice(20, 40).trim();
      } else if (label === 'APPROX POSITION XYZ') {
        const values = body.trim().split(/\s+/).map(Number);
        if (values.length >= 3 && values.slice(0, 3).every(Number.isFinite)) {
          header.approx = {
            x: values[0],
            y: values[1],
            z: values[2],
            ...(ecefToGeodetic(values[0], values[1], values[2]) || {})
          };
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
        if (values.length >= 6) header.firstMs = dateFromParts(values[0], values[1], values[2], values[3], values[4], values[5]);
        header.timeSystem = body.slice(48, 51).trim() || 'GPS';
      } else if (label === 'TIME OF LAST OBS') {
        const values = body.trim().split(/\s+/);
        if (values.length >= 6) header.lastMs = dateFromParts(values[0], values[1], values[2], values[3], values[4], values[5]);
      } else if (label === '# / TYPES OF OBSERV') {
        const count = parseInt(body.slice(0, 6), 10);
        const types = body.slice(6).trim().split(/\s+/).filter(Boolean);
        header.obsTypes.push(...types);
        // RINEX 2 continuation lines repeat no label and begin with six blanks.
        if (Number.isFinite(count)) {
          while (header.obsTypes.length < count && index + 1 < lines.length) {
            index += 1;
            const extra = lines[index].slice(6).trim().split(/\s+/).filter(Boolean);
            header.obsTypes.push(...extra);
          }
        }
      } else if (label === 'SYS / # / OBS TYPES') {
        const system = body.slice(0, 1).trim().toUpperCase();
        if (SYSTEM.test(system)) {
          const types = body.slice(7).trim().split(/\s+/).filter((item) => /^[A-Z]/.test(item));
          header.sysObs[system] = (header.sysObs[system] || []).concat(types);
        }
      } else if (label === 'COMMENT') {
        if (header.comments.length < 12) header.comments.push(body.trim());
      }
      if (label === 'END OF HEADER') {
        header.headerEnd = index;
        break;
      }
    }

    header.obsTypes = Array.from(new Set(header.obsTypes));
    const union = header.obsTypes.concat(...Object.values(header.sysObs));
    header.obsTypes = Array.from(new Set(union));
    return header;
  }

  function parseSatelliteIds(text, limit) {
    const source = String(text || '');
    const prefixed = source.match(/[GRECJSI]\d{2}/g);
    if (prefixed) return prefixed.slice(0, limit || prefixed.length);
    // RINEX 2 may write bare two-digit GPS PRNs, sometimes space padded.
    const spaced = source.match(/(?:^|\s)(\d{1,2})(?=\s|$)/g);
    if (spaced) {
      return spaced.slice(0, limit || spaced.length).map((id) => 'G' + id.trim().padStart(2, '0'));
    }
    return [];
  }

  function field16(value) {
    return String(value || '').padEnd(16).slice(0, 16);
  }

  // Real RINEX observation values are 16 columns wide. Some small exports,
  // including test fixtures, trim the padding instead. Accept fixed columns
  // when they are present and fall back to whitespace when they are not.
  function outputField(value) {
    const text = String(value == null ? '' : value);
    if (text.length === 16 && /^\s/.test(text)) return text;
    const trimmed = text.replace(/\s+$/, '');
    if (trimmed.length >= 16) return trimmed.slice(0, 16);
    if (trimmed.length === 0) return ' '.repeat(16);
    return trimmed.padStart(14).slice(-14).padEnd(16);
  }

  function splitFields(text, needed) {
    const source = String(text || '');
    if (source.length >= needed * 16) {
      const fixed = [];
      for (let index = 0; index < needed; index += 1) fixed.push(field16(source.slice(index * 16, index * 16 + 16)));
      return fixed;
    }
    const tokens = source.trim() ? source.trim().split(/\s+/) : [];
    const output = tokens.slice(0, needed).map(field16);
    while (output.length < needed) output.push(field16(''));
    return output;
  }

  function parseV3Epochs(lines, header, warnings) {
    const epochs = [];
    const systems = new Set();
    const satellites = new Set();
    let skipped = 0;
    let index = header.headerEnd + 1;
    while (index < lines.length) {
      const line = lines[index];
      if (!line || !line.startsWith('>')) {
        index += 1;
        continue;
      }
      const fields = line.slice(1).trim().split(/\s+/);
      const time = fields.length >= 6 ? dateFromParts(fields[0], fields[1], fields[2], fields[3], fields[4], fields[5]) : null;
      const flag = parseInt(fields[6], 10) || 0;
      const count = parseInt(fields[7], 10) || 0;
      index += 1;
      if (!time) continue;
      if (flag === 0 || flag === 1) {
        const records = [];
        for (let satellite = 0; satellite < count; satellite += 1) {
          const first = lines[index] || '';
          const id = first.slice(0, 3).trim().toUpperCase();
          if (!/^[GRECJSI]\d{2}$/.test(id)) break;
          const system = id[0];
          const codes = header.sysObs[system] || header.obsTypes;
          const needed = Math.max(1, codes.length);
          const chunks = [first.slice(3)];
          index += 1;
          while (chunks.join('').length < needed * 16) {
            const next = lines[index];
            if (next == null || next.startsWith('>') || /^[GRECJSI]\d{2}/.test(next)) break;
            chunks.push(next.startsWith('   ') ? next.slice(3) : next);
            index += 1;
          }
          const values = splitFields(chunks.join(''), needed);
          records.push({ id, system, codes, fields: values });
          systems.add(system);
          satellites.add(id);
        }
        if (records.length) epochs.push({ ms: time, flag, records });
      } else {
        skipped += 1;
        index += Math.max(1, count);
      }
    }
    if (skipped) warnings.push(skipped + ' special-event epoch block' + (skipped === 1 ? '' : 's') + ' were skipped; they do not contain ordinary satellite observations.');
    return { epochs, systems: Array.from(systems), satellites: Array.from(satellites) };
  }

  function parseV2Epochs(lines, header, warnings) {
    const epochs = [];
    const systems = new Set();
    const satellites = new Set();
    const types = header.obsTypes.length ? header.obsTypes : ['C1'];
    const observationLines = Math.max(1, Math.ceil(types.length / 5));
    const epochPattern = /^\s*(\d{2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2}(?:\.\d+)?)\s+([0-6])\s+(\d{1,2})(.*)$/;
    let skipped = 0;
    let index = header.headerEnd + 1;
    while (index < lines.length) {
      const line = lines[index];
      const match = line.match(epochPattern);
      if (!match) {
        index += 1;
        continue;
      }
      const year = +match[1] < 80 ? 2000 + +match[1] : 1900 + +match[1];
      const time = dateFromParts(year, match[2], match[3], match[4], match[5], match[6]);
      const flag = parseInt(match[7], 10) || 0;
      const count = parseInt(match[8], 10) || 0;
      let ids = parseSatelliteIds(match[9], count);
      let next = index + 1;
      while (ids.length < count && next < lines.length) {
        const continuation = parseSatelliteIds(lines[next], count - ids.length);
        if (!continuation.length) break;
        ids = ids.concat(continuation);
        next += 1;
      }
      index = next;
      if (!time) continue;
      if (flag === 0 || flag === 1) {
        const records = [];
        for (let satellite = 0; satellite < Math.min(count, ids.length); satellite += 1) {
          const id = ids[satellite];
          const system = id[0];
          const chunks = [];
          for (let lineIndex = 0; lineIndex < observationLines; lineIndex += 1) {
            const observationLine = lines[index] || '';
            chunks.push(lineIndex === 0 || observationLine.startsWith('   ') ? observationLine.slice(3) : observationLine);
            index += 1;
          }
          const values = splitFields(chunks.join(''), types.length);
          records.push({ id, system, codes: types.slice(), fields: values });
          systems.add(system);
          satellites.add(id);
        }
        if (records.length) epochs.push({ ms: time, flag, records });
      } else {
        skipped += 1;
        index += Math.max(1, count);
      }
    }
    if (skipped) warnings.push(skipped + ' special-event epoch block' + (skipped === 1 ? '' : 's') + ' were skipped; they do not contain ordinary satellite observations.');
    return { epochs, systems: Array.from(systems), satellites: Array.from(satellites) };
  }

  function parse(text, fileName) {
    const source = String(text || '');
    if (!source.trim()) return { ok: false, error: { title: 'The file is empty', message: 'Choose the observation file exported by the receiver.' } };
    if (/CRINEX VERS\s*\/\s*TYPE/i.test(source)) {
      return { ok: false, error: { title: 'This is Hatanaka-compressed RINEX', message: 'Decompress it with CRX2RNX, then open the resulting .rnx or .obs file.' } };
    }
    const lines = source.split(/\r?\n/);
    const header = parseHeader(lines);
    if (header.headerEnd < 0) {
      return { ok: false, error: { title: 'No RINEX header was found', message: 'The file does not contain END OF HEADER, so it is not a complete RINEX observation file.' } };
    }
    if (header.fileType && header.fileType !== 'O') {
      return { ok: false, error: { title: 'This is not an observation file', message: 'The file is RINEX type ' + header.fileType + '. Open it in the converter for navigation or identify it here.' } };
    }
    if (!header.version || header.version < 2) {
      return { ok: false, error: { title: 'Unsupported RINEX version', message: 'Northstar reads RINEX 2 and 3 observation files.' } };
    }
    const warnings = [];
    const observed = (header.version >= 3 ? parseV3Epochs : parseV2Epochs)(lines, header, warnings);
    if (!observed.epochs.length) {
      return { ok: false, error: { title: 'No observation epochs were found', message: 'The header is readable, but the observation records are missing or use an unsupported event layout.' } };
    }
    const firstMs = header.firstMs || observed.epochs[0].ms;
    const lastMs = header.lastMs || observed.epochs[observed.epochs.length - 1].ms;
    const systems = observed.systems.length ? observed.systems : Object.keys(header.sysObs);
    return {
      ok: true,
      name: fileName || 'observation',
      size: source.length,
      versionLabel: header.versionLabel,
      timeSystem: header.timeSystem,
      header,
      epochs: observed.epochs,
      satelliteIds: observed.satellites.sort(),
      systems: systems.sort(),
      firstMs,
      lastMs,
      duration: (lastMs - firstMs) / 1000,
      epochCount: observed.epochs.length,
      warnings,
      text: source
    };
  }

  function v2Code(code) {
    return String(code || '').slice(0, 2);
  }

  function uniqueV2Codes(header) {
    const output = [];
    const seen = new Set();
    header.obsTypes.forEach((code) => {
      const short = v2Code(code);
      if (short && !seen.has(short)) {
        seen.add(short);
        output.push(short);
      }
    });
    return output;
  }

  function timeLine(milliseconds, timeSystem) {
    const parts = partsFromMilliseconds(milliseconds);
    const seconds = parts.second.toFixed(7).padStart(13);
    return String(parts.year).padStart(6) + String(parts.month).padStart(6) + String(parts.day).padStart(6)
      + String(parts.hour).padStart(6) + String(parts.minute).padStart(6) + seconds + '     ' + (timeSystem || 'GPS');
  }

  function toRinex2(parsed) {
    if (!parsed || !parsed.ok) return { ok: false, error: parsed && parsed.error ? parsed.error : { title: 'No observation file', message: 'Open an observation file first.' } };
    if (parsed.header.version < 3) {
      return { ok: false, error: { title: 'Already RINEX 2', message: 'This file is already RINEX 2. Convert it to CSV or GeoJSON, or use it directly in post-processing.' } };
    }
    const codes = uniqueV2Codes(parsed.header);
    if (!codes.length) return { ok: false, error: { title: 'No observation types', message: 'The RINEX header does not list any observation codes.' } };
    const warnings = [
      'RINEX 2 groups signal codes by two characters (C1, L1, C2, L2). RINEX 3 attributes are lost, so keep the original file for archive use.'
    ];
    const collisions = new Map();
    parsed.header.obsTypes.forEach((code) => {
      const short = v2Code(code);
      if (!short) return;
      if (!collisions.has(short)) collisions.set(short, new Set());
      collisions.get(short).add(code);
    });
    const conflicted = Array.from(collisions.entries()).filter(([, set]) => set.size > 1);
    if (conflicted.length) {
      warnings.push('Some RINEX 3 codes share a RINEX 2 name (' + conflicted.map(([short, set]) => short + ': ' + Array.from(set).join('/')).join(', ') + '). The first signal is kept.');
    }
    const header = parsed.header;
    const lines = [];
    lines.push(headerLine('     2.11           OBSERVATION DATA    M', 'RINEX VERSION / TYPE'));
    const stamp = formatUtc(Date.now(), true).replace('T', ' ').replace('Z', '');
    lines.push(headerLine(('Northstar'.padEnd(20) + 'Northstar'.padEnd(20) + stamp).slice(0, 60), 'PGM / RUN BY / DATE'));
    if (header.markerName) lines.push(headerLine(header.markerName.slice(0, 60), 'MARKER NAME'));
    if (header.markerNumber) lines.push(headerLine(header.markerNumber.slice(0, 60), 'MARKER NUMBER'));
    if (header.observer || header.agency) {
      lines.push(headerLine((header.observer || '').slice(0, 20).padEnd(20) + (header.agency || '').slice(0, 40).padEnd(40), 'OBSERVER / AGENCY'));
    }
    if (header.receiverNumber || header.receiverType || header.receiverVersion) {
      lines.push(headerLine((header.receiverNumber || '').slice(0, 20).padEnd(20) + (header.receiverType || '').slice(0, 20).padEnd(20) + (header.receiverVersion || '').slice(0, 20), 'REC # / TYPE / VERS'));
    }
    if (header.antennaNumber || header.antennaType) {
      lines.push(headerLine((header.antennaNumber || '').slice(0, 20).padEnd(20) + (header.antennaType || '').slice(0, 40).padEnd(40), 'ANT # / TYPE'));
    }
    if (header.approx) {
      lines.push(headerLine([header.approx.x, header.approx.y, header.approx.z].map((value) => value.toFixed(4).padStart(14)).join(''), 'APPROX POSITION XYZ'));
    }
    if (header.antennaDelta) {
      const delta = header.antennaDelta;
      lines.push(headerLine([delta.h, delta.e, delta.n].map((value) => Number(value).toFixed(4).padStart(14)).join(''), 'ANTENNA: DELTA H/E/N'));
    }
    const chunks = [];
    for (let index = 0; index < codes.length; index += 9) chunks.push(codes.slice(index, index + 9));
    chunks.forEach((chunk, index) => {
      const prefix = index === 0 ? String(codes.length).padEnd(6) : ' '.repeat(6);
      lines.push(headerLine(prefix + chunk.map((code) => code.padEnd(6)).join(''), '# / TYPES OF OBSERV'));
    });
    if (header.interval) lines.push(headerLine('    ' + header.interval.toFixed(4).padStart(10), 'INTERVAL'));
    lines.push(headerLine(timeLine(parsed.firstMs, header.timeSystem), 'TIME OF FIRST OBS'));
    lines.push(headerLine(timeLine(parsed.lastMs, header.timeSystem), 'TIME OF LAST OBS'));
    header.comments.forEach((comment) => lines.push(headerLine(comment.slice(0, 60), 'COMMENT')));
    lines.push(headerLine('', 'END OF HEADER'));

    parsed.epochs.forEach((epoch) => {
      const date = partsFromMilliseconds(epoch.ms);
      const ids = epoch.records.map((record) => record.id);
      const base = String(date.year % 100).padStart(3) + String(date.month).padStart(3) + String(date.day).padStart(3)
        + String(date.hour).padStart(3) + String(date.minute).padStart(3) + date.second.toFixed(7).padStart(11)
        + '  ' + epoch.flag + String(ids.length).padStart(3);
      const first = ids.slice(0, 12).join('');
      lines.push(base + first);
      for (let index = 12; index < ids.length; index += 12) {
        lines.push(' '.repeat(32) + ids.slice(index, index + 12).join(''));
      }
      epoch.records.forEach((record) => {
        const values = codes.map((code) => {
          const fieldIndex = record.codes.findIndex((source) => v2Code(source) === code);
          return outputField(fieldIndex >= 0 ? record.fields[fieldIndex] : '');
        });
        for (let index = 0; index < values.length; index += 5) {
          const prefix = index === 0 ? record.id.padEnd(3) : '   ';
          lines.push(prefix + values.slice(index, index + 5).join(''));
        }
      });
    });
    return { ok: true, text: lines.join('\n') + '\n', warnings, codeCount: codes.length, epochCount: parsed.epochs.length };
  }

  function csvCell(value) {
    const text = String(value == null ? '' : value);
    return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }

  function toCsv(parsed) {
    if (!parsed || !parsed.ok) return { ok: false, error: parsed && parsed.error ? parsed.error : { title: 'No observation file', message: 'Open an observation file first.' } };
    const columns = [];
    const seen = new Set();
    parsed.epochs.forEach((epoch) => epoch.records.forEach((record) => {
      record.codes.forEach((code) => {
        const key = record.id + ':' + code;
        if (!seen.has(key)) {
          seen.add(key);
          columns.push({ key, id: record.id, code });
        }
      });
    }));
    const rows = [['epoch_utc', 'epoch_flag', 'satellite_count'].concat(columns.map((column) => column.id + '_' + column.code)).map(csvCell).join(',')];
    parsed.epochs.forEach((epoch) => {
      const values = new Map();
      epoch.records.forEach((record) => record.codes.forEach((code, index) => values.set(record.id + ':' + code, record.fields[index].slice(0, 14).trim())));
      rows.push([formatUtc(epoch.ms, true), epoch.flag, epoch.records.length].concat(columns.map((column) => values.get(column.key) || '')).map(csvCell).join(','));
    });
    return { ok: true, text: rows.join('\r\n') + '\r\n', rows: rows.length, columns: columns.length };
  }

  function toGeoJson(parsed) {
    if (!parsed || !parsed.ok) return { ok: false, error: parsed && parsed.error ? parsed.error : { title: 'No observation file', message: 'Open an observation file first.' } };
    const approx = parsed.header.approx;
    if (!approx || !Number.isFinite(approx.lat) || !Number.isFinite(approx.lon)) {
      return { ok: false, error: { title: 'No approximate position', message: 'This RINEX header does not include APPROX POSITION XYZ, so there is no marker point to export.' } };
    }
    const properties = {
      name: parsed.header.markerName || parsed.name,
      marker_name: parsed.header.markerName,
      marker_number: parsed.header.markerNumber,
      source_file: parsed.name,
      rinex_version: parsed.header.version,
      first_observation_utc: formatUtc(parsed.firstMs, true),
      last_observation_utc: formatUtc(parsed.lastMs, true),
      epoch_count: parsed.epochCount,
      systems: parsed.systems.join(' '),
      observation_types: parsed.header.obsTypes.join(' '),
      receiver: [parsed.header.receiverNumber, parsed.header.receiverType, parsed.header.receiverVersion].filter(Boolean).join(' '),
      antenna: [parsed.header.antennaNumber, parsed.header.antennaType].filter(Boolean).join(' '),
      ellipsoid_height_m: Number.isFinite(approx.height) ? +approx.height.toFixed(3) : null,
      note: 'Approximate marker position from the RINEX header, not a corrected survey coordinate.'
    };
    return {
      ok: true,
      text: JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [+approx.lon.toFixed(9), +approx.lat.toFixed(9)] }, properties }] }, null, 2) + '\n'
    };
  }

  window.northstarRinex = {
    parse,
    toRinex2,
    toCsv,
    toGeoJson,
    headerLine,
    formatUtc
  };
})();
