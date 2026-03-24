/**
 * Tab Aging — shared utilities (content script + service worker via importScripts).
 * No ES modules: attaches to globalThis for Chrome extension contexts.
 */

(function (global) {
  'use strict';

  /** Default aging boundaries (days): level bumps at 1, 4, 8, 15+ */
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
    return Math.floor(diff / 86400000);
  }

  /**
   * Map age in whole days to visual level 0–4 using ascending thresholds.
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
