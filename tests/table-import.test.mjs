// Table import: the delimiters a real export arrives with.
//
// The reported failure was a survey table that had been through a Markdown note, so
// every row arrived pipe-delimited and carried a `| --- |` line under its header. The
// reader is exercised directly here, then the same text is fed to the real interface
// so the wiring, not just the parser, is covered.
//
// The one browser test needs an installed Chromium, which is what the other harnesses
// use too. It is launched there rather than in a `before` hook so a machine without
// Chrome still runs the parser checks instead of failing all of them.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'src');
const CHANNEL = process.env.NORTHSTAR_BROWSER_CHANNEL || 'chrome';

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

const HEADER = ['name', 'latitude', 'longitude', 'utm_zone', 'utm_easting_m', 'utm_northing_m', 'utm_epsg'];

const POINTS = [
  ['Point 001', '36.00584292777778', '-120.12230357777777', '10N', '759374.765', '3988427.522', '32610'],
  ['Point 002', '36.00613220277778', '-120.12232058888888', '10N', '759372.283', '3988459.574', '32610'],
  ['Point 003', '36.006114141666664', '-120.12263960833333', '10N', '759343.580', '3988456.720', '32610'],
  ['Point 004', '36.005840319444445', '-120.12263595555555', '10N', '759344.807', '3988426.347', '32610']
];

// Exactly the file that was reported: 520 characters, pipes, and a separator row.
const PIPE_TABLE = ['| ' + HEADER.join(' | ') + ' |', '| ' + HEADER.map(() => '---').join(' | ') + ' |']
  .concat(POINTS.map(row => '| ' + row.join(' | ') + ' |'))
  .join('\n');

// --- the reader, loaded on its own -------------------------------------------

function stubElement() {
  const element = {
    value: '',
    textContent: '',
    innerHTML: '',
    checked: false,
    open: false,
    hidden: true,
    dataset: {},
    addEventListener() {},
    setAttribute() {},
    showModal() {
      element.open = true;
    },
    close() {
      element.open = false;
    },
    querySelector: () => stubElement(),
    querySelectorAll: () => [],
    classList: { toggle() {}, add() {}, remove() {} }
  };
  return element;
}

globalThis.window = globalThis;
globalThis.document = {
  querySelector: () => stubElement(),
  addEventListener() {},
  activeElement: null
};
window.northstarCRS = {
  picker: () => ({ value: 'EPSG:4326', set() {}, close() {} }),
  isProjected: () => false,
  toWGS84: () => null,
  label: id => String(id)
};
window.northstarApp = { message() {} };

await import(pathToFileURL(join(ROOT, 'crsimport.js')).href);
const readTable = window.northstarXYImport.readTable;

test('a pipe table keeps its columns and drops the separator row', () => {
  const rows = readTable(PIPE_TABLE);
  assert.equal(PIPE_TABLE.length, 520);
  // The header and four points; the `| --- |` line is not a row.
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[0], HEADER);
  assert.deepEqual(rows[1], POINTS[0]);
  assert.deepEqual(rows[4], POINTS[3]);
});

test('a table exported with quoted fields loses its quotes', () => {
  const quoted = [HEADER, ...POINTS]
    .map(row => row.map(value => '"' + value.replace(/"/g, '""') + '"').join(','))
    .join('\r\n');
  const rows = readTable(quoted);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[1], POINTS[0]);
  assert.equal(Number(rows[1][1]), 36.00584292777778);
});

test('a quoted field keeps its own delimiter', () => {
  const rows = readTable('name,latitude,longitude\n"Corner 4, north",36.5,-120.25\n');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], ['Corner 4, north', '36.5', '-120.25']);
});

test('semicolon and tab files still split into columns', () => {
  const semicolon = readTable('name;latitude;longitude\nPoint 001;36.5;-120.25\n');
  assert.deepEqual(semicolon[1], ['Point 001', '36.5', '-120.25']);
  const tabbed = readTable('name\tlatitude\tlongitude\nPoint 001\t36.5\t-120.25\n');
  assert.deepEqual(tabbed[1], ['Point 001', '36.5', '-120.25']);
});

test('a headerless latitude, longitude pair stays two columns', () => {
  const rows = readTable('36.00584292777778,-120.12230357777777\n36.00613220277778,-120.12232058888888\n');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], ['36.00584292777778', '-120.12230357777777']);
});

test('a byte order mark does not become part of the first name', () => {
  const rows = readTable('\uFEFFname,latitude,longitude\nPoint 001,36.5,-120.25\n');
  assert.deepEqual(rows[0], ['name', 'latitude', 'longitude']);
});

// --- which columns the mapper starts on --------------------------------------

