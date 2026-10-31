// Convert GNSS files — receiver-independent intake, validation and export.
// RINEX text is checked in the browser. Supported binary logs can be handed to
// the local Python backend, which runs RTKLIB convbin and returns RINEX 3.03.
// Closed formats are identified and rejected; their bytes are never guessed.
(function () {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const NAV_TYPES = {
    N: 'GPS',
    G: 'GLONASS',
    H: 'Galileo',
    J: 'QZSS',
    L: 'SBAS',
    C: 'BeiDou',
    S: 'SBAS'
  };
  const MAX_BYTES = 100 * 1024 * 1024;
  const LOCAL_MAX_BYTES = 48 * 1024 * 1024;
  const RAW_FORMATS = [
    ['ubx', 'UBX raw'],
    ['sbf', 'SBF raw'],
    ['rt17', 'RT17 raw'],
    ['nov', 'OEM4/6/7 raw'],
    ['oem3', 'OEM3 raw'],
    ['rtcm3', 'RTCM 3 raw'],
    ['rtcm2', 'RTCM 2 raw'],
    ['binex', 'BINEX raw'],
    ['javad', 'GREIS raw'],
    ['hemis', 'BIN raw'],
    ['stq', 'STQ raw'],
    ['nvs', 'BINR raw'],
    ['ss2', 'SS2 raw']
  ];
  const RAW_FORMAT_LABELS = RAW_FORMATS.reduce((map, pair) => {
    map[pair[0]] = pair[1];
    return map;
  }, {});
  const RAW_EXTENSIONS = {
    '.ubx': 'ubx',
    '.sbf': 'sbf',
    '.rt17': 'rt17',
    '.gps': 'nov',
    '.oem4': 'nov',
    '.oem6': 'nov',
    '.oem7': 'nov',
    '.oem3': 'oem3',
    '.rtcm2': 'rtcm2',
    '.rtcm3': 'rtcm3',
    '.bnx': 'binex',
    '.binex': 'binex',
    '.jps': 'javad',
    '.stq': 'stq',
    '.nvs': 'nvs',
    '.log': 'ss2',
    '.ss2': 'ss2'
  };
  const CLOSED_FORMATS = { '.ssf': 'SSF' };

  const state = {
    file: null,
    name: '',
    text: '',
    bytes: null,
    compressed: false,
    binary: false,
    kind: '',
    parsed: null,
    rinex: null,
    info: null,
    error: null,
    exportInfo: null,
    converted: null,
    target: 'rinex2',
    busy: false,
    local: {
      checked: false,
      checking: false,
      ready: false,
      version: '',
      error: '',
      busy: false,
      convertError: '',
      format: '',
      closed: '',
      tooLarge: false,
      token: 0
    }
  };

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[character]));
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '—';
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
    return Math.round(bytes) + ' B';
  }

  function formatDate(milliseconds, withTime) {
    if (!Number.isFinite(milliseconds)) return '—';
    const date = new Date(milliseconds);
    if (!Number.isFinite(date.getTime())) return '—';
    const day = date.toISOString().slice(0, 10);
    return withTime ? day + ' ' + date.toISOString().slice(11, 19) : day;
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '—';
    if (seconds < 60) return Math.round(seconds) + ' s';
    if (seconds < 3600) return Math.round(seconds / 60) + ' min';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.round((seconds - hours * 3600) / 60);
    return hours + ' h' + (minutes ? ' ' + minutes + ' min' : '');
  }

  function isBinary(bytes) {
    const length = Math.min(bytes.length, 8192);
    let control = 0;
    for (let index = 0; index < length; index += 1) {
      const value = bytes[index];
      if (value === 0) return true;
      if (value < 9 || (value > 13 && value < 32)) control += 1;
    }
    return length > 0 && control / length > 0.08;
  }

  function rawFormatForName(name) {
    const match = String(name || '').toLowerCase().match(/\.[^.]+$/);
    return match ? RAW_EXTENSIONS[match[0]] || '' : '';
  }

  function closedFormatForName(name) {
    const match = String(name || '').toLowerCase().match(/\.[^.]+$/);
    return match ? CLOSED_FORMATS[match[0]] || '' : '';
  }

  function resetLocalState() {
    const token = (state.local && state.local.token || 0) + 1;
    state.local = {
      checked: false,
      checking: false,
      ready: false,
      version: '',
      error: '',
      busy: false,
      convertError: '',
      format: '',
      closed: '',
      tooLarge: false,
      token
    };
  }

  function prepareLocalConversion() {
    state.local.format = rawFormatForName(state.name);
    state.local.closed = closedFormatForName(state.name);
    const size = state.bytes ? state.bytes.length : (state.file ? state.file.size : 0);
    state.local.tooLarge = size > LOCAL_MAX_BYTES;
    if (!state.local.closed && !state.local.tooLarge) void checkLocalConverter(false);
  }

  function loadConverterStatus() {
    return fetch('/api/preflight?noaa=0', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('The desktop backend did not answer the converter check.');
        const report = await response.json();
        const binaries = report && report.rtklib && report.rtklib.binaries ? report.rtklib.binaries : {};
        const convbin = binaries.convbin || {};
        return {
          ready: !!convbin.found,
          version: (report && report.rtklib && report.rtklib.release) || convbin.version || '',
          error: ''
        };
      })
      .catch(() => ({
        ready: false,
        version: '',
        error: 'The desktop converter is not available in this build.'
      }));
  }

  function checkLocalConverter(force) {
    if (!state.local || state.local.closed || state.local.checking) return;
    if (!force && state.local.checked) return;
    state.local.checking = true;
    state.local.error = '';
    render();
    loadConverterStatus().then((info) => {
      if (!state.local) return;
      state.local.checked = true;
      state.local.checking = false;
      state.local.ready = !!info.ready;
      state.local.version = info.version || '';
      state.local.error = info.error || '';
      if (state.binary && state.kind === 'proprietary') render();
    });
  }

  async function decompressGzip(bytes) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('This browser cannot open .gz files. Decompress the file first, then drop the RINEX file.');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function baseName(name) {
    return String(name || 'northstar')
      .replace(/\.gz$/i, '')
      .replace(/\.[^.]+$/, '')
      .replace(/[^A-Za-z0-9._-]+/g, '_') || 'northstar';
  }

  function outputName(extension) {
    return baseName(state.name) + '.' + extension;
  }

  function rinexVersion(text) {
    const line = text.split(/\r?\n/).slice(0, 20).find((item) => /RINEX VERSION\s*\/\s*TYPE/i.test(item));
    if (!line) return null;
    const body = line.slice(0, 60);
    const version = parseFloat(body.slice(0, 9));
    let type = body.slice(20, 21).trim().toUpperCase();
    if (!type) {
      if (/OBSERVATION DATA/i.test(line)) type = 'O';
      else if (/NAVIGATION DATA/i.test(line)) type = 'N';
    }
    return { version: Number.isFinite(version) ? version : null, type };
  }

  function fileKind(name, text, bytes) {
    if (!text.trim()) return { kind: 'empty' };
    if (/CRINEX VERS\s*\/\s*TYPE/i.test(text)) return { kind: 'hatanaka' };

    const header = rinexVersion(text);
    if (header) {
      if (header.type === 'O') {
        const parsed = window.northstarPostprocess
          ? window.northstarPostprocess.parseRinex(text, state.name)
          : null;
        const full = window.northstarRinex ? window.northstarRinex.parse(text, state.name) : null;
        if (parsed && parsed.ok) return { kind: 'observation', parsed, rinex: full && full.ok ? full : null };
        return {
          kind: 'rinex-error',
          error: parsed && parsed.error ? parsed.error : {
            title: 'Could not read the RINEX observation file',
            message: 'The header was found, but the observation records could not be read. Check that the file is complete and ends with ordinary RINEX records.'
          }
        };
      }
      if (Object.prototype.hasOwnProperty.call(NAV_TYPES, header.type)) {
        return { kind: 'navigation', version: header.version, navType: header.type };
      }
      return {
        kind: 'rinex-error',
        error: {
          title: 'Unsupported RINEX file type',
          message: 'Northstar reads observation (type O) and navigation (type N, G, H, J, L, C or S) files. This file is type ' + (header.type || 'unknown') + '.'
        }
      };
    }

    if (/^\s*%/m.test(text) && /program/i.test(text)) return { kind: 'solution' };
    if (bytes && isBinary(bytes)) return { kind: 'proprietary', binary: true };
    return { kind: 'proprietary', binary: false };
  }

  function detect() {
    if (state.binary) {
      state.kind = 'proprietary';
      state.parsed = null;
      state.info = null;
      state.error = null;
      return;
    }
    const result = fileKind(state.name, state.text, state.bytes);
    state.kind = result.kind;
    state.parsed = result.parsed || null;
    state.rinex = result.rinex || null;
    state.info = result.kind === 'navigation' ? { version: result.version, navType: result.navType } : null;
    state.error = result.error || null;
    state.binary = !!result.binary;
  }

  async function handleFile(file) {
    if (!file) return;
    resetLocalState();
    state.file = file;
    state.name = file.name;
    state.text = '';
    state.bytes = null;
    state.compressed = false;
    state.binary = false;
    state.kind = '';
    state.parsed = null;
    state.rinex = null;
    state.info = null;
    state.error = null;
    state.exportInfo = null;
    state.converted = null;
    if (file.size > MAX_BYTES) {
      state.error = {
        title: 'This file is too large to check here',
        message: 'The limit is 100 MB. Split the session or use a smaller export.'
      };
      state.kind = 'error';
      render();
      return;
    }
    state.busy = true;
    render();
    try {
      let bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
        bytes = await decompressGzip(bytes);
        if (bytes.length > MAX_BYTES) throw new Error('The decompressed file is larger than the 100 MB limit.');
        state.compressed = true;
        state.name = state.name.replace(/\.gz$/i, '');
      }
      state.bytes = bytes;
      state.binary = isBinary(bytes);
      state.text = state.binary ? '' : new TextDecoder('utf-8').decode(bytes);
      detect();
      if (state.binary && state.kind === 'proprietary') prepareLocalConversion();
    } catch (error) {
      state.kind = 'error';
      state.error = {
        title: 'Could not read this file',
        message: error && error.message ? error.message : 'The browser could not open this file.'
      };
    } finally {
      state.busy = false;
      render();
    }
  }

  function errorHtml(error) {
    if (!error) return '';
    return '<div class="pp-note error"><b>' + esc(error.title || 'Could not read this file') + '</b><br>' + esc(error.message || '') + '</div>';
  }

  function fileRow() {
    return '<div class="convert-file"><span class="convert-file-icon material-symbols">description</span><div class="convert-file-copy"><b>' + esc(state.name)
      + '</b><small>' + esc(formatBytes(state.converted ? state.text.length : (state.file ? state.file.size : (state.text ? state.text.length : 0))))
      + (state.compressed ? ' · decompressed from .gz' : '') + '</small></div>'
      + '<span class="pp-chip ' + (state.kind === 'observation' || state.kind === 'navigation' ? 'ok' : state.kind === 'error' || state.kind === 'rinex-error' ? 'fail' : 'warn') + '">'
      + esc(state.kind === 'observation' ? 'Observation' : state.kind === 'navigation' ? 'Navigation' : state.kind === 'hatanaka' ? 'Hatanaka' : state.binary ? 'Binary log' : 'Not RINEX') + '</span></div>';
  }

  function observationCard() {
    const parsed = state.parsed;
    if (!parsed) return '';
    const rows = [
      ['Format', parsed.versionLabel + (parsed.timeSystem ? ' · ' + parsed.timeSystem : '')],
      ['Marker', parsed.markerName || '—'],
      ['Window', formatDate(parsed.firstMs, true) + ' to ' + formatDate(parsed.lastMs, true)],
      ['Duration', formatDuration(parsed.duration)],
      ['Epochs', String(parsed.epochCount)],
      ['Interval', parsed.interval ? parsed.interval.toFixed(0) + ' s' : 'not stated'],
      ['Constellations', parsed.systems.length ? parsed.systems.join(', ') : 'not stated'],
      ['Carrier phase', parsed.hasPhase ? 'present' : 'not found'],
      ['L2', parsed.hasL2 ? 'present' : 'not found'],
      ['Antenna', parsed.antenna || '—']
    ];
    return '<div class="pp-card"><div class="pp-card-head"><div><b>RINEX observation file</b><small>Ready to use as the rover</small></div><span class="pp-chip ok">Observation</span></div><div class="pp-card-body">'
      + '<div class="pp-grid">' + rows.map(([label, value]) => '<div class="pp-row"><span>' + esc(label) + '</span><b>' + esc(value) + '</b></div>').join('') + '</div>'
      + (parsed.warnings && parsed.warnings.length ? '<div class="pp-note warn">' + parsed.warnings.map(esc).join('<br>') + '</div>' : '')
      + '<div class="convert-actions"><button class="primary-button" type="button" data-convert-action="use-rover">Use as rover</button><button class="secondary-button" type="button" data-convert-action="download">Download .obs</button></div>'
      + '</div></div>'
      + '<div class="pp-note"><b>No base station?</b> You do not need to own one. Continue to post-processing and use the free NOAA CORS search to find a station near this session.</div>';
  }

  function conversionCard() {
    const rinex = state.rinex;
    if (!rinex) return '';
    const targets = [];
    if (rinex.header.version >= 3) targets.push(['rinex2', 'RINEX 2.11 observation', '.obs']);
    targets.push(['csv', 'Observation table', '.csv']);
    if (rinex.header.approx && Number.isFinite(rinex.header.approx.lat)) targets.push(['geojson', 'Marker point', '.geojson']);
    const selected = targets.some(([value]) => value === state.target) ? state.target : targets[0][0];
    state.target = selected;
    const exported = state.exportInfo
      ? '<div class="pp-note ok"><b>' + esc(state.exportInfo.name) + ' ready.</b> ' + esc(state.exportInfo.detail) + (state.exportInfo.warnings || []).map((warning) => '<br>' + esc(warning)).join('') + '</div>'
      : '';
    return '<div class="pp-card convert-card"><div class="pp-card-head"><div><b>Convert this file</b><small>Choose a target, then download the result. Everything happens on this computer.</small></div><span class="pp-chip ok">Local</span></div><div class="pp-card-body">'
      + '<div class="convert-target-row"><label for="convertTarget">Convert to</label><select id="convertTarget">'
      + targets.map(([value, label, extension]) => '<option value="' + value + '"' + (value === selected ? ' selected' : '') + '>' + esc(label) + ' · ' + extension + '</option>').join('')
      + '</select><button class="primary-button" type="button" data-convert-action="download-target">Convert and download</button></div>'
      + '<p class="convert-target-hint">' + (selected === 'rinex2'
        ? 'RINEX 2.11 works with older survey and correction software. Signal attributes that RINEX 2 cannot store are dropped; keep the original as the archive copy.'
        : selected === 'csv'
          ? 'One row per epoch, one column per satellite observation. Useful for spreadsheets, charts and a quick record of the session.'
          : 'A single point at the approximate marker position in the header. This is a reference position, not a corrected survey coordinate.') + '</p>'
      + exported
      + '<div class="convert-inline-actions"><button class="secondary-button" type="button" data-convert-action="inspect">Open in RINEX inspector</button><button class="secondary-button" type="button" data-convert-action="download">Download original .obs</button></div>'
      + '</div></div>';
  }

  function navigationCard() {
    const info = state.info || {};
    const label = NAV_TYPES[info.navType] || 'GNSS';
    return '<div class="pp-card"><div class="pp-card-head"><div><b>RINEX navigation file</b><small>Ephemerides for ' + esc(label) + '</small></div><span class="pp-chip ok">Navigation</span></div><div class="pp-card-body">'
      + '<div class="pp-grid"><div class="pp-row"><span>Format</span><b>RINEX ' + esc(info.version || '—') + '</b></div><div class="pp-row"><span>System</span><b>' + esc(label) + '</b></div><div class="pp-row"><span>File type</span><b>' + esc(info.navType || '—') + '</b></div></div>'
      + '<div class="convert-actions"><button class="primary-button" type="button" data-convert-action="download">Download .nav</button></div>'
      + '</div></div>'
      + '<div class="pp-note">Navigation data is not a rover observation. Add it in <b>Step 2 · Base</b> after the observation file is loaded. If you use the free NOAA base search, the matching navigation data and precise orbit are downloaded automatically.</div>';
  }

  function formatChipsHtml() {
    return '<div class="convert-format" aria-label="Raw formats supported by RTKLIB convbin">'
      + RAW_FORMATS.map((pair) => '<span>' + esc(pair[1]) + '</span>').join('')
      + '</div>';
  }

  function convertedBanner() {
    const converted = state.converted;
    if (!converted) return '';
    const nav = Array.isArray(converted.nav) ? converted.nav : [];
    const navHtml = nav.length
      ? '<div class="convert-nav-files">' + nav.map((file, index) => '<button class="secondary-button" type="button" data-convert-action="download-nav" data-nav-index="' + index + '"><span class="material-symbols" aria-hidden="true">download</span> ' + esc(file.name) + '</button>').join('') + '</div>'
      : '<p class="convert-target-hint">No navigation file was produced. That is normal when the log has no broadcast ephemeris; the base step can supply navigation data.</p>';
    return '<div class="pp-note ok"><b>Converted locally with RTKLIB convbin.</b> '
      + esc(converted.source) + ' → ' + esc(state.name)
      + ' · ' + esc(converted.format)
      + (converted.elapsedMs ? ' · ' + converted.elapsedMs + ' ms' : '')
      + '</div>' + navHtml;
  }

  function localStatusHtml() {
    const local = state.local;
    if (local.checking) {
      return '<span class="pp-chip">Checking</span><span>Looking for RTKLIB convbin on this computer…</span>';
    }
    if (local.error) {
      return '<span class="pp-chip warn">Local server needed</span><span>' + esc(local.error) + '</span>';
    }
    if (!local.checked) {
      return '<span class="pp-chip">Waiting</span><span>The local converter has not been checked yet.</span>';
    }
    if (!local.ready) {
      return '<span class="pp-chip warn">Setup needed</span><span>RTKLIB convbin was not found. Open the readiness check and install RTKLIB — or use the receiver\'s own RINEX export.</span>';
    }
    return '<span class="pp-chip ok">convbin ready</span><span>RTKLIB '
      + esc(local.version || 'convbin') + ' will run locally. Nothing leaves this computer.</span>';
  }

  function localConversionCard() {
    const local = state.local;
    const disabled = local.busy || !local.ready || local.tooLarge;
    const options = '<option value="">Auto-detect from the file</option>'
      + RAW_FORMATS.map((pair) => '<option value="' + pair[0] + '"' + (pair[0] === local.format ? ' selected' : '') + '>' + esc(pair[1]) + '</option>').join('');
    const setupActions = local.checked && !local.ready && !local.checking
      ? '<div class="convert-inline-actions"><button class="secondary-button" type="button" data-convert-action="check-converter">Check again</button><button class="secondary-button" type="button" data-convert-action="open-postprocess">Open readiness check</button></div>'
      : '';
    const sizeNote = local.tooLarge
      ? '<div class="pp-note warn"><b>Too large for local conversion.</b> The limit is 48 MB. Shorten the session or use the receiver\'s office software to export RINEX.</div>'
      : '';
    const error = local.convertError
      ? '<div class="pp-note error"><b>Could not convert this file.</b><br>' + esc(local.convertError).replace(/\n/g, '<br>') + '</div>'
      : '';
    return '<div class="pp-card convert-local"><div class="pp-card-head"><div><b>Convert this binary log to RINEX</b><small>RTKLIB convbin runs on this computer; nothing leaves this computer.</small></div><span class="pp-chip ' + (local.ready ? 'ok' : 'warn') + '">' + (local.ready ? 'Local' : 'Setup') + '</span></div><div class="pp-card-body">'
      + '<p class="pp-copy">RTKLIB can read several published receiver logs and write RINEX 3.03 observations and navigation. It reads only formats it knows; closed formats are never guessed.</p>'
      + '<div class="convert-local-status">' + localStatusHtml() + '</div>'
      + sizeNote
      + '<div class="convert-target-row"><label for="convertRawFormat">Raw format</label><select id="convertRawFormat"' + (local.busy ? ' disabled' : '') + '>' + options + '</select><button class="primary-button" type="button" data-convert-action="run-convbin"' + (disabled ? ' disabled' : '') + '>' + (local.busy ? 'Converting…' : 'Convert locally') + '</button></div>'
      + '<p class="convert-target-hint">' + (local.format ? 'Output is a RINEX 3.03 observation and any navigation output, written locally.' : 'Choose the raw format if auto-detection is wrong; a generic .bin can be several formats.') + '</p>'
      + error
      + setupActions
      + formatChipsHtml()
      + '<p class="convert-target-hint">If conversion fails, the format may be closed. Use the receiver maker\'s free export or office utility, then drop the resulting RINEX here.</p>'
      + '</div></div>';
  }

  function closedBinaryCard() {
    const label = state.local.closed || 'This format';
    return '<div class="pp-card convert-local"><div class="pp-card-head"><div><b>This binary format is not supported</b><small>' + esc(label) + ' is a closed receiver format</small></div><span class="pp-chip warn">Not supported</span></div><div class="pp-card-body">'
      + '<p class="pp-copy">RTKLIB convbin cannot read ' + esc(label) + ' logs, so Northstar will not guess at the bytes. Export a RINEX observation file with the receiver\'s office software. If the utility offers navigation data, export that too.</p>'
      + formatChipsHtml()
      + '<div class="convert-actions"><button class="primary-button" type="button" data-convert-action="browse">Choose converted RINEX</button><button class="secondary-button" type="button" data-convert-action="postprocess">Open post-processing</button></div>'
      + '</div></div>'
      + '<div class="pp-note"><b>No base station?</b> You do not need one. Once the observation file is in RINEX, post-processing can search the free NOAA CORS network for a nearby base and download the matching window.</div>';
  }

  function binaryCard() {
    if (state.local.closed) return closedBinaryCard();
    return localConversionCard();
  }

  function guidanceCard() {
    if (state.kind === 'hatanaka') {
      return '<div class="pp-card"><div class="pp-card-head"><div><b>Hatanaka-compressed RINEX</b><small>The observations are compressed, not missing</small></div><span class="pp-chip warn">Compressed</span></div><div class="pp-card-body">'
        + '<p class="pp-copy">This is Hatanaka-compressed RINEX. Decompress it with the free <b>CRX2RNX</b> utility (included with RTKLIB), then drop the resulting <code>.rnx</code> or <code>.obs</code> file here.</p>'
        + '<div class="convert-actions"><button class="secondary-button" type="button" data-convert-action="browse">Choose decompressed file</button></div>'
        + '</div></div>';
    }
    if (state.kind === 'solution') {
      return '<div class="pp-card"><div class="pp-card-head"><div><b>This is a processed solution</b><small>Not a receiver observation file</small></div><span class="pp-chip warn">Solution</span></div><div class="pp-card-body">'
        + '<p class="pp-copy">A <code>.pos</code> file contains corrected positions, not the raw observations needed to compute them. Use <b>Tools → Import GNSS solution</b> to accept fixed epochs as a waypoint.</p>'
        + '<div class="convert-actions"><button class="secondary-button" type="button" data-convert-action="close">Close</button></div>'
        + '</div></div>';
    }
    return '<div class="pp-card"><div class="pp-card-head"><div><b>This is not a RINEX file</b><small>Unrecognized file</small></div><span class="pp-chip warn">Conversion needed</span></div><div class="pp-card-body">'
      + '<p class="pp-copy">RINEX is the open exchange format Northstar can read. This file is neither RINEX nor a binary log that can be handed to the local converter, so Northstar does not guess at the bytes. Use the receiver maker’s free export or RINEX conversion utility, then bring the result back here.</p>'
      + '<ol class="convert-steps">'
      + '<li>Open the <b>export, office, or conversion utility</b> that came with the receiver.</li>'
      + '<li>Export a <b>RINEX observation file</b> (<code>.obs</code>, <code>.rnx</code> or <code>.??o</code>). If the utility offers navigation data, export that too (<code>.nav</code> or <code>.??n</code>).</li>'
      + '<li>Drop the observation file here to validate it, then choose <b>Use as rover</b>.</li>'
      + '</ol>'
      + '<div class="convert-actions"><button class="primary-button" type="button" data-convert-action="browse">Choose converted RINEX</button><button class="secondary-button" type="button" data-convert-action="postprocess">Open post-processing</button></div>'
      + '</div></div>'
      + '<div class="pp-note"><b>No base station?</b> You do not need one. Once the observation file is in RINEX, post-processing can search the free NOAA CORS network for a nearby base and download the matching window.</div>';
  }

  function emptyState() {
    return '<div class="pp-drop convert-empty" data-convert-drop tabindex="0" role="button"><div><span class="pp-drop-icon material-symbols">upload_file</span>'
      + '<b>Drop a receiver file here</b><small>RINEX observations, RINEX navigation, a compressed file, or a binary log for local conversion.</small>'
      + '<button class="secondary-button" type="button" data-convert-action="browse">Choose file</button></div></div>'
      + '<div class="convert-hint">RINEX observations use <code>.obs</code> or <code>.rnx</code>; navigation uses <code>.nav</code> or <code>.??n</code>. Nothing leaves this computer.</div>';
  }

  function bodyHtml() {
    if (state.busy) {
      return '<div class="convert-empty"><div><span class="material-symbols">hourglass_top</span><b>Reading the file…</b><small>Checking the header and format.</small></div></div>';
    }
    if (!state.file) return emptyState();
    if (state.kind === 'observation') return fileRow() + errorHtml(state.error) + convertedBanner() + observationCard() + conversionCard();
    if (state.kind === 'navigation') return fileRow() + errorHtml(state.error) + navigationCard();
    if (state.kind === 'proprietary') return fileRow() + errorHtml(state.error) + (state.binary ? binaryCard() : guidanceCard());
    if (state.kind === 'hatanaka' || state.kind === 'solution') return fileRow() + guidanceCard();
    if (state.kind === 'empty') {
      return fileRow() + '<div class="pp-note error"><b>The file is empty</b><br>Choose the receiver export, not a shortcut or an empty placeholder.</div>';
    }
    return fileRow() + errorHtml(state.error) + '<div class="convert-actions"><button class="secondary-button" type="button" data-convert-action="browse">Choose another file</button></div>';
  }

  function render() {
    const body = $('#convertBody');
    if (!body) return;
    body.innerHTML = '<input id="convertInput" type="file" hidden>' + bodyHtml();
    const again = $('#convertAgain');
    const post = $('#convertPostprocess');
    const note = $('#convertFootNote');
    if (again) again.hidden = !state.file;
    if (post) {
      post.hidden = !state.file;
      post.disabled = state.busy || state.local.busy;
      post.textContent = state.kind === 'observation' ? 'Use as rover' : 'Open post-processing';
    }
    if (note) {
      if (!state.file) note.innerHTML = '<b>Files stay on this computer.</b> Validate or convert a receiver file locally; nothing is uploaded.';
      else if (state.kind === 'observation' && state.exportInfo) note.innerHTML = '<b>Converted.</b> ' + esc(state.exportInfo.name) + ' was downloaded. Adjust the target and convert again if needed.';
      else if (state.kind === 'observation' && state.converted) note.innerHTML = '<b>Converted locally.</b> RINEX 3.03 observation ready. Choose Use as rover, or convert it to RINEX 2, CSV or GeoJSON.';
      else if (state.kind === 'observation') note.innerHTML = '<b>Ready.</b> Convert to RINEX 2, CSV or GeoJSON, or use this observation as the rover.';
      else if (state.kind === 'navigation') note.innerHTML = '<b>Navigation file.</b> Add it in the base step after the observation file.';
      else if (state.kind === 'hatanaka') note.innerHTML = '<b>Compressed RINEX.</b> Decompress it with CRX2RNX, then drop the result here.';
      else if (state.kind === 'solution') note.innerHTML = '<b>Processed solution.</b> Use Import GNSS solution to accept fixed epochs.';
      else if (state.kind === 'proprietary' && state.binary) note.innerHTML = state.local.closed
        ? '<b>Closed format.</b> Export RINEX with the receiver maker’s office software, then check it here.'
        : '<b>Binary log.</b> Convert locally with RTKLIB convbin, or use the receiver maker’s export tool.';
      else note.innerHTML = '<b>Conversion needed.</b> Use the receiver maker’s export tool, then check the RINEX here.';
    }
  }

  function downloadText(fileName, text, mimeType) {
    const blob = new Blob([text], { type: mimeType || 'text/plain' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function downloadNav(index) {
    const file = state.converted && state.converted.nav ? state.converted.nav[index] : null;
    if (!file || !file.text) return;
    downloadText(file.name || outputName('nav'), file.text);
  }

  // A .gz log is decompressed in the browser, so the bytes convbin receives must
  // be the decompressed log, not the original gzip container.
  function conversionBody() {
    return state.compressed && state.bytes ? state.bytes : state.file;
  }

  async function runConvbin() {
    if (!state.file || !state.local.ready || state.local.busy || state.local.tooLarge) return;
    const token = state.local.token;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 190000);
    state.local.busy = true;
    state.local.convertError = '';
    render();
    try {
      const query = new URLSearchParams({ name: state.name });
      if (state.local.format) query.set('format', state.local.format);
      if (state.file && Number.isFinite(state.file.lastModified) && state.file.lastModified > 0) {
        query.set('mtime', String(state.file.lastModified / 1000));
      }
      const response = await fetch('/api/rtklib/convert?' + query.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Northstar-Action': 'convert-rtklib'
        },
        body: conversionBody(),
        signal: controller.signal
      });
      const result = await response.json().catch(() => ({}));
      if (state.local.token !== token) return;
      if (!response.ok) {
        throw new Error(response.status === 404
          ? 'The desktop converter did not answer.'
          : (result.error || 'The local converter could not read this file.')
            + (response.status === 422 ? ' If the format was detected from the file extension, choose the raw format explicitly and try again.' : ''));
      }
      if (!result.obs || typeof result.obs.text !== 'string' || !result.obs.text.trim()) {
        throw new Error('The local converter returned no RINEX observation data.');
      }
      const source = state.name;
      state.name = result.obs.name || outputName('obs');
      state.text = result.obs.text;
      state.bytes = null;
      state.binary = false;
      state.error = null;
      state.exportInfo = null;
      state.local.busy = false;
      state.converted = {
        source,
        format: result.formatLabel || RAW_FORMAT_LABELS[state.local.format] || 'raw log',
        nav: Array.isArray(result.nav) ? result.nav : [],
        elapsedMs: Number(result.elapsedMs) || 0,
        engine: result.engine && result.engine.version ? result.engine.version : state.local.version
      };
      detect();
      render();
      message('Converted ' + source + ' to RINEX');
    } catch (error) {
      if (state.local.token !== token) return;
      state.local.busy = false;
      state.local.convertError = error && error.name === 'AbortError'
        ? 'The conversion took longer than three minutes and was stopped. Try a shorter session.'
        : (/Failed to fetch|NetworkError/i.test(error && error.message ? error.message : '')
          ? 'The desktop backend did not answer.'
          : (error && error.message ? error.message : 'The local converter could not read this file.'));
      render();
    } finally {
      clearTimeout(timer);
    }
  }

  function download() {
    if (!state.text) return;
    const extension = state.kind === 'navigation' ? 'nav' : 'obs';
    downloadText(outputName(extension), state.text);
  }

  function downloadTarget() {
    if (!state.rinex) return;
    const target = $('#convertTarget')?.value || state.target;
    state.target = target;
    const api = window.northstarRinex;
    if (!api) {
      state.error = { title: 'Converter is not available', message: 'Reload Northstar and try again.' };
      render();
      return;
    }
    let result;
    let fileName;
    let detail;
    if (target === 'rinex2') {
      result = api.toRinex2(state.rinex);
      fileName = baseName(state.name) + '_rinex2.obs';
      detail = 'RINEX 2.11 · ' + (result.ok ? result.epochCount + ' epochs' : 'not converted');
    } else if (target === 'csv') {
      result = api.toCsv(state.rinex);
      fileName = baseName(state.name) + '_observations.csv';
      detail = 'CSV · ' + (result.ok ? result.rows - 1 + ' epochs × ' + result.columns + ' columns' : 'not converted');
    } else {
      result = api.toGeoJson(state.rinex);
      fileName = baseName(state.name) + '_marker.geojson';
      detail = 'GeoJSON · approximate marker position';
    }
    if (!result || !result.ok) {
      state.error = result && result.error ? result.error : { title: 'Could not convert this file', message: 'The RINEX reader rejected the observation records.' };
      state.exportInfo = null;
      render();
      return;
    }
    state.error = null;
    state.exportInfo = { name: fileName, detail, warnings: result.warnings || [] };
    downloadText(fileName, result.text, target === 'csv' ? 'text/csv' : target === 'geojson' ? 'application/geo+json' : 'text/plain');
    render();
  }

  function openInspector() {
    if (!state.text) return;
    const inspector = window.northstarRinexInspect;
    if (inspector && typeof inspector.openWithText === 'function') {
      close();
      inspector.openWithText(state.text, outputName('obs'));
    } else {
      state.error = { title: 'RINEX inspector is not available', message: 'Reload Northstar and try again.' };
      render();
    }
  }

  function useRover() {
    if (state.kind !== 'observation' || !state.text) return;
    const target = window.northstarPostprocess;
    if (!target || typeof target.openWithRover !== 'function') {
      state.error = { title: 'Post-processing is not available', message: 'Reload Northstar and try again.' };
      render();
      return;
    }
    const nav = state.converted && Array.isArray(state.converted.nav) ? state.converted.nav : [];
    const parsed = target.openWithRover(state.text, outputName('obs'), nav);
    if (parsed && parsed.ok === false) {
      state.error = parsed.error || { title: 'Could not use this observation', message: 'The post-processing reader rejected the file.' };
      render();
      return;
    }
    close();
  }

  function openPostprocess() {
    window.northstarPostprocess?.open();
    close();
  }

  function reset() {
    resetLocalState();
    state.file = null;
    state.name = '';
    state.text = '';
    state.bytes = null;
    state.compressed = false;
    state.binary = false;
    state.kind = '';
    state.parsed = null;
    state.rinex = null;
    state.info = null;
    state.error = null;
    state.exportInfo = null;
    state.converted = null;
    state.busy = false;
    render();
  }

  function open() {
    const dialog = $('#convertDialog');
    if (!dialog) return;
    render();
    if (!dialog.open) dialog.showModal();
  }

  function close() {
    const dialog = $('#convertDialog');
    if (dialog && dialog.open) dialog.close();
  }

  function bindEvents() {
    const dialog = $('#convertDialog');
    if (!dialog) return;

    dialog.addEventListener('click', (event) => {
      const drop = event.target.closest('[data-convert-drop]');
      if (drop && !event.target.closest('button')) {
        $('#convertInput')?.click();
        return;
      }
      const action = event.target.closest('[data-convert-action]');
      if (!action) return;
      const name = action.dataset.convertAction;
      if (name === 'browse') $('#convertInput')?.click();
      else if (name === 'download') download();
      else if (name === 'download-nav') downloadNav(Number(action.dataset.navIndex));
      else if (name === 'download-target') downloadTarget();
      else if (name === 'run-convbin') runConvbin();
      else if (name === 'check-converter') checkLocalConverter(true);
      else if (name === 'inspect') openInspector();
      else if (name === 'use-rover') useRover();
      else if (name === 'postprocess' || name === 'open-postprocess') openPostprocess();
      else if (name === 'close') close();
    });

    dialog.addEventListener('change', (event) => {
      if (event.target.id === 'convertInput') {
        handleFile(event.target.files && event.target.files[0]);
        event.target.value = '';
      } else if (event.target.id === 'convertTarget') {
        state.target = event.target.value;
        state.exportInfo = null;
        state.error = null;
        render();
      } else if (event.target.id === 'convertRawFormat') {
        state.local.format = event.target.value;
        state.local.convertError = '';
        render();
      }
    });

    dialog.addEventListener('dragover', (event) => {
      if (!event.target.closest('[data-convert-drop]')) return;
      event.preventDefault();
      event.target.closest('[data-convert-drop]').classList.add('dragging');
    });

    dialog.addEventListener('dragleave', (event) => {
      const drop = event.target.closest('[data-convert-drop]');
      if (drop) drop.classList.remove('dragging');
    });

    dialog.addEventListener('drop', (event) => {
      const drop = event.target.closest('[data-convert-drop]');
      if (!drop) return;
      event.preventDefault();
      drop.classList.remove('dragging');
      const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) handleFile(file);
    });

    dialog.addEventListener('keydown', (event) => {
      const drop = event.target.closest('[data-convert-drop]');
      if (drop && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        $('#convertInput')?.click();
      }
    });

    $('#convertClose')?.addEventListener('click', close);
    $('#convertAgain')?.addEventListener('click', () => {
      reset();
      $('#convertInput')?.click();
    });
    $('#convertPostprocess')?.addEventListener('click', () => {
      if (state.kind === 'observation') useRover();
      else openPostprocess();
    });
  }

  function initialize() {
    if (!$('#convertDialog')) return;
    bindEvents();
    render();
  }

  window.northstarConvert = {
    open,
    close,
    reset,
    handleFile,
    get state() { return state; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize);
  else initialize();
})();
