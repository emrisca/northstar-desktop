/* The desktop bridge.
 *
 * Two jobs. The first is the project store: before the interface's own scripts
 * run, this seeds the project and the preferences the shell read from disk, and
 * afterwards it mirrors every write back to those files. The second is the nine
 * endpoints that used to come from serve.py, which answer 503 until their batch
 * lands (docs/analysis.md has the table).
 *
 * This file must load before the rest of the interface, because the interface
 * reads localStorage the moment it parses and the project has to be there by
 * then. In a browser there is no shell to talk to, so everything below the seed
 * is skipped and the web build behaves as it did.
 */
(function () {
  'use strict';

  var tauri = typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);
  var boot = window.__NORTHSTAR_BOOT__ || null;
  window.northstarDesktop = { running: tauri, backend: tauri };
  // A menu item that only a shell can honour is hidden rather than offered and
  // then doing nothing, which is what the web build would get.
  if (tauri) document.documentElement.classList.add('desktop-shell');

  var PROJECT_KEY = 'northstar-project';
  var PREFIX = 'northstar-';
  // Whether the browser copy has already been written to a file. Without this,
  // deleting a project would bring it back on the next launch from the copy the
  // import deliberately left behind.
  var IMPORTED_KEY = 'northstar-legacy-imported';
  var NOT_SETTINGS = { 'northstar-project': true, 'northstar-firms-map-key': true };
  var store = {
    id: null,
    name: null,
    path: null,
    projects: [],
    folder: ''
  };
  var legacy = null;
  var ready = false;

  function parse(text) {
    try {
      return JSON.parse(text);
    } catch (error) {
      return null;
    }
  }

  function textOf(value) {
    return typeof value === 'string' ? value : JSON.stringify(value);
  }

  /* ------------------------------------------------------------- the seed */

  if (boot) {
    var keys = (boot.settings && boot.settings.keys) || {};
    Object.keys(keys).forEach(function (key) {
      try {
        localStorage.setItem(key, textOf(keys[key]));
      } catch (error) {}
    });

    if (boot.project) {
      try {
        localStorage.setItem(PROJECT_KEY, JSON.stringify(boot.project));
      } catch (error) {}
      store.projects = boot.projects || [];
      store.folder = boot.dataFolder || '';
    } else {
      var imported =
        String((boot.settings && boot.settings.keys && boot.settings.keys[IMPORTED_KEY]) || '') === '1';
      store.projects = boot.projects || [];
      store.folder = boot.dataFolder || '';
      if (imported) {
        // The file was the authority from the moment the import ran, so a copy
        // left in the browser is history and must not become a project again.
        try {
          localStorage.removeItem(PROJECT_KEY);
        } catch (error) {}
      } else {
        // No project file yet. Batch 0 kept one in this webview's localStorage,
        // and that is the copy worth carrying over, once. It stays where it is
        // so the window opens on it, and the browser copy is never destroyed.
        legacy = localStorage.getItem(PROJECT_KEY);
      }
    }

    var last = (boot.settings && boot.settings.lastProject) || null;
    if (boot.project && last) {
      var match = (boot.projects || []).filter(function (entry) {
        return entry.id === last;
      })[0];
      store.id = last;
      store.path = boot.projectPath || (match && match.path) || null;
      store.name = (match && match.name) || boot.project.workspaceName || null;
    }
  }

  if (!tauri) {
    // Opened in a browser: nothing to answer, and serve.py is not here either.
    return;
  }

  var invoke = window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__);

  /* ------------------------------------------------------- mirror the writes
   *
   * The interface writes localStorage on every change and reads it eagerly.
   * Rather than rewrite those call sites, a write is mirrored: the browser copy
   * stays authoritative for the running window, and the file follows a moment
   * later. Coalescing matters, because a pan across the map saves the project
   * many times a second and each save is a file.
   */

  var projectTimer = 0;
  var settingsTimer = 0;

  function mirrorProject() {
    if (projectTimer) clearTimeout(projectTimer);
    projectTimer = setTimeout(function () {
      projectTimer = 0;
      var document_ = parse(localStorage.getItem(PROJECT_KEY) || '');
      if (!document_ || typeof document_ !== 'object') return;
      setStatus('Saving…');
      invoke('project_save', { document: document_ }).then(function (saved) {
        adopt(saved.entry);
        setStatus('Saved');
      }).catch(function (error) {
        setStatus('Not saved: ' + error);
      });
    }, 400);
  }

  function mirrorSettings() {
    if (settingsTimer) clearTimeout(settingsTimer);
    settingsTimer = setTimeout(flushSettings, 600);
  }

  function flushSettings() {
    if (settingsTimer) {
      clearTimeout(settingsTimer);
      settingsTimer = 0;
    }
    var keys = {};
    for (var index = 0; index < localStorage.length; index += 1) {
      var key = localStorage.key(index);
      if (!key || key.indexOf(PREFIX) !== 0 || NOT_SETTINGS[key]) continue;
      var raw = localStorage.getItem(key);
      if (raw !== null) keys[key] = raw;
    }
    return invoke('settings_save', {
      document: { version: 1, lastProject: store.id || null, keys: keys }
    }).catch(function () {});
  }

  var setItem = Storage.prototype.setItem;
  var removeItem = Storage.prototype.removeItem;
  Storage.prototype.setItem = function (key, value) {
    setItem.call(this, key, value);
    if (!ready || this !== window.localStorage || typeof key !== 'string') return;
    if (key === PROJECT_KEY) mirrorProject();
    else if (key.indexOf(PREFIX) === 0 && !NOT_SETTINGS[key]) mirrorSettings();
  };
  Storage.prototype.removeItem = function (key) {
    removeItem.call(this, key);
    if (!ready || this !== window.localStorage || typeof key !== 'string') return;
    if (key.indexOf(PREFIX) === 0 && !NOT_SETTINGS[key]) mirrorSettings();
  };

  /* ------------------------------------------------------------- the status */

  function setStatus(text) {
    var label = document.getElementById('workspaceSaveLabel');
    if (label) label.textContent = text;
    var dot = document.getElementById('savedDot');
    if (dot) dot.classList.toggle('unsaved', text !== 'Saved');
  }

  function adopt(entry) {
    if (!entry) return;
    store.id = entry.id;
    store.name = entry.name;
    store.path = entry.path;
    var known = store.projects.filter(function (other) {
      return other.id === entry.id;
    })[0];
    if (known) Object.assign(known, entry);
    else store.projects.unshift(entry);
    flushSettings();
  }

  /* ------------------------------------------------------------ the commands */

  function refreshProjects() {
    return invoke('project_list').then(function (list) {
      store.projects = list || [];
      renderProjects();
      return store.projects;
    });
  }

  /** Hand a project document to the interface's own importer, so opening a
   *  file runs the same code an imported file always did. */
  function apply(text, name) {
    var input = document.getElementById('importProjectInput');
    if (!input) return false;
    try {
      var file = new File([text], name || 'project.northstar.json', {
        type: 'application/json'
      });
      var transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (error) {
      window.northstarApp && window.northstarApp.message('This project could not be opened: ' + error);
      return false;
    }
  }

  function openById(id) {
    return invoke('project_open', { id: id }).then(function (opened) {
      if (!apply(opened.text)) return null;
      store.path = opened.path;
      store.id = id;
      var known = store.projects.filter(function (entry) {
        return entry.id === id;
      })[0];
      store.name = known ? known.name : null;
      flushSettings();
      setStatus('Saved');
      closeProjects();
      return opened;
    }).catch(function (error) {
      window.northstarApp && window.northstarApp.message('That project did not open: ' + error);
      return null;
    });
  }

  /** Called by the shell when a project is dropped on the window or when a
   *  second launch names one. The shell evaluates this with the path. */
  window.northstarOpenPath = function (path) {
    if (!path) return;
    invoke('project_open_path', { path: path }).then(function (opened) {
      if (!apply(opened.text)) return;
      store.path = opened.path;
      store.id = null;
      refreshProjects();
      setStatus('Saved');
      window.northstarApp && window.northstarApp.message('Opened ' + opened.path);
    }).catch(function (error) {
      window.northstarApp && window.northstarApp.message('That file is not a Northstar project: ' + error);
    });
  };

  function chooseProject() {
    return invoke('project_pick').then(function (opened) {
      if (!opened) return null;
      if (!apply(opened.text)) return null;
      store.path = opened.path;
      store.id = null;
      refreshProjects();
      setStatus('Saved');
      return opened;
    }).catch(function (error) {
      window.northstarApp && window.northstarApp.message('That project did not open: ' + error);
      return null;
    });
  }

  function saveNow() {
    if (projectTimer) {
      clearTimeout(projectTimer);
      projectTimer = 0;
    }
    var document_ = parse(localStorage.getItem(PROJECT_KEY) || '');
    if (!document_) return Promise.resolve(null);
    return invoke('project_save', { document: document_ }).then(function (saved) {
      adopt(saved.entry);
      setStatus('Saved');
      return saved.entry;
    }).catch(function (error) {
      setStatus('Not saved: ' + error);
      return null;
    });
  }

  function saveCopy() {
    var document_ = parse(localStorage.getItem(PROJECT_KEY) || '');
    if (!document_) return Promise.resolve(null);
    return invoke('project_save_as', { document: document_ }).then(function (saved) {
      if (!saved) return null;
      adopt(saved.entry);
      setStatus('Saved');
      window.northstarApp && window.northstarApp.message('Saved a copy at ' + saved.entry.path);
      return saved.entry;
    }).catch(function (error) {
      window.northstarApp && window.northstarApp.message('That copy was not saved: ' + error);
      return null;
    });
  }

  function newProject() {
    return invoke('project_forget').then(function () {
      store.id = null;
      store.path = null;
      return flushSettings();
    }).then(function () {
      try {
        localStorage.removeItem(PROJECT_KEY);
      } catch (error) {}
      location.reload();
    });
  }

  /* ------------------------------------------------------------- the dialog */

  function projectsDialog() {
    return document.getElementById('projectsDialog');
  }

  function closeProjects() {
    var dialog = projectsDialog();
    if (dialog && dialog.open) dialog.close();
  }

  function markImported() {
    try {
      localStorage.setItem(IMPORTED_KEY, '1');
    } catch (error) {}
    flushSettings();
  }

  function when(entry) {
    if (!entry.modified) return '';
    var date = new Date(entry.modified);
    var days = Math.floor((Date.now() - entry.modified) / 86400000);
    if (days <= 0) {
      return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }
    if (days === 1) return 'Yesterday';
    if (days < 7) return days + ' days ago';
    return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function renderProjects() {
    var list = document.getElementById('projectsList');
    if (!list) return;
    list.textContent = '';
    if (!store.projects.length) {
      var empty = document.createElement('p');
      empty.className = 'projects-empty';
      empty.textContent = 'No saved projects yet. This one will be saved the first time you change it.';
      list.appendChild(empty);
      return;
    }
    store.projects.forEach(function (entry) {
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'project-row';
      row.dataset.projectId = entry.id;
      if (entry.id === store.id) row.dataset.current = 'true';

      var mark = document.createElement('span');
      mark.className = 'material-symbols project-row-icon';
      mark.setAttribute('aria-hidden', 'true');
      mark.textContent = entry.id === store.id ? 'folder_open' : 'folder';

      var body = document.createElement('span');
      body.className = 'project-row-body';
      var name = document.createElement('b');
      name.textContent = entry.name;
      var detail = document.createElement('small');
      detail.textContent = when(entry) + ' · ' + (entry.bytes / 1024).toFixed(1) + ' KB';
      body.appendChild(name);
      body.appendChild(detail);

      row.appendChild(mark);
      row.appendChild(body);
      row.addEventListener('click', function () {
        openById(entry.id);
      });
      list.appendChild(row);
    });
  }

  function openProjects() {
    var dialog = projectsDialog();
    if (!dialog) return;
    refreshProjects();
    if (!dialog.open) dialog.showModal();
  }

  /* --------------------------------------------------------------- the menu */

  window.northstarFiles = {
    list: refreshProjects,
    open: openById,
    choose: chooseProject,
    save: saveNow,
    saveCopy: saveCopy,
    create: newProject
  };

  function ready_() {
    ready = true;
    var menu = document.getElementById('northStarMenuPanel');
    if (menu) {
      menu.addEventListener('click', function (event) {
        var item = event.target.closest('[data-project-action]');
        if (!item) return;
        var action = item.dataset.projectAction;
        if (action === 'open-project') {
          chooseProject();
        } else if (action === 'open-recent') {
          openProjects();
        } else if (action === 'save-now') {
          saveNow().then(function (entry) {
            if (entry) window.northstarApp && window.northstarApp.message('Saved ' + entry.path);
          });
        } else if (action === 'save-as') {
          saveCopy();
        } else if (action === 'new-project') {
          newProject();
        }
      });
    }

    var dialog = projectsDialog();
    if (dialog) {
      var openButton = document.getElementById('projectsOpen');
      var folderButton = document.getElementById('projectsFolder');
      var newButton = document.getElementById('projectsNew');
      var closeButton = document.getElementById('projectsClose');
      if (openButton) openButton.addEventListener('click', chooseProject);
      if (folderButton) folderButton.addEventListener('click', function () {
        invoke('project_reveal', { path: store.folder }).catch(function () {});
      });
      if (newButton) newButton.addEventListener('click', newProject);
      if (closeButton) closeButton.addEventListener('click', closeProjects);
      dialog.addEventListener('click', function (event) {
        if (event.target === dialog) closeProjects();
      });
    }

    document.getElementById('workspaceSaveLabel') && setStatus(store.path ? 'Saved' : 'Not saved yet');

    if (legacy) {
      var document_ = parse(legacy);
      if (document_ && typeof document_ === 'object') {
        invoke('project_save', { document: document_ }).then(function (saved) {
          adopt(saved.entry);
          setStatus('Saved');
          markImported();
          window.northstarApp && window.northstarApp.message('Saved the project this build kept in the browser');
        }).catch(function () {});
        return;
      }
    }
    // Either there was nothing to carry over or the copy was unusable, and
    // either way the import is spent.
    markImported();
    flushSettings();

    if (!store.projects.length) {
      // First launch with nothing saved: the recent list is the welcome screen.
      setTimeout(openProjects, 300);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ready_);
  } else {
    ready_();
  }

  /* ------------------------------------------------------- the old endpoints
   *
   * The interface still asks for these paths with fetch, because that is what
   * the web build did. Each one now names the Rust command that answers it, and
   * the query string is read the way serve.py read it. A command failure comes
   * back as 502 with the message the card shows, which is the status and body
   * the Python proxy used for the same failure.
   */

  var ROUTES = {
    '/api/preflight': function (query) {
      var flag = (query.get('noaa') || '1').toLowerCase();
      return invoke('preflight', { noaa: ['0', 'false', 'no'].indexOf(flag) < 0 });
    },
    '/api/noaa/nearby': function (query) {
      var lat = query.get('lat');
      var lon = query.get('lon');
      var height = query.get('height') || '0';
      if (!lat || !lon || !isFinite(Number(lat)) || !isFinite(Number(lon))) {
        return Promise.reject('Latitude and longitude are required numbers.');
      }
      return invoke('noaa_nearby', {
        lat: Number(lat),
        lon: Number(lon),
        height: Number(height) || 0
      });
    },
    '/api/noaa/station': function (query) {
      return invoke('noaa_station', { id: query.get('id') || '' });
    },
    '/api/noaa/base': function (query) {
      var hours = Number(query.get('hours') || 1);
      var interval = Number(query.get('interval') || 30);
      if (!Number.isInteger(hours) || hours < 1 || hours > 24) {
        return Promise.reject('Hours must be between 1 and 24.');
      }
      if (!Number.isInteger(interval) || [1, 5, 15, 30].indexOf(interval) < 0) {
        return Promise.reject('Interval must be 1, 5, 15 or 30 seconds.');
      }
      return invoke('noaa_base', {
        station: query.get('station') || '',
        date: query.get('date') || '',
        start: query.get('start') || '00:00',
        hours: hours,
        interval: interval
      });
    }
  };

  var PENDING = {
    '/api/rtklib/install/info': { command: 'rtklib_install_info', batch: 4 },
    '/api/rtklib/install/status': { command: 'rtklib_install_status', batch: 4 },
    '/api/rtklib/install': { command: 'rtklib_install', batch: 4 },
    '/api/rtklib/convert': { command: 'rtklib_convert', batch: 4 },
    '/api/rtklib/run': { command: 'rtklib_run', batch: 4 }
  };

  function json(status, body) {
    return new Response(JSON.stringify(body), {
      status: status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }

  var realFetch = window.fetch.bind(window);

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : input && input.url ? input.url : '';
    if (url.indexOf('/api/') !== 0) {
      return realFetch(input, init);
    }

    var split = url.split('?');
    var path = split[0];
    var query = new URLSearchParams(split[1] || '');
    if (ROUTES[path]) {
      return ROUTES[path](query).then(
        function (body) {
          return json(200, body);
        },
        function (error) {
          return json(502, { ok: false, error: String(error) });
        }
      );
    }

    var entry = PENDING[path] || { command: 'none', batch: 0 };
    return Promise.resolve(
      json(503, {
        ok: false,
        error: 'The desktop backend does not answer yet.',
        endpoint: path,
        command: entry.command,
        batch: entry.batch
      })
    );
  };
})();
