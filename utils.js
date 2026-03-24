/**
 * OldTabber — shared utilities (content script + service worker via importScripts).
 * No ES modules: attaches to globalThis for Chrome extension contexts.
 */

(function (global) {
  'use strict';

  /**
   * Verbose extension logs (tab URL, inject retries, skips). Off by default.
   * Set to true in this file while debugging, reload the extension.
   */
  var DEBUG = false;

  /**
   * Favicon dot/tint are implemented but disabled for this release (title-only). Set true in a
   * future version and restore popup/options toggles to turn effects back on.
   */
  var FAVICON_EFFECTS_ENABLED = false;

  /**
   * When true: refresh alarm every 30s (see background.js). When false: periodic refresh every
   * ALARM_PERIOD_MINUTES_PROD (wall-clock thresholds use real time either way).
   */
  var FAST_TEST_MODE = false;
  /** Chained one-shot alarms use fractional minutes (0.5 = 30s). Not used when FAST_TEST_MODE is false. */
  var FAST_TEST_ALARM_DELAY_MINUTES = 0.5;
  /** Background refresh so background tabs pick up new emoji level without switching away. */
  var ALARM_PERIOD_MINUTES_PROD = 5;

  /** Minimum idle gap between consecutive emoji tiers (ms). */
  var MIN_STEP_GAP_MS = 60000;

  /**
   * Product presets (Balanced is the default for new installs and “reset to defaults”).
   */
  var MODE_PRESET_STEPS = {
    balanced: [
      { value: 30, unit: 'minutes' },
      { value: 2, unit: 'hours' },
      { value: 1, unit: 'days' },
      { value: 3, unit: 'days' },
    ],
    focus: [
      { value: 10, unit: 'minutes' },
      { value: 30, unit: 'minutes' },
      { value: 2, unit: 'hours' },
      { value: 8, unit: 'hours' },
    ],
    chill: [
      { value: 1, unit: 'hours' },
      { value: 6, unit: 'hours' },
      { value: 2, unit: 'days' },
      { value: 7, unit: 'days' },
    ],
  };

  /** @deprecated use MODE_PRESET_STEPS.balanced — kept for stable export name */
  var DEFAULT_AGING_STEPS = MODE_PRESET_STEPS.balanced.map(function (s) {
    return { value: s.value, unit: s.unit };
  });

  function unitToMsMult(unit) {
    if (unit === 'minutes') return 60000;
    if (unit === 'hours') return 3600000;
    return 86400000;
  }

  function stepToMs(step) {
    var v = Number(step.value);
    if (!isFinite(v) || v < 1) v = 1;
    return Math.floor(v * unitToMsMult(step.unit));
  }

  function cloneDefaultSteps() {
    return MODE_PRESET_STEPS.balanced.map(function (s) {
      return { value: s.value, unit: s.unit };
    });
  }

  function clonePresetSteps(presetId) {
    var src = MODE_PRESET_STEPS[presetId];
    if (!src) return cloneDefaultSteps();
    return src.map(function (s) {
      return { value: s.value, unit: s.unit };
    });
  }

  /**
   * Returns sanitized steps + thresholds for a named mode (balanced | focus | chill).
   */
  function applyPreset(presetId) {
    return sanitizeAgingSteps(clonePresetSteps(presetId), null);
  }

  function thresholdsMsEqual(a, b) {
    if (!a || !b || a.length !== 4 || b.length !== 4) return false;
    for (var i = 0; i < 4; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  /**
   * Compare current steps to preset thresholds (after sanitize). Returns 'balanced' | 'focus' | 'chill' | 'custom'.
   */
  function getPresetNameFromAgingSteps(steps) {
    if (!steps || !Array.isArray(steps) || steps.length !== 4) return 'custom';
    var user = sanitizeAgingSteps(steps, null);
    var ids = ['balanced', 'focus', 'chill'];
    for (var i = 0; i < ids.length; i++) {
      var ref = applyPreset(ids[i]);
      if (thresholdsMsEqual(user.thresholdsMs, ref.thresholdsMs)) return ids[i];
    }
    return 'custom';
  }

  function migrateLegacyThresholdsDays(arr) {
    if (!arr || arr.length !== 4) return null;
    var fallbacks = [1, 4, 8, 15];
    var out = [];
    for (var i = 0; i < 4; i++) {
      var n = Math.max(1, Math.round(Number(arr[i])));
      if (!isFinite(n)) n = fallbacks[i];
      out.push({ value: n, unit: 'days' });
    }
    return out;
  }

  /**
   * Normalize four { value, unit } steps to strict time order (each tier strictly after the previous).
   * @param {Array|null} steps
   * @param {Array|null} legacyThresholds - old settings.agingThresholds (days as integers)
   * @returns {{ steps: Array, thresholdsMs: number[] }}
   */
  function sanitizeAgingSteps(steps, legacyThresholds) {
    var base = cloneDefaultSteps();
    var parsed = [];
    var i;
    if (steps && Array.isArray(steps) && steps.length === 4) {
      for (i = 0; i < 4; i++) {
        var seg = steps[i];
        var u =
          seg && (seg.unit === 'minutes' || seg.unit === 'hours' || seg.unit === 'days')
            ? seg.unit
            : base[i].unit;
        var v = seg != null ? Number(seg.value) : NaN;
        if (!isFinite(v) || v < 1) v = base[i].value;
        parsed.push({ value: v, unit: u });
      }
    } else {
      var mig = migrateLegacyThresholdsDays(legacyThresholds);
      parsed = mig || base;
    }

    var ms = parsed.map(stepToMs);
    var iter;
    for (iter = 0; iter < 24; iter++) {
      var changed = false;
      for (i = 1; i < 4; i++) {
        if (ms[i] <= ms[i - 1]) {
          ms[i] = ms[i - 1] + MIN_STEP_GAP_MS;
          var mult = unitToMsMult(parsed[i].unit);
          parsed[i].value = Math.ceil(ms[i] / mult);
          if (parsed[i].value < 1) parsed[i].value = 1;
          ms = parsed.map(stepToMs);
          changed = true;
        }
      }
      if (!changed) break;
    }

    return { steps: parsed, thresholdsMs: ms };
  }

  function getIdleMs(lastSeenAt, nowMs) {
    if (lastSeenAt == null || typeof lastSeenAt !== 'number') return 0;
    var now = nowMs != null ? nowMs : Date.now();
    var diff = now - lastSeenAt;
    return diff < 0 ? 0 : diff;
  }

  /**
   * Level 0 = no marker; 1–4 = emoji or minimal tiers. Idle time must reach thresholdsMs[i] for level i+1.
   */
  function getLevelFromIdleMs(idleMs, thresholdsMs) {
    var t =
      thresholdsMs && thresholdsMs.length === 4
        ? thresholdsMs
        : sanitizeAgingSteps(null, null).thresholdsMs;
    var level = 0;
    for (var i = 0; i < 4; i++) {
      if (idleMs >= t[i]) level = i + 1;
    }
    return Math.min(level, 4);
  }

  /**
   * Browser-internal / non-web schemes we never inject into or track.
   * Normal pages must be http: or https: only (MVP).
   */
  function isRestrictedBrowserUrl(href) {
    if (!href || typeof href !== 'string') return true;
    var h = href.trim().toLowerCase();
    return (
      h.indexOf('chrome://') === 0 ||
      h.indexOf('edge://') === 0 ||
      h.indexOf('about:') === 0 ||
      h.indexOf('chrome-extension://') === 0 ||
      h.indexOf('moz-extension://') === 0 ||
      h.indexOf('devtools://') === 0 ||
      h.indexOf('view-source:') === 0 ||
      h.indexOf('file://') === 0
    );
  }

  function isTrackableUrl(url) {
    if (!url || typeof url !== 'string') return false;
    if (isRestrictedBrowserUrl(url)) return false;
    try {
      var u = new URL(url);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch (e) {
      return false;
    }
  }

  /**
   * Normalize for stable keys: origin + pathname only (no query, no hash).
   */
  function normalizeUrl(urlString) {
    if (!urlString) return '';
    try {
      var u = new URL(urlString);
      return u.origin + u.pathname;
    } catch (e) {
      return '';
    }
  }

  /**
   * Emoji-style tab markers. Chrome tab titles use normal text layout; color vs monochrome varies by
   * OS/font. Levels: 🥚 → ⏳ → 🔥 → ☠️.
   */
  var EMOJI_MARKER_L1 = '\uD83E\uDD5A';
  var EMOJI_MARKER_L2 = '\u23F3';
  var EMOJI_MARKER_L3 = '\uD83D\uDD25';
  var EMOJI_MARKER_L4 = '\u2620' + '\uFE0F';

  /**
   * Prefixes we may have injected (all styles + legacy). Longest UTF-16 length first for stripping.
   * Still strips U+26A0 U+FE0F / bare U+26A0 for titles saved under the old level-2 warning marker,
   * and 👀 (U+1F440) for titles saved under the previous level-2 emoji.
   */
  function getTitleStripMarkersSortedDesc() {
    var raw = [
      EMOJI_MARKER_L2,
      EMOJI_MARKER_L4,
      '\u26A0\uFE0F',
      '\uD83D\uDC40',
      '\uD83D\uDD38',
      '\uD83D\uDD36',
      '\uD83D\uDD34',
      '\u26D4',
      EMOJI_MARKER_L3,
      EMOJI_MARKER_L1,
      '\u25CF',
      '\u2716',
      '\u2715',
      '\u25CB',
      '\u00B7',
      '\u26A0',
      '\u2620',
    ];
    raw.sort(function (a, b) {
      return b.length - a.length;
    });
    return raw;
  }

  /**
   * Remove any known injected title prefix(es) from the start, repeatedly (e.g. "● ● Title").
   * Does not Unicode-normalize or alter inner code points — only removes known whole-prefix matches.
   */
  function stripInjectedTitlePrefixes(rawTitle) {
    if (!rawTitle) return '';
    var s = rawTitle;
    var markers = getTitleStripMarkersSortedDesc();
    var changed = true;
    while (changed) {
      changed = false;
      for (var i = 0; i < markers.length; i++) {
        var m = markers[i];
        if (s.indexOf(m) === 0) {
          s = s.slice(m.length).replace(/^\s+/, '');
          changed = true;
          break;
        }
      }
    }
    return s;
  }

  /**
   * Title prefix for tab UI. indicatorStyle: "minimal" | "emoji" (default minimal).
   */
  function getTitleMarkerForLevel(level, indicatorStyle) {
    if (level <= 0) return '';
    var st = indicatorStyle === 'emoji' ? 'emoji' : 'minimal';
    if (st === 'emoji') {
      switch (level) {
        case 1:
          return EMOJI_MARKER_L1;
        case 2:
          return EMOJI_MARKER_L2;
        case 3:
          return EMOJI_MARKER_L3;
        default:
          return EMOJI_MARKER_L4;
      }
    }
    switch (level) {
      case 1:
        return '\u00B7';
      case 2:
        return '\u25CB';
      case 3:
        return '\u25CF';
      default:
        return '\u2716';
    }
  }

  function defaultSettings() {
    var san = sanitizeAgingSteps(null, null);
    return {
      enabled: true,
      useTitleMarkers: true,
      useFaviconDot: false,
      useFaviconTint: false,
      indicatorStyle: 'minimal',
      agingSteps: san.steps,
      agingThresholdsMs: san.thresholdsMs,
    };
  }

  /**
   * Merge saved settings with defaults; migrate legacy agingThresholds → agingSteps.
   */
  function normalizeSettings(raw) {
    var s = raw && typeof raw === 'object' ? raw : {};
    var o = Object.assign(defaultSettings(), s);
    if (Object.prototype.hasOwnProperty.call(s, 'useFaviconOverlay')) {
      var hasDot = Object.prototype.hasOwnProperty.call(s, 'useFaviconDot');
      var hasTint = Object.prototype.hasOwnProperty.call(s, 'useFaviconTint');
      if (!hasDot && !hasTint && s.useFaviconOverlay) {
        o.useFaviconDot = true;
        o.useFaviconTint = true;
      }
    }
    delete o.useFaviconOverlay;
    if (!FAVICON_EFFECTS_ENABLED) {
      o.useFaviconDot = false;
      o.useFaviconTint = false;
    }

    var san = sanitizeAgingSteps(s.agingSteps, s.agingThresholds);
    o.agingSteps = san.steps;
    o.agingThresholdsMs = san.thresholdsMs;
    delete o.agingThresholds;

    o.useTitleMarkers = true;

    o.indicatorStyle = s.indicatorStyle === 'emoji' ? 'emoji' : 'minimal';

    return o;
  }

  global.TabAgingUtils = {
    DEBUG: DEBUG,
    FAVICON_EFFECTS_ENABLED: FAVICON_EFFECTS_ENABLED,
    FAST_TEST_MODE: FAST_TEST_MODE,
    FAST_TEST_ALARM_DELAY_MINUTES: FAST_TEST_ALARM_DELAY_MINUTES,
    ALARM_PERIOD_MINUTES_PROD: ALARM_PERIOD_MINUTES_PROD,
    MIN_STEP_GAP_MS: MIN_STEP_GAP_MS,
    DEFAULT_AGING_STEPS: DEFAULT_AGING_STEPS,
    MODE_PRESET_STEPS: MODE_PRESET_STEPS,
    applyPreset: applyPreset,
    getPresetNameFromAgingSteps: getPresetNameFromAgingSteps,
    clonePresetSteps: clonePresetSteps,
    unitToMsMult: unitToMsMult,
    stepToMs: stepToMs,
    sanitizeAgingSteps: sanitizeAgingSteps,
    getIdleMs: getIdleMs,
    getLevelFromIdleMs: getLevelFromIdleMs,
    isRestrictedBrowserUrl: isRestrictedBrowserUrl,
    isTrackableUrl: isTrackableUrl,
    normalizeUrl: normalizeUrl,
    getTitleMarkerForLevel: getTitleMarkerForLevel,
    stripInjectedTitlePrefixes: stripInjectedTitlePrefixes,
    getTitleStripMarkersSortedDesc: getTitleStripMarkersSortedDesc,
    defaultSettings: defaultSettings,
    normalizeSettings: normalizeSettings,
  };
})(typeof self !== 'undefined' ? self : globalThis);
