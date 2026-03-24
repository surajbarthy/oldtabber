/**
 * Tab Aging — MV3 service worker.
 *
 * Permissions (see manifest.json):
 * - storage: persist pages + settings in chrome.storage.local
 * - alarms: refresh + cleanup (30s chained delay in fast test, daily period in prod)
 * - tabs: read tab URLs and active state for “seen” + broadcast visuals
 * - scripting: inject content scripts when sendMessage fails (e.g. pre-injection race)
 * - host_permissions http(s)/*: inject pages + fetch favicon bytes here (no page CORS taint)
 */
importScripts('utils.js');

(function () {
  'use strict';

  var U = self.TabAgingUtils;
  var ALARM_DAILY = 'tab-aging-daily';
  var STORAGE_MS = 180 * 86400000; /* cleanup entries older than this */

  function blobToDataUrl(blob) {
    return new Promise(function (resolve) {
      var fr = new FileReader();
      fr.onloadend = function () {
        resolve(typeof fr.result === 'string' ? fr.result : null);
      };
      fr.onerror = function () {
        resolve(null);
      };
      fr.readAsDataURL(blob);
    });
  }

  async function fetchFaviconAsDataUrl(href) {
    if (!href || typeof href !== 'string') return null;
    try {
      var u = new URL(href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    } catch (e) {
      return null;
    }
    try {
      var r = await fetch(href, {
        credentials: 'omit',
        redirect: 'follow',
        cache: 'force-cache',
      });
      if (!r.ok) return null;
      var ct = (r.headers.get('content-type') || '').toLowerCase();
      if (ct.indexOf('text/html') === 0) return null;
      var blob = await r.blob();
      if (!blob || blob.size === 0) return null;
      if (blob.size > 512 * 1024) return null;
      return await blobToDataUrl(blob);
    } catch (e) {
      return null;
    }
  }

  async function fetchFaviconWithFallbacks(href, pageOrigin) {
    var seen = {};
    var urls = [];
    function add(u) {
      if (!u || seen[u]) return;
      seen[u] = true;
      urls.push(u);
    }
    add(href);
    try {
      if (pageOrigin) add(new URL('/favicon.ico', pageOrigin).href);
    } catch (e) {}
    for (var i = 0; i < urls.length; i++) {
      var d = await fetchFaviconAsDataUrl(urls[i]);
      if (d) return d;
    }
    return null;
  }

  /** Fast test uses one-shot alarms every 30s (0.5 min); prod uses repeating 24h alarm. */
  function scheduleAgingAlarm() {
    chrome.alarms.clear(ALARM_DAILY, function () {
      if (U.FAST_TEST_MODE) {
        chrome.alarms.create(ALARM_DAILY, { delayInMinutes: U.FAST_TEST_ALARM_DELAY_MINUTES });
      } else {
        chrome.alarms.create(ALARM_DAILY, { periodInMinutes: U.ALARM_PERIOD_MINUTES_PROD });
      }
    });
  }

  async function getState() {
    var data = await chrome.storage.local.get(['pages', 'settings']);
    var pages = data.pages && typeof data.pages === 'object' ? data.pages : {};
    var settings = Object.assign(U.defaultSettings(), data.settings || {});
    return { pages: pages, settings: settings };
  }

  async function saveState(partial) {
    var patch = {};
    if (partial.pages) patch.pages = partial.pages;
    if (partial.settings) patch.settings = partial.settings;
    await chrome.storage.local.set(patch);
  }

  function pageKeyFromUrl(url) {
    return U.normalizeUrl(url);
  }

  /**
   * Remove stale URL keys (not opened in STORAGE_MS).
   */
  async function cleanupOldPages(pages) {
    var now = Date.now();
    var cutoff = now - STORAGE_MS;
    var next = Object.assign({}, pages);
    var removed = 0;
    for (var k in next) {
      if (!Object.prototype.hasOwnProperty.call(next, k)) continue;
      var rec = next[k];
      if (rec && typeof rec.lastSeenAt === 'number' && rec.lastSeenAt < cutoff) {
        delete next[k];
        removed++;
      }
    }
    if (removed) console.debug('[Tab Aging] cleanup removed', removed, 'stale page(s)');
    return next;
  }

  async function markPageSeen(url) {
    if (!U.isTrackableUrl(url)) return;
    var key = pageKeyFromUrl(url);
    if (!key) return;
    var state = await getState();
    var rec = state.pages[key] || {};
    rec.lastSeenAt = Date.now();
    state.pages[key] = rec;
    await saveState({ pages: state.pages });
  }

  function computeAgeWithSettings(pages, settings, url, nowMs) {
    var key = pageKeyFromUrl(url);
    if (!key) return { ageDays: 0, level: 0 };
    var rec = pages[key];
    if (!rec || typeof rec.lastSeenAt !== 'number') return { ageDays: 0, level: 0 };
    var ageDays = U.getAgeDays(rec.lastSeenAt, nowMs);
    var level = U.getAgeLevel(ageDays, settings.agingThresholds);
    return { ageDays: ageDays, level: level };
  }

  async function sendAgeToTab(tabId, url, settings, pages) {
    if (!settings.enabled) {
      try {
        await chrome.tabs.sendMessage(tabId, {
          type: 'APPLY_AGE_STATE',
          ageDays: 0,
          level: 0,
          settings: settings,
        });
      } catch (e) {
        /* tab may not have content script */
      }
      return;
    }

    var now = Date.now();
    var comp = computeAgeWithSettings(pages, settings, url, now);
    var payload = {
      type: 'APPLY_AGE_STATE',
      ageDays: comp.ageDays,
      level: comp.level,
      settings: settings,
    };

    try {
      await chrome.tabs.sendMessage(tabId, payload);
    } catch (e) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tabId },
          files: ['utils.js', 'content.js'],
        });
        await chrome.tabs.sendMessage(tabId, payload);
      } catch (e2) {
        /* restricted page, unloaded tab, etc. */
      }
    }
  }

  async function refreshAllTabsVisuals() {
    var state = await getState();
    var tabs = await chrome.tabs.query({});
    for (var i = 0; i < tabs.length; i++) {
      var t = tabs[i];
      if (t.id == null || !U.isTrackableUrl(t.url)) continue;
      await sendAgeToTab(t.id, t.url, state.settings, state.pages);
    }
  }

  async function onActiveTabContext(tabId) {
    var tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (e) {
      return;
    }
    if (!tab.url || !U.isTrackableUrl(tab.url)) return;

    await markPageSeen(tab.url);

    var state = await getState();
    /* Active tab is always “fresh” after markPageSeen */
    await sendAgeToTab(tabId, tab.url, state.settings, state.pages);

    /* Background tabs: show urgency without resetting their lastSeenAt */
    var others = await chrome.tabs.query({});
    for (var i = 0; i < others.length; i++) {
      var ot = others[i];
      if (ot.id === tabId) continue;
      if (ot.id == null || !U.isTrackableUrl(ot.url)) continue;
      await sendAgeToTab(ot.id, ot.url, state.settings, state.pages);
    }
  }

  chrome.tabs.onActivated.addListener(function (activeInfo) {
    onActiveTabContext(activeInfo.tabId).catch(function (e) {
      console.debug('[Tab Aging] onActivated', e);
    });
  });

  chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
    if (changeInfo.status !== 'complete') return;
    if (!tab.active || !tab.url || !U.isTrackableUrl(tab.url)) return;
    markPageSeen(tab.url)
      .then(function () {
        return onActiveTabContext(tabId);
      })
      .catch(function (e) {
        console.debug('[Tab Aging] onUpdated', e);
      });
  });

  chrome.alarms.onAlarm.addListener(function (alarm) {
    if (alarm.name !== ALARM_DAILY) return;
    (async function () {
      try {
        var state = await getState();
        state.pages = await cleanupOldPages(state.pages);
        await saveState({ pages: state.pages });
        await refreshAllTabsVisuals();
      } catch (e) {
        console.debug('[Tab Aging] alarm', e);
      } finally {
        if (U.FAST_TEST_MODE) {
          chrome.alarms.create(ALARM_DAILY, { delayInMinutes: U.FAST_TEST_ALARM_DELAY_MINUTES });
        }
      }
    })();
  });

  chrome.runtime.onInstalled.addListener(function () {
    (async function () {
      var state = await getState();
      await saveState({ settings: state.settings, pages: state.pages });
      scheduleAgingAlarm();
      console.debug(
        '[Tab Aging] installed / updated; fast mode:',
        U.FAST_TEST_MODE,
        U.FAST_TEST_MODE ? 'delay min ' + U.FAST_TEST_ALARM_DELAY_MINUTES : 'period min ' + U.ALARM_PERIOD_MINUTES_PROD
      );
    })().catch(function (e) {
      console.debug('[Tab Aging] onInstalled', e);
    });
  });

  chrome.runtime.onStartup.addListener(function () {
    scheduleAgingAlarm();
  });

  chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
    if (message && message.type === 'TAB_AGING_OPTIONS_CHANGED') {
      refreshAllTabsVisuals()
        .then(function () {
          sendResponse({ ok: true });
        })
        .catch(function () {
          sendResponse({ ok: false });
        });
      return true;
    }
    if (message && message.type === 'TAB_AGING_RESET_PAGES') {
      (async function () {
        await chrome.storage.local.set({ pages: {} });
        await refreshAllTabsVisuals();
        sendResponse({ ok: true });
      })().catch(function () {
        sendResponse({ ok: false });
      });
      return true;
    }
    if (message && message.type === 'TAB_AGING_GET_FAVICON_DATA') {
      (async function () {
        var dataUrl = await fetchFaviconWithFallbacks(message.href, message.origin);
        sendResponse({ dataUrl: dataUrl });
      })().catch(function () {
        sendResponse({ dataUrl: null });
      });
      return true;
    }
  });

  /* Initial paint for already-open tabs when worker wakes */
  refreshAllTabsVisuals().catch(function () {});
})();
