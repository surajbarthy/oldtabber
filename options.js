/**
 * OldTabber — options page: master switch + reset tracked tabs (timing is in the toolbar popup).
 */
(function () {
  'use strict';

  var U = self.TabAgingUtils;
  var $enabled = document.getElementById('enabled');
  var $reset = document.getElementById('resetPages');
  var $status = document.getElementById('status');

  function setStatus(text) {
    $status.textContent = text || '';
  }

  async function savePartial(patch) {
    var data = await chrome.storage.local.get(['settings']);
    var merged = Object.assign({}, data.settings || {}, patch);
    var s = U.normalizeSettings(merged);
    await chrome.storage.local.set({ settings: s });
    try {
      await chrome.runtime.sendMessage({ type: 'TAB_AGING_OPTIONS_CHANGED' });
    } catch (e) {
      /* background may be sleeping */
    }
    setStatus('Saved.');
    setTimeout(function () {
      setStatus('');
    }, 2000);
  }

  async function load() {
    var data = await chrome.storage.local.get(['settings']);
    var s = U.normalizeSettings(data.settings);
    $enabled.checked = !!s.enabled;
  }

  $enabled.addEventListener('change', function () {
    savePartial({ enabled: $enabled.checked, useTitleMarkers: true });
  });

  $reset.addEventListener('click', function () {
    if (!confirm('Clear all per-tab timers? Aging restarts from when you next focus each tab.')) return;
    chrome.runtime.sendMessage({ type: 'TAB_AGING_RESET_PAGES' }, function (res) {
      if (res && res.ok) setStatus('All tab records cleared.');
      else setStatus('Could not reset (try reloading the extension).');
      setTimeout(function () {
        setStatus('');
      }, 3000);
    });
  });

  load().catch(function (e) {
    console.debug('[OldTabber] options load', e);
    setStatus('Failed to load settings.');
  });
})();
