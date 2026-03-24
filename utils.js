/**
 * Tab Aging — shared utilities (content script + service worker via importScripts).
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
      /** Corner dot drawn on top of the site favicon (after SW fetch → data URL). */
      useFaviconDot: true,
      /** Semi-transparent red wash on top of the site favicon. */
      useFaviconTint: false,
      agingThresholds: DEFAULT_THRESHOLDS.slice(),
    };
  }

  /**
   * Merge saved settings with defaults; migrate legacy useFaviconOverlay → dot+tint when needed.
   */
  function normalizeSettings(raw) {
    var s = raw && typeof raw === 'object' ? raw : {};
    var o = Object.assign(defaultSettings(), s);
    if (Object.prototype.hasOwnProperty.call(s, 'useFaviconOverlay')) {
      var hasDot = Object.prototype.hasOwnProperty.call(s, 'useFaviconDot');
      var hasTint = Object.prototype.hasOwnProperty.call(s, 'useFaviconTint');
      if (!hasDot && !hasTint) {
        o.useFaviconDot = !!s.useFaviconOverlay;
        o.useFaviconTint = !!s.useFaviconOverlay;
      }
    }
    return o;
  }

  global.TabAgingUtils = {
    DEBUG: DEBUG,
    FAST_TEST_MODE: FAST_TEST_MODE,
    AGING_UNIT_MS: AGING_UNIT_MS,
    FAST_TEST_ALARM_DELAY_MINUTES: FAST_TEST_ALARM_DELAY_MINUTES,
    ALARM_PERIOD_MINUTES_PROD: ALARM_PERIOD_MINUTES_PROD,
    DEFAULT_THRESHOLDS: DEFAULT_THRESHOLDS,
    isRestrictedBrowserUrl: isRestrictedBrowserUrl,
    isTrackableUrl: isTrackableUrl,
    normalizeUrl: normalizeUrl,
    getAgeDays: getAgeDays,
    getAgeLevel: getAgeLevel,
    getTitleMarker: getTitleMarker,
    getTitleMarkerForLevel: getTitleMarkerForLevel,
    defaultSettings: defaultSettings,
    normalizeSettings: normalizeSettings,
  };
})(typeof self !== 'undefined' ? self : globalThis);
