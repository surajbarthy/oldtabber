/**
 * Tab Aging — MV3 service worker.
 *
 * Permissions (manifest.json):
 * - storage: persist pages + settings in chrome.storage.local
 * - alarms: periodic refresh + stale-entry cleanup (fast-test chain vs 24h prod)
 * - tabs: read tab URLs / active state for “seen” and push APPLY_AGE_STATE
 * - scripting: inject utils.js + content.js when sendMessage fails (no content script yet)
 * - host_permissions http(s)/*: required so chrome.scripting.executeScript can run on normal sites
 *   (Chrome will not inject into chrome:// etc. even with broad hosts; we still skip those URLs.)
 */
importScripts('utils.js');

(function () {
  'use strict';

  var U = self.TabAgingUtils;
  var ALARM_DAILY = 'tab-aging-daily';
  var STORAGE_MS = 180 * 86400000; /* cleanup entries older than this */

  function logd() {
    if (!U.DEBUG) return;
    var a = ['[Tab Aging]'].concat(Array.prototype.slice.call(arguments));
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
    if (url == null || typeof url !== 'string') {
      logd('skipped tab', tabId, '(no url)');
      return;
    }
    if (!U.isTrackableUrl(url)) {
      logd('skipped restricted URL', url);
      return;
    }

    if (!settings.enabled) {
      try {
        await chrome.tabs.sendMessage(tabId, {
          type: 'APPLY_AGE_STATE',
          ageDays: 0,
          level: 0,
          settings: settings,
          pageUrl: url,
        });
      } catch (e) {
        /* tab may not have injectable script */
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
      pageUrl: url,
    };

    logd('applying level', comp.level, 'to', url);

    try {
      await chrome.tabs.sendMessage(tabId, payload);
    } catch (e) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tabId },
          files: ['utils.js', 'content.js'],
        });
        logd('injected content script for tab', tabId);
        await chrome.tabs.sendMessage(tabId, payload);
      } catch (e2) {
        logd('sendMessage failed after inject', tabId, (e2 && e2.message) || e2);
      }
    }
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

    await markPageSeen(tab.url);

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

  chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
    if (changeInfo.status !== 'complete') return;
    if (!tab.active || !tab.url || !U.isTrackableUrl(tab.url)) return;
    markPageSeen(tab.url)
      .then(function () {
        return onActiveTabContext(tabId);
      })
      .catch(function (e) {
        logd('onUpdated', e);
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
  });

  refreshAllTabsVisuals().catch(function () {});
})();
