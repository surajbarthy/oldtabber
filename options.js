/**
 * Tab Aging — options page: settings, per-emoji timing (sliders + units), notify background.
 */
(function () {
  'use strict';

  var U = self.TabAgingUtils;
  var $enabled = document.getElementById('enabled');
  var $title = document.getElementById('title');
  var $reset = document.getElementById('resetPages');
  var $resetThresholds = document.getElementById('resetThresholds');
  var $status = document.getElementById('status');

  var applyingFromSanitize = false;
  var saveTimer = null;

  function maxForUnit(unit) {
    if (unit === 'minutes') return 10080;
    if (unit === 'hours') return 720;
    return 365;
  }

  function setStatus(text) {
    $status.textContent = text || '';
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
        var range = document.getElementById('tier-' + i + '-range');
        var num = document.getElementById('tier-' + i + '-num');
        var unit = document.getElementById('tier-' + i + '-unit');
        unit.value = s.unit;
        var mx = maxForUnit(s.unit);
        range.max = String(mx);
        num.max = String(mx);
        num.min = '1';
        range.min = '1';
        var v = Math.min(mx, Math.max(1, Math.round(Number(s.value))));
        range.value = String(v);
        num.value = String(v);
      }
    } finally {
      applyingFromSanitize = false;
    }
  }

  function syncRangeFromNum(i) {
    var range = document.getElementById('tier-' + i + '-range');
    var num = document.getElementById('tier-' + i + '-num');
    var unit = document.getElementById('tier-' + i + '-unit');
    var mx = maxForUnit(unit.value);
    range.max = String(mx);
    num.max = String(mx);
    var v = Math.min(mx, Math.max(1, Math.round(Number(num.value)) || 1));
    num.value = String(v);
    range.value = String(v);
  }

  function syncNumFromRange(i) {
    var range = document.getElementById('tier-' + i + '-range');
    var num = document.getElementById('tier-' + i + '-num');
    num.value = range.value;
  }

  function onTierInputChanged() {
    if (applyingFromSanitize) return;
    var raw = readFormSteps();
    var san = U.sanitizeAgingSteps(raw, null);
    applyStepsToForm(san.steps);
    scheduleSave(san.steps);
  }

  function scheduleSave(steps) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      savePartial({ agingSteps: steps });
    }, 350);
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
    $title.checked = !!s.useTitleMarkers;
    applyStepsToForm(s.agingSteps);
  }

  $enabled.addEventListener('change', function () {
    savePartial({ enabled: $enabled.checked });
  });
  $title.addEventListener('change', function () {
    savePartial({ useTitleMarkers: $title.checked });
  });

  for (var t = 0; t < 4; t++) {
    (function (i) {
      document.getElementById('tier-' + i + '-range').addEventListener('input', function () {
        syncNumFromRange(i);
        onTierInputChanged();
      });
      document.getElementById('tier-' + i + '-num').addEventListener('input', function () {
        syncRangeFromNum(i);
        onTierInputChanged();
      });
      document.getElementById('tier-' + i + '-num').addEventListener('change', function () {
        syncRangeFromNum(i);
        onTierInputChanged();
      });
      document.getElementById('tier-' + i + '-unit').addEventListener('change', function () {
        syncRangeFromNum(i);
        onTierInputChanged();
      });
    })(t);
  }

  $resetThresholds.addEventListener('click', function () {
    var def = U.DEFAULT_AGING_STEPS.map(function (x) {
      return { value: x.value, unit: x.unit };
    });
    var san = U.sanitizeAgingSteps(def, null);
    applyStepsToForm(san.steps);
    savePartial({ agingSteps: san.steps });
    setStatus('Timing reset to defaults.');
    setTimeout(function () {
      setStatus('');
    }, 2500);
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
    console.debug('[Tab Aging] options load', e);
    setStatus('Failed to load settings.');
  });
})();
