/**
 * Tab Aging — toolbar popup: mode-first UX, collapsible advanced timing.
 */
(function () {
  'use strict';

  var U = self.TabAgingUtils;
  var $enabled = document.getElementById('enabled');
  var $customizeToggle = document.getElementById('customize-toggle');
  var $advanced = document.getElementById('advanced-panel');
  var $customBadge = document.getElementById('custom-badge');
  var $resetModeDefaults = document.getElementById('resetModeDefaults');
  var $resetTabTimers = document.getElementById('resetTabTimers');
  var $openOptions = document.getElementById('openOptions');
  var $status = document.getElementById('status');
  var $pills = document.querySelectorAll('.mode-pill');

  var applyingFromSanitize = false;
  var saveTimer = null;

  function maxForUnit(unit) {
    if (unit === 'minutes') return 10080;
    if (unit === 'hours') return 720;
    return 365;
  }

  function setStatus(t) {
    $status.textContent = t || '';
  }

  function readFormSteps() {
    var steps = [];
    for (var i = 0; i < 4; i++) {
      var num = document.getElementById('tier-' + i + '-num');
      var unit = document.getElementById('tier-' + i + '-unit');
      steps.push({ value: Number(num.value), unit: unit.value });
    }
    return steps;
  }

  function applyStepsToForm(steps) {
    applyingFromSanitize = true;
    try {
      for (var i = 0; i < 4; i++) {
        var s = steps[i];
        var num = document.getElementById('tier-' + i + '-num');
        var unit = document.getElementById('tier-' + i + '-unit');
        unit.value = s.unit;
        var mx = maxForUnit(s.unit);
        num.max = String(mx);
        num.min = '1';
        var v = Math.min(mx, Math.max(1, Math.round(Number(s.value))));
        num.value = String(v);
      }
    } finally {
      applyingFromSanitize = false;
    }
  }

  function syncNumBounds(i) {
    var num = document.getElementById('tier-' + i + '-num');
    var unit = document.getElementById('tier-' + i + '-unit');
    var mx = maxForUnit(unit.value);
    num.max = String(mx);
    var v = Math.min(mx, Math.max(1, Math.round(Number(num.value)) || 1));
    num.value = String(v);
  }

  function refreshModeUI() {
    var steps = readFormSteps();
    var name = U.getPresetNameFromAgingSteps(steps);
    for (var p = 0; p < $pills.length; p++) {
      var pill = $pills[p];
      var id = pill.getAttribute('data-preset');
      pill.classList.toggle('is-selected', id === name);
    }
    if (name === 'custom') {
      $customBadge.classList.remove('is-hidden');
    } else {
      $customBadge.classList.add('is-hidden');
    }
  }

  function onTierInputChanged() {
    if (applyingFromSanitize) return;
    var raw = readFormSteps();
    var san = U.sanitizeAgingSteps(raw, null);
    applyStepsToForm(san.steps);
    scheduleSave(san.steps);
    refreshModeUI();
  }

  function scheduleSave(steps) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      savePartial({ agingSteps: steps, useTitleMarkers: true });
    }, 350);
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
    }, 1000);
  }

  function setAdvancedOpen(open) {
    $customizeToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      $advanced.classList.remove('is-collapsed');
      $advanced.removeAttribute('hidden');
    } else {
      $advanced.classList.add('is-collapsed');
      $advanced.setAttribute('hidden', '');
    }
  }

  /**
   * Reset timing to current named mode, or Balanced when settings are Custom.
   */
  function resetToModeDefaults() {
    var current = U.getPresetNameFromAgingSteps(readFormSteps());
    var target = current === 'custom' ? 'balanced' : current;
    var san = U.applyPreset(target);
    applyStepsToForm(san.steps);
    savePartial({ agingSteps: san.steps, useTitleMarkers: true });
    refreshModeUI();
    setStatus('Timing reset');
    setTimeout(function () {
      setStatus('');
    }, 1200);
  }

  async function load() {
    var data = await chrome.storage.local.get(['settings']);
    var s = U.normalizeSettings(data.settings);
    $enabled.checked = !!s.enabled;
    applyStepsToForm(s.agingSteps);
    refreshModeUI();
  }

  $enabled.addEventListener('change', function () {
    savePartial({ enabled: $enabled.checked, useTitleMarkers: true });
  });

  for (var t = 0; t < 4; t++) {
    (function (i) {
      document.getElementById('tier-' + i + '-num').addEventListener('input', function () {
        syncNumBounds(i);
        onTierInputChanged();
      });
      document.getElementById('tier-' + i + '-num').addEventListener('change', function () {
        syncNumBounds(i);
        onTierInputChanged();
      });
      document.getElementById('tier-' + i + '-unit').addEventListener('change', function () {
        syncNumBounds(i);
        onTierInputChanged();
      });
    })(t);
  }

  for (var q = 0; q < $pills.length; q++) {
    $pills[q].addEventListener('click', function () {
      var preset = this.getAttribute('data-preset');
      if (!preset) return;
      var san = U.applyPreset(preset);
      applyStepsToForm(san.steps);
      savePartial({ agingSteps: san.steps, useTitleMarkers: true });
      refreshModeUI();
      setStatus('Mode applied');
      setTimeout(function () {
        setStatus('');
      }, 900);
    });
  }

  $customizeToggle.addEventListener('click', function () {
    var open = $customizeToggle.getAttribute('aria-expanded') !== 'true';
    setAdvancedOpen(open);
  });

  $resetModeDefaults.addEventListener('click', function () {
    resetToModeDefaults();
  });

  $resetTabTimers.addEventListener('click', function () {
    if (!confirm('Clear last-focus times for every tab? Counters restart when you visit each tab again.')) return;
    chrome.runtime.sendMessage({ type: 'TAB_AGING_RESET_PAGES' }, function (res) {
      if (res && res.ok) setStatus('Tab timers cleared');
      else setStatus('Could not reset — try reloading the extension');
      setTimeout(function () {
        setStatus('');
      }, 2200);
    });
  });

  $openOptions.addEventListener('click', function () {
    chrome.runtime.openOptionsPage();
  });

  load().catch(function (e) {
    console.debug('[Tab Aging] popup load', e);
    setStatus('Could not load settings.');
  });
})();
