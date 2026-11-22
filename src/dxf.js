// ASCII DXF point interchange.
//
// The parser accepts point-like entities from R12 and newer drawings: POINT,
// legacy POLYLINE vertices, and LWPOLYLINE vertices. Nearby TEXT entities are
// used as point names (for example TopoCal's "Numero" layer), while elevation
// text on "Z" layers is ignored. The writer emits a small R12-compatible
// POINT drawing with optional TEXT labels.
(function () {
  function finite(value) {
    return Number.isFinite(Number(value));
  }

  function dxfNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '0';
    return number.toFixed(6).replace(/\.?0+$/, '') || '0';
  }

  function textValue(value) {
    return String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim();
  }

  function pairs(text) {
    const lines = String(text == null ? '' : text).replace(/^\uFEFF/, '').split(/\r?\n/);
    const out = [];
    for (let index = 0; index + 1 < lines.length; index += 2) {
      const code = Number(lines[index].trim());
      if (!Number.isInteger(code)) continue;
      out.push({ code, value: lines[index + 1].trim() });
    }
    return out;
  }

  function first(values, code) {
    const found = values.find(value => value.code === code);
    return found ? found.value : '';
  }

  function all(values, code) {
    return values.filter(value => value.code === code).map(value => value.value);
  }

  function layerScore(layer) {
    const value = String(layer || '').toLowerCase();
    if (/^(z|elev|elevation|cota|height|level)$/.test(value)) return -1;
    if (/num|name|id|point|punto|station|label|marker|code|desc/.test(value)) return 2;
    return 1;
  }

  function parse(text) {
    if (/^AutoCAD Binary DXF/i.test(String(text == null ? '' : text).trim())) return [];
    const input = pairs(text);
    const rawPoints = [];
    const labels = [];
    let section = null;
    let entity = null;

    function consume(current) {
      if (!current) return;
      const values = current.values;
      const layer = first(values, 8);
      if (current.type === 'POINT' || current.type === 'VERTEX') {
        const x = Number(first(values, 10));
        const y = Number(first(values, 20));
        const z = Number(first(values, 30));
        if (finite(x) && finite(y)) rawPoints.push({ x, y, z: finite(z) ? z : 0 });
      } else if (current.type === 'LWPOLYLINE') {
        const xs = all(values, 10).map(Number);
        const ys = all(values, 20).map(Number);
        const count = Math.min(xs.length, ys.length);
        for (let index = 0; index < count; index++) {
          if (finite(xs[index]) && finite(ys[index])) {
            rawPoints.push({ x: xs[index], y: ys[index], z: 0 });
          }
        }
      } else if (current.type === 'TEXT' || current.type === 'MTEXT') {
        const x = Number(first(values, 10));
        const y = Number(first(values, 20));
        const value = textValue(first(values, 1));
        if (finite(x) && finite(y) && value) labels.push({ x, y, text: value, layer });
      }
    }

    for (const pair of input) {
      if (pair.code === 0 && pair.value === 'SECTION') {
        if (entity) consume(entity);
        entity = null;
        section = '';
        continue;
      }
      if (section === '' && pair.code === 2) {
        section = pair.value;
        continue;
      }
      if (pair.code === 0 && pair.value === 'ENDSEC') {
        if (entity) consume(entity);
        entity = null;
        section = null;
        continue;
      }
      if (section !== 'ENTITIES') continue;
      if (pair.code === 0) {
        if (entity) consume(entity);
        entity = { type: pair.value, values: [] };
      } else if (entity) {
        entity.values.push(pair);
      }
    }
    if (entity) consume(entity);

    const unique = new Map();
    rawPoints.forEach(point => {
      const key = point.x.toFixed(9) + '|' + point.y.toFixed(9);
      if (!unique.has(key)) unique.set(key, point);
    });
    const points = [...unique.values()];
    const used = new Set();
    points.forEach(point => {
      let best = null;
      let bestScore = -1;
      let bestDistance = Infinity;
      labels.forEach((label, index) => {
        if (used.has(index)) return;
        const score = layerScore(label.layer);
        if (score < 0) return;
        const distance = Math.hypot(label.x - point.x, label.y - point.y);
        if (score > bestScore || (score === bestScore && distance < bestDistance)) {
          best = { index, label };
          bestScore = score;
          bestDistance = distance;
        }
      });
      if (best) {
        point.name = best.label.text;
        used.add(best.index);
      }
    });

    return points.map((point, index) => ({
      x: point.x,
      y: point.y,
      z: point.z || 0,
      name: point.name || ('Point ' + (index + 1))
    }));
  }

  function rows(points) {
    return [['X', 'Y', 'Name']].concat((points || []).map(point => [
      dxfNumber(point.x),
      dxfNumber(point.y),
      point.name || ''
    ]));
  }

  function build(points) {
    const list = (points || []).filter(point => finite(point && point.x) && finite(point && point.y));
    if (!list.length) return '';

    const xs = list.map(point => Number(point.x));
    const ys = list.map(point => Number(point.y));
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const range = Math.max(maxX - minX, maxY - minY);
    const labelHeight = range > 0 ? Math.max(range / 200, 0.000001) : 0.25;
    const labelX = labelHeight * 0.5;
    const labelY = -labelHeight * 0.8;
    const out = [];
    const add = (code, value) => out.push(String(code), String(value));

    add(0, 'SECTION');
    add(2, 'HEADER');
    add(9, '$ACADVER');
    add(1, 'AC1009');
    add(9, '$INSBASE');
    add(10, '0');
    add(20, '0');
    add(30, '0');
    add(9, '$EXTMIN');
    add(10, dxfNumber(minX));
    add(20, dxfNumber(minY));
    add(30, '0');
    add(9, '$EXTMAX');
    add(10, dxfNumber(maxX));
    add(20, dxfNumber(maxY));
    add(30, '0');
    add(0, 'ENDSEC');
    add(0, 'SECTION');
    add(2, 'ENTITIES');

    list.forEach(point => {
      const x = Number(point.x);
      const y = Number(point.y);
      add(0, 'POINT');
      add(8, 'POINTS');
      add(10, dxfNumber(x));
      add(20, dxfNumber(y));
      add(30, dxfNumber(point.z || 0));
      const name = textValue(point.name);
      if (name) {
        add(0, 'TEXT');
        add(8, 'POINT LABELS');
        add(10, dxfNumber(x + labelX));
        add(20, dxfNumber(y + labelY));
        add(30, '0');
        add(40, dxfNumber(labelHeight));
        add(1, name.slice(0, 255));
      }
    });

    add(0, 'ENDSEC');
    add(0, 'EOF');
    return out.join('\r\n') + '\r\n';
  }

  // Project export for CAD.
  //
  // CADCraft (ArtCraft) reads DXF R12 through 2018, so this writer stays on R12
  // and uses the classic POLYLINE/VERTEX form: every DXF reader understands it,
  // where LWPOLYLINE needs R13 or newer. Geometry arrives already projected into
  // drawing units; this module only emits entities, never geodesy.
  const PROJECT_LAYERS = [
    ['NORTHSTAR-POINTS', 5],
    ['NORTHSTAR-LABELS', 7],
    ['NORTHSTAR-LINES', 3],
    ['NORTHSTAR-PARCELS', 3],
    ['NORTHSTAR-DIMENSIONS', 1],
    ['NORTHSTAR-BEARINGS', 2],
    ['NORTHSTAR-ANGLES', 6],
    ['NORTHSTAR-AREAS', 4],
    ['NORTHSTAR-NOTES', 8]
  ];

  function buildProject(model) {
    const data = model || {};
    const points = (data.points || []).filter(p => p && finite(p.x) && finite(p.y));
    const polylines = (data.polylines || []).filter(l => l && Array.isArray(l.points) && l.points.length > 1);
    const sides = (data.sides || []).filter(s => s && s.a && s.b && finite(s.a.x) && finite(s.b.x));
    const angles = (data.angles || []).filter(a => a && a.vertex && finite(a.vertex.x));
    const areas = (data.areas || []).filter(a => a && finite(a.x) && finite(a.y));
    const notes = (data.notes || []).map(textValue).filter(Boolean);
    const xs = [];
    const ys = [];
    const track = (x, y) => { xs.push(Number(x)); ys.push(Number(y)); };
    points.forEach(p => track(p.x, p.y));
    polylines.forEach(l => l.points.forEach(p => track(p.x, p.y)));
    sides.forEach(s => { track(s.a.x, s.a.y); track(s.b.x, s.b.y); });
    angles.forEach(a => track(a.vertex.x, a.vertex.y));
    areas.forEach(a => track(a.x, a.y));
    if (!xs.length) return '';

    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const range = Math.max(maxX - minX, maxY - minY);
    const th = range > 0 ? Math.max(range / 260, 0.0001) : 1;
    const noteTop = notes.length ? minY - th * 3 - (notes.length - 1) * th * 2.6 : minY;
    const out = [];
    const add = (code, value) => out.push(String(code), String(value));

    function line(x1, y1, x2, y2, layer) {
      add(0, 'LINE');
      add(8, layer);
      add(10, dxfNumber(x1));
      add(20, dxfNumber(y1));
      add(30, '0');
      add(11, dxfNumber(x2));
      add(21, dxfNumber(y2));
      add(31, '0');
    }

    function text(x, y, height, value, layer, rotation, centered) {
      const body = textValue(value);
      if (!body) return;
      add(0, 'TEXT');
      add(8, layer);
      add(10, dxfNumber(x));
      add(20, dxfNumber(y));
      add(30, '0');
      add(40, dxfNumber(height));
      add(1, body.slice(0, 255));
      const rot = Number(rotation);
      if (finite(rot) && rot) add(50, dxfNumber(((rot % 360) + 360) % 360));
      if (centered) {
        add(72, '1');
        add(73, '2');
        add(11, dxfNumber(x));
        add(21, dxfNumber(y));
        add(31, '0');
      }
    }

    add(0, 'SECTION');
    add(2, 'HEADER');
    add(9, '$ACADVER');
    add(1, 'AC1009');
    add(9, '$INSBASE');
    add(10, '0');
    add(20, '0');
    add(30, '0');
    add(9, '$EXTMIN');
    add(10, dxfNumber(minX));
    add(20, dxfNumber(noteTop));
    add(30, '0');
    add(9, '$EXTMAX');
    add(10, dxfNumber(maxX));
    add(20, dxfNumber(maxY));
    add(30, '0');
    add(0, 'ENDSEC');

    add(0, 'SECTION');
    add(2, 'TABLES');
    add(0, 'TABLE');
    add(2, 'LTYPE');
    add(70, '1');
    add(0, 'LTYPE');
    add(2, 'CONTINUOUS');
    add(70, '64');
    add(3, 'Solid line');
    add(72, '65');
    add(73, '0');
    add(40, '0');
    add(0, 'ENDTAB');
    add(0, 'TABLE');
    add(2, 'LAYER');
    add(70, String(PROJECT_LAYERS.length));
    PROJECT_LAYERS.forEach(entry => {
      add(0, 'LAYER');
      add(2, entry[0]);
      add(70, '64');
      add(62, String(entry[1]));
      add(6, 'CONTINUOUS');
    });
    add(0, 'ENDTAB');
    add(0, 'ENDSEC');

    add(0, 'SECTION');
    add(2, 'ENTITIES');

    points.forEach(point => {
      add(0, 'POINT');
      add(8, 'NORTHSTAR-POINTS');
      add(10, dxfNumber(point.x));
      add(20, dxfNumber(point.y));
      add(30, '0');
      text(point.x + th * 0.6, point.y + th * 0.45, th, point.name, 'NORTHSTAR-LABELS');
    });

    polylines.forEach(polyline => {
      const layer = polyline.closed ? 'NORTHSTAR-PARCELS' : 'NORTHSTAR-LINES';
      add(0, 'POLYLINE');
      add(8, layer);
      add(66, '1');
      add(70, polyline.closed ? '1' : '0');
      add(10, '0');
      add(20, '0');
      add(30, '0');
      polyline.points.forEach(vertex => {
        add(0, 'VERTEX');
        add(8, layer);
        add(10, dxfNumber(vertex.x));
        add(20, dxfNumber(vertex.y));
        add(30, '0');
      });
      add(0, 'SEQEND');
      add(8, layer);
      if (polyline.name) {
        const a = polyline.points[0];
        const b = polyline.points[1];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const length = Math.hypot(dx, dy) || 1;
        text((a.x + b.x) / 2 - dy / length * th * 1.8, (a.y + b.y) / 2 + dx / length * th * 1.8, th * 1.1, polyline.name, 'NORTHSTAR-LABELS');
      }
    });

    sides.forEach(side => {
      const a = side.a;
      const b = side.b;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.hypot(dx, dy) || 1;
      const nx = -dy / length;
      const ny = dx / length;
      const shift = (finite(side.shift) ? Number(side.shift) : 2.4) * th;
      const ax = a.x + nx * shift;
      const ay = a.y + ny * shift;
      const bx = b.x + nx * shift;
      const by = b.y + ny * shift;
      line(a.x, a.y, ax, ay, 'NORTHSTAR-DIMENSIONS');
      line(b.x, b.y, bx, by, 'NORTHSTAR-DIMENSIONS');
      line(ax, ay, bx, by, 'NORTHSTAR-DIMENSIONS');
      const tickX = dx / length * th * 0.6;
      const tickY = dy / length * th * 0.6;
      line(ax - tickX, ay - tickY, ax + tickX, ay + tickY, 'NORTHSTAR-DIMENSIONS');
      line(bx - tickX, by - tickY, bx + tickX, by + tickY, 'NORTHSTAR-DIMENSIONS');
      let rotation = Math.atan2(dy, dx) * 180 / Math.PI;
      if (rotation > 90) rotation -= 180;
      if (rotation <= -90) rotation += 180;
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      const lift = shift >= 0 ? th : -th;
      text(mx + nx * lift, my + ny * lift, th * 1.15, side.label, 'NORTHSTAR-DIMENSIONS', rotation, true);
      if (side.bearing) text(mx + nx * lift * 2.2, my + ny * lift * 2.2, th, side.bearing, 'NORTHSTAR-BEARINGS', rotation, true);
    });

    angles.forEach(angle => {
      const radius = Math.max(finite(angle.radius) ? Number(angle.radius) : 0, th * 1.4);
      const start = ((Number(angle.start) % 360) + 360) % 360;
      const end = ((Number(angle.end) % 360) + 360) % 360;
      add(0, 'ARC');
      add(8, 'NORTHSTAR-ANGLES');
      add(10, dxfNumber(angle.vertex.x));
      add(20, dxfNumber(angle.vertex.y));
      add(30, '0');
      add(40, dxfNumber(radius));
      add(50, dxfNumber(start));
      add(51, dxfNumber(end));
      const sweep = ((end - start) + 360) % 360 || 360;
      const mid = (start + sweep / 2) * Math.PI / 180;
      text(angle.vertex.x + Math.cos(mid) * (radius + th * 1.7), angle.vertex.y + Math.sin(mid) * (radius + th * 1.7), th, angle.label, 'NORTHSTAR-ANGLES', 0, true);
    });

    areas.forEach(area => {
      text(area.x, area.y, th * 1.3, area.label, 'NORTHSTAR-AREAS', 0, true);
    });

    notes.forEach((note, index) => {
      text(minX, minY - th * 3 - index * th * 2.6, th * 1.25, note, 'NORTHSTAR-NOTES');
    });

    add(0, 'ENDSEC');
    add(0, 'EOF');
    return out.join('\r\n') + '\r\n';
  }

  window.northstarDXF = { parse, rows, build, buildProject };
})();
