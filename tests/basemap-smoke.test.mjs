// Every 2D basemap, against the provider that feeds it.
//
// The interface is served here and Chrome loads it with the network on, so each
// picker entry is asked to draw and the tile responses are counted. This is the
// check that a provider URL or a template token still resolves; it needs the
// internet, so it is not part of `npm test`.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'src');
const MIME = { '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };

const VECTOR_MAPS = new Set(['openmaptiles', 'openTopoVector', 'positron', 'darkMatter', 'openHistoricalMap', 'ohmWoodblock', 'ohmJapaneseScroll', 'ohmRailway']);

const MAPS = [
  ['street', 'Street map'],
  ['openmaptiles', 'OpenMapTiles vector'],
  ['openTopoVector', 'OpenFreeMap Bright'],
  ['hot', 'OSM Humanitarian'],
  ['eoxS2', 'Sentinel-2 cloudless'],
  ['aerial', 'High-res aerial (U.S.)'],
  ['naip', 'USDA NAIP aerial'],
  ['imagery', 'World imagery (Esri)'],
  ['imageryClarity', 'Esri Clarity imagery'],
  ['topo', 'Topographic map'],
  ['topoOpen', 'OpenTopoMap'],
  ['positron', 'Positron (light)'],
  ['esriGray', 'Esri Light Gray'],
  ['darkMatter', 'Dark Matter (dark)'],
  ['esriDarkGray', 'Esri Dark Gray'],
  ['esriNatgeo', 'NatGeo World Map'],
  ['openHistoricalMap', 'OpenHistoricalMap'],
  ['ohmWoodblock', 'Woodblock'],
  ['ohmJapaneseScroll', 'Japanese scroll'],
  ['ohmRailway', 'Railway'],
  ['blank', 'Blank grid']
];

let server, baseUrl, browser;

before(async () => {
  server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const path = join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!path.startsWith(ROOT)) return response.writeHead(403).end();
    try {
      const body = await readFile(path);
      response.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream' });
      response.end(body);
    } catch {
      response.writeHead(404).end('not found');
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  baseUrl = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise((done) => server.close(done));
});

test('every 2D basemap draws from its provider', async () => {
  const page = await browser.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  await page.goto(`${baseUrl}index.html?maps=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.northstarApp, null, { timeout: 20_000 });

  const rows = [];
  const failures = [];
  for (const [id, name] of MAPS) {
    const seen = [];
    const onResponse = (response) => {
      const url = response.url();
      if (!url.startsWith(baseUrl) && /^https?:/.test(url)) {
        seen.push({ url, status: response.status() });
      }
    };
    const onFailed = (request) => {
      const url = request.url();
      if (!url.startsWith(baseUrl) && /^https?:/.test(url)) seen.push({ url, status: 0 });
    };
    page.on('response', onResponse);
    page.on('requestfailed', onFailed);
    const before = consoleErrors.length;
    const errorsBefore = pageErrors.length;
    await page.evaluate((next) => {
      const app = window.northstarApp;
      app.S.layer = next;
      app.S.hidden.base = false;
      app.refreshBaseLayer(true);
    }, id);
    await page.waitForTimeout(VECTOR_MAPS.has(id) ? 8000 : 5000);
    page.off('response', onResponse);
    page.off('requestfailed', onFailed);

    const ok = seen.filter((r) => r.status >= 200 && r.status < 400).length;
    const bad = seen.filter((r) => r.status === 0 || r.status >= 400);
    const banner = await page.evaluate(() => !document.getElementById('mapError').hidden);
    const sample = bad[0] ? `${bad[0].status} ${bad[0].url.slice(0, 110)}` : '';
    rows.push({ id, name, ok, bad: bad.length, banner, errors: consoleErrors.length - before, thrown: pageErrors.slice(errorsBefore), sample });
    if (id !== 'blank' && ok === 0) failures.push(`${name} (${id}): no tile loaded${sample ? ' — ' + sample : ''}`);
    if (banner) failures.push(`${name} (${id}): the map error banner is showing${sample ? ' — ' + sample : ''}`);
  }
  await page.close();

  console.log('');
  for (const row of rows) {
    const state = row.ok === 0 && row.id !== 'blank' ? 'FAIL' : row.banner ? 'FAIL' : 'ok';
    console.log(`  ${state.padEnd(4)} ${row.id.padEnd(18)} ${String(row.ok).padStart(3)} loaded ${String(row.bad).padStart(3)} failed ${row.errors ? row.errors + ' console' : ''}${row.thrown && row.thrown.length ? ' THREW ' + row.thrown[0].slice(0, 160) : ''} ${row.sample}`);
  }
  assert.deepEqual(failures, [], `basemaps not drawing:\n${failures.join('\n')}`);
});
