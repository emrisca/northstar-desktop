// RTKLIB .pos solution import and accepted coordinates for Northstar.
// Only fixed epochs (Q=1) are averaged. Float, single and other statuses are listed but never accepted.
(function () {
  const STATUS = { 1: 'Fixed', 2: 'Float', 3: 'SBAS', 4: 'DGPS', 5: 'Unresolved', 6: 'PPP' };
  const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);
  const WEEK_SECONDS = 604800;

  // RTKLIB writes either GPS week/seconds-of-week or a calendar date, depending
  // on out-timeform. Convert both to one epoch record the rest of the app uses.
  function gpsClock(week, tow) {
    if (!Number.isFinite(week) || !Number.isFinite(tow)) return null;
    return {
      week,
      tow,
      timeMs: GPS_EPOCH_MS + (week * WEEK_SECONDS + tow) * 1000
    };
  }

  function calendarClock(line) {
    const match = line.match(/^(\d{4})[\/-](\d{2})[\/-](\d{2})[ T](\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/);
    if (!match) return null;
    const seconds = Number(match[6]);
    if (!Number.isFinite(seconds)) return null;
    const whole = Math.floor(seconds);
    const milliseconds = Math.round((seconds - whole) * 1000);
    const timeMs = Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], whole, milliseconds);
    if (!Number.isFinite(timeMs)) return null;
    const elapsed = (timeMs - GPS_EPOCH_MS) / 1000;
    const week = Math.floor(elapsed / WEEK_SECONDS);
    return gpsClock(week, elapsed - week * WEEK_SECONDS);
  }

  // Parses an rnx2rtkp .pos file. Returns { header, epochs }.
  function parsePos(text) {
    const header = {};
    const epochs = [];
    for (const raw of String(text).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('%')) {
        const m = line.match(/^%\s*(program|inp file|ref pos)\s*:\s*(.*)$/i);
        if (m) {
          const key = m[1].toLowerCase().replace(' ', '_');
          (header[key] = header[key] || []).push(m[2].trim());
        }
        continue;
      }
      // Calendar output starts with two fields (date and time); week/TOW output
      // starts with two numeric fields. Both put lat/lon/hgt/Q at 2..5.
      const calendar = calendarClock(line);
      const f = line.split(/\s+/);
      if (f.length < 10) continue;
      const clock = calendar || gpsClock(Number(f[0]), Number(f[1]));
      if (!clock) continue;
      const q = Number(f[5]);
      const epoch = {
        week: clock.week,
        tow: clock.tow,
        timeMs: clock.timeMs,
        lat: Number(f[2]),
        lon: Number(f[3]),
        height: Number(f[4]),
        status: q,
        statusLabel: STATUS[q] || 'Unknown',
        satellites: Number(f[6]),
        sdn: Number(f[7]),
        sde: Number(f[8]),
        sdu: Number(f[9])
      };
      if ([epoch.lat, epoch.lon, epoch.height].every(Number.isFinite)) epochs.push(epoch);
    }
    return { header, epochs };
  }

  // Averages fixed epochs only. Returns null when there are none.
  function acceptFixed(epochs) {
    const fixed = epochs.filter(e => e.status === 1);
    if (!fixed.length) return null;
    const mean = key => fixed.reduce((sum, e) => sum + e[key], 0) / fixed.length;
    return {
      lat: mean('lat'),
      lon: mean('lon'),
      height: mean('height'),
      epochCount: fixed.length,
      firstTow: fixed[0].tow,
      lastTow: fixed[fixed.length - 1].tow,
      week: fixed[0].week
    };
  }

  // Counts epochs by status, for display.
  function statusCounts(epochs) {
    const counts = {};
    for (const e of epochs) counts[e.statusLabel] = (counts[e.statusLabel] || 0) + 1;
    return counts;
  }

  window.northstarGNSS = { parsePos, acceptFixed, statusCounts, STATUS };
})();
