/**
 * Tab Aging — content script: generated favicon badge + optional title markers.
 * Reliability: no site favicon fetch/draw (avoids CORS canvas taint). Plain canvas → data URL only.
 */
(function () {
  'use strict';

  var U = self.TabAgingUtils;
  if (!U) return;

  var DATA_ORIGINAL_TITLE = 'tabAgingOriginalTitle';
  var MANAGED_LINK_ID = 'tab-aging-managed-favicon';
  var MANAGED_LINK_ID_2 = 'tab-aging-managed-favicon-2';

  var titleHeadObserver = null;
  var faviconHeadObserver = null;
  var applyingTitle = false;

  /** Last successful APPLY_AGE_STATE snapshot for reapplies (visibility, retries, DOM). */
  var latestState = null;
  var reapplyDebounceTimer = null;
  var reapplySeriesTimers = [];

  function logd() {
    if (!U.DEBUG) return;
    var a = ['[Tab Aging]'].concat(Array.prototype.slice.call(arguments));
    console.debug.apply(console, a);
  }

  var TITLE_MARKERS = ['\uD83D\uDD38', '\uD83D\uDD36', '\uD83D\uDD34', '\u26D4'];

  function stripOurMarkers(rawTitle) {
    if (!rawTitle) return '';
    var s = rawTitle;
    var changed = true;
    while (changed) {
      changed = false;
      for (var i = 0; i < TITLE_MARKERS.length; i++) {
        if (s.indexOf(TITLE_MARKERS[i]) === 0) {
          s = s.slice(TITLE_MARKERS[i].length).replace(/^\s+/, '');
          changed = true;
          break;
        }
      }
    }
    return s;
  }

  function captureOriginalTitleOnce() {
    var el = document.documentElement;
    var stored = el.getAttribute('data-' + DATA_ORIGINAL_TITLE);
    if (stored != null) return stored;
    var base = stripOurMarkers(document.title);
    el.setAttribute('data-' + DATA_ORIGINAL_TITLE, base);
    return base;
  }

  function disconnectTitleObserver() {
    if (titleHeadObserver) {
      titleHeadObserver.disconnect();
      titleHeadObserver = null;
    }
  }

  function disconnectFaviconObserver() {
    if (faviconHeadObserver) {
      faviconHeadObserver.disconnect();
      faviconHeadObserver = null;
    }
  }

  function ensureTitleMarkerObserver(marker) {
    disconnectTitleObserver();
    if (!marker || !document.head) return;
    var debounceTimer = null;
    titleHeadObserver = new MutationObserver(function () {
      if (applyingTitle) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function () {
        if (applyingTitle || !latestState || !latestState.settings.useTitleMarkers) return;
        var cur = document.title;
        if (cur.indexOf(marker) === 0) return;
        applyingTitle = true;
        try {
          document.title = marker + ' ' + stripOurMarkers(cur);
        } catch (e) {
          logd('title reapply failed', e);
        } finally {
          applyingTitle = false;
        }
      }, 120);
    });
    titleHeadObserver.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  function ensureFaviconHeadObserver() {
    if (faviconHeadObserver || !document.head) return;
    var t = null;
    faviconHeadObserver = new MutationObserver(function () {
      if (!latestState || latestState.level <= 0 || !latestState.settings.useFaviconOverlay) return;
      if (t) clearTimeout(t);
      t = setTimeout(function () {
        pinManagedFaviconLast();
        var el = document.getElementById(MANAGED_LINK_ID);
        var h = el ? el.getAttribute('href') || '' : '';
        if (!el || h.indexOf('data:') !== 0) {
          try {
            applyManagedFaviconLevel(latestState.level);
          } catch (e) {
            logd('favicon reapply after head mutation failed', e);
          }
        }
      }, 120);
    });
    faviconHeadObserver.observe(document.head, { childList: true, subtree: true });
  }

  function pinManagedFaviconLast() {
    var head = document.head;
    if (!head) return;
    var a = document.getElementById(MANAGED_LINK_ID);
    var b = document.getElementById(MANAGED_LINK_ID_2);
    if (a) head.appendChild(a);
    if (b) head.appendChild(b);
  }

  /**
   * Pure generated badge — no site bitmap. Circle is **centered** so Chrome’s scaled-down
   * tab icon still shows color (corner-only art was often invisible).
   */
  function generateBadgeFavicon(level) {
    if (level <= 0) return null;
    var size = 32;
    var canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    var ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.clearRect(0, 0, size, size);

    var radii = [0, 6, 9, 12, 14];
    var r = radii[Math.min(level, 4)];
    var cx = size / 2;
    var cy = size / 2;

    var fills = ['', '#fb923c', '#f97316', '#ef4444', '#b91c1c'];
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = fills[level] || '#dc2626';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = level >= 3 ? 2.5 : 1.5;
    ctx.stroke();

    if (level >= 4) {
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 11px system-ui,Segoe UI,sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('!', cx, cy + 0.5);
    }

    try {
      return canvas.toDataURL('image/png');
    } catch (e) {
      logd('generateBadgeFavicon toDataURL failed', e);
      return null;
    }
  }

  function removeManagedFavicon() {
    var el = document.getElementById(MANAGED_LINK_ID);
    var el2 = document.getElementById(MANAGED_LINK_ID_2);
    if (el) el.remove();
    if (el2) el2.remove();
    var orphans = document.querySelectorAll('link[data-tab-aging-managed="true"]');
    for (var i = 0; i < orphans.length; i++) {
      orphans[i].remove();
    }
  }

  function applyManagedFaviconLevel(level) {
    if (level <= 0) {
      removeManagedFavicon();
      return;
    }
    var dataUrl = generateBadgeFavicon(level);
    if (!dataUrl) {
      logd('favicon apply failed, title-only fallback (no data URL)');
      removeManagedFavicon();
      return;
    }
    if (!document.head) return;

    var link = document.getElementById(MANAGED_LINK_ID);
    if (!link) {
      link = document.createElement('link');
      link.id = MANAGED_LINK_ID;
      link.setAttribute('data-tab-aging-managed', 'true');
      link.setAttribute('rel', 'shortcut icon');
      link.setAttribute('type', 'image/png');
      link.setAttribute('sizes', '32x32');
      document.head.appendChild(link);
    }

    var link2 = document.getElementById(MANAGED_LINK_ID_2);
    if (!link2) {
      link2 = document.createElement('link');
      link2.id = MANAGED_LINK_ID_2;
      link2.setAttribute('data-tab-aging-managed', 'true');
      link2.setAttribute('rel', 'icon');
      link2.setAttribute('type', 'image/png');
      link2.setAttribute('sizes', '32x32');
      document.head.appendChild(link2);
    }

    ensureFaviconHeadObserver();
    link.href = dataUrl;
    link2.href = dataUrl;
    pinManagedFaviconLast();
    logd('managed favicon level', level);
  }

  function clearReapplySeries() {
    for (var i = 0; i < reapplySeriesTimers.length; i++) {
      clearTimeout(reapplySeriesTimers[i]);
    }
    reapplySeriesTimers = [];
  }

  function reapplyFromLatestDebounced() {
    if (reapplyDebounceTimer) clearTimeout(reapplyDebounceTimer);
    reapplyDebounceTimer = setTimeout(function () {
      reapplyDebounceTimer = null;
      if (latestState) {
        applyAllFromLatest();
      }
    }, 100);
  }

  function scheduleReapplySeries() {
    clearReapplySeries();
    var delays = [300, 1000, 2500];
    for (var i = 0; i < delays.length; i++) {
      (function (ms) {
        reapplySeriesTimers.push(
          setTimeout(function () {
            reapplyFromLatestDebounced();
          }, ms)
        );
      })(delays[i]);
    }
  }

  function applyTitleFromState(settings, ageDays) {
    if (!settings.useTitleMarkers) {
      disconnectTitleObserver();
      applyingTitle = true;
      try {
        var el = document.documentElement;
        if (el.hasAttribute('data-' + DATA_ORIGINAL_TITLE)) {
          document.title = el.getAttribute('data-' + DATA_ORIGINAL_TITLE);
        } else {
          document.title = stripOurMarkers(document.title);
        }
      } finally {
        applyingTitle = false;
      }
      return;
    }

    var marker = U.getTitleMarker(ageDays, settings.agingThresholds);
    var base = captureOriginalTitleOnce();

    applyingTitle = true;
    try {
      if (!marker) {
        document.title = base;
        disconnectTitleObserver();
        return;
      }
      var plain = stripOurMarkers(document.title);
      var docEl = document.documentElement;
      if (plain !== base) {
        docEl.setAttribute('data-' + DATA_ORIGINAL_TITLE, plain);
        base = plain;
      }
      document.title = marker + ' ' + base;
      ensureTitleMarkerObserver(marker);
    } catch (e) {
      logd('title apply failed', e);
    } finally {
      applyingTitle = false;
    }
  }

  function applyAllFromLatest() {
    if (!latestState) return;
    var s = latestState.settings;
    if (!s.enabled) {
      restoreAllVisuals();
      return;
    }

    var ageDays = latestState.ageDays | 0;
    var level = latestState.level != null ? latestState.level : U.getAgeLevel(ageDays, s.agingThresholds);

    applyTitleFromState(s, ageDays);

    try {
      if (s.useFaviconOverlay) {
        applyManagedFaviconLevel(level);
      } else {
        removeManagedFavicon();
      }
    } catch (e) {
      logd('favicon apply failed, title-only fallback', e);
      removeManagedFavicon();
    }
  }

  function restoreAllVisuals() {
    latestState = null;
    clearReapplySeries();
    disconnectTitleObserver();
    disconnectFaviconObserver();
    removeManagedFavicon();
    applyingTitle = true;
    try {
      var el = document.documentElement;
      if (el.hasAttribute('data-' + DATA_ORIGINAL_TITLE)) {
        document.title = el.getAttribute('data-' + DATA_ORIGINAL_TITLE);
      } else {
        document.title = stripOurMarkers(document.title);
      }
      el.removeAttribute('data-' + DATA_ORIGINAL_TITLE);
    } catch (e) {
      logd('restore failed', e);
    } finally {
      applyingTitle = false;
    }
  }

  function handleApplyMessage(msg) {
    if (!msg || msg.type !== 'APPLY_AGE_STATE') return;

    if (!msg.settings || !msg.settings.enabled) {
      restoreAllVisuals();
      return;
    }

    var ageDays = msg.ageDays | 0;
    var level = msg.level != null ? msg.level : U.getAgeLevel(ageDays, msg.settings.agingThresholds);

    latestState = {
      settings: msg.settings,
      ageDays: ageDays,
      level: level,
      pageUrl: msg.pageUrl || '',
    };

    if (U.DEBUG && latestState.pageUrl) {
      logd('applying level', level, 'to', latestState.pageUrl);
    }

    applyAllFromLatest();
    scheduleReapplySeries();
  }

  chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
    if (message && message.type === 'APPLY_AGE_STATE') {
      try {
        handleApplyMessage(message);
        sendResponse({ ok: true });
      } catch (e) {
        logd('handleApplyMessage error', e);
        sendResponse({ ok: false });
      }
      return false;
    }
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      reapplyFromLatestDebounced();
    }
  });

  function onDomReady() {
    reapplyFromLatestDebounced();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onDomReady);
  } else {
    onDomReady();
  }
  window.addEventListener('load', function () {
    reapplyFromLatestDebounced();
  });
})();
