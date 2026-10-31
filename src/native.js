/* The desktop bridge.
 *
 * The web build talked to serve.py. This build talks to commands in the Rust
 * shell, and batch 0 has none of them yet, so this file answers the endpoints
 * the front end would otherwise ask a server for. Each answer is a 503 with a
 * body, which the existing error paths already handle: the cards show their
 * message and keep working instead of failing with an unhandled rejection.
 *
 * The table is the contract. Every entry names the Rust command that replaces
 * it, and the batch that does so (docs/analysis.md has the long form). Delete an
 * entry when its command lands, and delete this file when the table is empty.
 */
(function () {
  'use strict';

  var tauri = typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);
  window.northstarDesktop = { running: tauri, backend: false };

  if (!tauri) {
    // Opened in a browser: nothing to answer, and serve.py is not here either.
    return;
  }

  var COMMANDS = {
    '/api/preflight': { command: 'preflight', batch: 3 },
    '/api/noaa/nearby': { command: 'noaa_nearby', batch: 3 },
    '/api/noaa/station': { command: 'noaa_station', batch: 3 },
    '/api/noaa/base': { command: 'noaa_base', batch: 3 },
    '/api/rtklib/install/info': { command: 'rtklib_install_info', batch: 4 },
    '/api/rtklib/install/status': { command: 'rtklib_install_status', batch: 4 },
    '/api/rtklib/install': { command: 'rtklib_install', batch: 4 },
    '/api/rtklib/convert': { command: 'rtklib_convert', batch: 4 },
    '/api/rtklib/run': { command: 'rtklib_run', batch: 4 }
  };

  var realFetch = window.fetch.bind(window);

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : input && input.url ? input.url : '';
    if (url.indexOf('/api/') !== 0) {
      return realFetch(input, init);
    }

    var path = url.split('?')[0];
    var entry = COMMANDS[path] || { command: 'none', batch: 0 };
    var body = {
      ok: false,
      error: 'The desktop backend does not answer yet.',
      endpoint: path,
      command: entry.command,
      batch: entry.batch
    };

    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      })
    );
  };
})();
