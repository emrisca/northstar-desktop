// Desktop partition regression harness.
//
// Serves src/ over loopback, runs the real desktop interface in Chrome, and
// checks that every partition preview agrees with the area measurement saved
// from the accepted part. The four dialog methods are area, equal, cut, draw.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'src');
const FT2_PER_M2 = 0.09290304;
const LAT0 = 37.7749;
const LON0 = -122.4194;
const FT_LAT = (feet) => (feet * 0.3048) / 111320;
const FT_LON = (feet) => (feet * 0.3048) / (111320 * Math.cos(LAT0 * Math.PI / 180));

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

function projectState() {
  return {
    center: { lat: LAT0 + FT_LAT(30), lon: LON0 + FT_LON(50) },
    zoom: 19,
    layer: 'blank',
    points: [
      { id: 'p1', name: 'SW', lat: LAT0, lon: LON0 },
      { id: 'p2', name: 'SE', lat: LAT0, lon: LON0 + FT_LON(100) },
      { id: 'p3', name: 'NE', lat: LAT0 + FT_LAT(60), lon: LON0 + FT_LON(80) },
      { id: 'p4', name: 'NW', lat: LAT0 + FT_LAT(60), lon: LON0 }
    ],
    lines: [{ id: 'line-test', name: 'Trapezoid', ids: ['p1', 'p2', 'p3', 'p4'], closed: true, color: '#21a67a' }],
    measurements: [],
    features: [],
    selected: 'line-test',
    tool: 'select'
  };
}

const SETTINGS = {
  theme: 'light',
  accent: 'blue',
  terrainProfile: false,
  areaUnit: 'ft2',
  lenUnit: 'ft',
  projectCrs: 'EPSG:4326',
  measureAreaUnit: 'ft2',
  measureLenUnit: 'ft',
  parcelSource: 'auto'
};

function makeServer() {
  return createServer(async (request, response) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url || '/', 'http://127.0.0.1').pathname);
    } catch {
      response.writeHead(400);
      response.end('Bad request');
      return;
    }
    if (pathname === '/') pathname = '/index.html';
    const file = resolve(ROOT, '.' + pathname);
    if (!file.startsWith(ROOT + sep)) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
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
let browser;

before(async () => {
  server = makeServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function openPage() {
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    serviceWorkers: 'block'
  });
  const page = await context.newPage();
  await page.goto(baseUrl);
  await page.evaluate(({ project, settings }) => {
    localStorage.setItem('northstar-project', JSON.stringify(project));
    localStorage.setItem('northstar-settings', JSON.stringify(settings));
  }, { project: projectState(), settings: SETTINGS });
  await page.reload();
  await page.waitForFunction(() => !!window.northstarApp && !!window.northstarGeodesy);
  await page.waitForSelector('#propertyMeasurePreview');
  return { context, page };
}

async function previewAreas(page) {
  return page.locator('.partition-part').evaluateAll(rows => rows.map(row => {
    const text = row.querySelector('span')?.textContent || '';
    return { text: text.trim(), value: Number(text.replace(/[^0-9.]/g, '')) };
  }));
}

async function acceptAndTag(page) {
  await page.click('#partitionAcceptBtn');
  await page.waitForFunction(() => !document.querySelector('#partitionDialog').open);
  await page.waitForFunction(() => window.northstarApp.S.lines.length === 2);

  const accepted = await page.evaluate(() => {
    const A = window.northstarApp;
    return A.S.lines.map(line => {
      const ring = line.ids.map(id => A.S.points.find(point => point.id === id)).filter(Boolean)
        .map(point => [point.lon, point.lat]);
      return {
        id: line.id,
        areaFt2: window.northstarGeodesy.areaSquareMeters('geographiclib', ring) / 0.09290304
      };
    });
  });
  assert.equal(accepted.length, 2);

  const tags = [];
  for (const line of accepted) {
    await page.evaluate(id => {
      const A = window.northstarApp;
      A.S.selected = id;
      A.inspect();
    }, line.id);
    await page.waitForSelector('#savePropertyMeasurement');
    await page.click('#savePropertyMeasurement');
    await page.waitForFunction(() => /Saved measurement/.test(document.querySelector('#propertyMeasurePreview')?.textContent || ''));
    const text = await page.locator('#propertyMeasurePreview').innerText();
    tags.push({
      text,
      value: Number((text.match(/([\d,]+(?:\.\d+)?)\s*ft²/) || [])[1]?.replace(/,/g, ''))
    });
  }
  assert.equal(await page.evaluate(() => window.northstarApp.S.measurements.length), 2);
  return { accepted, tags };
}

