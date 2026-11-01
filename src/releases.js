/* Past releases.
 *
 * The updater only moves forward, so a build that breaks something needs a way
 * back. The shell reads the project's release page and knows which file belongs
 * to this platform; this file draws the list and starts the download.
 */
(function () {
  'use strict';

  var box = document.getElementById('releaseRestore');
  var api = window.northstarUpdate;
  if (!box) return;
  if (!api || !api.releases) {
    box.hidden = true;
    return;
  }

  var button = document.getElementById('releaseListBtn');
  var list = document.getElementById('releaseList');
  var note = document.getElementById('releaseNote');
  var loading = false;

  function say(text) {
    if (!note) return;
    note.textContent = text || '';
    note.hidden = !text;
  }

  function megabytes(bytes) {
    if (!bytes) return '';
    return Math.max(1, Math.round(bytes / (1024 * 1024))) + ' MB';
  }

  function day(value) {
    if (!value) return '';
    var date = new Date(value);
    return isNaN(date.getTime()) ? '' : date.toLocaleDateString();
  }

  function install(release, control) {
    control.disabled = true;
    control.textContent = 'Downloading…';
    say('Downloading Northstar ' + release.version + '…');
    api.installRelease(release.tag).then(function () {
      control.textContent = 'Opened';
      say('The ' + release.version + ' installer is open. Quit Northstar, finish the install, then reopen it. Your projects and settings stay where they are.');
    }).catch(function (error) {
      control.disabled = false;
      control.textContent = 'Install';
      say(error && error.message ? error.message : String(error));
    });
  }

  function row(release) {
    var line = document.createElement('div');
    line.className = 'release-row';

    var meta = document.createElement('div');
    meta.className = 'release-meta';
    var version = document.createElement('b');
    version.textContent = release.version;
    var detail = document.createElement('small');
    detail.textContent = [day(release.date), megabytes(release.size), release.asset]
      .filter(Boolean).join(' · ');
    meta.appendChild(version);
    meta.appendChild(detail);
    line.appendChild(meta);

    var control = document.createElement('button');
    control.type = 'button';
    control.className = 'secondary-button';
    if (release.current) {
      control.textContent = 'Running';
      control.disabled = true;
    } else if (!release.asset) {
      control.textContent = 'No installer';
      control.disabled = true;
    } else {
      control.textContent = 'Install';
      control.addEventListener('click', function () { install(release, control); });
    }
    line.appendChild(control);
    return line;
  }

  function show() {
    if (loading) return;
    loading = true;
    button.disabled = true;
    button.textContent = 'Looking…';
    api.releases().then(function (releases) {
      list.innerHTML = '';
      (releases || []).slice(0, 12).forEach(function (release) {
        list.appendChild(row(release));
      });
      list.hidden = !(releases && releases.length);
      button.hidden = true;
      say(releases && releases.length
        ? 'Pick the version that worked. Installing an older release keeps your projects and settings.'
        : 'No releases were listed.');
    }).catch(function (error) {
      button.disabled = false;
      button.textContent = 'Show past releases';
      say(error && error.message ? error.message : String(error));
    }).then(function () {
      loading = false;
    });
  }

  button.addEventListener('click', show);
})();
