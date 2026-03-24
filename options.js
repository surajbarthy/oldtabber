/**
 * Tab Aging — options page: read/write settings and notify background.
 */
(function () {
  'use strict';

  var U = self.TabAgingUtils;
  var $enabled = document.getElementById('enabled');
  var $favicon = document.getElementById('favicon');
  var $title = document.getElementById('title');
  var $thresholdsLabel = document.getElementById('thresholdsLabel');
  var $reset = document.getElementById('resetPages');
  var $status = document.getElementById('status');

  function setStatus(text) {
    $status.textContent = text || '';
  }

  async function load() {
    var data = await chrome.storage.local.get(['settings']);
    var s = Object.assign(U.defaultSettings(), data.settings || {});
    $enabled.checked = !!s.enabled;
    $favicon.checked = !!s.useFaviconOverlay;
    $title.checked = !!s.useTitleMarkers;
    $thresholdsLabel.textContent = (s.agingThresholds || U.DEFAULT_THRESHOLDS).join(', ');
  }

  async function savePartial(patch) {
    var data = await chrome.storage.local.get(['settings']);
    var s = Object.assign(U.defaultSettings(), data.settings || {}, patch);
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

  $enabled.addEventListener('change', function () {
    savePartial({ enabled: $enabled.checked });
  });
  $favicon.addEventListener('change', function () {
    savePartial({ useFaviconOverlay: $favicon.checked });
  });
  $title.addEventListener('change', function () {
    savePartial({ useTitleMarkers: $title.checked });
  });

  $reset.addEventListener('click', function () {
    if (!confirm('Clear all tracked pages? Aging will restart from when you next focus each tab.')) return;
    chrome.runtime.sendMessage({ type: 'TAB_AGING_RESET_PAGES' }, function (res) {
      if (res && res.ok) setStatus('All page records cleared.');
      else setStatus('Could not reset (try reloading the extension).');
      setTimeout(function () {
        setStatus('');
      }, 3000);
    });
  });

  load().catch(function (e) {
    console.debug('[Tab Aging] options load', e);
    setStatus('Failed to load settings.');
  });
})();
