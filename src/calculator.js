(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const panel = $('#calcPanel');
  if (!panel) return;

  const MODES = ['basic', 'scientific', 'programmer', 'convert', 'rpn', 'notes'];
  const MODE_NAMES = {
    basic: 'Basic', scientific: 'Scientific', programmer: 'Programmer',
    convert: 'Convert', rpn: 'RPN', notes: 'Notes'
  };
  const LS = {
    open: 'northstar-calc-open',
    size: 'northstar-calc-size',
    pos: 'northstar-calc-pos',
    mode: 'northstar-calc-mode',
    history: 'northstar-calc-history',
    angle: 'northstar-calc-angle',
    base: 'northstar-calc-base',
    bits: 'northstar-calc-bits',
    signed: 'northstar-calc-signed',
    notes: 'northstar-calc-notes',
    rates: 'northstar-calc-rates'
  };

  const dom = {
    button: $('#calcBtn'),
    panel,
    head: $('#calcHead'),
    display: $('#calcDisplay'),
    expr: $('#calcExpr'),
    sub: $('#calcSub'),
    keys: $('#calcKeys'),
    extra: $('#calcExtra'),
    flags: $('#calcFlags'),
    memoryFlag: $('#calcMemoryFlag'),
    angleFlag: $('#calcAngleFlag'),
    baseFlag: $('#calcBaseFlag'),
    wordFlag: $('#calcWordFlag'),
    modeName: $('#calcModeName'),
    modes: $('#calcModes'),
    historyBtn: $('#calcHistoryBtn'),
    copyBtn: $('#calcCopyBtn'),
    helpBtn: $('#calcHelpBtn'),
    close: $('#calcClose'),
    historyDrawer: $('#calcHistoryDrawer'),
    historyList: $('#calcHistoryList'),
    historyEmpty: $('#calcHistoryEmpty'),
    historyClear: $('#calcHistoryClear'),
    historyClose: $('#calcHistoryClose'),
    helpDrawer: $('#calcHelpDrawer'),
    helpClose: $('#calcHelpClose'),
    resize: $('#calcResize'),
    convert: $('#calcConvert'),
    convCategory: $('#calcConvCategory'),
    convFrom: $('#calcConvFrom'),
    convTo: $('#calcConvTo'),
    convFromUnit: $('#calcConvFromUnit'),
    convToUnit: $('#calcConvToUnit'),
    convSwap: $('#calcConvSwap'),
    convNote: $('#calcConvNote'),
    notes: $('#calcNotes'),
    notesInput: $('#calcNotesInput'),
    notesRun: $('#calcNotesRun'),
    notesClear: $('#calcNotesClear'),
    notesGraph: $('#calcNotesGraph'),
    notesStatus: $('#calcNotesStatus'),
    notesOutput: $('#calcNotesOutput'),
    notesCanvas: $('#calcNotesCanvas')
  };

  const readString = (key, fallback) => {
    try { const value = localStorage.getItem(key); return value === null ? fallback : value; }
    catch (error) { return fallback; }
  };
  const write = (key, value) => { try { localStorage.setItem(key, value); } catch (error) {} };
  const readJSON = (key, fallback) => {
    try { const value = localStorage.getItem(key); return value ? JSON.parse(value) : fallback; }
    catch (error) { return fallback; }
  };
  const writeJSON = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch (error) {} };

  const escapeHTML = value => String(value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));

  /* ---------------------------------------------------------------- numbers */
  function cleanFloat(value, sig = 12) {
    if (typeof value === 'bigint') return value.toString();
    const n = Number(value);
    if (Number.isNaN(n)) return 'NaN';
    if (!Number.isFinite(n)) return n > 0 ? 'Infinity' : '-Infinity';
    if (Object.is(n, -0)) return '0';
    const abs = Math.abs(n);
    if (abs !== 0 && (abs >= 1e15 || abs < 1e-9)) {
      return n.toExponential(Math.min(10, Math.max(1, sig - 2)))
        .replace(/\.?0+e/, 'e').replace('e+', 'e');
    }
    let text = Number(n.toPrecision(sig)).toString();
    if (text.includes('e')) text = n.toExponential(8).replace(/\.?0+e/, 'e').replace('e+', 'e');
    return text;
  }

  function groupString(value) {
    const text = String(value);
    const match = text.match(/^(-?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
    if (!match) return text;
    const integer = match[2].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return match[1] + integer + (match[3] !== undefined ? '.' + match[3] : '') + (match[4] ? 'e' + match[4] : '');
  }

  const formatNumber = (value, sig = 12) => groupString(cleanFloat(value, sig));
  function tidyNumber(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return n;
    const rounded = Math.round(n);
    return Math.abs(n - rounded) < 1e-9 * Math.max(1, Math.abs(n)) ? rounded : n;
  }
  const formatInput = value => groupString(String(value));
  const rawNumber = (value, sig = 12) => cleanFloat(value, sig);
  const pretty = value => formatNumber(value);
  const symbol = op => ({ '+': '+', '-': '−', '*': '×', '/': '÷' }[op] || op);

  /* ---------------------------------------------------------------- parser */
  const FUNCTIONS = {
    sin: 1, cos: 1, tan: 1, asin: 1, acos: 1, atan: 1,
    sinh: 1, cosh: 1, tanh: 1, asinh: 1, acosh: 1, atanh: 1,
    ln: 1, log: 1, log2: 1, sqrt: 1, cbrt: 1, abs: 1,
    floor: 1, ceil: 1, round: 1, trunc: 1, sign: 1, exp: 1,
    pow10: 1, inv: 1, gamma: 1,
    pow: 2, root: 2, min: 2, max: 2, gcd: 2, lcm: 2, mod: 2, logb: 2,
    rand: 0
  };

  function gamma(n) {
    if (n <= 0 && Number.isInteger(n)) return NaN;
    const cof = [76.18009172947146, -86.50532032941677, 24.01409824083091,
      -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    let y = n;
    let x = n;
    let tmp = x + 5.5;
    tmp -= (x + 0.5) * Math.log(tmp);
    let ser = 1.000000000190015;
    for (const c of cof) ser += c / ++y;
    return Math.exp(-tmp + Math.log(2.5066282746310005 * ser / x));
  }

  function factorial(n) {
    if (!Number.isInteger(n)) return gamma(n + 1);
    if (n < 0) return NaN;
    if (n > 170) return Infinity;
    let out = 1;
    for (let i = 2; i <= n; i++) out *= i;
    return out;
  }

  function tokenize(input) {
    const tokens = [];
    let i = 0;
    const source = String(input);
    while (i < source.length) {
      const c = source[i];
      if (/\s/.test(c)) { i++; continue; }
      if (/[0-9.]/.test(c)) {
        const number = source.slice(i).match(/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/);
        if (!number) throw new Error('Invalid number');
        tokens.push({ type: 'number', value: number[0] });
        i += number[0].length;
        continue;
      }
      if (/[A-Za-z_π°]/.test(c)) {
        if (c === 'π') { tokens.push({ type: 'name', value: 'pi' }); i++; continue; }
        if (c === '°') { tokens.push({ type: 'name', value: 'deg' }); i++; continue; }
        const name = source.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/);
        tokens.push({ type: 'name', value: name[0] });
        i += name[0].length;
        continue;
      }
      if ('+-*/^!%(),'.includes(c)) { tokens.push({ type: 'op', value: c }); i++; continue; }
      if (c === '×' || c === '÷' || c === '−') {
        tokens.push({ type: 'op', value: c === '×' ? '*' : c === '÷' ? '/' : '-' });
        i++;
        continue;
      }
      throw new Error('Unexpected character ' + c);
    }
    return tokens;
  }

  function evaluateExpression(input, variables = {}, angle = 'deg') {
    const tokens = tokenize(input);
    let index = 0;

    const peek = () => tokens[index];
    const matchOp = value => {
      if (tokens[index] && tokens[index].type === 'op' && tokens[index].value === value) {
        index++;
        return true;
      }
      return false;
    };
    const matchName = value => {
      if (tokens[index] && tokens[index].type === 'name' && tokens[index].value.toLowerCase() === value) {
        index++;
        return true;
      }
      return false;
    };
    const startsPrimary = () => {
      const token = tokens[index];
      if (!token) return false;
      return token.type === 'number' || token.type === 'name' ||
        (token.type === 'op' && token.value === '(');
    };
    const toRadians = x => angle === 'deg' ? x * Math.PI / 180 : x;
    const fromRadians = x => angle === 'deg' ? x * 180 / Math.PI : x;

    function parseExpression() {
      let value = parseTerm();
      while (true) {
        if (matchOp('+')) value += parseTerm();
        else if (matchOp('-')) value -= parseTerm();
        else break;
      }
      return value;
    }

    function parseTerm() {
      let value = parseUnary();
      while (true) {
        if (matchOp('*')) value *= parseUnary();
        else if (matchOp('/')) {
          const divisor = parseUnary();
          if (divisor === 0) throw new Error('Cannot divide by zero');
          value /= divisor;
        } else if (startsPrimary()) {
          value *= parseUnary();
        } else break;
      }
      return value;
    }

    function parseUnary() {
      if (matchOp('+')) return parseUnary();
      if (matchOp('-')) return -parseUnary();
      return parsePower();
    }

    function parsePower() {
      const base = parsePostfix();
      if (matchOp('^')) return Math.pow(base, parseUnary());
      return base;
    }

    function parsePostfix() {
      let value = parsePrimary();
      while (true) {
        if (matchOp('!')) value = factorial(value);
        else if (matchOp('%')) value /= 100;
        else break;
      }
      return value;
    }

    function parsePrimary() {
      const token = peek();
      if (!token) throw new Error('Incomplete expression');
      if (token.type === 'number') {
        index++;
        return Number(token.value);
      }
      if (token.type === 'op' && token.value === '(') {
        index++;
        const value = parseExpression();
        if (!matchOp(')')) throw new Error('Missing )');
        return value;
      }
      if (token.type === 'name') {
        const name = token.value;
        const lower = name.toLowerCase();
        if (FUNCTIONS[lower] !== undefined) {
          index++;
          if (!matchOp('(')) throw new Error('Expected ( after ' + name);
          const args = [];
          if (!matchOp(')')) {
            args.push(parseExpression());
            while (matchOp(',')) args.push(parseExpression());
            if (!matchOp(')')) throw new Error('Missing ) after ' + name);
          }
          return applyFunction(lower, args);
        }
        index++;
        if (lower === 'pi' || lower === 'π') return Math.PI;
        if (lower === 'e') return Math.E;
        if (lower === 'tau') return Math.PI * 2;
        if (lower === 'phi') return (1 + Math.sqrt(5)) / 2;
        if (lower === 'deg') return Math.PI / 180;
        if (Object.prototype.hasOwnProperty.call(variables, name)) return Number(variables[name]);
        if (Object.prototype.hasOwnProperty.call(variables, lower)) return Number(variables[lower]);
        throw new Error('Unknown name ' + name);
      }
      throw new Error('Unexpected token');
    }

    function applyFunction(name, args) {
      const expected = FUNCTIONS[name];
      if (args.length !== expected) throw new Error(name + ' expects ' + expected + ' value' + (expected === 1 ? '' : 's'));
      const x = args[0];
      const y = args[1];
      switch (name) {
        case 'sin': return Math.sin(toRadians(x));
        case 'cos': return Math.cos(toRadians(x));
        case 'tan': return Math.tan(toRadians(x));
        case 'asin': return fromRadians(Math.asin(x));
        case 'acos': return fromRadians(Math.acos(x));
        case 'atan': return fromRadians(Math.atan(x));
        case 'sinh': return Math.sinh(x);
        case 'cosh': return Math.cosh(x);
        case 'tanh': return Math.tanh(x);
        case 'asinh': return Math.asinh(x);
        case 'acosh': return Math.acosh(x);
        case 'atanh': return Math.atanh(x);
        case 'ln': return Math.log(x);
        case 'log': return Math.log10(x);
        case 'log2': return Math.log2(x);
        case 'logb': return Math.log(x) / Math.log(y);
        case 'sqrt': return Math.sqrt(x);
        case 'cbrt': return Math.cbrt(x);
        case 'abs': return Math.abs(x);
        case 'floor': return Math.floor(x);
        case 'ceil': return Math.ceil(x);
        case 'round': return Math.round(x);
        case 'trunc': return Math.trunc(x);
        case 'sign': return Math.sign(x);
        case 'exp': return Math.exp(x);
        case 'pow10': return Math.pow(10, x);
        case 'inv': return x === 0 ? NaN : 1 / x;
        case 'gamma': return gamma(x);
        case 'pow': return Math.pow(x, y);
        case 'root': return y === 0 ? NaN : Math.sign(x) * Math.pow(Math.abs(x), 1 / y);
        case 'min': return Math.min(x, y);
        case 'max': return Math.max(x, y);
        case 'gcd': {
          let a = Math.abs(Math.trunc(x));
          let b = Math.abs(Math.trunc(y));
          while (b) { const t = b; b = a % b; a = t; }
          return a;
        }
        case 'lcm': {
          let a = Math.abs(Math.trunc(x));
          let b = Math.abs(Math.trunc(y));
          if (!a || !b) return 0;
          const gcd = (m, n) => n ? gcd(n, m % n) : m;
          return a / gcd(a, b) * b;
        }
        case 'mod': return x % y;
        case 'rand': return Math.random();
        default: return NaN;
      }
    }

    const result = parseExpression();
    if (index < tokens.length) throw new Error('Unexpected token');
    if (Number.isNaN(result)) throw new Error('Invalid result');
    return result;
  }

  function balancedExpression(expression) {
    let open = 0;
    let close = 0;
    for (const ch of expression) {
      if (ch === '(') open++;
      if (ch === ')') close++;
    }
    if (close > open) throw new Error('Too many closing parentheses');
    return expression + ')'.repeat(open - close);
  }

  /* ---------------------------------------------------------------- units */
  const CONVERT = {
    length: { label: 'Length', from: 'm', to: 'ft', units: {
      m: ['Meter', 'm', 1], km: ['Kilometer', 'km', 1000], cm: ['Centimeter', 'cm', 0.01],
      mm: ['Millimeter', 'mm', 0.001], mi: ['Mile', 'mi', 1609.344], yd: ['Yard', 'yd', 0.9144],
      ft: ['Foot', 'ft', 0.3048], in: ['Inch', 'in', 0.0254], nmi: ['Nautical mile', 'nmi', 1852]
    } },
    area: { label: 'Area', from: 'm2', to: 'ft2', units: {
      m2: ['Square meter', 'm²', 1], km2: ['Square kilometer', 'km²', 1e6],
      cm2: ['Square centimeter', 'cm²', 1e-4], ha: ['Hectare', 'ha', 10000],
      acre: ['Acre', 'acre', 4046.8564224], ft2: ['Square foot', 'ft²', 0.09290304],
      yd2: ['Square yard', 'yd²', 0.83612736], mi2: ['Square mile', 'mi²', 2589988.110336],
      in2: ['Square inch', 'in²', 0.00064516]
    } },
    volume: { label: 'Volume', from: 'l', to: 'gal', units: {
      l: ['Liter', 'L', 1], ml: ['Milliliter', 'mL', 0.001], m3: ['Cubic meter', 'm³', 1000],
      cm3: ['Cubic centimeter', 'cm³', 0.001], ft3: ['Cubic foot', 'ft³', 28.316846592],
      in3: ['Cubic inch', 'in³', 0.016387064], gal: ['US gallon', 'gal', 3.785411784],
      qt: ['US quart', 'qt', 0.946352946], pt: ['US pint', 'pt', 0.473176473],
      cup: ['US cup', 'cup', 0.2365882365], floz: ['US fluid ounce', 'fl oz', 0.0295735295625],
      galuk: ['UK gallon', 'gal UK', 4.54609], flozuk: ['UK fluid ounce', 'fl oz UK', 0.0284130625]
    } },
    mass: { label: 'Mass', from: 'kg', to: 'lb', units: {
      kg: ['Kilogram', 'kg', 1], g: ['Gram', 'g', 0.001], mg: ['Milligram', 'mg', 1e-6],
      t: ['Metric ton', 't', 1000], lb: ['Pound', 'lb', 0.45359237], oz: ['Ounce', 'oz', 0.028349523125],
      st: ['Stone', 'st', 6.35029318], ton: ['US ton', 'ton', 907.18474],
      tonuk: ['Long ton', 'long ton', 1016.0469088]
    } },
    temperature: { label: 'Temperature', from: 'c', to: 'f', special: 'temperature', units: {
      c: ['Celsius', '°C'], f: ['Fahrenheit', '°F'], k: ['Kelvin', 'K']
    } },
    speed: { label: 'Speed', from: 'kmh', to: 'mph', units: {
      ms: ['Meter/second', 'm/s', 1], kmh: ['Kilometer/hour', 'km/h', 1 / 3.6],
      mph: ['Mile/hour', 'mph', 0.44704], fts: ['Foot/second', 'ft/s', 0.3048],
      kn: ['Knot', 'kn', 0.514444444]
    } },
    time: { label: 'Time', from: 'h', to: 'min', units: {
      ms: ['Millisecond', 'ms', 0.001], s: ['Second', 's', 1], min: ['Minute', 'min', 60],
      h: ['Hour', 'h', 3600], day: ['Day', 'day', 86400], week: ['Week', 'week', 604800],
      year: ['Year (365.25 d)', 'year', 31557600]
    } },
    pressure: { label: 'Pressure', from: 'bar', to: 'psi', units: {
      pa: ['Pascal', 'Pa', 1], kpa: ['Kilopascal', 'kPa', 1000], mpa: ['Megapascal', 'MPa', 1e6],
      bar: ['Bar', 'bar', 1e5], mbar: ['Millibar', 'mbar', 100], psi: ['Pound/inch²', 'psi', 6894.757293168],
      atm: ['Atmosphere', 'atm', 101325], torr: ['Torr', 'torr', 133.322368421],
      inhg: ['Inch mercury', 'inHg', 3386.389], mmhg: ['Millimeter mercury', 'mmHg', 133.322387415]
    } },
    energy: { label: 'Energy', from: 'j', to: 'cal', units: {
      j: ['Joule', 'J', 1], kj: ['Kilojoule', 'kJ', 1000], cal: ['Calorie', 'cal', 4.184],
      kcal: ['Kilocalorie', 'kcal', 4184], wh: ['Watt-hour', 'Wh', 3600],
      kwh: ['Kilowatt-hour', 'kWh', 3.6e6], btu: ['British thermal unit', 'BTU', 1055.05585262],
      ftlb: ['Foot-pound', 'ft·lb', 1.3558179483314], ev: ['Electronvolt', 'eV', 1.602176634e-19]
    } },
    power: { label: 'Power', from: 'kw', to: 'hp', units: {
      w: ['Watt', 'W', 1], kw: ['Kilowatt', 'kW', 1000], mw: ['Megawatt', 'MW', 1e6],
      hp: ['Mechanical horsepower', 'hp', 745.699871582], hpm: ['Metric horsepower', 'PS', 735.49875],
      btuh: ['BTU/hour', 'BTU/h', 0.29307107017], ftlbs: ['Foot-pound/second', 'ft·lb/s', 1.3558179483314]
    } },
    data: { label: 'Data', from: 'mb', to: 'mib', units: {
      bit: ['Bit', 'bit', 0.125], b: ['Byte', 'B', 1], kb: ['Kilobyte', 'KB', 1000],
      mb: ['Megabyte', 'MB', 1e6], gb: ['Gigabyte', 'GB', 1e9], tb: ['Terabyte', 'TB', 1e12],
      kib: ['Kibibyte', 'KiB', 1024], mib: ['Mebibyte', 'MiB', 1048576],
      gib: ['Gibibyte', 'GiB', 1073741824], tib: ['Tebibyte', 'TiB', 1099511627776]
    } },
    angle: { label: 'Angle', from: 'deg', to: 'rad', units: {
      deg: ['Degree', '°', 1], rad: ['Radian', 'rad', 57.29577951308232],
      grad: ['Gradian', 'grad', 0.9], turn: ['Turn', 'turn', 360],
      arcmin: ['Arcminute', '′', 1 / 60], arcsec: ['Arcsecond', '″', 1 / 3600]
    } },
    fuel: { label: 'Fuel economy', from: 'l100', to: 'mpgus', special: 'fuel', units: {
      l100: ['Liters/100 km', 'L/100 km'], mpgus: ['Miles/US gallon', 'mpg US'],
      mpguk: ['Miles/UK gallon', 'mpg UK'], kml: ['Kilometers/liter', 'km/L']
    } },
    currency: { label: 'Currency', from: 'usd', to: 'eur', special: 'currency', units: {
      usd: ['US dollar', 'USD'], eur: ['Euro', 'EUR'], gbp: ['British pound', 'GBP'],
      jpy: ['Japanese yen', 'JPY'], cad: ['Canadian dollar', 'CAD'], aud: ['Australian dollar', 'AUD'],
      chf: ['Swiss franc', 'CHF'], cny: ['Chinese yuan', 'CNY'], inr: ['Indian rupee', 'INR'],
      mxn: ['Mexican peso', 'MXN'], brl: ['Brazilian real', 'BRL'], krw: ['South Korean won', 'KRW']
    } }
  };

  function convertTemperature(value, from, to) {
    const base = from === 'c' ? value : from === 'f' ? (value - 32) * 5 / 9 : value - 273.15;
    return to === 'c' ? base : to === 'f' ? base * 9 / 5 + 32 : base + 273.15;
  }
  const fuelFromBase = (base, unit) => unit === 'l100' ? base : unit === 'kml' ? 100 / base : unit === 'mpgus' ? 235.214583 / base : 282.4809363 / base;
  const fuelToBase = (value, unit) => unit === 'l100' ? value : unit === 'kml' ? 100 / value : unit === 'mpgus' ? 235.214583 / value : 282.4809363 / value;

  /* ---------------------------------------------------------------- state */
  const basic = { entry: '0', acc: null, op: null, fresh: true, expr: '', repeat: null, error: '' };
  const scientific = { expr: '', result: null, lastResult: 0, evaluated: false, preview: null, error: '', note: '' };
  const programmer = {
    value: 0n, entry: '0', acc: null, op: null, fresh: true, expr: '', error: '',
    base: Math.max(2, Math.min(16, Number(readString(LS.base, '10')) || 10)),
    bits: [8, 16, 32, 64].includes(Number(readString(LS.bits, '64'))) ? Number(readString(LS.bits, '64')) : 64,
    signed: readString(LS.signed, '0') === '1'
  };
  const rpn = { stack: [0], entry: '', expr: '', error: '' };
  const converter = { category: 'length', from: 'm', to: 'ft', value: '1', rates: null, rateDate: '', rateStatus: '', loading: false, rateAttempted: false };
  const notes = { text: readString(LS.notes, ''), vars: {}, graphExpr: '', lines: [], status: '' };
  const state = {
    mode: MODES.includes(readString(LS.mode, 'basic')) ? readString(LS.mode, 'basic') : 'basic',
    angle: readString(LS.angle, 'deg') === 'rad' ? 'rad' : 'deg',
    memory: 0,
    history: readJSON(LS.history, [])
  };
  if (!Array.isArray(state.history)) state.history = [];
  if (state.memory === 0) dom.memoryFlag.hidden = true;

  /* ---------------------------------------------------------------- history */
  function saveHistory() {
    if (state.history.length > 80) state.history = state.history.slice(0, 80);
    writeJSON(LS.history, state.history);
  }

  function pushHistory(expression, result, mode = state.mode, rawResult) {
    if (result === undefined || result === null || Number.isNaN(result)) return;
    const raw = rawResult !== undefined ? String(rawResult) : (typeof result === 'bigint' ? result.toString() : rawNumber(result));
    const shown = typeof result === 'bigint' ? formatNumber(result) : formatNumber(result);
    state.history.unshift({ expr: String(expression), result: shown, raw, mode, at: Date.now() });
    saveHistory();
    renderHistory();
  }

  function renderHistory() {
    dom.historyList.replaceChildren();
    if (!state.history.length) {
      dom.historyEmpty.hidden = false;
      return;
    }
    dom.historyEmpty.hidden = true;
    state.history.forEach((item, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'calc-hist-item';
      button.dataset.index = String(index);
      const expr = document.createElement('span');
      expr.className = 'hist-expr';
      expr.textContent = item.expr;
      const result = document.createElement('b');
      result.className = 'hist-result';
      result.textContent = item.result;
      const mode = document.createElement('span');
      mode.className = 'hist-mode';
      mode.textContent = MODE_NAMES[item.mode] || item.mode;
      button.append(expr, result, mode);
      dom.historyList.appendChild(button);
    });
  }

  /* ---------------------------------------------------------------- basic */
  const applyBinary = (a, b, op) => {
    switch (op) {
      case '+': return a + b;
      case '-': return a - b;
      case '*': return a * b;
      case '/':
        if (b === 0) throw new Error('Cannot divide by zero');
        return a / b;
      default: return b;
    }
  };

  function basicRender() {
    if (basic.error) {
      dom.display.textContent = 'Error';
      dom.sub.textContent = basic.error;
    } else {
      dom.display.textContent = formatInput(basic.entry);
      dom.sub.textContent = '';
    }
    dom.expr.textContent = basic.expr;
    dom.memoryFlag.hidden = state.memory === 0;
    dom.angleFlag.hidden = true;
    dom.baseFlag.hidden = true;
    dom.wordFlag.hidden = true;
  }

  function basicError(message) {
    basic.error = message;
    basic.fresh = true;
    dom.display.textContent = 'Error';
    dom.sub.textContent = message;
    dom.expr.textContent = basic.expr;
  }

  function basicDigit(digit) {
    if (basic.error) { basic.error = ''; basic.entry = '0'; basic.expr = ''; }
    if (basic.fresh) {
      basic.entry = digit === '.' ? '0.' : digit;
      basic.fresh = false;
      basic.expr = '';
      if (basic.op === null) basic.repeat = null;
    } else if (digit === '.') {
      if (!basic.entry.includes('.')) basic.entry += '.';
    } else if (basic.entry === '0') {
      basic.entry = digit;
    } else if (basic.entry === '-0') {
      basic.entry = '-' + digit;
    } else {
      const digits = basic.entry.replace('-', '').replace('.', '').length;
      if (digits < 15) basic.entry += digit;
    }
    basicRender();
  }

  function basicSetOp(op) {
    if (basic.error) return;
    try {
      if (basic.op !== null && !basic.fresh) {
        basic.acc = applyBinary(basic.acc, Number(basic.entry), basic.op);
        basic.entry = rawNumber(basic.acc);
      } else if (basic.acc === null) {
        basic.acc = Number(basic.entry);
      }
      basic.op = op;
      basic.entry = rawNumber(basic.acc);
      basic.expr = `${pretty(basic.acc)} ${symbol(op)}`;
      basic.fresh = true;
      basic.repeat = null;
      basicRender();
    } catch (error) { basicError(error.message); }
  }

  function basicEquals() {
    if (basic.error) return;
    try {
      if (basic.op !== null) {
        const operand = Number(basic.entry);
        const expression = `${pretty(basic.acc)} ${symbol(basic.op)} ${pretty(operand)} =`;
        basic.expr = expression;
        const result = applyBinary(basic.acc, operand, basic.op);
        basic.repeat = { op: basic.op, operand };
        basic.entry = rawNumber(result);
        basic.expr = expression;
        basic.acc = null;
        basic.op = null;
        basic.fresh = true;
        basicRender();
        pushHistory(expression, result, 'basic');
      } else if (basic.repeat) {
        const left = Number(basic.entry);
        const result = applyBinary(left, basic.repeat.operand, basic.repeat.op);
        const expression = `${pretty(left)} ${symbol(basic.repeat.op)} ${pretty(basic.repeat.operand)} =`;
        basic.entry = rawNumber(result);
        basic.expr = expression;
        basic.fresh = true;
        basicRender();
        pushHistory(expression, result, 'basic');
      }
    } catch (error) { basicError(error.message); }
  }

  function basicPercent() {
    if (basic.error) return;
    basic.repeat = null;
    const value = Number(basic.entry);
    if (basic.op !== null && basic.acc !== null) {
      if (basic.op === '+' || basic.op === '-') basic.entry = rawNumber(basic.acc * value / 100);
      else basic.entry = rawNumber(value / 100);
      basic.expr = `${pretty(basic.acc)} ${symbol(basic.op)} ${pretty(value)}%`;
    } else {
      basic.entry = rawNumber(value / 100);
      basic.expr = `${pretty(value)}%`;
    }
    basic.fresh = true;
    basicRender();
  }

  function basicUnary(kind) {
    if (basic.error) return;
    basic.repeat = null;
    const value = Number(basic.entry);
    let result;
    let label;
    try {
      if (kind === 'sqrt') {
        if (value < 0) throw new Error('Invalid input for √');
        result = Math.sqrt(value); label = '√';
      } else if (kind === 'sqr') {
        result = value * value; label = 'sqr';
      } else if (kind === 'inv') {
        if (value === 0) throw new Error('Cannot divide by zero');
        result = 1 / value; label = '1/';
      } else return;
      basic.entry = rawNumber(result);
      basic.expr = `${label}(${pretty(value)})`;
      basic.fresh = true;
      basicRender();
    } catch (error) { basicError(error.message); }
  }

  function basicToggleSign() {
    if (basic.error) { basic.error = ''; basic.entry = '0'; }
    basic.repeat = null;
    if (basic.entry.startsWith('-')) basic.entry = basic.entry.slice(1);
    else if (basic.entry !== '0') basic.entry = '-' + basic.entry;
    basic.fresh = false;
    basicRender();
  }

  function basicBack() {
    if (basic.error) { basic.error = ''; basic.entry = '0'; basic.fresh = true; basicRender(); return; }
    if (basic.fresh) return;
    basic.entry = basic.entry.length > 1 ? basic.entry.slice(0, -1) : '0';
    if (basic.entry === '-') basic.entry = '0';
    basicRender();
  }

  function basicClear() {
    basic.entry = '0'; basic.acc = null; basic.op = null; basic.fresh = true;
    basic.expr = ''; basic.repeat = null; basic.error = '';
    basicRender();
  }

  function basicClearEntry() {
    basic.entry = '0'; basic.fresh = true; basic.error = '';
    basicRender();
  }

  function basicMemory(action) {
    const value = Number(basic.entry) || 0;
    if (action === 'clear') { state.memory = 0; basic.expr = 'Memory cleared'; }
    else if (action === 'recall') { basic.entry = rawNumber(state.memory); basic.fresh = true; basic.expr = 'Memory recall'; }
    else if (action === 'add') { state.memory += value; basic.expr = `M + ${pretty(value)}`; basic.fresh = true; }
    else if (action === 'sub') { state.memory -= value; basic.expr = `M − ${pretty(value)}`; basic.fresh = true; }
    basicRender();
  }

  function basicHandle(action, value) {
    switch (action) {
      case 'digit': return basicDigit(value);
      case 'op': return basicSetOp(value);
      case 'equals': return basicEquals();
      case 'percent': return basicPercent();
      case 'unary': return basicUnary(value);
      case 'clear': return basicClear();
      case 'clearEntry': return basicClearEntry();
      case 'back': return basicBack();
      case 'toggleSign': return basicToggleSign();
      case 'mem': return basicMemory(value);
      default: return undefined;
    }
  }

  /* ---------------------------------------------------------------- scientific */
  function scientificPreview() {
    scientific.error = '';
    scientific.preview = null;
    if (!scientific.expr.trim()) return;
    try {
      const result = evaluateExpression(balancedExpression(scientific.expr), { Ans: scientific.lastResult }, state.angle);
      scientific.preview = result;
    } catch (error) {
      scientific.preview = null;
    }
  }

  function scientificRender() {
    renderScientificExtra();
    dom.expr.textContent = scientific.evaluated ? scientific.expr + ' =' : scientific.expr;
    if (scientific.error) {
      dom.display.textContent = 'Error';
      dom.sub.textContent = scientific.error;
    } else if (scientific.evaluated && scientific.result !== null) {
      dom.display.textContent = formatNumber(scientific.result);
      dom.sub.textContent = scientific.note || '';
    } else if (scientific.preview !== null && scientific.preview !== undefined) {
      dom.display.textContent = formatNumber(scientific.preview);
      dom.sub.textContent = scientific.note || '';
    } else {
      dom.display.textContent = scientific.expr ? '…' : '0';
      dom.sub.textContent = scientific.note || '';
    }
    dom.memoryFlag.hidden = state.memory === 0;
    dom.angleFlag.hidden = false;
    dom.angleFlag.textContent = state.angle.toUpperCase();
    dom.baseFlag.hidden = true;
    dom.wordFlag.hidden = true;
  }

  function scientificAppend(text, kind = 'token') {
    if (scientific.error) { scientific.error = ''; }
    scientific.note = '';
    if (scientific.evaluated) {
      const resultText = rawNumber(scientific.result, 12);
      if (kind === 'digit' || kind === 'constant' || kind === 'open') {
        scientific.expr = '';
      } else if (kind === 'function') {
        scientific.expr = `${text}${resultText})`;
        scientific.evaluated = false;
        scientific.preview = null;
        scientificRender();
        return;
      } else if (kind === 'operator' || kind === 'postfix') {
        scientific.expr = resultText;
      } else {
        scientific.expr = resultText;
      }
      scientific.evaluated = false;
    }
    const trimmed = scientific.expr.trimEnd();
    if (kind === 'function' && trimmed && !/[+\-*/^(]$/.test(trimmed)) {
      scientific.expr = `${text}${scientific.expr})`;
    } else {
      scientific.expr += text;
    }
    scientificPreview();
    scientificRender();
  }

  function scientificEquals() {
    if (!scientific.expr.trim()) return;
    scientific.note = '';
    try {
      const expression = balancedExpression(scientific.expr);
      const result = evaluateExpression(expression, { Ans: scientific.lastResult }, state.angle);
      if (!Number.isFinite(result)) throw new Error('Invalid result');
      scientific.expr = expression;
      scientific.result = result;
      scientific.lastResult = result;
      scientific.evaluated = true;
      scientific.error = '';
      scientific.preview = null;
      scientificRender();
      pushHistory(expression, result, 'scientific');
    } catch (error) {
      scientific.error = error.message;
      scientific.preview = null;
      dom.display.textContent = 'Error';
      dom.sub.textContent = error.message;
      dom.expr.textContent = scientific.expr;
    }
  }

  function scientificClear() {
    scientific.expr = '';
    scientific.result = null;
    scientific.evaluated = false;
    scientific.preview = null;
    scientific.error = '';
    scientific.note = '';
    scientificRender();
  }

  function scientificBack() {
    scientific.note = '';
    if (scientific.error) { scientific.error = ''; scientificRender(); return; }
    if (scientific.evaluated) {
      scientific.expr = rawNumber(scientific.result, 12);
      scientific.evaluated = false;
      scientific.result = null;
    } else {
      scientific.expr = scientific.expr.slice(0, -1);
    }
    scientificPreview();
    scientificRender();
  }

  function scientificToggleSign() {
    scientific.note = '';
    if (scientific.evaluated) {
      scientific.expr = `-(${rawNumber(scientific.result, 12)})`;
      scientific.evaluated = false;
      scientific.result = null;
    } else if (!scientific.expr.trim() || /[+\-*/^(]$/.test(scientific.expr)) {
      scientific.expr += '-';
    } else {
      scientific.expr = `-(${scientific.expr})`;
    }
    scientificPreview();
    scientificRender();
  }

  function scientificToggleAngle() {
    state.angle = state.angle === 'deg' ? 'rad' : 'deg';
    write(LS.angle, state.angle);
    scientific.note = state.angle === 'deg' ? 'Degrees' : 'Radians';
    scientificPreview();
    scientificRender();
  }

  function scientificMemory(action) {
    const value = scientific.preview !== null && scientific.preview !== undefined ? scientific.preview : (scientific.result !== null ? scientific.result : 0);
    if (action === 'clear') {
      state.memory = 0;
      scientific.note = 'Memory cleared';
    } else if (action === 'recall') {
      scientificInsertConstant(rawNumber(state.memory, 12));
      return;
    } else if (action === 'add') {
      state.memory += value;
      scientific.note = `Memory ${pretty(state.memory)}`;
    } else if (action === 'sub') {
      state.memory -= value;
      scientific.note = `Memory ${pretty(state.memory)}`;
    }
    scientificRender();
  }

  function renderScientificExtra() {
    if (state.mode !== 'scientific') return;
    const active = (action, label) => `<button type="button" data-sci-mem="${action}" class="calc-key mem">${label}</button>`;
    dom.extra.innerHTML = `<div class="calc-mem-row">${active('clear', 'MC')}${active('recall', 'MR')}${active('add', 'M+')}${active('sub', 'M−')}</div>`;
  }

  function scientificInsertConstant(value) {
    scientific.note = '';
    if (scientific.evaluated) { scientific.expr = ''; scientific.evaluated = false; }
    scientific.expr += value;
    scientificPreview();
    scientificRender();
  }

  function scientificInsertAnswer() {
    const value = rawNumber(scientific.lastResult, 12);
    if (scientific.evaluated) {
      scientific.expr = value;
      scientific.evaluated = false;
      scientific.result = null;
    } else {
      scientific.expr += value;
    }
    scientificPreview();
    scientificRender();
  }

  function scientificInverse() {
    if (scientific.evaluated) {
      scientific.expr = `inv(${rawNumber(scientific.result, 12)})`;
      scientific.evaluated = false;
      scientific.result = null;
    } else if (scientific.expr.trim()) {
      scientific.expr = `inv(${scientific.expr})`;
    } else {
      scientific.expr = 'inv(';
    }
    scientificPreview();
    scientificRender();
  }

  function scientificHandle(action, value) {
    switch (action) {
      case 'digit': return scientificAppend(value, 'digit');
      case 'fn': return value === 'inv' ? scientificInverse() : scientificAppend(value + '(', 'function');
      case 'const': return scientificInsertConstant(value);
      case 'op': return scientificAppend(value === '^' ? '^' : value, 'operator');
      case 'post': return scientificAppend(value, 'postfix');
      case 'paren': return scientificAppend(value, value === '(' ? 'open' : 'token');
      case 'rand': return scientificInsertConstant(rawNumber(Math.random(), 10));
      case 'ans': return scientificInsertAnswer();
      case 'equals': return scientificEquals();
      case 'clear': return scientificClear();
      case 'clearEntry': return scientificClear();
      case 'back': return scientificBack();
      case 'toggleSign': return scientificToggleSign();
      case 'angle': return scientificToggleAngle();
      default: return undefined;
    }
  }

  /* ---------------------------------------------------------------- programmer */
  const BASE_NAMES = { 2: 'BIN', 8: 'OCT', 10: 'DEC', 16: 'HEX' };
  const DIGITS = '0123456789ABCDEF';

  const progMask = value => BigInt.asUintN(programmer.bits, value);
  const progRaw = (value, base = programmer.base) => progMask(value).toString(base).toUpperCase();
  function progParse(text, base = programmer.base) {
    let value = 0n;
    const upper = String(text).toUpperCase();
    for (const ch of upper) {
      const digit = DIGITS.indexOf(ch);
      if (digit < 0 || digit >= base) throw new Error('Invalid digit');
      value = value * BigInt(base) + BigInt(digit);
    }
    return value;
  }
  function progGroup(text, base) {
    if (base === 10) return groupString(text);
    if (base === 2) return text.replace(/\B(?=(?:[01]{4})+$)/g, ' ');
    if (base === 16) return text.replace(/\B(?=(?:[0-9A-F]{4})+$)/g, ' ');
    return text.replace(/\B(?=(?:[0-7]{3})+$)/g, ' ');
  }
  function progDisplay(value = programmer.value, base = programmer.base) {
    if (base === 10 && programmer.signed) return BigInt.asIntN(programmer.bits, value).toString();
    return progGroup(progRaw(value, base), base);
  }
  function progApply(a, b, op) {
    switch (op) {
      case '+': return progMask(a + b);
      case '-': return progMask(a - b);
      case '*': return progMask(a * b);
      case '/':
        if (b === 0n) throw new Error('Cannot divide by zero');
        return progMask(a / b);
      case 'mod':
        if (b === 0n) throw new Error('Cannot divide by zero');
        return progMask(a % b);
      case '&': return progMask(a & b);
      case '|': return progMask(a | b);
      case '^': return progMask(a ^ b);
      case '<<': {
        if (b > 64n) return 0n;
        return progMask(a << b);
      }
      case '>>': {
        if (programmer.signed) return progMask(BigInt.asIntN(programmer.bits, a) >> b);
        return progMask(a >> b);
      }
      default: return b;
    }
  }
  const progSymbol = op => ({ '+': '+', '-': '−', '*': '×', '/': '÷', '&': 'AND', '|': 'OR', '^': 'XOR', '<<': '<<', '>>': '>>', 'mod': 'MOD' }[op] || op);

  function programmerSetEntry(text) {
    programmer.entry = text;
    try { programmer.value = progMask(progParse(text, programmer.base)); }
    catch (error) { programmer.value = 0n; }
  }

  function programmerRender() {
    dom.expr.textContent = programmer.expr || `${BASE_NAMES[programmer.base]} · ${programmer.bits}-bit`;
    if (programmer.error) {
      dom.display.textContent = 'Error';
      dom.sub.textContent = programmer.error;
    } else {
      dom.display.textContent = progDisplay();
      const bases = [16, 10, 8, 2].map(base => {
        const label = BASE_NAMES[base];
        const value = base === 10 && programmer.signed ? BigInt.asIntN(programmer.bits, programmer.value).toString() : progGroup(progRaw(programmer.value, base), base);
        return `<span>${label} ${escapeHTML(value)}</span>`;
      });
      dom.sub.innerHTML = `<div class="calc-bases">${bases.join('')}</div>`;
    }
    dom.memoryFlag.hidden = state.memory === 0;
    dom.angleFlag.hidden = true;
    dom.baseFlag.hidden = false;
    dom.baseFlag.textContent = BASE_NAMES[programmer.base];
    dom.wordFlag.hidden = false;
    dom.wordFlag.textContent = `${programmer.bits}-bit${programmer.signed ? ' signed' : ''}`;
    renderProgrammerExtra();
  }

  function programmerDigit(digit) {
    if (DIGITS.indexOf(digit) >= programmer.base) return;
    if (programmer.error) programmer.error = '';
    if (programmer.fresh || programmer.entry === '0') programmer.entry = digit;
    else if (programmer.entry.length < Math.ceil(programmer.bits / Math.log2(programmer.base)) + 2) programmer.entry += digit;
    programmer.entry = programmer.entry.replace(/^0+(?=.)/, '');
    programmer.fresh = false;
    programmer.value = progMask(progParse(programmer.entry, programmer.base));
    programmer.expr = '';
    programmerRender();
  }

  function programmerSetOp(op) {
    if (programmer.error) return;
    try {
      if (programmer.op !== null && !programmer.fresh) {
        programmer.value = progApply(programmer.acc, programmer.value, programmer.op);
        programmer.entry = progRaw(programmer.value);
      }
      programmer.acc = programmer.value;
      programmer.op = op;
      programmer.entry = progRaw(programmer.value);
      programmer.fresh = true;
      programmer.expr = `${progDisplay(programmer.value)} ${progSymbol(op)}`;
      programmerRender();
    } catch (error) { programmer.error = error.message; programmerRender(); }
  }

  function programmerEquals() {
    if (programmer.error) return;
    if (programmer.op === null) return;
    try {
      const b = programmer.value;
      const a = programmer.acc;
      const result = progApply(a, b, programmer.op);
      const expression = `${progDisplay(a)} ${progSymbol(programmer.op)} ${progDisplay(b)} =`;
      programmer.value = result;
      programmer.entry = progRaw(result);
      programmer.expr = expression;
      programmer.op = null;
      programmer.acc = null;
      programmer.fresh = true;
      programmerRender();
      pushHistory(expression, result, 'programmer', result.toString());
    } catch (error) { programmer.error = error.message; programmerRender(); }
  }

  function programmerUnary(kind) {
    if (programmer.error) return;
    if (kind === 'not') programmer.value = progMask(~programmer.value);
    else if (kind === 'neg') programmer.value = progMask(-programmer.value);
    programmer.entry = progRaw(programmer.value);
    programmer.expr = kind === 'not' ? 'NOT' : '±';
    programmer.fresh = true;
    programmerRender();
  }

  function programmerBack() {
    if (programmer.error) { programmer.error = ''; programmer.entry = '0'; programmer.value = 0n; programmerRender(); return; }
    if (programmer.fresh) return;
    programmer.entry = programmer.entry.length > 1 ? programmer.entry.slice(0, -1) : '0';
    programmer.value = progMask(progParse(programmer.entry || '0', programmer.base));
    programmerRender();
  }

  function programmerClear() {
    programmer.value = 0n; programmer.entry = '0'; programmer.acc = null; programmer.op = null;
    programmer.fresh = true; programmer.expr = ''; programmer.error = '';
    programmerRender();
  }

  function programmerClearEntry() {
    programmer.value = 0n; programmer.entry = '0'; programmer.fresh = true; programmer.error = '';
    programmerRender();
  }

  function programmerBase(base) {
    if (![2, 8, 10, 16].includes(base)) return;
    programmer.base = base;
    programmer.entry = progRaw(programmer.value, base);
    programmer.fresh = true;
    write(LS.base, String(base));
    renderKeys();
    programmerRender();
  }

  function programmerBits(bits) {
    if (![8, 16, 32, 64].includes(bits)) return;
    programmer.bits = bits;
    programmer.value = progMask(programmer.value);
    programmer.entry = progRaw(programmer.value);
    if (programmer.acc !== null) programmer.acc = progMask(programmer.acc);
    write(LS.bits, String(bits));
    programmerRender();
  }

  function programmerToggleSigned() {
    programmer.signed = !programmer.signed;
    write(LS.signed, programmer.signed ? '1' : '0');
    programmerRender();
  }

  function programmerHandle(action, value) {
    switch (action) {
      case 'digit': return programmerDigit(value);
      case 'op': return programmerSetOp(value);
      case 'unary': return programmerUnary(value);
      case 'equals': return programmerEquals();
      case 'clear': return programmerClear();
      case 'clearEntry': return programmerClearEntry();
      case 'back': return programmerBack();
      default: return undefined;
    }
  }

  function renderProgrammerExtra() {
    if (state.mode !== 'programmer') return;
    const bases = [2, 8, 10, 16].map(base => `<button type="button" data-prog-base="${base}" class="${programmer.base === base ? 'selected' : ''}">${BASE_NAMES[base]}</button>`).join('');
    const bits = [8, 16, 32, 64].map(size => `<button type="button" data-prog-bits="${size}" class="${programmer.bits === size ? 'selected' : ''}">${size}</button>`).join('');
    dom.extra.innerHTML = `<div class="calc-base-row"><div class="calc-seg">${bases}</div><div class="calc-seg">${bits}<button type="button" data-prog-signed class="${programmer.signed ? 'selected' : ''}">SIGNED</button></div></div>`;
  }

  /* ---------------------------------------------------------------- RPN */
  function rpnRender() {
    const x = rpn.entry !== '' ? Number(rpn.entry) : (rpn.stack[0] || 0);
    dom.display.textContent = rpn.error ? 'Error' : formatInput(rpn.entry !== '' ? rpn.entry : rawNumber(x));
    dom.expr.textContent = rpn.expr;
    if (rpn.error) {
      dom.sub.textContent = rpn.error;
    } else {
      const labels = ['Y', 'Z', 'T'];
      const rest = rpn.stack.slice(1, 4).map((value, index) => `<span>${labels[index]} ${formatNumber(value)}</span>`).join('');
      dom.sub.innerHTML = `<div class="calc-stack">${rest || '<span>Y 0</span>'}</div>`;
    }
    dom.memoryFlag.hidden = state.memory === 0;
    dom.angleFlag.hidden = true;
    dom.baseFlag.hidden = true;
    dom.wordFlag.hidden = true;
  }

  function rpnCommit() {
    if (rpn.entry === '') return false;
    const value = Number(rpn.entry);
    if (Number.isNaN(value)) return false;
    rpn.stack.unshift(value);
    rpn.entry = '';
    return true;
  }

  function rpnDigit(digit) {
    if (rpn.error) { rpn.error = ''; rpn.entry = ''; }
    if (rpn.entry === '') rpn.entry = digit === '.' ? '0.' : digit;
    else if (digit === '.') { if (!rpn.entry.includes('.')) rpn.entry += '.'; }
    else if (rpn.entry.length < 16) rpn.entry += digit;
    rpn.expr = '';
    rpnRender();
  }

  function rpnEnter() {
    if (rpn.error) rpn.error = '';
    if (rpn.entry !== '') rpnCommit();
    else rpn.stack.unshift(rpn.stack[0] || 0);
    rpn.expr = '';
    rpnRender();
  }

  function rpnOperator(op) {
    if (rpn.error) return;
    try {
      rpnCommit();
      if (rpn.stack.length < 2) throw new Error('Need two values');
      const b = rpn.stack.shift();
      const a = rpn.stack.shift();
      const result = applyBinary(a, b, op);
      rpn.stack.unshift(result);
      rpn.expr = `${pretty(a)} ${symbol(op)} ${pretty(b)} =`;
      rpnRender();
      pushHistory(`${pretty(a)} ${symbol(op)} ${pretty(b)} =`, result, 'rpn');
    } catch (error) { rpn.error = error.message; rpnRender(); }
  }

  function rpnUnary(kind) {
    if (rpn.error) return;
    try {
      rpnCommit();
      const value = rpn.stack.shift() || 0;
      let result;
      if (kind === 'sqrt') { if (value < 0) throw new Error('Invalid input for √'); result = Math.sqrt(value); }
      else if (kind === 'sqr') result = value * value;
      else if (kind === 'inv') { if (value === 0) throw new Error('Cannot divide by zero'); result = 1 / value; }
      else if (kind === 'neg') result = -value;
      else result = value;
      rpn.stack.unshift(result);
      rpn.expr = `${kind}(${pretty(value)})`;
      rpnRender();
      pushHistory(rpn.expr, result, 'rpn');
    } catch (error) { rpn.error = error.message; rpnRender(); }
  }

  function rpnSwap() {
    if (rpn.entry !== '') rpnCommit();
    if (rpn.stack.length < 2) return;
    [rpn.stack[0], rpn.stack[1]] = [rpn.stack[1], rpn.stack[0]];
    rpn.expr = 'SWAP';
    rpnRender();
  }
  function rpnDrop() {
    if (rpn.entry !== '') rpnCommit();
    if (rpn.stack.length > 1) rpn.stack.shift();
    rpn.expr = 'DROP';
    rpnRender();
  }
  function rpnRoll() {
    if (rpn.entry !== '') rpnCommit();
    if (rpn.stack.length > 1) rpn.stack.push(rpn.stack.shift());
    rpn.expr = 'ROLL';
    rpnRender();
  }
  function rpnClear() {
    rpn.stack = [0]; rpn.entry = ''; rpn.expr = ''; rpn.error = '';
    rpnRender();
  }
  function rpnBack() {
    if (rpn.error) { rpn.error = ''; rpnRender(); return; }
    if (rpn.entry === '') return;
    rpn.entry = rpn.entry.length > 1 ? rpn.entry.slice(0, -1) : '';
    rpnRender();
  }

  function rpnHandle(action, value) {
    switch (action) {
      case 'digit': return rpnDigit(value);
      case 'enter': return rpnEnter();
      case 'op': return rpnOperator(value);
      case 'unary': return rpnUnary(value);
      case 'swap': return rpnSwap();
      case 'drop': return rpnDrop();
      case 'roll': return rpnRoll();
      case 'clear': return rpnClear();
      case 'back': return rpnBack();
      default: return undefined;
    }
  }

  /* ---------------------------------------------------------------- converter */
  function converterDefinition() { return CONVERT[converter.category] || CONVERT.length; }

  function converterUnit(unit) {
    const def = converterDefinition();
    return def.units[unit] || def.units[def.from];
  }

  function convertValue() {
    const def = converterDefinition();
    const value = Number(converter.value);
    if (converter.value.trim() === '' || Number.isNaN(value)) return { error: 'Enter a number to convert.' };
    if (def.special === 'temperature') {
      const result = convertTemperature(value, converter.from, converter.to);
      return { result, note: `${formatNumber(value, 10)} ${escapeHTML(converterUnit(converter.from)[1])} = ${formatNumber(result, 10)} ${escapeHTML(converterUnit(converter.to)[1])}` };
    }
    if (def.special === 'fuel') {
      if (value === 0) return { error: 'Fuel economy cannot be zero.' };
      const base = fuelToBase(value, converter.from);
      const result = fuelFromBase(base, converter.to);
      return { result, note: 'Fuel economy units are inversely related.' };
    }
    if (def.special === 'currency') {
      if (!converter.rates) return { error: converter.rateStatus || 'Live rates are loading…' };
      const fromRate = converter.rates[converter.from.toUpperCase()];
      const toRate = converter.rates[converter.to.toUpperCase()];
      if (!fromRate || !toRate) return { error: 'No rate available for that currency.' };
      return { result: (value / fromRate) * toRate, note: converter.rateDate ? `ECB reference rates · ${escapeHTML(converter.rateDate)}` : 'ECB reference rates' };
    }
    const from = converterUnit(converter.from);
    const to = converterUnit(converter.to);
    return { result: value * from[2] / to[2], note: `1 ${escapeHTML(from[1])} = ${formatNumber(from[2] / to[2], 10)} ${escapeHTML(to[1])}` };
  }

  function converterRender(options = {}) {
    const def = converterDefinition();
    if (dom.convCategory.options.length !== Object.keys(CONVERT).length) {
      dom.convCategory.replaceChildren(...Object.entries(CONVERT).map(([key, item]) => {
        const option = document.createElement('option');
        option.value = key; option.textContent = item.label; return option;
      }));
    }
    dom.convCategory.value = converter.category;
    if (options.syncCategory !== false) {
      const available = Object.keys(def.units);
      if (!available.includes(converter.from)) converter.from = def.from;
      if (!available.includes(converter.to)) converter.to = def.to;
    }
    if (options.syncUnits !== false) {
      const build = (select, selected) => {
        select.replaceChildren(...Object.entries(def.units).map(([key, unit]) => {
          const option = document.createElement('option');
          option.value = key; option.textContent = `${unit[0]} (${unit[1]})`; return option;
        }));
        select.value = selected;
      };
      build(dom.convFromUnit, converter.from);
      build(dom.convToUnit, converter.to);
    }
    if (options.syncValue !== false) dom.convFrom.value = converter.value;
    const converted = convertValue();
    if (converted.result === undefined || Number.isNaN(converted.result) || !Number.isFinite(converted.result)) {
      dom.convTo.textContent = '—';
      dom.convNote.innerHTML = converted.error || 'No conversion available.';
    } else {
      const from = converterUnit(converter.from);
      const to = converterUnit(converter.to);
      dom.convTo.textContent = formatNumber(tidyNumber(converted.result), 10);
      dom.convNote.innerHTML = converted.note || '';
      if (def.special === 'currency' && converter.rateStatus && !converter.rates) {
        dom.convNote.innerHTML = converter.rateStatus;
      }
      if (def.special !== 'currency') {
        dom.convNote.innerHTML = `${escapeHTML(from[1])} → ${escapeHTML(to[1])} · ${converted.note || ''}`;
      }
    }
    if (def.special === 'currency') ensureCurrencyRates();
  }

  function converterCategory(category) {
    if (!CONVERT[category]) return;
    converter.category = category;
    const def = CONVERT[category];
    converter.from = def.from;
    converter.to = def.to;
    converter.value = '1';
    converter.rates = converter.rates || null;
    converterRender();
  }

  function converterSwap() {
    const converted = convertValue();
    const oldFrom = converter.from;
    converter.from = converter.to;
    converter.to = oldFrom;
    if (converted.result !== undefined && Number.isFinite(converted.result)) converter.value = rawNumber(converted.result, 10);
    converterRender({ syncCategory: false });
  }

  function loadRateCache() {
    const cached = readJSON(LS.rates, null);
    if (!cached || !cached.rates || !cached.at) return null;
    if (Date.now() - cached.at > 12 * 60 * 60 * 1000) return null;
    return cached;
  }

  async function ensureCurrencyRates() {
    if (converter.rates || converter.loading || converter.rateAttempted) return;
    converter.rateAttempted = true;
    const cached = loadRateCache();
    if (cached) {
      converter.rates = cached.rates;
      converter.rateDate = cached.date || '';
      converter.rateStatus = 'ECB reference rates';
      converterRender({ syncValue: false, syncUnits: false, syncCategory: false });
      return;
    }
    converter.loading = true;
    converter.rateStatus = 'Loading live ECB rates…';
    converterRender({ syncValue: false, syncUnits: false, syncCategory: false });
    try {
      const response = await fetch('https://api.frankfurter.dev/v1/latest?from=USD', { cache: 'no-store' });
      if (!response.ok) throw new Error('Rates request failed');
      const data = await response.json();
      const rates = Object.assign({ USD: 1 }, data.rates || {});
      converter.rates = rates;
      converter.rateDate = data.date || '';
      converter.rateStatus = 'ECB reference rates';
      writeJSON(LS.rates, { at: Date.now(), date: data.date || '', rates });
      converter.loading = false;
      if (state.mode === 'convert' && converter.category === 'currency') converterRender({ syncValue: false, syncUnits: false, syncCategory: false });
    } catch (error) {
      converter.loading = false;
      converter.rateStatus = 'Live rates unavailable. <button type="button" class="calc-link" data-conv-retry>Retry</button>';
      if (state.mode === 'convert' && converter.category === 'currency') converterRender({ syncValue: false, syncUnits: false, syncCategory: false });
    }
  }

  /* ---------------------------------------------------------------- notes */
  function notesOutputRender(lines) {
    dom.notesOutput.replaceChildren();
    if (!lines.length) {
      const empty = document.createElement('p');
      empty.className = 'calc-empty';
      empty.textContent = 'Results appear here as you type.';
      dom.notesOutput.appendChild(empty);
      return;
    }
    for (const line of lines) {
      const row = document.createElement('div');
      row.className = 'calc-note-line' + (line.error ? ' error' : '');
      const code = document.createElement('code');
      code.textContent = line.source;
      const result = document.createElement('b');
      result.textContent = line.error ? line.error : line.result;
      row.append(code, result);
      dom.notesOutput.appendChild(row);
    }
  }

  function runNotes() {
    const text = dom.notesInput.value;
    notes.text = text;
    write(LS.notes, text);
    const vars = {};
    const lines = [];
    let graphExpr = '';
    const sourceLines = text.split(/\r?\n/);
    for (const sourceLine of sourceLines) {
      const line = sourceLine.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) continue;
      let match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*x\s*\)\s*=\s*(.+)$/);
      if (match) {
        graphExpr = match[2];
        lines.push({ source: line, result: 'graph', error: '' });
        continue;
      }
      match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
      if (match) {
        const name = match[1];
        const rhs = match[2];
        if (name === 'y') {
          graphExpr = rhs;
          lines.push({ source: line, result: 'graph', error: '' });
          continue;
        }
        try {
          const value = evaluateExpression(rhs, vars, state.angle);
          if (!Number.isFinite(value)) throw new Error('Invalid result');
          vars[name] = value;
          lines.push({ source: line, result: formatNumber(value), error: '' });
        } catch (error) {
          lines.push({ source: line, result: error.message, error: error.message });
        }
        continue;
      }
      try {
        const value = evaluateExpression(line, vars, state.angle);
        if (!Number.isFinite(value)) throw new Error('Invalid result');
        lines.push({ source: line, result: formatNumber(value), error: '' });
      } catch (error) {
        lines.push({ source: line, result: error.message, error: error.message });
      }
    }
    notes.vars = vars;
    notes.graphExpr = graphExpr;
    notes.lines = lines;
    notes.status = `${lines.length} line${lines.length === 1 ? '' : 's'}${graphExpr ? ' · graph' : ''}`;
    dom.notesStatus.textContent = notes.status;
    notesOutputRender(lines);
    if (graphExpr) drawGraph(graphExpr);
    else { dom.notesCanvas.hidden = true; }
  }

  function drawGraph(expression) {
    const canvas = dom.notesCanvas;
    canvas.hidden = false;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) { requestAnimationFrame(() => drawGraph(expression)); return; }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const width = rect.width;
    const height = rect.height;
    const style = getComputedStyle(document.documentElement);
    const blue = style.getPropertyValue('--blue').trim() || '#1a73e8';
    const line = style.getPropertyValue('--line').trim() || '#d6deec';
    const muted = style.getPropertyValue('--muted').trim() || '#667085';
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = style.getPropertyValue('--panel2').trim() || '#f6f8fc';
    ctx.fillRect(0, 0, width, height);

    const samples = [];
    const minX = -10;
    const maxX = 10;
    for (let i = 0; i <= 240; i++) {
      const x = minX + (maxX - minX) * i / 240;
      try {
        const y = evaluateExpression(expression, Object.assign({}, notes.vars, { x }), state.angle);
        if (Number.isFinite(y)) samples.push({ x, y });
      } catch (error) { /* skip undefined points */ }
    }
    if (!samples.length) {
      ctx.fillStyle = muted;
      ctx.font = '11px Roboto, Arial, sans-serif';
      ctx.fillText('No graph points for y = ' + expression, 12, 24);
      return;
    }
    let minY = Math.min(...samples.map(point => point.y));
    let maxY = Math.max(...samples.map(point => point.y));
    if (minY === maxY) { minY -= 1; maxY += 1; }
    const spanY = maxY - minY;
    minY -= spanY * 0.08;
    maxY += spanY * 0.08;
    const plot = { left: 34, top: 10, right: width - 10, bottom: height - 20 };
    const px = x => plot.left + (x - minX) / (maxX - minX) * (plot.right - plot.left);
    const py = y => plot.bottom - (y - minY) / (maxY - minY) * (plot.bottom - plot.top);

    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = plot.top + (plot.bottom - plot.top) * i / 4;
      ctx.beginPath(); ctx.moveTo(plot.left, y); ctx.lineTo(plot.right, y); ctx.stroke();
    }
    for (let i = 0; i <= 8; i++) {
      const x = plot.left + (plot.right - plot.left) * i / 8;
      ctx.beginPath(); ctx.moveTo(x, plot.top); ctx.lineTo(x, plot.bottom); ctx.stroke();
    }
    ctx.strokeStyle = muted;
    ctx.lineWidth = 1;
    if (minY <= 0 && maxY >= 0) {
      const y0 = py(0);
      ctx.beginPath(); ctx.moveTo(plot.left, y0); ctx.lineTo(plot.right, y0); ctx.stroke();
    }
    if (minX <= 0 && maxX >= 0) {
      const x0 = px(0);
      ctx.beginPath(); ctx.moveTo(x0, plot.top); ctx.lineTo(x0, plot.bottom); ctx.stroke();
    }
    ctx.fillStyle = muted;
    ctx.font = '8px Roboto, Arial, sans-serif';
    ctx.fillText('-10', plot.left, height - 7);
    ctx.fillText('10', plot.right - 11, height - 7);
    ctx.fillText(formatNumber(maxY, 6), 2, plot.top + 8);
    ctx.fillText(formatNumber(minY, 6), 2, plot.bottom);

    ctx.strokeStyle = blue;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    let drawing = false;
    for (const point of samples) {
      const x = px(point.x);
      const y = py(point.y);
      if (y < -height || y > height * 2) { drawing = false; continue; }
      if (!drawing) { ctx.beginPath(); ctx.moveTo(x, y); drawing = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = blue;
    ctx.font = '600 9px Roboto, Arial, sans-serif';
    ctx.fillText('y = ' + expression, plot.left + 4, plot.top + 10);
  }

  function notesRender() {
    if (dom.notesInput.value !== notes.text) dom.notesInput.value = notes.text;
    if (notes.text.trim() && !notes.lines.length) runNotes();
    dom.notesStatus.textContent = notes.status;
    if (notes.lines.length) notesOutputRender(notes.lines);
    else notesOutputRender([]);
    if (notes.graphExpr) drawGraph(notes.graphExpr);
    else dom.notesCanvas.hidden = true;
  }

  function clearNotes() {
    notes.text = '';
    notes.vars = {};
    notes.graphExpr = '';
    notes.lines = [];
    notes.status = '';
    write(LS.notes, '');
    dom.notesInput.value = '';
    dom.notesStatus.textContent = '';
    notesOutputRender([]);
    dom.notesCanvas.hidden = true;
  }

  /* ---------------------------------------------------------------- keypads */
  const key = (label, action, value = '', cls = '', span = 1) => ({ label, action, value, cls, span });
  const BASIC_KEYS = [
    [key('MC', 'mem', 'clear', 'mem'), key('MR', 'mem', 'recall', 'mem'), key('M+', 'mem', 'add', 'mem'), key('M−', 'mem', 'sub', 'mem'), key('%', 'percent', '', 'fn')],
    [key('AC', 'clear', '', 'fn'), key('CE', 'clearEntry', '', 'fn'), key('⌫', 'back', '', 'fn'), key('√', 'unary', 'sqrt', 'fn'), key('÷', 'op', '/', 'op')],
    [key('7', 'digit', '7', 'num'), key('8', 'digit', '8', 'num'), key('9', 'digit', '9', 'num'), key('x²', 'unary', 'sqr', 'fn'), key('×', 'op', '*', 'op')],
    [key('4', 'digit', '4', 'num'), key('5', 'digit', '5', 'num'), key('6', 'digit', '6', 'num'), key('1/x', 'unary', 'inv', 'fn'), key('−', 'op', '-', 'op')],
    [key('1', 'digit', '1', 'num'), key('2', 'digit', '2', 'num'), key('3', 'digit', '3', 'num'), key('±', 'toggleSign', '', 'fn'), key('+', 'op', '+', 'op')],
    [key('0', 'digit', '0', 'num', 2), key('.', 'digit', '.', 'num'), key('=', 'equals', '', 'eq', 2)]
  ];
  const SCI_KEYS = [
    [key('sin', 'fn', 'sin', 'fn'), key('cos', 'fn', 'cos', 'fn'), key('tan', 'fn', 'tan', 'fn'), key('asin', 'fn', 'asin', 'fn'), key('acos', 'fn', 'acos', 'fn')],
    [key('atan', 'fn', 'atan', 'fn'), key('sinh', 'fn', 'sinh', 'fn'), key('cosh', 'fn', 'cosh', 'fn'), key('tanh', 'fn', 'tanh', 'fn'), key('ln', 'fn', 'ln', 'fn')],
    [key('log', 'fn', 'log', 'fn'), key('log₂', 'fn', 'log2', 'fn'), key('e^x', 'fn', 'exp', 'fn'), key('10^x', 'fn', 'pow10', 'fn'), key('x^y', 'op', '^', 'fn')],
    [key('√', 'fn', 'sqrt', 'fn'), key('∛', 'fn', 'cbrt', 'fn'), key('x²', 'post', '^2', 'fn'), key('x³', 'post', '^3', 'fn'), key('1/x', 'fn', 'inv', 'fn')],
    [key('x!', 'post', '!', 'fn'), key('abs', 'fn', 'abs', 'fn'), key('Rand', 'rand', '', 'fn'), key('Ans', 'ans', '', 'fn'), key('π', 'const', 'π', 'const')],
    [key('e', 'const', 'e', 'const'), key('(', 'paren', '(', 'fn'), key(')', 'paren', ')', 'fn'), key('%', 'post', '%', 'fn'), key('÷', 'op', '/', 'op')],
    [key('7', 'digit', '7', 'num'), key('8', 'digit', '8', 'num'), key('9', 'digit', '9', 'num'), key('AC', 'clear', '', 'fn'), key('×', 'op', '*', 'op')],
    [key('4', 'digit', '4', 'num'), key('5', 'digit', '5', 'num'), key('6', 'digit', '6', 'num'), key('CE', 'clearEntry', '', 'fn'), key('−', 'op', '-', 'op')],
    [key('1', 'digit', '1', 'num'), key('2', 'digit', '2', 'num'), key('3', 'digit', '3', 'num'), key('⌫', 'back', '', 'fn'), key('+', 'op', '+', 'op')],
    [key('±', 'toggleSign', '', 'fn'), key('0', 'digit', '0', 'num'), key('.', 'digit', '.', 'num'), key('=', 'equals', '', 'eq', 2)]
  ];
  const PROG_KEYS = [
    [key('AND', 'op', '&', 'fn'), key('OR', 'op', '|', 'fn'), key('XOR', 'op', '^', 'fn'), key('NOT', 'unary', 'not', 'fn'), key('<<', 'op', '<<', 'fn'), key('>>', 'op', '>>', 'fn')],
    [key('A', 'digit', 'A', 'num'), key('B', 'digit', 'B', 'num'), key('C', 'digit', 'C', 'num'), key('D', 'digit', 'D', 'num'), key('E', 'digit', 'E', 'num'), key('F', 'digit', 'F', 'num')],
    [key('7', 'digit', '7', 'num'), key('8', 'digit', '8', 'num'), key('9', 'digit', '9', 'num'), key('÷', 'op', '/', 'op'), key('MOD', 'op', 'mod', 'fn'), key('AC', 'clear', '', 'fn')],
    [key('4', 'digit', '4', 'num'), key('5', 'digit', '5', 'num'), key('6', 'digit', '6', 'num'), key('×', 'op', '*', 'op'), key('CE', 'clearEntry', '', 'fn'), key('⌫', 'back', '', 'fn')],
    [key('1', 'digit', '1', 'num'), key('2', 'digit', '2', 'num'), key('3', 'digit', '3', 'num'), key('−', 'op', '-', 'op'), key('±', 'unary', 'neg', 'fn'), key('+', 'op', '+', 'op')],
    [key('0', 'digit', '0', 'num', 2), key('=', 'equals', '', 'eq', 4)]
  ];
  const RPN_KEYS = [
    [key('Enter', 'enter', '', 'eq'), key('Swap', 'swap', '', 'fn'), key('Drop', 'drop', '', 'fn'), key('Roll', 'roll', '', 'fn'), key('AC', 'clear', '', 'fn')],
    [key('7', 'digit', '7', 'num'), key('8', 'digit', '8', 'num'), key('9', 'digit', '9', 'num'), key('÷', 'op', '/', 'op'), key('√', 'unary', 'sqrt', 'fn')],
    [key('4', 'digit', '4', 'num'), key('5', 'digit', '5', 'num'), key('6', 'digit', '6', 'num'), key('×', 'op', '*', 'op'), key('x²', 'unary', 'sqr', 'fn')],
    [key('1', 'digit', '1', 'num'), key('2', 'digit', '2', 'num'), key('3', 'digit', '3', 'num'), key('−', 'op', '-', 'op'), key('1/x', 'unary', 'inv', 'fn')],
    [key('0', 'digit', '0', 'num'), key('.', 'digit', '.', 'num'), key('±', 'unary', 'neg', 'fn'), key('+', 'op', '+', 'op'), key('⌫', 'back', '', 'fn')]
  ];

  function renderKeys() {
    const rows = state.mode === 'basic' ? BASIC_KEYS : state.mode === 'scientific' ? SCI_KEYS : state.mode === 'programmer' ? PROG_KEYS : state.mode === 'rpn' ? RPN_KEYS : null;
    if (!rows) return;
    dom.keys.style.gridTemplateColumns = `repeat(${rows[0].length}, minmax(0, 1fr))`;
    dom.keys.replaceChildren();
    for (const row of rows) {
      for (const item of row) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `calc-key ${item.cls || ''}${item.span > 1 ? ' span' + item.span : ''}`.trim();
        button.dataset.calc = item.action;
        button.dataset.value = item.value;
        button.textContent = item.label;
        if (state.mode === 'programmer' && item.action === 'digit' && DIGITS.indexOf(item.value) >= programmer.base) button.disabled = true;
        dom.keys.appendChild(button);
      }
    }
  }

  /* ---------------------------------------------------------------- mode rendering */
  function renderFlags() {
    if (state.mode === 'scientific') {
      dom.angleFlag.hidden = false;
      dom.angleFlag.textContent = state.angle.toUpperCase();
    } else if (state.mode !== 'basic' && state.mode !== 'programmer') {
      dom.angleFlag.hidden = true;
    }
    if (state.mode === 'programmer') {
      dom.baseFlag.hidden = false;
      dom.baseFlag.textContent = BASE_NAMES[programmer.base];
      dom.wordFlag.hidden = false;
      dom.wordFlag.textContent = `${programmer.bits}-bit${programmer.signed ? ' signed' : ''}`;
    } else if (state.mode !== 'scientific') {
      dom.baseFlag.hidden = true;
      dom.wordFlag.hidden = true;
    }
    dom.memoryFlag.hidden = state.memory === 0;
  }

  function render() {
    panel.dataset.mode = state.mode;
    dom.modeName.textContent = MODE_NAMES[state.mode] || 'Basic';
    for (const button of dom.modes.querySelectorAll('[data-calc-mode]')) {
      button.classList.toggle('selected', button.dataset.calcMode === state.mode);
      button.setAttribute('aria-pressed', String(button.dataset.calcMode === state.mode));
    }
    const workspaceMode = state.mode === 'convert' || state.mode === 'notes';
    $('.calc-display-wrap', panel).hidden = workspaceMode;
    dom.keys.hidden = workspaceMode;
    dom.extra.hidden = state.mode !== 'programmer' && state.mode !== 'scientific';
    dom.convert.hidden = state.mode !== 'convert';
    dom.notes.hidden = state.mode !== 'notes';
    renderFlags();
    if (state.mode === 'convert') {
      converterRender();
      return;
    }
    if (state.mode === 'notes') {
      notesRender();
      return;
    }
    renderKeys();
    if (state.mode === 'basic') basicRender();
    else if (state.mode === 'scientific') scientificRender();
    else if (state.mode === 'programmer') programmerRender();
    else if (state.mode === 'rpn') rpnRender();
  }

  function transferState(nextMode) {
    const current = state.mode;
    if (current === nextMode) return;
    if (current === 'basic' && nextMode === 'scientific') {
      const seed = Number(basic.entry);
      if (Number.isFinite(seed)) scientific.lastResult = seed;
      scientific.expr = '';
      scientific.result = null; scientific.evaluated = false; scientific.error = '';
    } else if (current === 'scientific' && nextMode === 'basic') {
      const value = scientific.result !== null ? scientific.result : scientific.preview;
      if (value !== null && value !== undefined && Number.isFinite(value)) {
        basic.entry = rawNumber(value); basic.fresh = true; basic.expr = ''; basic.error = '';
      }
    } else if (current === 'programmer' && (nextMode === 'basic' || nextMode === 'scientific')) {
      const value = programmer.signed ? BigInt.asIntN(programmer.bits, programmer.value) : programmer.value;
      if (nextMode === 'basic') {
        basic.entry = value.toString(); basic.fresh = true; basic.expr = ''; basic.error = '';
      } else {
        scientific.expr = value.toString(); scientific.result = null; scientific.evaluated = false; scientific.error = '';
      }
    } else if (current === 'rpn' && (nextMode === 'basic' || nextMode === 'scientific')) {
      const value = rpn.entry !== '' ? Number(rpn.entry) : rpn.stack[0] || 0;
      if (nextMode === 'basic') { basic.entry = rawNumber(value); basic.fresh = true; basic.expr = ''; basic.error = ''; }
      else { scientific.expr = rawNumber(value); scientific.result = null; scientific.evaluated = false; scientific.error = ''; }
    } else if (nextMode === 'programmer' && (current === 'basic' || current === 'scientific' || current === 'rpn')) {
      const value = current === 'basic' ? Number(basic.entry) : current === 'scientific' ? scientific.result : (rpn.entry !== '' ? Number(rpn.entry) : rpn.stack[0]);
      if (Number.isFinite(value)) {
        programmer.value = progMask(BigInt(Math.trunc(value)));
        programmer.entry = progRaw(programmer.value);
        programmer.acc = null; programmer.op = null; programmer.fresh = true; programmer.expr = ''; programmer.error = '';
      }
    }
  }

  function setMode(nextMode) {
    if (!MODES.includes(nextMode)) return;
    if (nextMode === state.mode) { render(); return; }
    transferState(nextMode);
    state.mode = nextMode;
    write(LS.mode, nextMode);
    render();
  }

  /* ---------------------------------------------------------------- history load */
  function loadHistoryItem(index) {
    const item = state.history[index];
    if (!item) return;
    if (item.mode === 'programmer' && item.raw) {
      try {
        programmer.value = progMask(BigInt(item.raw));
        programmer.entry = progRaw(programmer.value);
        programmer.acc = null; programmer.op = null; programmer.fresh = true; programmer.error = '';
        state.mode = 'programmer';
        write(LS.mode, state.mode);
        dom.historyDrawer.hidden = true;
        render();
        return;
      } catch (error) { /* fall back to basic */ }
    }
    if (item.mode === 'scientific') {
      scientific.expr = String(item.expr || item.raw).replace(/\s*=$/, '');
      scientific.result = Number(item.raw);
      scientific.lastResult = Number(item.raw); scientific.evaluated = true; scientific.error = '';
      state.mode = 'scientific';
      write(LS.mode, state.mode);
      dom.historyDrawer.hidden = true;
      render();
      return;
    }
    if (item.mode === 'rpn') {
      rpn.stack = [Number(item.raw) || 0]; rpn.entry = ''; rpn.expr = item.expr; rpn.error = '';
      state.mode = 'rpn'; write(LS.mode, state.mode);
      dom.historyDrawer.hidden = true;
      render();
      return;
    }
    basic.entry = item.raw; basic.acc = null; basic.op = null; basic.repeat = null;
    basic.fresh = true; basic.expr = item.expr; basic.error = '';
    state.mode = 'basic'; write(LS.mode, state.mode);
    dom.historyDrawer.hidden = true;
    render();
  }

  /* ---------------------------------------------------------------- open / size */
  function clampPanel() {
    if (panel.hidden) return;
    const rect = panel.getBoundingClientRect();
    let left = parseFloat(panel.style.left);
    let top = parseFloat(panel.style.top);
    if (Number.isFinite(left)) panel.style.left = Math.max(8, Math.min(window.innerWidth - rect.width - 8, left)) + 'px';
    if (Number.isFinite(top)) panel.style.top = Math.max(8, Math.min(window.innerHeight - rect.height - 8, top)) + 'px';
  }

  function setOpen(open) {
    panel.hidden = !open;
    if (dom.button) dom.button.setAttribute('aria-pressed', String(open));
    write(LS.open, open ? '1' : '0');
    if (open) {
      clampPanel();
      render();
    }
  }

  function applySavedSize() {
    const size = readJSON(LS.size, null);
    if (size && Number(size.width) >= 330 && Number(size.height) >= 430) {
      panel.style.width = Math.min(Number(size.width), Math.max(330, window.innerWidth - 16)) + 'px';
      panel.style.height = Math.min(Number(size.height), Math.max(430, window.innerHeight - 16)) + 'px';
    }
    const pos = readJSON(LS.pos, null);
    if (pos && Number.isFinite(Number(pos.left)) && Number.isFinite(Number(pos.top))) {
      panel.style.left = Math.max(8, Number(pos.left)) + 'px';
      panel.style.top = Math.max(8, Number(pos.top)) + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      clampPanel();
    }
  }

  function saveSize() {
    if (panel.hidden) return;
    writeJSON(LS.size, { width: panel.offsetWidth, height: panel.offsetHeight });
  }

  function savePosition() {
    if (panel.hidden) return;
    writeJSON(LS.pos, { left: panel.offsetLeft, top: panel.offsetTop });
  }

  /* ---------------------------------------------------------------- copy */
  async function copyResult() {
    let text = '';
    if (state.mode === 'basic') text = basic.error ? '' : basic.entry;
    else if (state.mode === 'scientific') text = scientific.result !== null ? rawNumber(scientific.result, 12) : scientific.expr;
    else if (state.mode === 'programmer') text = progRaw(programmer.value);
    else if (state.mode === 'rpn') text = rpn.entry !== '' ? rpn.entry : rawNumber(rpn.stack[0] || 0);
    else if (state.mode === 'convert') text = dom.convTo.textContent;
    else if (state.mode === 'notes') text = dom.notesOutput.textContent.trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      const area = document.createElement('textarea');
      area.value = text; area.style.position = 'fixed'; area.style.opacity = '0';
      document.body.appendChild(area); area.select();
      try { document.execCommand('copy'); } catch (copyError) {}
      area.remove();
    }
    if (dom.copyBtn) {
      const original = dom.copyBtn.title;
      dom.copyBtn.title = 'Copied';
      setTimeout(() => { dom.copyBtn.title = original; }, 1200);
    }
  }

  /* ---------------------------------------------------------------- events */
  dom.modes.addEventListener('click', event => {
    const button = event.target.closest('[data-calc-mode]');
    if (button) setMode(button.dataset.calcMode);
  });

  dom.keys.addEventListener('click', event => {
    const button = event.target.closest('button[data-calc]');
    if (!button || button.disabled) return;
    const action = button.dataset.calc;
    const value = button.dataset.value || '';
    if (state.mode === 'basic') basicHandle(action, value);
    else if (state.mode === 'scientific') scientificHandle(action, value);
    else if (state.mode === 'programmer') programmerHandle(action, value);
    else if (state.mode === 'rpn') rpnHandle(action, value);
  });

  dom.extra.addEventListener('click', event => {
    const memory = event.target.closest('[data-sci-mem]');
    if (memory) { scientificMemory(memory.dataset.sciMem); return; }
    const base = event.target.closest('[data-prog-base]');
    if (base) { programmerBase(Number(base.dataset.progBase)); return; }
    const bits = event.target.closest('[data-prog-bits]');
    if (bits) { programmerBits(Number(bits.dataset.progBits)); return; }
    if (event.target.closest('[data-prog-signed]')) programmerToggleSigned();
  });

  dom.historyBtn.addEventListener('click', () => {
    dom.historyDrawer.hidden = false;
    dom.helpDrawer.hidden = true;
    renderHistory();
  });
  dom.historyClose.addEventListener('click', () => { dom.historyDrawer.hidden = true; });
  dom.historyClear.addEventListener('click', () => {
    state.history = [];
    saveHistory();
    renderHistory();
  });
  dom.historyList.addEventListener('click', event => {
    const item = event.target.closest('[data-index]');
    if (item) loadHistoryItem(Number(item.dataset.index));
  });
  dom.helpBtn.addEventListener('click', () => {
    dom.helpDrawer.hidden = false;
    dom.historyDrawer.hidden = true;
  });
  dom.helpClose.addEventListener('click', () => { dom.helpDrawer.hidden = true; });
  dom.copyBtn.addEventListener('click', copyResult);
  dom.angleFlag.addEventListener('click', () => { if (state.mode === 'scientific') scientificToggleAngle(); });
  dom.close.addEventListener('click', () => setOpen(false));
  if (dom.button) dom.button.addEventListener('click', () => setOpen(panel.hidden));

  dom.convCategory.addEventListener('change', () => converterCategory(dom.convCategory.value));
  dom.convFromUnit.addEventListener('change', () => {
    converter.from = dom.convFromUnit.value;
    converterRender({ syncCategory: false, syncUnits: false, syncValue: false });
  });
  dom.convToUnit.addEventListener('change', () => {
    converter.to = dom.convToUnit.value;
    converterRender({ syncCategory: false, syncUnits: false, syncValue: false });
  });
  dom.convFrom.addEventListener('input', () => {
    converter.value = dom.convFrom.value;
    converterRender({ syncCategory: false, syncUnits: false, syncValue: false });
  });
  dom.convSwap.addEventListener('click', converterSwap);
  dom.convNote.addEventListener('click', event => {
    if (!event.target.closest('[data-conv-retry]')) return;
    converter.rateAttempted = false;
    converter.rateStatus = 'Loading live ECB rates…';
    converterRender({ syncValue: false, syncUnits: false, syncCategory: false });
  });

  let notesTimer = 0;
  dom.notesInput.addEventListener('input', () => {
    notes.text = dom.notesInput.value;
    write(LS.notes, notes.text);
    clearTimeout(notesTimer);
    notesTimer = setTimeout(runNotes, 450);
  });
  dom.notesInput.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); runNotes(); }
  });
  dom.notesRun.addEventListener('click', runNotes);
  dom.notesClear.addEventListener('click', clearNotes);
  dom.notesGraph.addEventListener('click', () => {
    if (!dom.notesInput.value.trim()) return;
    runNotes();
    if (!notes.graphExpr) {
      dom.notesStatus.textContent = 'No y = … line to graph.';
    }
  });

  document.addEventListener('keydown', event => {
    if (panel.hidden) return;
    const target = event.target;
    const inField = target && target.closest && target.closest('input, textarea, select, [contenteditable="true"]');
    if (event.altKey && /^[1-6]$/.test(event.key)) {
      event.preventDefault();
      setMode(MODES[Number(event.key) - 1]);
      return;
    }
    if (event.key === 'Escape') {
      if (!dom.helpDrawer.hidden) { dom.helpDrawer.hidden = true; event.preventDefault(); return; }
      if (!dom.historyDrawer.hidden) { dom.historyDrawer.hidden = true; event.preventDefault(); return; }
    }
    if (inField) return;
    if (event.ctrlKey || event.metaKey) return;
    if (event.key === '?' || (event.key === '/' && event.shiftKey)) {
      dom.helpDrawer.hidden = false; event.preventDefault(); return;
    }

    const keyValue = event.key;
    if (state.mode === 'basic') {
      if (/^[0-9]$/.test(keyValue)) { event.preventDefault(); basicDigit(keyValue); return; }
      if (keyValue === '.') { event.preventDefault(); basicDigit('.'); return; }
      if (['+', '-', '*', '/'].includes(keyValue)) { event.preventDefault(); basicSetOp(keyValue); return; }
      if (keyValue === 'Enter' || keyValue === '=') { event.preventDefault(); basicEquals(); return; }
      if (keyValue === '%') { event.preventDefault(); basicPercent(); return; }
      if (keyValue === 'Backspace') { event.preventDefault(); basicBack(); return; }
      if (keyValue === 'Delete') { event.preventDefault(); basicClearEntry(); return; }
      if (keyValue === 'Escape') { event.preventDefault(); basicClear(); return; }
      return;
    }
    if (state.mode === 'scientific') {
      if (/^[0-9]$/.test(keyValue)) { event.preventDefault(); scientificAppend(keyValue, 'digit'); return; }
      if (keyValue === '.') { event.preventDefault(); scientificAppend('.', 'digit'); return; }
      if (['+', '-', '*', '/', '^'].includes(keyValue)) { event.preventDefault(); scientificAppend(keyValue, 'operator'); return; }
      if (keyValue === '(' || keyValue === ')') { event.preventDefault(); scientificAppend(keyValue, keyValue === '(' ? 'open' : 'token'); return; }
      if (keyValue === '!') { event.preventDefault(); scientificAppend('!', 'postfix'); return; }
      if (keyValue === '%') { event.preventDefault(); scientificAppend('%', 'postfix'); return; }
      if (keyValue === 'Enter' || keyValue === '=') { event.preventDefault(); scientificEquals(); return; }
      if (keyValue === 'Backspace') { event.preventDefault(); scientificBack(); return; }
      if (keyValue === 'Delete') { event.preventDefault(); scientificClear(); return; }
      if (keyValue === 'Escape') { event.preventDefault(); scientificClear(); return; }
      if (keyValue.toLowerCase() === 'd') { event.preventDefault(); scientificToggleAngle(); return; }
      return;
    }
    if (state.mode === 'programmer') {
      const upper = keyValue.toUpperCase();
      if (DIGITS.includes(upper) && DIGITS.indexOf(upper) < programmer.base) { event.preventDefault(); programmerDigit(upper); return; }
      if (keyValue === '+') { event.preventDefault(); programmerSetOp('+'); return; }
      if (keyValue === '-') { event.preventDefault(); programmerSetOp('-'); return; }
      if (keyValue === '*') { event.preventDefault(); programmerSetOp('*'); return; }
      if (keyValue === '/') { event.preventDefault(); programmerSetOp('/'); return; }
      if (keyValue === '&') { event.preventDefault(); programmerSetOp('&'); return; }
      if (keyValue === '|') { event.preventDefault(); programmerSetOp('|'); return; }
      if (keyValue === '^') { event.preventDefault(); programmerSetOp('^'); return; }
      if (keyValue === '~') { event.preventDefault(); programmerUnary('not'); return; }
      if (keyValue === 'Enter' || keyValue === '=') { event.preventDefault(); programmerEquals(); return; }
      if (keyValue === 'Backspace') { event.preventDefault(); programmerBack(); return; }
      if (keyValue === 'Delete') { event.preventDefault(); programmerClearEntry(); return; }
      if (keyValue === 'Escape') { event.preventDefault(); programmerClear(); return; }
      return;
    }
    if (state.mode === 'rpn') {
      if (/^[0-9]$/.test(keyValue)) { event.preventDefault(); rpnDigit(keyValue); return; }
      if (keyValue === '.') { event.preventDefault(); rpnDigit('.'); return; }
      if (['+', '-', '*', '/'].includes(keyValue)) { event.preventDefault(); rpnOperator(keyValue); return; }
      if (keyValue === 'Enter' || keyValue === '=') { event.preventDefault(); rpnEnter(); return; }
      if (keyValue === 'Backspace') { event.preventDefault(); rpnBack(); return; }
      if (keyValue === 'Escape') { event.preventDefault(); rpnClear(); return; }
    }
  });

  /* ---------------------------------------------------------------- drag and resize */
  let drag = null;
  dom.head.addEventListener('pointerdown', event => {
    if (event.target.closest('button, input, select, textarea, a')) return;
    const rect = panel.getBoundingClientRect();
    drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    dom.head.setPointerCapture(event.pointerId);
  });
  dom.head.addEventListener('pointermove', event => {
    if (!drag) return;
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, event.clientX - drag.dx));
    const top = Math.max(8, Math.min(window.innerHeight - height - 8, event.clientY - drag.dy));
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  });
  dom.head.addEventListener('pointerup', () => { drag = null; savePosition(); });
  dom.head.addEventListener('pointercancel', () => { drag = null; savePosition(); });

  let resize = null;
  dom.resize.addEventListener('pointerdown', event => {
    event.preventDefault();
    const rect = panel.getBoundingClientRect();
    const style = getComputedStyle(panel);
    resize = {
      startX: event.clientX, startY: event.clientY,
      width: rect.width, height: rect.height,
      rightAnchored: panel.style.right !== 'auto',
      bottomAnchored: panel.style.bottom !== 'auto',
      right: parseFloat(style.right) || 0,
      bottom: parseFloat(style.bottom) || 0,
      left: rect.left, top: rect.top
    };
    dom.resize.setPointerCapture(event.pointerId);
  });
  dom.resize.addEventListener('pointermove', event => {
    if (!resize) return;
    let maxW = resize.rightAnchored ? window.innerWidth - resize.right - 8 : window.innerWidth - resize.left - 8;
    let maxH = resize.bottomAnchored ? window.innerHeight - resize.bottom - 8 : window.innerHeight - resize.top - 8;
    maxW = Math.max(330, maxW);
    maxH = Math.max(430, maxH);
    const width = Math.max(330, Math.min(maxW, resize.width + event.clientX - resize.startX));
    const height = Math.max(430, Math.min(maxH, resize.height + event.clientY - resize.startY));
    panel.style.width = width + 'px';
    panel.style.height = height + 'px';
  });
  dom.resize.addEventListener('pointerup', () => { resize = null; saveSize(); });
  dom.resize.addEventListener('pointercancel', () => { resize = null; saveSize(); });

  window.addEventListener('resize', () => {
    clampPanel();
    if (state.mode === 'notes' && notes.graphExpr) drawGraph(notes.graphExpr);
  });
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(() => {
      if (panel.hidden) return;
      saveSize();
      if (state.mode === 'notes' && notes.graphExpr) drawGraph(notes.graphExpr);
    });
    observer.observe(panel);
  }

  /* ---------------------------------------------------------------- init */
  applySavedSize();
  setOpen(readString(LS.open, '0') === '1');
  renderHistory();
  if (state.angle !== 'deg') dom.angleFlag.textContent = 'RAD';
  dom.notesInput.value = notes.text;
  render();

  // A small read-only hook keeps browser checks and future integrations easy
  // without exposing the internal UI state.
  window.northstarCalculator = {
    evaluate: (expression, variables = {}) => evaluateExpression(expression, variables, state.angle),
    setMode,
    setOpen
  };
})();
