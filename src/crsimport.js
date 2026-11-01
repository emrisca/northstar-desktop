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

  // Does this table need the column mapper? A lat/lon table does not.
  function needsDialog(rows) {
    if (!rows || !rows.length) return false;
    const header = hasHeader(rows);
    if (!header) return true;
    const names = rows[0].map(value => cell(value).toLowerCase());
    const lat = names.some(name => /^(lat|latitude)/.test(name));
    const lon = names.some(name => /(lon|lng|long)/.test(name));
    return !(lat && lon);
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
    x.value = String(guess(names, [/east/i, /^x\b/i, /^x/i, /lon/i], 0));
    y.value = String(guess(names, [/north/i, /^y\b/i, /^y/i, /lat/i], Math.min(1, names.length - 1)));
    name.value = String(guess(names, [/name/i, /label/i, /station/i, /point/i, /id/i], -1));
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

  window.northstarXYImport = { needsDialog, open };
})();
