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

  window.northstarDXF = { parse, rows, build };
})();
