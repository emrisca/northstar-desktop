// DXF project export structure.
//
// Loads src/dxf.js as a plain script with a window stub, builds a small parcel
// and checks the entity stream a CAD reader receives. This is structural: it
// proves the writer emits the layers, points, closed polyline, dimensions,
// bearings, angles and notes in the order and codes DXF expects. It does not
// open the file in CADCraft.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'src', 'dxf.js');

async function loadWriter() {
  const code = await readFile(SOURCE, 'utf8');
  const sandbox = { window: {} };
  new Function('window', code)(sandbox.window);
  return sandbox.window.northstarDXF;
}

function pairs(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let index = 0; index + 1 < lines.length; index += 2) {
    out.push([lines[index].trim(), lines[index + 1].trim()]);
  }
  return out;
}

function entities(text) {
  const out = [];
  let section = null;
  let current = null;
  for (const [code, value] of pairs(text)) {
    if (code === '0' && value === 'SECTION') {
      section = null;
      current = null;
      continue;
    }
    if (section === null && code === '2') {
      section = value;
      continue;
    }
    if (code === '0' && value === 'ENDSEC') {
      if (current) out.push(current);
      current = null;
      section = null;
      continue;
    }
    if (section !== 'ENTITIES') continue;
    if (code === '0') {
      if (current) out.push(current);
      current = { type: value, values: [] };
    } else if (current) {
      current.values.push([code, value]);
    }
  }
  if (current) out.push(current);
  return out;
}

function value(entity, code) {
  const found = entity.values.find(pair => pair[0] === code);
  return found ? found[1] : '';
}

function square(x, y, size) {
  return [
    { x, y },
    { x: x + size, y },
    { x: x + size, y: y + size },
    { x, y: y + size }
  ];
}

function parcelModel() {
  const ring = square(500000, 4100000, 100);
  return {
    name: 'Test parcel',
    points: ring.map((point, index) => ({ ...point, name: ['SW', 'SE', 'NE', 'NW'][index] })),
    polylines: [{ name: 'Boundary', closed: true, points: ring }],
    sides: [
      { a: ring[0], b: ring[1], shift: -2.4, label: '100 m', bearing: 'N 90°00\'00" E' },
      { a: ring[1], b: ring[2], shift: -2.4, label: '100 m', bearing: 'N 0°00\'00" E' },
      { a: ring[2], b: ring[3], shift: -2.4, label: '100 m', bearing: 'N 90°00\'00" W' },
      { a: ring[3], b: ring[0], shift: -2.4, label: '100 m', bearing: 'S 0°00\'00" W' }
    ],
    angles: ring.map((vertex, index) => ({
      vertex,
      radius: 20,
      start: index * 45,
      end: index * 45 + 90,
      label: '90°00\'00"'
    })),
    areas: [{ x: 500050, y: 4100050, label: 'Area 1 ha' }],
    notes: ['Test parcel', 'Drawing units: metres']
  };
}

test('buildProject writes an R12 entity stream CADCraft can read', async () => {
  const writer = await loadWriter();
  const drawing = writer.buildProject(parcelModel());

  assert.ok(drawing.endsWith('EOF\r\n'), 'drawing ends with EOF');
  assert.match(drawing, /\$ACADVER\r\n1\r\nAC1009/, 'header declares R12');

  const layers = drawing.split('\r\n').join('\n').match(/NORTHSTAR-[A-Z]+/g) || [];
  for (const layer of ['NORTHSTAR-POINTS', 'NORTHSTAR-PARCELS', 'NORTHSTAR-DIMENSIONS', 'NORTHSTAR-BEARINGS', 'NORTHSTAR-ANGLES', 'NORTHSTAR-AREAS', 'NORTHSTAR-NOTES']) {
    assert.ok(layers.includes(layer), layer + ' is in the layer table');
  }

  const items = entities(drawing);
  const count = type => items.filter(item => item.type === type).length;

  assert.equal(count('POINT'), 4, 'one POINT per waypoint');
  assert.equal(count('POLYLINE'), 1, 'one POLYLINE per parcel');
  assert.equal(count('VERTEX'), 4, 'one VERTEX per corner');
  assert.equal(count('SEQEND'), 1, 'the polyline closes with SEQEND');
  assert.equal(count('ARC'), 4, 'one angle arc per corner');
  assert.equal(count('LINE'), 20, 'five dimension lines for each of four sides');

  const polyline = items.find(item => item.type === 'POLYLINE');
  assert.equal(value(polyline, '70'), '1', 'closed parcel sets the closed flag');
  assert.equal(value(polyline, '66'), '1', 'vertices follow the polyline');

  const arc = items.find(item => item.type === 'ARC');
  const start = Number(value(arc, '50'));
  const end = Number(value(arc, '51'));
  assert.ok(start >= 0 && start < 360, 'arc start is normalised');
  assert.ok(end >= 0 && end < 360, 'arc end is normalised');

  const labels = items.filter(item => item.type === 'TEXT').map(item => value(item, '1'));
  assert.ok(labels.includes('SW'), 'waypoint names are written');
  assert.ok(labels.includes('Boundary'), 'parcel name is written');
  assert.ok(labels.includes('100 m'), 'side distance is written');
  assert.ok(labels.includes('90°00\'00"'), 'interior angle is written');
  assert.ok(labels.includes('Area 1 ha'), 'area is written');
  assert.ok(labels.includes('Drawing units: metres'), 'note block is written');

  const centred = items.filter(item => item.type === 'TEXT' && value(item, '72') === '1' && value(item, '73') === '2');
  assert.ok(centred.length >= 9, 'dimension, angle and area labels are centre aligned');
});

test('the point parser reads the drawn geometry back', async () => {
  const writer = await loadWriter();
  const drawing = writer.buildProject(parcelModel());
  const points = writer.parse(drawing);

  assert.equal(points.length, 4, 'the four shared corner coordinates collapse to four points');
  const names = points.map(point => point.name);
  for (const name of ['SW', 'SE', 'NE', 'NW']) {
    assert.ok(names.includes(name), name + ' survives the round trip');
  }
});

test('buildProject refuses an empty model', async () => {
  const writer = await loadWriter();
  assert.equal(writer.buildProject({}), '');
  assert.equal(writer.buildProject({ points: [] }), '');
});

test('open lines still export their sides', async () => {
  const writer = await loadWriter();
  const drawing = writer.buildProject({
    points: [{ x: 0, y: 0, name: 'A' }, { x: 30, y: 40, name: 'B' }],
    polylines: [{ name: 'Traverse', closed: false, points: [{ x: 0, y: 0 }, { x: 30, y: 40 }] }],
    sides: [{ a: { x: 0, y: 0 }, b: { x: 30, y: 40 }, shift: 2.4, label: '50 m', bearing: 'N 53°07\'48" E' }]
  });

  const items = entities(drawing);
  assert.equal(items.filter(item => item.type === 'POLYLINE')[0] && value(items.find(item => item.type === 'POLYLINE'), '70'), '0');
  assert.equal(items.filter(item => item.type === 'ARC').length, 0, 'no interior angle without a closed ring');
  assert.ok(items.filter(item => item.type === 'TEXT').map(item => value(item, '1')).includes('50 m'));
});
