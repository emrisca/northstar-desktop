/*
 * RINEX inspector. Opens one or more observation files, explains the header
 * and session, and lets the user plot each file's approximate marker position.
 *
 * A RINEX observation file contains satellite observations, not a coordinate
 * for every epoch. The only position in the file is APPROX POSITION XYZ, so
 * one point per file is the honest maximum here.
 */
(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const MAX_FILES = 24;
  const MAX_BYTES = 100 * 1024 * 1024;

  const state = {
    files: [],
    selected: new Set(),
    busy: false,
    error: null
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
    return withTime ? day + ' ' + date.toISOString().slice(11, 19) + ' UTC' : day;
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '—';
    if (seconds < 90) return Math.round(seconds) + ' s';
    if (seconds < 5400) return Math.round(seconds / 60) + ' min';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.round((seconds - hours * 3600) / 60);
    return hours + ' h' + (minutes ? ' ' + minutes + ' min' : '');
  }

  function intervalOf(parsed) {
    if (parsed.header.interval) return parsed.header.interval;
    const times = parsed.epochs.slice(0, 12).map((epoch) => epoch.ms).filter(Number.isFinite);
    const differences = [];
    for (let index = 1; index < times.length; index += 1) differences.push((times[index] - times[index - 1]) / 1000);
    const usable = differences.filter((value) => value > 0 && value < 3600).sort((a, b) => a - b);
    return usable.length ? usable[Math.floor(usable.length / 2)] : null;
  }

  // Some receivers write a bare station number into MARKER NAME ("1", "42"),
  // which makes a plotted point unrecognisable. Fall back to the file name
  // when the marker is a placeholder; the properties table still shows it.
  function labelFor(entry) {
    const parsed = entry.parsed;
    if (!parsed) return entry.name;
    const marker = String(parsed.header.markerName || '').trim();
    if (marker && !/^\d{1,3}$/.test(marker)) return marker;
    return (parsed.name || entry.name).replace(/\.[^.]+$/, '');
  }

  function positionFor(entry) {
    const approx = entry.parsed && entry.parsed.header.approx;
    if (!approx || !Number.isFinite(approx.lat) || !Number.isFinite(approx.lon)) return null;
    return { lat: approx.lat, lon: approx.lon, height: approx.height };
  }

  async function readFile(file) {
    if (file.size > MAX_BYTES) throw new Error('The file is larger than the 100 MB inspection limit.');
    let bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      if (typeof DecompressionStream !== 'function') throw new Error('This browser cannot open .gz files. Decompress the file first.');
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
      if (bytes.length > MAX_BYTES) throw new Error('The decompressed file is larger than the 100 MB inspection limit.');
    }
    const text = new TextDecoder('utf-8').decode(bytes);
    const parsed = window.northstarRinex?.parse(text, file.name.replace(/\.gz$/i, ''));
    if (!parsed) throw new Error('The RINEX reader is unavailable. Reload Northstar and try again.');
    if (!parsed.ok) {
      const error = new Error(parsed.error?.message || 'The file could not be read.');
      error.title = parsed.error?.title || 'Not an observation file';
      throw error;
    }
    return { name: file.name.replace(/\.gz$/i, ''), size: file.size, parsed };
  }

  async function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    state.busy = true;
    state.error = null;
    render();
    for (const file of files) {
      if (state.files.length >= MAX_FILES) {
        state.error = { title: 'File limit reached', message: 'Inspect up to ' + MAX_FILES + ' observation files at a time.' };
        break;
      }
      try {
        const entry = await readFile(file);
        entry.key = String(Date.now()) + '-' + state.files.length;
        state.files.push(entry);
        state.selected.add(entry.key);
      } catch (error) {
        state.files.push({
          key: String(Date.now()) + '-' + state.files.length,
          name: file.name,
          size: file.size,
          error: { title: error.title || 'Could not read this file', message: error.message || 'Unknown error.' }
        });
      }
    }
    state.busy = false;
    render();
  }

  function openWithText(text, name) {
    const parsed = window.northstarRinex?.parse(text, name || 'observation.obs');
    state.files = [];
    state.selected.clear();
    state.error = null;
    state.busy = false;
    if (!parsed) {
      state.error = { title: 'RINEX reader unavailable', message: 'Reload Northstar and try again.' };
    } else if (!parsed.ok) {
      state.error = { title: parsed.error?.title || 'Could not read this file', message: parsed.error?.message || '' };
    } else {
      const entry = { key: 'current', name: parsed.name, size: parsed.size, parsed };
      state.files.push(entry);
      state.selected.add(entry.key);
    }
    open();
  }

  function summary() {
    const good = state.files.filter((entry) => entry.parsed);
    const positions = good.filter((entry) => positionFor(entry));
    const first = Math.min(...good.map((entry) => entry.parsed.firstMs).filter(Number.isFinite));
    const last = Math.max(...good.map((entry) => entry.parsed.lastMs).filter(Number.isFinite));
    const epochs = good.reduce((total, entry) => total + entry.parsed.epochCount, 0);
    const systems = Array.from(new Set(good.flatMap((entry) => entry.parsed.systems))).sort();
    return {
      files: state.files.length,
      good: good.length,
      positions: positions.length,
      first: Number.isFinite(first) ? first : null,
      last: Number.isFinite(last) ? last : null,
      epochs,
      systems
    };
  }

  function pointRows() {
    return state.files.map((entry, index) => {
      const position = positionFor(entry);
      const checked = state.selected.has(entry.key);
      const chip = entry.error ? '<span class="pp-chip fail">Not readable</span>' : '<span class="pp-chip ok">Observation</span>';
      return '<label class="rinex-point' + (position ? '' : ' no-position') + '">'
        + '<input type="checkbox" data-rinex-point="' + index + '"' + (checked ? ' checked' : '') + (position ? '' : ' disabled') + '>'
        + '<span class="rinex-point-copy"><b>' + esc(labelFor(entry)) + '</b><small>'
        + (position ? esc(position.lat.toFixed(7)) + '°, ' + esc(position.lon.toFixed(7)) + '°' : 'No approximate position in this header') + '</small></span>'
        + chip + '</label>';
    }).join('');
  }

  function fileCard(entry, index) {
    if (entry.error) {
      return '<div class="pp-card rinex-file-card"><div class="pp-card-head"><div><b>' + esc(entry.name) + '</b><small>' + esc(formatBytes(entry.size)) + '</small></div><span class="pp-chip fail">Not readable</span></div><div class="pp-card-body"><div class="pp-note error"><b>' + esc(entry.error.title) + '</b><br>' + esc(entry.error.message) + '</div></div></div>';
    }
    const parsed = entry.parsed;
    const header = parsed.header;
    const position = positionFor(entry);
    const interval = intervalOf(parsed);
    const hasPhase = header.obsTypes.some((code) => /^L/i.test(code));
    const hasL2 = header.obsTypes.some((code) => /^L2/i.test(code));
    const receiver = [header.receiverNumber, header.receiverType, header.receiverVersion].filter(Boolean).join(' · ') || '—';
    const antenna = [header.antennaNumber, header.antennaType].filter(Boolean).join(' · ') || '—';
    const rows = [
      ['Format', parsed.versionLabel + ' · observation' + (parsed.systems.length ? ' · ' + parsed.systems.join('/') : '')],
      ['Marker', [header.markerName, header.markerNumber].filter(Boolean).join(' · ') || '—'],
      ['Observer / agency', [header.observer, header.agency].filter(Boolean).join(' · ') || '—'],
      ['Receiver', receiver],
      ['Antenna', antenna],
      ['Antenna delta', 'H ' + Number(header.antennaDelta.h || 0).toFixed(3) + ' m · E ' + Number(header.antennaDelta.e || 0).toFixed(3) + ' m · N ' + Number(header.antennaDelta.n || 0).toFixed(3) + ' m'],
      ['Time system', header.timeSystem || '—'],
      ['Window', formatDate(parsed.firstMs, true) + ' to ' + formatDate(parsed.lastMs, true)],
      ['Duration', formatDuration(parsed.duration)],
      ['Epochs', String(parsed.epochCount)],
      ['Interval', interval ? interval.toFixed(interval < 1 ? 2 : 0) + ' s' : 'not stated'],
      ['Satellites', parsed.satelliteIds.length ? parsed.satelliteIds.length + ' (' + parsed.satelliteIds.slice(0, 8).join(', ') + (parsed.satelliteIds.length > 8 ? '…' : '') + ')' : 'not stated'],
      ['Constellations', parsed.systems.length ? parsed.systems.join(', ') : 'not stated'],
      ['Observation types', header.obsTypes.length ? header.obsTypes.join(' ') : 'not stated'],
      ['Carrier phase', hasPhase ? 'present' + (hasL2 ? ' · L1 and L2' : '') : 'not found'],
      ['Approximate position', position ? position.lat.toFixed(7) + '°, ' + position.lon.toFixed(7) + '°' : 'not in header'],
      ['Ellipsoid height', position && Number.isFinite(position.height) ? position.height.toFixed(3) + ' m' : '—']
    ];
    const warnings = parsed.warnings.slice();
    if (!position) warnings.push('No APPROX POSITION XYZ is present, so this file cannot contribute a map point.');
    if (!hasPhase) warnings.push('No carrier-phase observations were found. RTKLIB needs phase for a fixed solution.');
    if (header.comments.length) warnings.push('Header comment: ' + header.comments.slice(0, 2).join(' · '));
    return '<div class="pp-card rinex-file-card"><div class="pp-card-head"><div><b>' + esc(entry.name) + '</b><small>' + esc(formatBytes(entry.size)) + ' · ' + esc(parsed.epochCount) + ' epochs</small></div><span class="pp-chip ' + (hasPhase ? 'ok' : 'warn') + '">' + (hasPhase ? 'Ready' : 'No phase') + '</span></div><div class="pp-card-body">'
      + '<div class="pp-grid">' + rows.map(([label, value]) => '<div class="pp-row"><span>' + esc(label) + '</span><b>' + esc(value) + '</b></div>').join('') + '</div>'
      + (warnings.length ? '<div class="pp-note warn">' + warnings.map((warning) => esc(warning)).join('<br>') + '</div>' : '')
      + '</div></div>';
  }

  function bodyHtml() {
    if (state.busy) {
      return '<div class="convert-empty"><div><span class="material-symbols">hourglass_top</span><b>Reading observation files…</b><small>Checking headers and epoch records.</small></div></div>';
    }
    if (!state.files.length) {
      return '<div class="pp-drop convert-empty" data-rinex-drop tabindex="0" role="button"><div><span class="pp-drop-icon material-symbols">upload_file</span>'
        + '<b>Drop one or more RINEX observation files</b><small>Each file is inspected separately. Multiple files are useful for comparing sessions or receivers.</small>'
        + '<button class="secondary-button" type="button" data-rinex-action="browse">Choose files</button></div></div>'
        + '<div class="convert-hint">Accepts <code>.obs</code>, <code>.rnx</code>, <code>.??o</code> and gzip-compressed files. Navigation files are not observations and will be rejected with an explanation.</div>'
        + (state.error ? '<div class="pp-note error"><b>' + esc(state.error.title) + '</b><br>' + esc(state.error.message) + '</div>' : '');
    }
    const info = summary();
    const error = state.error ? '<div class="pp-note error"><b>' + esc(state.error.title) + '</b><br>' + esc(state.error.message) + '</div>' : '';
    return error
      + '<div class="rinex-summary"><div class="rinex-stat"><span>Files</span><b>' + info.files + '</b><small>' + info.good + ' readable</small></div>'
      + '<div class="rinex-stat"><span>Epochs</span><b>' + info.epochs + '</b><small>across all files</small></div>'
      + '<div class="rinex-stat"><span>Time span</span><b>' + (info.first && info.last ? formatDate(info.first, false) + ' – ' + formatDate(info.last, false) : '—') + '</b><small>' + (info.systems.length ? info.systems.join(' · ') : 'no constellations') + '</small></div></div>'
      + '<div class="rinex-points-head"><div><b>Plot marker positions</b><small>Check the files to add to the map. RINEX stores one approximate marker position per file, not a coordinate per epoch.</small></div><button class="text-button" type="button" data-rinex-action="select-all">Select all</button></div>'
      + '<div class="rinex-points">' + pointRows() + '</div>'
      + '<div class="rinex-actions"><button class="primary-button" type="button" data-rinex-action="plot">Plot selected on map</button><button class="secondary-button" type="button" data-rinex-action="browse">Add files</button><button class="secondary-button" type="button" data-rinex-action="clear">Clear</button></div>'
      + '<div class="rinex-details-head"><b>Properties</b><small>Every readable file, with the header fields that affect processing.</small></div>'
      + state.files.map(fileCard).join('');
  }

  function render() {
    const body = $('#rinexInspectBody');
    if (!body) return;
    body.innerHTML = '<input id="rinexInspectInput" type="file" accept=".obs,.rnx,.gz,.??o,text/plain" multiple hidden>' + bodyHtml();
  }

  function plot() {
    const points = state.files
      .filter((entry) => state.selected.has(entry.key))
      .map((entry) => {
        const position = positionFor(entry);
        if (!position) return null;
        return {
          name: 'RINEX · ' + labelFor(entry),
          lat: position.lat,
          lon: position.lon,
          symbol: 'circle',
          showLabel: true
        };
      })
      .filter(Boolean);
    if (!points.length) {
      state.error = { title: 'Nothing selected', message: 'Choose at least one file whose header contains an approximate position.' };
      render();
      return;
    }
    const added = window.northstarApp?.addMany?.(points) || 0;
    close();
    window.northstarApp?.message?.(added + ' RINEX marker point' + (added === 1 ? '' : 's') + ' added to the map');
  }

  function selectAll() {
    state.files.forEach((entry) => {
      if (positionFor(entry)) state.selected.add(entry.key);
    });
    render();
  }

  function clear() {
    state.files = [];
    state.selected.clear();
    state.error = null;
    render();
  }

  function bindEvents() {
    const dialog = $('#rinexInspectDialog');
    if (!dialog) return;
    dialog.addEventListener('click', (event) => {
      const drop = event.target.closest('[data-rinex-drop]');
      if (drop && !event.target.closest('button')) {
        $('#rinexInspectInput')?.click();
        return;
      }
      const action = event.target.closest('[data-rinex-action]');
      if (!action) return;
      const name = action.dataset.rinexAction;
      if (name === 'browse') $('#rinexInspectInput')?.click();
      else if (name === 'plot') plot();
      else if (name === 'select-all') selectAll();
      else if (name === 'clear') clear();
    });
    dialog.addEventListener('change', (event) => {
      if (event.target.id === 'rinexInspectInput') {
        addFiles(event.target.files);
        event.target.value = '';
        return;
      }
      const checkbox = event.target.closest('[data-rinex-point]');
      if (!checkbox) return;
      const entry = state.files[+checkbox.dataset.rinexPoint];
      if (!entry) return;
      if (checkbox.checked) state.selected.add(entry.key);
      else state.selected.delete(entry.key);
    });
    dialog.addEventListener('dragover', (event) => {
      const drop = event.target.closest('[data-rinex-drop]');
      if (!drop) return;
      event.preventDefault();
      drop.classList.add('dragging');
    });
    dialog.addEventListener('dragleave', (event) => {
      const drop = event.target.closest('[data-rinex-drop]');
      if (drop) drop.classList.remove('dragging');
    });
    dialog.addEventListener('drop', (event) => {
      const drop = event.target.closest('[data-rinex-drop]');
      if (!drop) return;
      event.preventDefault();
      drop.classList.remove('dragging');
      addFiles(event.dataTransfer?.files);
    });
    dialog.addEventListener('keydown', (event) => {
      const drop = event.target.closest('[data-rinex-drop]');
      if (drop && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        $('#rinexInspectInput')?.click();
      }
    });
    $('#rinexInspectClose')?.addEventListener('click', close);
    $('#rinexInspectAgain')?.addEventListener('click', () => $('#rinexInspectInput')?.click());
  }

  function open() {
    const dialog = $('#rinexInspectDialog');
    if (!dialog) return;
    render();
    if (!dialog.open) dialog.showModal();
  }

  function close() {
    const dialog = $('#rinexInspectDialog');
    if (dialog && dialog.open) dialog.close();
  }

  function initialize() {
    if (!$('#rinexInspectDialog')) return;
    bindEvents();
    render();
  }

  window.northstarRinexInspect = {
    open,
    close,
    openWithText,
    get state() { return state; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize);
  else initialize();
})();
