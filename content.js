/**
 * Tab Aging — content script: favicon overlay + optional title markers.
 * Fails softly if canvas/DOM operations are blocked.
 */
(function () {
  'use strict';

  var U = self.TabAgingUtils;
  if (!U) return;

  var DATA_ORIGINAL_TITLE = 'tabAgingOriginalTitle';
  var DYNAMIC_FAVICON_ID = 'tab-aging-favicon-dynamic';
  var lastFaviconLevel = 0;
  var headObserver = null;
  var titleHeadObserver = null;
  var applyingTitle = false;

  function logDebug(msg, err) {
    if (err) console.debug('[Tab Aging]', msg, err);
    else console.debug('[Tab Aging]', msg);
  }

  function stripOurMarkers(rawTitle) {
    if (!rawTitle) return '';
    var s = rawTitle;
    var markers = ['\uD83D\uDD38', '\uD83D\uDD36', '\uD83D\uDD34', '\u26D4'];
    var changed = true;
    while (changed) {
      changed = false;
      for (var i = 0; i < markers.length; i++) {
        if (s.indexOf(markers[i]) === 0) {
          s = s.slice(markers[i].length).replace(/^\s+/, '');
          changed = true;
          break;
        }
      }
    }
    return s;
  }

  function getOrCaptureOriginalTitle() {
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

  /**
   * SPAs (Google Calendar, Gmail, etc.) replace <title> after we run; re-apply marker when head/title mutates.
   */
  function ensureTitleMarkerObserver(marker) {
    disconnectTitleObserver();
    if (!marker || !document.head) return;
    var debounceTimer = null;
    titleHeadObserver = new MutationObserver(function () {
      if (applyingTitle) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function () {
        if (applyingTitle) return;
        var cur = document.title;
        if (cur.indexOf(marker) === 0) return;
        applyingTitle = true;
        try {
          document.title = marker + ' ' + stripOurMarkers(cur);
        } catch (e) {
          logDebug('title reapply failed', e);
        } finally {
          applyingTitle = false;
        }
      }, 100);
    });
    titleHeadObserver.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  function applyTitle(marker, originalBase) {
    applyingTitle = true;
    try {
      var base = originalBase != null ? originalBase : getOrCaptureOriginalTitle();
      if (!marker) {
        document.title = base;
        return;
      }
      document.title = marker + ' ' + base;
    } catch (e) {
      logDebug('title update failed', e);
    } finally {
      applyingTitle = false;
    }
  }

  function findIconLinks() {
    var all = Array.prototype.slice.call(
      document.querySelectorAll('link[rel~="icon"], link[rel="shortcut icon"]')
    );
    return all.filter(function (el) {
      return el.id !== DYNAMIC_FAVICON_ID && el.id !== DYNAMIC_FAVICON_ID + '-2';
    });
  }

  function pinOurFaviconLast() {
    var head = document.head;
    if (!head) return;
    var a = document.getElementById(DYNAMIC_FAVICON_ID);
    var b = document.getElementById(DYNAMIC_FAVICON_ID + '-2');
    if (a) head.appendChild(a);
    if (b) head.appendChild(b);
  }

  function ensureHeadObserver() {
    if (headObserver || !document.head) return;
    var t = null;
    headObserver = new MutationObserver(function () {
      if (lastFaviconLevel <= 0) return;
      if (t) clearTimeout(t);
      t = setTimeout(function () {
        pinOurFaviconLast();
      }, 100);
    });
    headObserver.observe(document.head, { childList: true, subtree: false });
  }

  /**
   * 32×32 favicon: draw the real icon when the canvas allows it, then paint only a
   * growing red dot (no full-frame tint). Dot radius scales with level 1–4.
   */
  function drawBadgeFavicon(level, baseImage) {
    var size = 32;
    var canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    var ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.clearRect(0, 0, size, size);

    var drewBase = false;
    if (baseImage && baseImage.complete && baseImage.naturalWidth) {
      try {
        ctx.drawImage(baseImage, 0, 0, size, size);
        drewBase = true;
      } catch (e) {
        drewBase = false;
      }
    }
    if (!drewBase) {
      ctx.fillStyle = '#ececec';
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#888';
      ctx.font = 'bold 16px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('\u2022', size / 2, size / 2);
    }

    if (level <= 0) {
      try {
        return canvas.toDataURL('image/png');
      } catch (e) {
        return null;
      }
    }

    /* Radius per level — bigger dot as urgency increases (index = level). */
    var radii = [0, 3.5, 5.5, 8, 11];
    var dotR = radii[Math.min(level, 4)];
    var margin = 1.5;
    var cx = size - dotR - margin;
    var cy = size - dotR - margin;

    ctx.beginPath();
    ctx.arc(cx, cy, dotR, 0, Math.PI * 2);
    ctx.fillStyle = '#dc2626';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = level >= 3 ? 2 : 1.25;
    ctx.stroke();

    try {
      return canvas.toDataURL('image/png');
    } catch (e) {
      return null;
    }
  }

  function loadImageFromUrl(href) {
    return new Promise(function (resolve) {
      if (!href) {
        resolve(null);
        return;
      }
      var img = new Image();
      try {
        var abs = new URL(href, document.baseURI);
        if (abs.origin !== window.location.origin) {
          img.crossOrigin = 'anonymous';
        }
      } catch (e) {
        img.crossOrigin = 'anonymous';
      }
      img.onload = function () {
        resolve(img);
      };
      img.onerror = function () {
        resolve(null);
      };
      img.referrerPolicy = 'no-referrer';
      img.src = href;
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

  /**
   * Chrome often ignores in-place href updates on <link rel="icon">.
   * Remove + append a fresh node and use shortcut icon + sizes so the tab strip picks it up.
   */
  function ensureOverlayLink(dataUrl) {
    if (!dataUrl || !document.head) return;
    var o1 = document.getElementById(DYNAMIC_FAVICON_ID);
    var o2 = document.getElementById(DYNAMIC_FAVICON_ID + '-2');
    if (o1) o1.remove();
    if (o2) o2.remove();

    var link = document.createElement('link');
    link.id = DYNAMIC_FAVICON_ID;
    link.setAttribute('rel', 'shortcut icon');
    link.setAttribute('type', 'image/png');
    link.setAttribute('sizes', '32x32');
    link.href = dataUrl;
    document.head.appendChild(link);

    var alt = document.createElement('link');
    alt.id = DYNAMIC_FAVICON_ID + '-2';
    alt.setAttribute('rel', 'icon');
    alt.setAttribute('type', 'image/png');
    alt.setAttribute('sizes', '32x32');
    alt.href = dataUrl;
    document.head.appendChild(alt);

    ensureHeadObserver();
    pinOurFaviconLast();
  }

  function removeDynamicFavicons() {
    var a = document.getElementById(DYNAMIC_FAVICON_ID);
    var b = document.getElementById(DYNAMIC_FAVICON_ID + '-2');
    if (a) a.remove();
    if (b) b.remove();
    lastFaviconLevel = 0;
  }

  async function applyFaviconOverlay(level) {
    lastFaviconLevel = level;
    if (level <= 0) {
      removeDynamicFavicons();
      return;
    }

    var links = findIconLinks();
    var href = pickBestIconHref(links);
    var img = await loadImageFromUrl(href);
    var dataUrl = drawBadgeFavicon(level, img);
    if (!dataUrl) dataUrl = drawBadgeFavicon(level, null);
    if (dataUrl) {
      ensureOverlayLink(dataUrl);
      logDebug('favicon dot badge level ' + level);
    }
  }

  function restoreAllVisuals() {
    try {
      var el = document.documentElement;
      var orig = el.getAttribute('data-' + DATA_ORIGINAL_TITLE);
      if (orig != null) document.title = orig;
      removeDynamicFavicons();
      disconnectTitleObserver();
    } catch (e) {
      logDebug('restore failed', e);
    }
  }

  async function handleMessage(msg) {
    if (!msg || msg.type !== 'APPLY_AGE_STATE') return;

    if (!msg.settings || !msg.settings.enabled) {
      restoreAllVisuals();
      return;
    }

    var ageDays = msg.ageDays | 0;
    var level = msg.level != null ? msg.level : U.getAgeLevel(ageDays, msg.settings.agingThresholds);

    var marker = '';
    if (msg.settings.useTitleMarkers) {
      marker = U.getTitleMarker(ageDays, msg.settings.agingThresholds);
      applyTitle(marker, getOrCaptureOriginalTitle());
      if (marker) {
        ensureTitleMarkerObserver(marker);
      } else {
        disconnectTitleObserver();
      }
    } else {
      disconnectTitleObserver();
      applyTitle('', getOrCaptureOriginalTitle());
    }

    if (msg.settings.useFaviconOverlay) {
      await applyFaviconOverlay(level);
    } else {
      removeDynamicFavicons();
    }
  }

  chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
    if (message && message.type === 'APPLY_AGE_STATE') {
      handleMessage(message).then(function () {
        sendResponse({ ok: true });
      });
      return true;
    }
  });
})();
