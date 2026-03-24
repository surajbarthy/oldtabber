/**
 * Tab Aging — shared utilities (content script + service worker via importScripts).
 * No ES modules: attaches to globalThis for Chrome extension contexts.
 */

(function (global) {
  'use strict';

  /**
   * When true: one “aging unit” = 30 seconds and a chained alarm fires every 30s (see background.js).
   * Set to false for production (real calendar days + one repeating alarm per 24h).
   */
  var FAST_TEST_MODE = true;
  var AGING_UNIT_MS = FAST_TEST_MODE ? 30 * 1000 : 86400000;
  /** Chained one-shot alarms use fractional minutes (0.5 = 30s). Not used when FAST_TEST_MODE is false. */
  var FAST_TEST_ALARM_DELAY_MINUTES = 0.5;
  var ALARM_PERIOD_MINUTES_PROD = 24 * 60;

  /** Default aging boundaries (days in prod, minutes when FAST_TEST_MODE): bumps at 1, 4, 8, 15+ */
  var DEFAULT_THRESHOLDS = [1, 4, 8, 15];

  /**
   * Pages we must not inject into or track.
   * chrome://, edge://, about:, chrome-extension:// are restricted by Chrome anyway;
   * we still guard for clarity and any future broad host permissions.
   */
  function isTrackableUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
      var u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      return true;
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

  function getAgeDays(lastSeenAt, nowMs) {
    if (lastSeenAt == null || typeof lastSeenAt !== 'number') return 0;
    var now = nowMs != null ? nowMs : Date.now();
    var diff = now - lastSeenAt;
    if (diff < 0) return 0;
    return Math.floor(diff / AGING_UNIT_MS);
  }

  /**
   * Map age (whole days in prod, whole minutes in FAST_TEST_MODE) to visual level 0–4.
   * thresholds: e.g. [1,4,8,15] → 0:<1, 1:1–3, 2:4–7, 3:8–14, 4:15+
   */
  function getAgeLevel(ageDays, thresholds) {
    var t = thresholds && thresholds.length ? thresholds : DEFAULT_THRESHOLDS;
    var level = 0;
    for (var i = 0; i < t.length; i++) {
      if (ageDays >= t[i]) level = i + 1;
    }
    return Math.min(level, 4);
  }

  /** Title emoji markers by level (matches product spec). */
  function getTitleMarkerForLevel(level) {
    switch (level) {
      case 0:
        return '';
      case 1:
        return '\uD83D\uDD38'; /* 🔸 */
      case 2:
        return '\uD83D\uDD36'; /* 🔶 */
      case 3:
        return '\uD83D\uDD34'; /* 🔴 */
      default:
        return '\u26D4'; /* ⛔ */
    }
  }

  function getTitleMarker(ageDays, thresholds) {
    if (ageDays <= 0) return '';
    return getTitleMarkerForLevel(getAgeLevel(ageDays, thresholds));
  }

  function defaultSettings() {
    return {
      enabled: true,
      useTitleMarkers: true,
      useFaviconOverlay: true,
      agingThresholds: DEFAULT_THRESHOLDS.slice(),
    };
  }

  global.TabAgingUtils = {
    FAST_TEST_MODE: FAST_TEST_MODE,
    AGING_UNIT_MS: AGING_UNIT_MS,
    FAST_TEST_ALARM_DELAY_MINUTES: FAST_TEST_ALARM_DELAY_MINUTES,
    ALARM_PERIOD_MINUTES_PROD: ALARM_PERIOD_MINUTES_PROD,
    DEFAULT_THRESHOLDS: DEFAULT_THRESHOLDS,
    isTrackableUrl: isTrackableUrl,
    normalizeUrl: normalizeUrl,
    getAgeDays: getAgeDays,
    getAgeLevel: getAgeLevel,
    getTitleMarker: getTitleMarker,
    getTitleMarkerForLevel: getTitleMarkerForLevel,
    defaultSettings: defaultSettings,
  };
})(typeof self !== 'undefined' ? self : globalThis);
