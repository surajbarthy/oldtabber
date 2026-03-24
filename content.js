/**
 * Tab Aging — content script: favicon overlay + optional title markers.
 * Fails softly if canvas/DOM operations are blocked.
 */
(function () {
  'use strict';

  var U = self.TabAgingUtils;
  if (!U) return;

  var DATA_ORIGINAL_TITLE = 'tabAgingOriginalTitle';
  var DATA_RESTORED_FAVICON = 'tabAgingRestoredHref';

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
    return Array.prototype.slice.call(
      document.querySelectorAll('link[rel~="icon"], link[rel="shortcut icon"]')
    );
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

    var alphaMap = [0.12, 0.28, 0.52, 0.78, 0.92];
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
      img.crossOrigin = 'anonymous';
      img.onload = function () {
        resolve(img);
      };
      img.onerror = function () {
        resolve(null);
      };
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

  function ensureOverlayLink(dataUrl) {
    if (!dataUrl) return;
    var id = 'tab-aging-favicon-dynamic';
    var existing = document.getElementById(id);
    if (existing) {
      existing.href = dataUrl;
      return;
    }
    var link = document.createElement('link');
    link.id = id;
    link.rel = 'icon';
    link.type = 'image/png';
    link.href = dataUrl;
    document.head.appendChild(link);
  }

  async function applyFaviconOverlay(level) {
    if (level <= 0) {
      var dyn = document.getElementById('tab-aging-favicon-dynamic');
      if (dyn) dyn.remove();
      return;
    }

    var links = findIconLinks();
    var href = pickBestIconHref(links);
    var img = await loadImageFromUrl(href);
    var dataUrl = drawBadgeFavicon(level, img);
    if (!dataUrl) dataUrl = drawBadgeFavicon(level, null);
    if (dataUrl) ensureOverlayLink(dataUrl);
  }

  function restoreAllVisuals() {
    try {
      var el = document.documentElement;
      var orig = el.getAttribute('data-' + DATA_ORIGINAL_TITLE);
      if (orig != null) document.title = orig;
      var dyn = document.getElementById('tab-aging-favicon-dynamic');
      if (dyn) dyn.remove();
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
      var d = document.getElementById('tab-aging-favicon-dynamic');
      if (d) d.remove();
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
