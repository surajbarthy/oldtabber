/**
 * Tab Aging — content script: composite favicon (site icon + optional tint + dot) + title markers.
 * Favicon bytes come from the service worker (data URL) so canvas stays untainted; tint/dot draw on top.
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

  var latestState = null;
  var reapplyDebounceTimer = null;
  var reapplySeriesTimers = [];

  function logd() {
    if (!U.DEBUG) return;
    var a = ['[Tab Aging]'].concat(Array.prototype.slice.call(arguments));
    console.debug.apply(console, a);
  }

  function wantsFaviconEffects(settings) {
    if (!settings) return false;
    return !!(settings.useFaviconDot === true || settings.useFaviconTint === true);
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
    disconnectFaviconObserver();
    if (!document.head) return;
    var t = null;
    faviconHeadObserver = new MutationObserver(function () {
      if (!latestState || latestState.level <= 0 || !wantsFaviconEffects(latestState.settings)) return;
      if (t) clearTimeout(t);
      t = setTimeout(function () {
        pinManagedFaviconLast();
        var el = document.getElementById(MANAGED_LINK_ID);
        var h = el ? el.getAttribute('href') || '' : '';
        if (!el || h.indexOf('data:') !== 0) {
          applyManagedFaviconComposite(latestState.level, latestState.settings).catch(function (e) {
            logd('favicon reapply after head mutation failed', e);
          });
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

  function findIconLinks() {
    var all = Array.prototype.slice.call(
      document.querySelectorAll('link[rel~="icon"], link[rel="shortcut icon"]')
    );
    return all.filter(function (el) {
      return (
        el.id !== MANAGED_LINK_ID &&
        el.id !== MANAGED_LINK_ID_2 &&
        el.getAttribute('data-tab-aging-managed') !== 'true'
      );
    });
  }

  function pickBestIconHref(links) {
    var sizes = [];
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute('href');
      if (!href) continue;
      try {
        sizes.push({ href: new URL(href, document.baseURI).href, el: links[i] });
      } catch (e) {
        sizes.push({ href: href, el: links[i] });
      }
    }
    return sizes.length ? sizes[0].href : new URL('/favicon.ico', document.location.origin).href;
  }

  async function requestFaviconDataUrlFromBackground(href, origin) {
    var o = origin || window.location.origin;
    var first = await requestFaviconDataUrlFromBackgroundOnce(href, o);
    if (first) return first;
    await new Promise(function (r) {
      setTimeout(r, 50);
    });
    return requestFaviconDataUrlFromBackgroundOnce(href, o);
  }

  function loadImageFromDataUrl(dataUrl) {
    return new Promise(function (resolve) {
      if (!dataUrl) {
        resolve(null);
        return;
      }
      var img = new Image();
      img.onload = function () {
        if (img.decode && typeof img.decode === 'function') {
          img
            .decode()
            .then(function () {
              resolve(img);
            })
            .catch(function () {
              resolve(img);
            });
        } else {
          resolve(img);
        }
      };
      img.onerror = function () {
        resolve(null);
      };
      img.src = dataUrl;
    });
  }

  function requestFaviconDataUrlFromBackgroundOnce(href, origin) {
    return new Promise(function (resolve) {
      chrome.runtime.sendMessage(
        { type: 'TAB_AGING_GET_FAVICON_DATA', href: href, origin: origin || window.location.origin },
        function (res) {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(res && res.dataUrl ? res.dataUrl : null);
        }
      );
    });
  }

  /**
   * Draw site favicon (or gray fallback), then optional red tint and/or corner dot on top.
   */
  function compositeFaviconDataUrl(level, settings, baseImage) {
    if (level <= 0) return null;
    var size = 32;
    var canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    var ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return null;

    /**
     * Fully opaque matte first. Icons with alpha leave “holes” in the bitmap stack in some
     * browsers; opaque raster/JPEG favicons sit on a solid base so tint + dot always stack
     * visibly the same way as on transparent PNGs.
     */
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#f3f4f6';
    ctx.fillRect(0, 0, size, size);

    var drew = false;
    if (baseImage && baseImage.complete && baseImage.naturalWidth) {
      try {
        ctx.globalCompositeOperation = 'source-over';
        ctx.drawImage(baseImage, 0, 0, size, size);
        drew = true;
      } catch (e) {
        drew = false;
      }
    }
    if (!drew) {
      ctx.fillStyle = '#e5e7eb';
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#666';
      ctx.font = 'bold 14px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('\u00B7', size / 2, size / 2);
    }

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    if (settings.useFaviconTint === true) {
      var alphas = [0, 0.34, 0.48, 0.6, 0.74];
      var a = alphas[Math.min(level, 4)];
      ctx.fillStyle = 'rgba(185, 28, 28, ' + a + ')';
      ctx.fillRect(0, 0, size, size);
      /* Darken/warm opaque artwork so tint reads on saturated icons (multiply is cheap). */
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = 'rgba(255, 140, 140, 0.4)';
      ctx.fillRect(0, 0, size, size);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.restore();

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    if (settings.useFaviconDot === true) {
      var radii = [0, 4.5, 6, 7.5, 9];
      var r = radii[Math.min(level, 4)];
      var margin = 2;
      var cx = size - margin - r;
      var cy = size - margin - r;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = '#b91c1c';
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = level >= 3 ? 2 : 1.25;
      ctx.stroke();
    }
    ctx.restore();

    try {
      return canvas.toDataURL('image/png');
    } catch (e) {
      logd('composite toDataURL failed', e);
      return null;
    }
  }

  function removeManagedFavicon() {
    disconnectFaviconObserver();
    var el = document.getElementById(MANAGED_LINK_ID);
    var el2 = document.getElementById(MANAGED_LINK_ID_2);
    if (el) el.remove();
    if (el2) el2.remove();
    var orphans = document.querySelectorAll('link[data-tab-aging-managed="true"]');
    for (var i = 0; i < orphans.length; i++) {
      orphans[i].remove();
    }
  }

  /** New <link> nodes each time so Chrome’s tab UI actually picks up the data URL. */
  function installManagedLinks(dataUrl) {
    if (!document.head || !dataUrl) return;

    removeManagedFavicon();

    var link = document.createElement('link');
    link.id = MANAGED_LINK_ID;
    link.setAttribute('data-tab-aging-managed', 'true');
    link.setAttribute('rel', 'shortcut icon');
    link.setAttribute('type', 'image/png');
    link.setAttribute('sizes', '32x32');
    link.href = dataUrl;
    document.head.appendChild(link);

    var link2 = document.createElement('link');
    link2.id = MANAGED_LINK_ID_2;
    link2.setAttribute('data-tab-aging-managed', 'true');
    link2.setAttribute('rel', 'icon');
    link2.setAttribute('type', 'image/png');
    link2.setAttribute('sizes', '32x32');
    link2.href = dataUrl;
    document.head.appendChild(link2);

    ensureFaviconHeadObserver();
    pinManagedFaviconLast();
    logd('composite favicon applied');
  }

  async function applyManagedFaviconComposite(level, settings) {
    if (level <= 0 || !wantsFaviconEffects(settings)) {
      removeManagedFavicon();
      return;
    }
    if (!document.head) return;

    var href = pickBestIconHref(findIconLinks());
    var fetched = await requestFaviconDataUrlFromBackground(href, window.location.origin);
    var img = await loadImageFromDataUrl(fetched);
    var out = compositeFaviconDataUrl(level, settings, img);
    if (!out) {
      logd('favicon composite failed, title-only fallback');
      removeManagedFavicon();
      return;
    }
    installManagedLinks(out);
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
        applyAllFromLatest().catch(function (e) {
          logd('reapply failed', e);
        });
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

  async function applyAllFromLatest() {
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
      if (wantsFaviconEffects(s)) {
        await applyManagedFaviconComposite(level, s);
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
    if (!msg || msg.type !== 'APPLY_AGE_STATE') return Promise.resolve();

    if (!msg.settings || !msg.settings.enabled) {
      restoreAllVisuals();
      return Promise.resolve();
    }

    var ageDays = msg.ageDays | 0;
    var level = msg.level != null ? msg.level : U.getAgeLevel(ageDays, msg.settings.agingThresholds);

    latestState = {
      settings: U.normalizeSettings(msg.settings || {}),
      ageDays: ageDays,
      level: level,
      pageUrl: msg.pageUrl || '',
    };

    if (U.DEBUG && latestState.pageUrl) {
      logd('applying level', level, 'to', latestState.pageUrl);
    }

    scheduleReapplySeries();
    return applyAllFromLatest();
  }

  chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
    if (message && message.type === 'APPLY_AGE_STATE') {
      handleApplyMessage(message)
        .then(function () {
          sendResponse({ ok: true });
        })
        .catch(function (e) {
          logd('handleApplyMessage error', e);
          sendResponse({ ok: false });
        });
      return true;
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
