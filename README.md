# Tab Aging

A **Chrome extension (Manifest V3)** that makes tabs feel like an “impossible list”: the longer a page goes **without being the active, focused tab**, the more **urgent** it looks.

Because **Chrome does not allow extensions to paint native tab backgrounds**, Tab Aging instead:

- **Sets a generated favicon badge** (transparent canvas, colored dot/badge by age level — no site icon bitmap), and optionally  
- **Prepends small markers to `document.title`** (which usually appears on the tab strip).

All state is **local** (`chrome.storage.local`). No backend.

## Why some sites were failing before

- **Native tab color** cannot be changed by extensions; only signals the page exposes (favicon + title) are under partial control.
- **Drawing the site’s real favicon on a canvas** often fails in practice: cross-origin images **taint** the canvas, so **`toDataURL()` throws** or behavior is inconsistent. Fetching bytes in the service worker helped some cases but still depended on servers, SVG vs raster, and Chrome’s favicon pipeline.
- **This MVP** uses a **fully generated** PNG (data URL) — no site bitmap — so **CORS/taint does not apply** and the badge is **consistent across sites**.
- **SPAs** (Gmail, Calendar, etc.) may still **replace `<link rel="icon">` or `<title>`** after load. The content script **reapplies** state on a **short retry schedule**, **`visibilitychange`**, **`load`**, and a **debounced `MutationObserver` on `<head>`** so the badge/title come back without tight loops.

## How aging works

- **`lastSeenAt`** is updated when a tab becomes **active** (and when an **http/https** tab **finishes loading** while active).
- **Age** is `floor((now - lastSeenAt) / AGING_UNIT_MS)` — in production that unit is one **day** (`86400000` ms); see fast test mode below.
- **Focusing a tab** sets `lastSeenAt` to now, so **age resets to 0** for that URL key while you are on it.
- **Other open tabs** keep their own `lastSeenAt`; when you switch away, their favicons/titles refresh to reflect **their** staleness.
- A **`chrome.alarms`** tick runs **cleanup** and **refreshes visuals** on open tabs (repeating **24h** in production; in fast test, a **30s** chained one-shot alarm).

### Fast test mode (development)

In **`utils.js`**, `FAST_TEST_MODE` is currently **`true`**: each threshold step uses **30 seconds** instead of one day, and the background schedules the next tick **every 30 seconds**. Set **`FAST_TEST_MODE`** to **`false`** and reload the extension for real-world behavior.

### Debug logging

In **`utils.js`**, set **`DEBUG`** to **`true`** and reload the extension. The service worker and content script will log lines such as applying level, inject retries, and skipped URLs. Leave **`false`** to avoid console noise.

### Seeing favicon / title changes

The tab you are **actively using** is always treated as **fresh** (age 0), so its favicon stays normal. To verify aging, open **at least two** http(s) tabs, stay on one for **30+ seconds** (in fast mode), then look at the **other** tab’s icon/title.

## Title markers (when enabled)

| Age (days, or 30s steps in fast test mode) | Marker |
|------------|--------|
| 0 | _(none)_ |
| 1–3 | 🔸 |
| 4–7 | 🔶 |
| 8–14 | 🔴 |
| 15+ | ⛔ |

Thresholds are configurable in storage as `settings.agingThresholds` (default `[1, 4, 8, 15]`). The options page **displays** them; editing numbers can be done via storage for now.

## Favicon badge levels (generated)

| Level | Appearance |
|-------|------------|
| 0 | _(managed link removed; site default)_ |
| 1 | Small orange dot |
| 2 | Larger orange–red dot |
| 3 | Red badge + stronger ring |
| 4 | Strong red + white “!” |

## Load unpacked in Chrome

1. Open **`chrome://extensions`**.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select the folder that contains **`manifest.json`** (this project root).

## Permissions (why they exist)

| Permission | Reason |
|------------|--------|
| `storage` | Persist `pages` + `settings`. |
| `alarms` | Periodic refresh + stale entry cleanup (daily in prod, 30s chain in fast test). |
| `tabs` | Read tab URLs / active state for “seen” and broadcasting visuals. |
| `scripting` | Inject `utils.js` + `content.js` when `sendMessage` fails (race / no script yet). |
| `host_permissions` `http://*/*`, `https://*/*` | Declarative content scripts + programmatic injection on normal websites (MVP). |

Internal schemes (`chrome://`, `edge://`, `about:`, `chrome-extension://`, `devtools://`, `view-source:`, `file://`, etc.) are **skipped** by `isTrackableUrl` in **`utils.js`**.

## File structure

| File | Role |
|------|------|
| `manifest.json` | MV3 entry, permissions, service worker, content scripts, options UI. |
| `utils.js` | URL guards, age/level, `DEBUG`, defaults (shared). |
| `background.js` | Service worker: alarms, tab events, storage, messaging, inject + retry. |
| `content.js` | Generated favicon, title markers, reapplies, observers. |
| `options.html` / `options.js` | Toggle features, show thresholds, reset tracked pages. |
| `README.md` | This document. |

## Data model

```json
{
  "pages": {
    "https://example.com/path": {
      "lastSeenAt": 1710000000000
    }
  },
  "settings": {
    "enabled": true,
    "useTitleMarkers": true,
    "useFaviconOverlay": true,
    "agingThresholds": [1, 4, 8, 15]
  }
}
```

URLs are keyed by **origin + pathname** (no query, no hash).

## Storage cleanup

Entries whose `lastSeenAt` is older than **180 days** are removed on the daily alarm so storage does not grow forever.

## Known limitations

- **Discarded / unloaded tabs** may not run content scripts until loaded again.
- **Per-tab vs per-URL**: State is per **normalized URL**; two tabs on the same path share one `lastSeenAt`.
- **Favicon**: If a tab strip still ignores a data-URL `link` (rare), **title markers** remain the fallback when enabled.

## Manual test checklist

1. **Normal static site** (e.g. `https://example.com`): open two tabs, age one in the background; confirm **generated badge** + optional title marker on the stale tab; active tab clean.
2. **SPA** (e.g. Google Calendar): after navigation or delayed title/icon changes, confirm badge/title **reappear** after retries or tab focus (`visibilitychange`).
3. **Restricted URL** (`chrome://extensions`, `file://`): extension should **not** inject; no errors spamming the page console.
4. **Tab visible again**: switch away and back; stale tabs should **refresh** visuals.
5. **Title changes after load**: SPA that updates `document.title`; marker should **stay** once (no duplicate emoji run) via observer + strip logic.

## Future ideas

- Tab groups / color hints where the API allows  
- Snooze (“don’t age until …”)  
- Custom curves, per-site rules, query-aware keys  
- Optional popup with “oldest tabs” list  

## License

Use and modify freely for personal projects.
