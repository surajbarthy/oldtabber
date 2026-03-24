/**
 * Tab Aging — toolbar popup: quick toggles (same settings as options page).
 */
(function () {
  'use strict';

  var U = self.TabAgingUtils;
  var $enabled = document.getElementById('enabled');
  var $dot = document.getElementById('dot');
  var $tint = document.getElementById('tint');
  var $emoji = document.getElementById('emoji');
  var $openOptions = document.getElementById('openOptions');
  var $status = document.getElementById('status');

  function setStatus(t) {
    $status.textContent = t || '';
  }

  async function load() {
    var data = await chrome.storage.local.get(['settings']);
    var s = U.normalizeSettings(data.settings);
    $enabled.checked = !!s.enabled;
    $dot.checked = !!s.useFaviconDot;
    $tint.checked = !!s.useFaviconTint;
    $emoji.checked = !!s.useTitleMarkers;
  }

  async function savePartial(patch) {
    var data = await chrome.storage.local.get(['settings']);
    var merged = Object.assign({}, data.settings || {}, patch);
    var s = U.normalizeSettings(merged);
    await chrome.storage.local.set({ settings: s });
    try {
      await chrome.runtime.sendMessage({ type: 'TAB_AGING_OPTIONS_CHANGED' });
    } catch (e) {}
    setStatus('Saved');
    setTimeout(function () {
      setStatus('');
    }, 1200);
  }

  $enabled.addEventListener('change', function () {
    savePartial({ enabled: $enabled.checked });
  });
  $dot.addEventListener('change', function () {
    savePartial({ useFaviconDot: $dot.checked });
  });
  $tint.addEventListener('change', function () {
    savePartial({ useFaviconTint: $tint.checked });
  });
  $emoji.addEventListener('change', function () {
    savePartial({ useTitleMarkers: $emoji.checked });
  });

  $openOptions.addEventListener('click', function () {
    chrome.runtime.openOptionsPage();
  });

  load().catch(function (e) {
    console.debug('[Tab Aging] popup load', e);
    setStatus('Could not load settings.');
  });
})();