async function drawVerticalCut(page) {
  await page.selectOption('#partitionMethod', 'draw');
  await page.selectOption('#partitionDrawAxis', 'ns');
  await page.click('#partitionDrawBtn');
  await page.waitForFunction(() => !document.querySelector('#partitionDialog').open);

  const canvas = await page.locator('#mapCanvas').boundingBox();
  assert.ok(canvas, 'map canvas should be visible');
  const points = await page.evaluate(() => {
    const A = window.northstarApp;
    const S = A.S;
    const p1 = S.points.find(point => point.id === 'p1');
    const p2 = S.points.find(point => point.id === 'p2');
    const p4 = S.points.find(point => point.id === 'p4');
    const lon = (p1.lon + p2.lon) / 2;
    const north = p4.lat - p1.lat;
    const my = lat => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) * 180 / Math.PI;
    const world = (lat, longitude, zoom) => {
      const size = 256 * 2 ** zoom;
      return {
        x: (longitude + 180) / 360 * size,
        y: (1 - my(lat) / 180) / 2 * size
      };
    };
    const center = world(S.center.lat, S.center.lon, S.zoom);
    const rect = document.querySelector('#mapCanvas').getBoundingClientRect();
    const screen = (lat, longitude) => {
      const point = world(lat, longitude, S.zoom);
      return {
        x: point.x - center.x + rect.width / 2,
        y: point.y - center.y + rect.height / 2
      };
    };
    return [
      screen(p1.lat - north * 0.3, lon),
      screen(p4.lat + north * 0.3, lon)
    ];
  });

  // Dispatch on the canvas directly. The canvas can have pointer-events:none
  // until the blank-grid class is applied, but the app listens on the canvas.
  for (const point of points) {
    await page.evaluate(({ x, y }) => {
      const target = document.querySelector('#mapCanvas');
      const rect = target.getBoundingClientRect();
      target.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        clientX: rect.left + x,
        clientY: rect.top + y
      }));
    }, point);
    await page.waitForTimeout(80);
  }
  await page.waitForFunction(() => document.querySelector('#partitionDialog').open);
}

async function runPartition(method) {
  const { context, page } = await openPage();
  try {
    await page.click('#partitionParcelBtn');
    await page.waitForSelector('#partitionDialog[open]');
    await page.selectOption('#partitionMethod', method);
    await page.selectOption('#partitionAreaUnit', 'ft2');

    if (method === 'area') {
      await page.fill('#partitionTarget', '1200');
      await page.click('#partitionPreviewBtn');
    } else if (method === 'equal') {
      await page.selectOption('#partitionOrient', 'vertical');
      await page.fill('#partitionCount', '2');
      await page.click('#partitionPreviewBtn');
    } else if (method === 'cut') {
      await page.selectOption('#partitionCutFrom', '0');
      await page.selectOption('#partitionCutTo', '2');
      await page.click('#partitionPreviewBtn');
    } else {
      await drawVerticalCut(page);
    }

    await page.waitForFunction(() => /passes all constraints/.test(document.querySelector('#partitionPreview')?.textContent || ''));
    const preview = await previewAreas(page);
    assert.equal(preview.length, 2, method + ' should preview two parts');
    assert.ok(preview.every(part => Number.isFinite(part.value)), method + ' should show numeric preview areas');

    const { accepted, tags } = await acceptAndTag(page);
    accepted.forEach((line, index) => {
      assert.ok(
        Math.abs(line.areaFt2 - preview[index].value) < 0.02,
        `${method} part ${index + 1}: preview ${preview[index].text} should match accepted GeographicLib ${line.areaFt2.toFixed(3)} ft²`
      );
      assert.ok(
        Math.abs(line.areaFt2 - tags[index].value) < 0.02,
        `${method} part ${index + 1}: saved tag ${tags[index].text} should match accepted GeographicLib ${line.areaFt2.toFixed(3)} ft²`
      );
    });
  } finally {
    await context.close();
  }
}

for (const method of ['area', 'equal', 'cut', 'draw']) {
  test(`desktop partition ${method} preview matches saved area tags`, async () => {
    await runPartition(method);
  });
}
