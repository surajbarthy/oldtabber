/**
 * OldTabber — MV3 service worker.
 *
 * Permissions (manifest.json):
 * - storage: persist per-tab last-seen times + settings in chrome.storage.local (tab:<id> keys)
 * - alarms: periodic refresh + stale-entry cleanup (fast-test chain vs 24h prod)
 * - tabs: read tab URLs / active state for “seen” and push APPLY_AGE_STATE
 * - scripting: inject utils.js + content.js when sendMessage fails (no content script yet)
 * - host_permissions http(s)/*: content scripts + optional favicon fetch (when favicon effects return)
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

  function logd() {
    if (!U.DEBUG) return;
    var a = ['[OldTabber]'].concat(Array.prototype.slice.call(arguments));
    console.debug.apply(console, a);
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
    var raw = data.pages && typeof data.pages === 'object' ? data.pages : {};
    var pages = {};
    var droppedLegacy = false;
    for (var k in raw) {
      if (!Object.prototype.hasOwnProperty.call(raw, k)) continue;
      if (k.indexOf('tab:') === 0) pages[k] = raw[k];
      else droppedLegacy = true;
    }
    if (droppedLegacy) await chrome.storage.local.set({ pages: pages });
    var settings = U.normalizeSettings(data.settings);
    return { pages: pages, settings: settings };
  }

  async function saveState(partial) {
    var patch = {};
    if (partial.pages) patch.pages = partial.pages;
    if (partial.settings) patch.settings = partial.settings;
    await chrome.storage.local.set(patch);
  }

  function pageKeyFromTabId(tabId) {
    if (tabId == null || typeof tabId !== 'number') return '';
    return 'tab:' + tabId;
  }

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
    if (removed) logd('cleanup removed', removed, 'stale page(s)');
    return next;
  }

  async function markPageSeen(tabId, url) {
    if (!U.isTrackableUrl(url)) return;
    var key = pageKeyFromTabId(tabId);
    if (!key) return;
    var state = await getState();
    var rec = state.pages[key] || {};
    rec.lastSeenAt = Date.now();
    state.pages[key] = rec;
    await saveState({ pages: state.pages });
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function computeAgeWithSettings(pages, settings, tabId, nowMs) {
    var key = pageKeyFromTabId(tabId);
    if (!key) return { idleMs: 0, level: 0 };
    var rec = pages[key];
    if (!rec || typeof rec.lastSeenAt !== 'number') return { idleMs: 0, level: 0 };
    var idleMs = U.getIdleMs(rec.lastSeenAt, nowMs);
    var level = U.getLevelFromIdleMs(idleMs, settings.agingThresholdsMs);
    return { idleMs: idleMs, level: level };
  }

  async function sendAgeToTab(tabId, url, settings, pages) {
    if (url == null || typeof url !== 'string') {
      logd('skipped tab', tabId, '(no url)');
      return;
    }
    if (!U.isTrackableUrl(url)) {
      logd('skipped restricted URL', url);
      return;
    }

    var disabledPayload = {
      type: 'APPLY_AGE_STATE',
      idleMs: 0,
      level: 0,
      settings: settings,
      pageUrl: url,
    };

    if (!settings.enabled) {
      var inj0 = false;
      for (var d = 0; d < 4; d++) {
        try {
          await chrome.tabs.sendMessage(tabId, disabledPayload);
          return;
        } catch (e) {
          if (!inj0) {
            try {
              await chrome.scripting.executeScript({
                target: { tabId: tabId },
                files: ['utils.js', 'content.js'],
              });
              logd('injected tab', tabId, '(disabled payload)');
            } catch (e2) {}
            inj0 = true;
          }
          await sleep(90 + d * 80);
        }
      }
      return;
    }

    var now = Date.now();
    var comp = computeAgeWithSettings(pages, settings, tabId, now);
    var payload = {
      type: 'APPLY_AGE_STATE',
      idleMs: comp.idleMs,
      level: comp.level,
      settings: settings,
      pageUrl: url,
    };

    logd('applying level', comp.level, 'to', url);

    var injected = false;
    for (var attempt = 0; attempt < 4; attempt++) {
      try {
        await chrome.tabs.sendMessage(tabId, payload);
        return;
      } catch (e) {
        if (!injected) {
          try {
            await chrome.scripting.executeScript({
              target: { tabId: tabId },
              files: ['utils.js', 'content.js'],
            });
            logd('injected content script for tab', tabId);
            injected = true;
          } catch (e2) {
            logd('inject failed', tabId, (e2 && e2.message) || e2);
          }
        }
        await sleep(100 + attempt * 90);
      }
    }
    logd('sendAgeToTab gave up after retries', tabId);
  }

  async function refreshAllTabsVisuals() {
    var state = await getState();
    var tabs = await chrome.tabs.query({});
    for (var i = 0; i < tabs.length; i++) {
      var t = tabs[i];
      if (t.id == null) continue;
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
    if (!tab.url || !U.isTrackableUrl(tab.url)) {
      logd('onActiveTabContext skip', tab.url);
      return;
    }

    await markPageSeen(tabId, tab.url);

    var state = await getState();
    await sendAgeToTab(tabId, tab.url, state.settings, state.pages);

    var others = await chrome.tabs.query({});
    for (var i = 0; i < others.length; i++) {
      var ot = others[i];
      if (ot.id === tabId) continue;
      if (ot.id == null) continue;
      await sendAgeToTab(ot.id, ot.url, state.settings, state.pages);
    }
  }

  chrome.tabs.onActivated.addListener(function (activeInfo) {
    onActiveTabContext(activeInfo.tabId).catch(function (e) {
      logd('onActivated', e);
    });
  });

  chrome.tabs.onRemoved.addListener(function (closedTabId) {
    (async function () {
      var key = pageKeyFromTabId(closedTabId);
      if (!key) return;
      var state = await getState();
      if (!state.pages[key]) return;
      delete state.pages[key];
      await saveState({ pages: state.pages });
    })().catch(function (e) {
      logd('onRemoved', e);
    });
  });

  /**
   * Active tab: mark seen + refresh all tabs. Background tabs: still push age state once
   * (otherwise new background loads stayed “cold” until you switched or the alarm fired).
   */
  chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
    if (changeInfo.status !== 'complete') return;
    if (!tab.url || !U.isTrackableUrl(tab.url)) return;
    (async function () {
      try {
        if (tab.active) {
          await markPageSeen(tabId, tab.url);
          await onActiveTabContext(tabId);
        } else {
          var state = await getState();
          await sendAgeToTab(tabId, tab.url, state.settings, state.pages);
        }
      } catch (e) {
        logd('onUpdated', e);
      }
    })();
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
        logd('alarm', e);
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
      logd(
        'installed / updated; fast:',
        U.FAST_TEST_MODE,
        U.FAST_TEST_MODE ? 'delay min ' + U.FAST_TEST_ALARM_DELAY_MINUTES : 'period min ' + U.ALARM_PERIOD_MINUTES_PROD
      );
    })().catch(function (e) {
      logd('onInstalled', e);
    });
  });

  chrome.runtime.onStartup.addListener(function () {
    scheduleAgingAlarm();
  });

  /** Service worker restarts do not fire onStartup; re-arm alarm if Chrome dropped it. */
  function ensureAlarmExists() {
    chrome.alarms.get(ALARM_DAILY, function (alarm) {
      if (chrome.runtime.lastError || !alarm) {
        if (U.FAST_TEST_MODE) {
          chrome.alarms.create(ALARM_DAILY, { delayInMinutes: U.FAST_TEST_ALARM_DELAY_MINUTES });
        } else {
          chrome.alarms.create(ALARM_DAILY, { periodInMinutes: U.ALARM_PERIOD_MINUTES_PROD });
        }
        logd('re-created alarm after worker wake');
      }
    });
  }

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

  ensureAlarmExists();
  refreshAllTabsVisuals().catch(function () {});
})();
