/* One-click updates.
 *
 * The shell owns the network and signature checks; this file owns the small
 * amount of UI around them: a topbar pill when a release is waiting, a dialog
 * with the version and notes, progress while the download runs, and a manual
 * check in Settings. It polls the shell rather than listening to events, which
 * keeps the plain-script frontend free of a bundler.
 */
(function () {
  'use strict';

  var api = window.northstarUpdate;
  if (!api) {
    // The browser harness has no shell to check against; do not promise an
    // update control that cannot work there.
    var section = document.getElementById('updateSettings');
    if (section) section.hidden = true;
    return;
  }

  function byId(id) {
    return document.getElementById(id);
  }

  var pill = byId('updatePill');
  var pillText = byId('updatePillText');
  var dialog = byId('updateDialog');
  var title = byId('updateTitle');
  var summary = byId('updateSummary');
  var notes = byId('updateNotes');
  var status = byId('updateStatus');
  var progress = byId('updateProgress');
  var progressFill = byId('updateProgressFill');
  var progressText = byId('updateProgressText');
  var later = byId('updateLater');
  var now = byId('updateNow');
  var close = byId('updateClose');
  var checkBtn = byId('updateCheckBtn');
  var settingsStatus = byId('updateSettingsStatus');
  var currentVersion = byId('updateCurrentVersion');

  var view = null;
  var checking = false;
  var dismissed = null;
  var installTimer = 0;

  function bytes(value) {
    if (!value) return '0 MB';
    if (value >= 1024 * 1024 * 1024) return (value / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
    return Math.max(1, Math.round(value / (1024 * 1024))) + ' MB';
  }

  function message() {
    if (!view) return 'Updates are checked at launch and every six hours.';
    switch (view.status) {
      case 'checking':
        return 'Checking for updates…';
      case 'upToDate':
        return 'Northstar ' + (view.currentVersion || '') + ' is up to date.';
      case 'available':
        return 'Version ' + view.version + ' is ready to install.';
      case 'downloading':
        return 'Downloading ' + bytes(view.downloaded) +
          (view.total ? ' of ' + bytes(view.total) : '') + '…';
      case 'installing':
        return 'Installing… Northstar will restart when it is done.';
      case 'restarting':
        return 'Restarting Northstar…';
      case 'error':
        return view.error || 'The update could not be completed.';
      default:
        return 'Updates are checked at launch and every six hours.';
    }
  }

  function isWorking() {
    return view && (view.status === 'downloading' || view.status === 'installing' ||
      view.status === 'restarting');
  }

  function isActive() {
    return view && (view.status === 'available' || view.status === 'downloading' ||
      view.status === 'installing' || view.status === 'restarting' ||
      view.status === 'error');
  }

  function drawProgress() {
    if (!progress) return;
    var working = view && (view.status === 'downloading' || view.status === 'installing');
    progress.hidden = !working;
    if (!working) return;
    var ratio = view.total ? Math.min(1, view.downloaded / view.total) : 0;
    if (progressFill) progressFill.style.width = (ratio * 100).toFixed(1) + '%';
    if (progressText) {
      progressText.textContent = view.status === 'installing'
        ? 'Installing…'
        : bytes(view.downloaded) + (view.total ? ' of ' + bytes(view.total) : '');
    }
  }

  function drawButtons() {
    var working = isWorking();
    var active = isActive();
    if (checkBtn) checkBtn.disabled = checking || working;
    if (now) {
      now.hidden = !active || view.status === 'error';
      now.disabled = working;
      now.textContent = working ? 'Updating…' : 'Update now';
    }
    if (later) {
      later.disabled = working;
      later.textContent = view && view.status === 'error' ? 'Close' : 'Later';
    }
  }

  function drawDialog() {
    if (!dialog) return;
    if (!view) return;
    if (view.status === 'available') {
      if (title) title.textContent = 'Northstar ' + view.version;
      if (summary) {
        summary.textContent = 'A new version is ready. It will download, verify its signature, ' +
          'install, and restart Northstar. Your projects are not touched.';
      }
    } else if (view.status === 'error') {
      if (title) title.textContent = 'Update failed';
      if (summary) summary.textContent = 'The current version is still usable. Try again, or ' +
        'download the release from GitHub.';
    } else if (view.status === 'downloading') {
      if (title) title.textContent = 'Downloading Northstar ' + (view.version || '');
    } else if (view.status === 'installing') {
      if (title) title.textContent = 'Installing Northstar ' + (view.version || '');
    } else if (view.status === 'restarting') {
      if (title) title.textContent = 'Restarting Northstar';
    }
    if (notes) {
      notes.textContent = view.notes || '';
      notes.hidden = !view.notes;
    }
    if (status) status.textContent = message();
    drawProgress();
    drawButtons();
  }

  function render(next) {
    if (next) view = next;
    if (!view) return;
    if (currentVersion) currentVersion.textContent = view.currentVersion || '0.1.0';
    if (settingsStatus) settingsStatus.textContent = message();

    var version = view.version || '';
    var showPill = view.status === 'available' && dismissed !== version;
    if (pill) {
      pill.hidden = !showPill;
      if (pillText) pillText.textContent = 'Update ' + version;
    }
    if (dialog && dialog.open) drawDialog();
    drawButtons();
  }

  function openDialog() {
    if (!dialog) return;
    drawDialog();
    if (!dialog.open) dialog.showModal();
  }

  function closeDialog() {
    if (dialog && dialog.open) dialog.close();
  }

  function showError(error) {
    var text = error && error.message ? error.message : String(error);
    view = {
      currentVersion: view && view.currentVersion,
      status: 'error',
      version: view && view.version,
      notes: null,
      error: text || 'The update could not be completed.'
    };
    render(view);
    openDialog();
  }

  function stopInstallPoll() {
    if (installTimer) {
      clearInterval(installTimer);
      installTimer = 0;
    }
  }

  function startInstallPoll() {
    stopInstallPoll();
    installTimer = setInterval(function () {
      api.state().then(function (next) {
        render(next);
        if (next.status === 'error' || next.status === 'upToDate' ||
            next.status === 'idle' || next.status === 'available') {
          stopInstallPoll();
        }
      }).catch(function () {});
    }, 500);
  }

  function check(manual) {
    if (checking || isWorking()) return;
    checking = true;
    if (settingsStatus) settingsStatus.textContent = 'Checking for updates…';
    api.check().then(function (next) {
      render(next);
      if (next.status === 'available') {
        dismissed = null;
        openDialog();
      } else if (manual && next.status === 'upToDate') {
        if (settingsStatus) settingsStatus.textContent = message();
      }
    }).catch(function (error) {
      if (manual) showError(error);
      else if (settingsStatus) settingsStatus.textContent = 'Could not reach the update server.';
    }).then(function () {
      checking = false;
      drawButtons();
    });
  }

  function updateNow() {
    if (!view || isWorking()) return;
    if (now) now.disabled = true;
    if (later) later.disabled = true;
    if (status) status.textContent = 'Starting the update…';
    api.install().then(function () {
      startInstallPoll();
    }).catch(function (error) {
      showError(error);
    });
  }

  if (pill) {
    pill.addEventListener('click', openDialog);
  }
  if (now) {
    now.addEventListener('click', updateNow);
  }
  if (later) {
    later.addEventListener('click', function () {
      if (view && view.status === 'error') {
        closeDialog();
        return;
      }
      dismissed = view && view.version ? view.version : null;
      closeDialog();
      render(view);
    });
  }
  if (close) {
    close.addEventListener('click', function () {
      if (view && view.status === 'available') dismissed = view.version;
      closeDialog();
      render(view);
    });
  }
  if (checkBtn) {
    checkBtn.addEventListener('click', function () {
      check(true);
    });
  }

  api.state().then(render).catch(function () {});
  setInterval(function () {
    if (!dialog || !dialog.open) {
      api.state().then(render).catch(function () {});
    }
  }, 10000);
})();
