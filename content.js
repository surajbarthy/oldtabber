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

  function applyTitle(marker, originalBase) {
    try {
      var base = originalBase != null ? originalBase : getOrCaptureOriginalTitle();
      if (!marker) {
        document.title = base;
        return;
      }
      document.title = marker + ' ' + base;
    } catch (e) {
      logDebug('title update failed', e);
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
   * Draw a 32×32 favicon with optional base image and red overlay by level.
   */
  function drawBadgeFavicon(level, baseImage) {
    var size = 32;
    var canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    var ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.clearRect(0, 0, size, size);

    if (baseImage && baseImage.complete && baseImage.naturalWidth) {
      try {
        ctx.drawImage(baseImage, 0, 0, size, size);
      } catch (e) {
        /* CORS taint — draw fallback plate */
        ctx.fillStyle = '#e8e8e8';
        ctx.fillRect(0, 0, size, size);
      }
    } else {
      ctx.fillStyle = 'rgba(240,240,240,0.92)';
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#666';
      ctx.font = 'bold 18px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('·', size / 2, size / 2);
    }

    if (level <= 0) {
      try {
        return canvas.toDataURL('image/png');
      } catch (e) {
        return null;
      }
    }

    var alphaMap = U.FAST_TEST_MODE
      ? [0.35, 0.55, 0.72, 0.88, 0.96]
      : [0.12, 0.28, 0.52, 0.78, 0.92];
    var a = alphaMap[Math.min(level, 4)];

    ctx.fillStyle = 'rgba(220, 38, 38, ' + a + ')';
    ctx.fillRect(0, 0, size, size);

    /* Corner “ring” / dot for lower levels */
    if (level <= 2) {
      ctx.beginPath();
      ctx.arc(size - 6, size - 6, level === 1 ? 3 : 5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(185, 28, 28, 0.95)';
      ctx.fill();
    }

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
      logDebug('favicon overlay applied level ' + level);
    }
  }

  function restoreAllVisuals() {
    try {
      var el = document.documentElement;
      var orig = el.getAttribute('data-' + DATA_ORIGINAL_TITLE);
      if (orig != null) document.title = orig;
      removeDynamicFavicons();
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

    if (msg.settings.useTitleMarkers) {
      var marker = U.getTitleMarker(ageDays, msg.settings.agingThresholds);
      applyTitle(marker, getOrCaptureOriginalTitle());
    } else {
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
