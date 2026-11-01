// Load budget harness.
//
// Batch 6 asks for two measured budgets: a cold start, and an index rebuild on a
// ten thousand waypoint fixture, with dragging still responsive. This runs the
// real interface in Chrome with every non-local request blocked, builds the
// fixture the way an imported project arrives, and times the work the app does
// on the load path and per frame. The numbers are printed, so a pass is a
// measurement rather than a claim.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'src');
const POINTS = 10_000;
const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

function makeServer() {
  return createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const path = join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!path.startsWith(ROOT)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(path);
      response.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream' });
      response.end(body);
    } catch {
      response.writeHead(404).end('not found');
    }
  });
}

let server;
let baseUrl;
let browser;

before(async () => {
  server = makeServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  baseUrl = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise((done) => server.close(done));
});

test('a ten thousand waypoint project loads, indexes and draws within budget', async () => {
  const page = await browser.newPage();
  // Networking off: only this server answers, which is the field case the
  // budget is for. Tiles and styles fail fast instead of waiting.
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(baseUrl)) return route.continue();
    return route.abort();
  });

  await page.goto(`${baseUrl}index.html?budget=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.northstarApp, null, { timeout: 20_000 });

  const numbers = await page.evaluate((count) => {
    const app = window.northstarApp;
    const S = app.S;
    const now = () => performance.now();

    // The fixture: a 10 000 waypoint grid over a county-sized area, plus the
    // boundaries and measurements a real project carries.
    const points = [];
    for (let i = 0; i < count; i++) {
      points.push({
        id: `p${i}`,
        name: `WP-${String(i + 1).padStart(5, '0')}`,
        lat: 37.7 + ((i % 100) * 0.0004),
        lon: -122.5 + (Math.floor(i / 100) * 0.0004)
      });
    }
    const lines = [];
    for (let i = 0; i < 50; i++) {
      const ids = [];
      for (let k = 0; k < 4; k++) ids.push(`p${i * 4 + k}`);
      lines.push({ id: `line${i}`, name: `Parcel ${i + 1}`, ids, closed: true, color: '#21a67a' });
    }

    // A street basemap so a real Leaflet map exists: the hit index is only built
    // when there is a map to project through.
    S.layer = 'street';
    app.refreshBaseLayer();

    const start = now();
    S.points = points;
    S.lines = lines;
    app.draw();
    app.refreshTree();
    app.save();
    const load = now() - start;

    const index = app.hitIndexRebuild();

    const frames = [];
    for (let i = 0; i < 20; i++) {
      const frame = now();
      app.draw();
      frames.push(now() - frame);
    }
    frames.sort((a, b) => a - b);

    const treeStart = now();
    app.refreshTree();
    const tree = now() - treeStart;

    const saveStart = now();
    S.points = S.points.slice();
    app.save();
    const save = now() - saveStart;

    return {
      points: S.points.length,
      load,
      index,
      drawMedian: frames[Math.floor(frames.length / 2)],
      drawWorst: frames[frames.length - 1],
      tree,
      save
    };
  }, POINTS);

  await page.close();

  console.log(`  fixture: ${numbers.points} waypoints, 50 boundaries`);
  console.log(`  cold load (apply + tree + save): ${numbers.load.toFixed(0)} ms`);
  console.log(`  hit index rebuild: ${numbers.index.toFixed(0)} ms`);
  console.log(`  draw per frame: median ${numbers.drawMedian.toFixed(1)} ms, worst ${numbers.drawWorst.toFixed(1)} ms`);
  console.log(`  object tree rebuild: ${numbers.tree.toFixed(0)} ms`);
  console.log(`  project save (serialise): ${numbers.save.toFixed(0)} ms`);

  assert.ok(numbers.load < 2000, `cold load was ${numbers.load.toFixed(0)} ms, budget 2000 ms`);
  assert.ok(numbers.index < 2000, `index rebuild was ${numbers.index.toFixed(0)} ms, budget 2000 ms`);
  assert.ok(numbers.drawMedian < 100, `median draw was ${numbers.drawMedian.toFixed(1)} ms, budget 100 ms`);
});
