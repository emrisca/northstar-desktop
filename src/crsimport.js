// Import points from a table by choosing the X/Y columns and their CRS.
//
// QGIS-style "create points from a table": the numbers in the file are read in the CRS
// you choose and converted to the stored geometry CRS (WGS 84). Latitude/longitude
// tables still take the fast path in app.js and never open this dialog.
(function () {
  const $ = selector => document.querySelector(selector);
  const dialog = $('#xyImportDialog');
  if (!dialog || !window.northstarCRS) return;

  let pending = null;
  let pendingFileName = 'table';
  let crsPicker = window.northstarCRS.picker($('#xyCrsPicker'), () => {
    swapIfNeeded();
    preview();
  });

  function cell(value) {
    return String(value == null ? '' : value).trim();
  }

  function isNumeric(value) {
    const text = cell(value);
    return text !== '' && Number.isFinite(Number(text.replace(/,/g, '')));
  }

  // Delimiters these files actually arrive with. Pipe first: a table that has been
  // through a spreadsheet or a Markdown note keeps its pipes, and by then any commas
  // are inside the cells rather than between them.
  const DELIMITERS = ['|', '\t', ';', ','];

  function countDelimiters(line, delimiter) {
    let count = 0;
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') quoted = !quoted;
      else if (!quoted && ch === delimiter) count++;
    }
    return count;
  }

  // The delimiter whose field count holds steady across the first lines. A name column
  // full of commas cannot make the comma steady; a real separator can.
  function sniffDelimiter(source) {
    const lines = source.split(/\r?\n/).filter(line => line.trim() !== '').slice(0, 8);
    for (const delimiter of DELIMITERS) {
      const counts = lines.map(line => countDelimiters(line, delimiter));
      if (counts.length && counts[0] > 0 && counts.every(count => count === counts[0])) {
        return delimiter;
      }
    }
    return ',';
  }

  // RFC 4180 enough for a survey export: a quoted field keeps its delimiters and can
  // hold a doubled quote or a line break, and CRLF or LF ends a row either way.
  function splitRows(source, delimiter) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    const endRow = () => {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    };
    for (let i = 0; i < source.length; i++) {
      const ch = source[i];
      if (quoted) {
        if (ch !== '"') field += ch;
        else if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else if (ch === '"' && field === '') {
        quoted = true;
      } else if (ch === delimiter) {
        row.push(field);
        field = '';
      } else if (ch === '\n') {
        endRow();
      } else if (ch === '\r') {
        if (source[i + 1] !== '\n') endRow();
      } else {
        field += ch;
      }
    }
    if (field !== '' || row.length) endRow();
    return rows;
  }

  // A pipe table is written with a pipe at each end, which leaves an empty cell there.
  function stripOuterPipes(row) {
    const cells = row.slice();
    if (cells.length && cells[0] === '') cells.shift();
    if (cells.length && cells[cells.length - 1] === '') cells.pop();
    return cells;
  }

  // The `| --- | :---: |` line a Markdown table carries under its header.
  function isSeparatorRow(row) {
    return row.length > 0 && row.every(value => /^:?-{3,}:?$/.test(value));
  }

  // A delimited table as rows of trimmed cells, or one column per row if the file has
  // no delimiter at all. Every import reads through here, so the dialog and the direct
  // latitude/longitude path cannot disagree about what the columns are.
  function readTable(text) {
    const source = String(text == null ? '' : text).replace(/^\uFEFF/, '');
    const delimiter = sniffDelimiter(source);
    return splitRows(source, delimiter)
      .map(row => (delimiter === '|' ? stripOuterPipes(row) : row))
      .map(row => row.map(value => cell(value)))
      .filter(row => row.some(value => value !== ''))
      .filter(row => !isSeparatorRow(row));
  }

  function hasHeader(rows) {
    if (!rows.length) return false;
    return rows[0].some(value => {
      const text = cell(value);
      return text !== '' && !isNumeric(text);
    });
  }

  function columnCount(rows) {
    return rows.reduce((max, row) => Math.max(max, row.length), 0);
  }

  function parse(fileName, rows) {
    const header = hasHeader(rows);
    const width = columnCount(rows);
    const names = [];
    for (let i = 0; i < width; i++) {
      names.push(header && cell(rows[0][i]) ? cell(rows[0][i]) : 'Column ' + (i + 1));
    }
    const body = rows.slice(header ? 1 : 0)
      .filter(row => row.some(value => cell(value) !== ''));
    return { fileName, header, names, rows: body };
  }

  // Does this table need the column mapper? A table with one obvious latitude/longitude
  // pair does not. One offering several (input and output, say) does, because choosing
  // is the whole point and a silent first match is how DMS or change columns get read.
  function needsDialog(rows) {
    if (!rows || !rows.length) return false;
    const header = hasHeader(rows);
    if (!header) return true;
    const names = rows[0].map(value => cell(value));
    if (!pickColumns(names)) return true;
    return candidatePairs(names).length > 1;
  }

  // What a column name says, as words: `Input_Lat(DD)` is [input, lat, dd].
  function words(name) {
    return cell(name).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  }

  // Words that name the axis itself, rather than the dataset or the format.
  const AXIS_WORDS = ['lat', 'latitude', 'lon', 'long', 'longitude', 'lng'];
  const FORMAT_WORDS = ['dd', 'decimal', 'dec', 'dms', 'dm', 'rad', 'deg', 'degrees'];

  // A column is one axis or the other, never both, and `X`/`Y` alone says nothing.
  function axisOf(tokens) {
    const lat = tokens.some(token => token === 'lat' || token === 'latitude');
    const lon = tokens.some(token => token === 'lon' || token === 'long' || token === 'longitude' || token === 'lng');
    return { lat, lon };
  }

  // How good a column is for one axis. Decimal degrees beat degrees-minutes-seconds,
  // input beats output, and a change or an uncertainty is not a position at all. A
  // converter export carries both axes four times, so this is what decides between them.
  function axisScore(name, axis) {
    const tokens = words(name);
    const { lat, lon } = axisOf(tokens);
    if (lat === lon) return -Infinity;
    if (axis === 'y' ? !lat : !lon) return -Infinity;
    const has = token => tokens.includes(token);
    let score = 100;
    if (has('dd') || has('decimal') || has('dec')) score += 50;
    if (has('dms') || has('dm') || has('rad')) score -= 45;
    if (has('input') || has('in') || has('source') || has('src')) score += 30;
    if (has('output') || has('out') || has('result') || has('converted')) score -= 25;
    if (['change', 'delta', 'residual', 'sigma', 'error', 'uncertainty'].some(has)) score -= 80;
    if (['m', 'ft', 'usft', 'ift', 's', 'metres', 'meters', 'feet'].some(has)) score -= 30;
    return score;
  }

  // Which dataset a column belongs to: "input" for `Input_Lat(DD)`, "output" for
  // `Output_Lon(DD)`, empty for a plain `latitude`. Pairing on it keeps both axes in
  // the same group instead of taking one from each.
  function family(name) {
    return words(name)
      .filter(token => !AXIS_WORDS.includes(token) && !FORMAT_WORDS.includes(token))
      .join(' ');
  }

  // The pair the dialog opens on, or null when the table names no latitude or longitude
  // column at all and easting/northing guessing is all there is.
  // Every (longitude, latitude) pair that could be read as a position, scored. A column
  // that says change, sigma or a foot/metre unit scores below zero and is not offered.
  function candidatePairs(names) {
    const lat = [];
    const lon = [];
    names.forEach((name, index) => {
      const yScore = axisScore(name, 'y');
      if (yScore > 0) lat.push({ index, score: yScore, family: family(name) });
      const xScore = axisScore(name, 'x');
      if (xScore > 0) lon.push({ index, score: xScore, family: family(name) });
    });
    const pairs = [];
    lat.forEach(y => {
      lon.forEach(x => {
        if (x.index === y.index) return;
        const shared = x.family === y.family ? 40 : 0;
        pairs.push({ x: x.index, y: y.index, total: x.score + y.score + shared });
      });
    });
    return pairs;
  }

  // The pair the dialog opens on, and the pair the direct import reads, so the two
  // cannot disagree about which columns are the coordinates.
  function pickColumns(names) {
    return candidatePairs(names).reduce((best, pair) => (!best || pair.total > best.total ? pair : best), null);
  }

  function guess(names, patterns, fallback) {
    for (const pattern of patterns) {
      const index = names.findIndex(name => pattern.test(name));
      if (index >= 0) return index;
    }
    return fallback;
  }

  function fillColumns() {
    const names = pending.names;
    const x = $('#xyXColumn');
    const y = $('#xyYColumn');
    const name = $('#xyNameColumn');
    const options = names.map((label, index) => '<option value="' + index + '">' + label + '</option>').join('');
    x.innerHTML = options;
    y.innerHTML = options;
    name.innerHTML = '<option value="-1">(none)</option>' + options;
    const pair = pickColumns(names);
    x.value = String(pair ? pair.x : guess(names, [/east/i, /^x\b/i, /^x/i, /lon/i], 0));
    y.value = String(pair ? pair.y : guess(names, [/north/i, /^y\b/i, /^y/i, /lat/i], Math.min(1, names.length - 1)));
    name.value = String(guess(names, [/name/i, /label/i, /station/i, /point/i, /id/i], -1));
    // One column cannot be both axes. A table that arrives as a single column used to
    // land here with X and Y on the same index, and every row was then skipped.
    if (names.length > 1 && x.value === y.value) {
      y.value = String([...names.keys()].find(index => String(index) !== x.value));
    }
  }

  function currentCrs() {
    return ($('#xyCrsValue') && $('#xyCrsValue').value) || 'EPSG:4326';
  }

  // A headerless table is usually "latitude, longitude". When the guessed order cannot
  // be read as a longitude/latitude pair but the opposite order can, swap them.
  function swapIfNeeded() {
    const C = window.northstarCRS;
    const crs = currentCrs();
    if (!C || !pending || C.isProjected(crs)) return;
    const xSelect = $('#xyXColumn');
    const ySelect = $('#xyYColumn');
    const x = Number(xSelect.value);
    const y = Number(ySelect.value);
    if (x === y) return;
    const row = pending.rows.find(candidate => cell(candidate[x]) !== '' && cell(candidate[y]) !== '');
    if (!row) return;
    const works = (xi, yi) => !!C.toWGS84(crs, row[xi], row[yi]);
    if (!works(x, y) && works(y, x)) {
      xSelect.value = String(y);
      ySelect.value = String(x);
    }
  }

  function preview() {
    const out = $('#xyPreview');
    if (!pending || !pending.rows.length) {
      out.textContent = 'No data rows found in this file.';
      return;
    }
    const xIndex = Number($('#xyXColumn').value);
    const yIndex = Number($('#xyYColumn').value);
    const row = pending.rows.find(candidate => cell(candidate[xIndex]) !== '' && cell(candidate[yIndex]) !== '');
    if (!row) {
      out.textContent = 'Those columns are empty in every row.';
      return;
    }
    const crs = currentCrs();
    const converted = window.northstarCRS.toWGS84(crs, row[xIndex], row[yIndex]);
    const count = pending.rows.length;
    if (!converted) {
      out.textContent = count + ' rows · ' + cell(row[xIndex]) + ', ' + cell(row[yIndex]) +
        ' does not convert with ' + window.northstarCRS.label(crs) + '. Check the CRS and columns.';
      return;
    }
    out.textContent = count + ' row' + (count === 1 ? '' : 's') + ' · first row ' +
      cell(row[xIndex]) + ', ' + cell(row[yIndex]) + ' → ' +
      converted.lat.toFixed(7) + ', ' + converted.lon.toFixed(7) + ' (WGS 84 lat, lon)';
  }

  function open(options) {
    pendingFileName = (options && options.fileName) || 'table';
    pending = parse(pendingFileName, (options && options.rows) || []);
    if (!pending.rows.length) {
      window.northstarApp && window.northstarApp.message('That file has no data rows');
      return;
    }
    $('#xyImportFile').textContent = pending.fileName;
    const title = $('#xyImportTitle');
    if (title) title.textContent = options && options.title ? options.title : 'Points from a table';
    const copy = $('#xyImportCopy');
    if (copy) copy.textContent = (options && options.copy) || 'has no latitude/longitude columns. Pick the coordinate columns and the CRS they are in.';
    const preferred = (window.northstarApp && window.northstarApp.settings && window.northstarApp.settings.projectCrs) || 'EPSG:4326';
    if (crsPicker) crsPicker.set(preferred, true);
    fillColumns();
    swapIfNeeded();
    $('#xySetDefault').checked = false;
    preview();
    if (!dialog.open) dialog.showModal();
  }

  function close() {
    pending = null;
    if (dialog.open) dialog.close();
  }

  function apply() {
    if (!pending) return;
    const xIndex = Number($('#xyXColumn').value);
    const yIndex = Number($('#xyYColumn').value);
    const nameIndex = Number($('#xyNameColumn').value);
    const crs = currentCrs();
    const points = [];
    let skipped = 0;
    pending.rows.forEach(row => {
      const converted = window.northstarCRS.toWGS84(crs, row[xIndex], row[yIndex]);
      if (!converted) {
        skipped++;
        return;
      }
      const rawName = nameIndex >= 0 ? cell(row[nameIndex]) : '';
      points.push({ lat: converted.lat, lon: converted.lon, name: rawName || undefined });
    });
    if (!points.length) {
      preview();
      if (window.northstarApp && window.northstarApp.message) {
        window.northstarApp.message('No row converted with ' + window.northstarCRS.label(crs) + ' — check the X and Y columns');
      }
      return;
    }
    if ($('#xySetDefault').checked && window.northstarApp && window.northstarApp.setSetting) {
      window.northstarApp.setSetting('projectCrs', crs);
    }
    const app = window.northstarApp;
    const added = app && app.addMany ? app.addMany(points) : 0;
    close();
    if (app && app.message) {
      app.message(added + ' point' + (added === 1 ? '' : 's') + ' imported from ' + pendingFileName +
        (skipped ? ' (' + skipped + ' row' + (skipped === 1 ? '' : 's') + ' skipped)' : ''));
    }
  }

  $('#xyXColumn').addEventListener('change', preview);
  $('#xyYColumn').addEventListener('change', preview);
  $('#xyImportRun').addEventListener('click', apply);
  $('#xyImportCancel').addEventListener('click', close);
  $('#xyImportClose').addEventListener('click', close);

  window.northstarXYImport = { needsDialog, open, readTable, pickColumns };
})();