// A converter export: both axes four times each, plus State Plane, UTM and ECEF
// columns that the old easting/northing guess used to land on.
const COORDS_HEADER = [
  'RowID', 'Input_Ref_Frame', 'Output_Ref_frame', 'Input_Geopot_Datum', 'Output_Geopot_Datum',
  'Input_Lat(DD)', 'Input_Lat(DMS)', 'Input_Lon(DD)', 'Input_Lon(DMS)', 'Height_Units',
  'Input_Eht', 'Input_Orthoht', 'Output_Lat(DD)', 'Output_Lat(DMS)', 'Output_Lon(DD)', 'Output_Lon(DMS)',
  'Output_Eht', 'Output_Orthoht', 'Lat_Change(m)', 'Lat_Sigma(s)', 'Lat_Sigma(m)', 'Lon_Change(m)',
  'Lon_Sigma(s)', 'Lon_Sigma(m)', 'Eht_sigma', 'Orthoht_Sigma', 'SPCZone', 'SPCNorth(m)', 'SPCEast(m)',
  'SPCNorth(usft)', 'SPCEast(usft)', 'SPCNorth(ift)', 'SPCEast(ift)', 'SPCConvergence', 'SPCSF', 'SPCCF',
  'UTMZone', 'UTMNorth', 'UTMEast', 'UTMConvergence', 'UTMSF', 'UTMCF', 'X', 'Y', 'Z', 'USNG'
];

const pickColumns = window.northstarXYImport.pickColumns;

test('a converter export starts on its input decimal-degree columns', () => {
  const pair = pickColumns(COORDS_HEADER);
  assert.ok(pair, 'expected a latitude/longitude pair');
  assert.equal(COORDS_HEADER[pair.y], 'Input_Lat(DD)');
  assert.equal(COORDS_HEADER[pair.x], 'Input_Lon(DD)');
});

test('decimal degrees beat DMS wherever they sit, and both axes agree', () => {
  const pair = pickColumns(['name', 'latitude(dms)', 'longitude(dms)', 'latitude(dd)', 'longitude(dd)']);
  assert.equal(pair.y, 3);
  assert.equal(pair.x, 4);
});

test('output columns are only used when there is no input pair', () => {
  const pair = pickColumns(['RowID', 'Output_Lat(DD)', 'Output_Lon(DD)', 'Output_Lat(DMS)', 'Output_Lon(DMS)']);
  assert.equal(pair.y, 1);
  assert.equal(pair.x, 2);
});

test('a table with no latitude or longitude names leaves easting/northing guessing', () => {
  assert.equal(pickColumns(['point', 'easting', 'northing']), null);
  assert.equal(pickColumns(['Column 1', 'Column 2']), null);
});

test('a table offering several coordinate pairs opens the mapper', () => {
  const needsDialog = window.northstarXYImport.needsDialog;
  assert.equal(needsDialog([COORDS_HEADER, ['1']]), true);
  assert.equal(needsDialog([['name', 'latitude', 'longitude'], ['Point 001', '36.5', '-120.25']]), false);
  assert.equal(needsDialog([['Column 1', 'Column 2'], ['1', '2']]), true);
});

// --- the whole path, in the interface ---------------------------------------

function makeServer() {
  return createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname);
    const file = join(ROOT, relative);
    if (!file.startsWith(ROOT)) {
      response.writeHead(403);
      return response.end('Forbidden');
    }
    try {
      const body = await readFile(file);
      response.writeHead(200, {
        'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end('Not found');
    }
  });
}

let server;
let baseUrl;

before(async () => {
  server = makeServer();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  baseUrl = `http://127.0.0.1:${server.address().port}/`;
});

after(async () => {
  if (server) await new Promise(done => server.close(done));
});

test('the reported survey table imports its four points', async t => {
  let browser;
  try {
    browser = await chromium.launch({ channel: CHANNEL, headless: true });
  } catch (error) {
    t.skip(`no Chromium for channel "${CHANNEL}": ${String(error.message).split('\n')[0]}`);
    return;
  }
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.goto(baseUrl);
    await page.waitForFunction(() => !!window.northstarApp && !!window.northstarXYImport);
    await page.setInputFiles('#fileInput', {
      name: 'Survey workspace (3).csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(PIPE_TABLE, 'utf8')
    });
    await page.waitForFunction(() => {
      const saved = JSON.parse(localStorage.getItem('northstar-project') || '{}');
      return Array.isArray(saved.points) && saved.points.length >= 4;
    }, undefined, { timeout: 15000 });
    const points = await page.evaluate(() => JSON.parse(localStorage.getItem('northstar-project')).points);
    assert.deepEqual(points.map(point => point.name), ['Point 001', 'Point 002', 'Point 003', 'Point 004']);
    assert.ok(Math.abs(points[0].lat - 36.00584292777778) < 1e-12);
    assert.ok(Math.abs(points[0].lon + 120.12230357777777) < 1e-12);
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
    await browser.close();
  }
});
