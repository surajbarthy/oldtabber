# Tab Aging

A **Chrome extension (Manifest V3)** that makes tabs feel like an “impossible list”: the longer a page goes **without being the active, focused tab**, the more **urgent** it looks.

Because **Chrome does not allow extensions to paint native tab backgrounds**, Tab Aging instead:

- **Adds a growing red dot** on the page favicon (by age level; no full-icon tint), and optionally  
- **Prepends small markers to `document.title`** (which usually appears on the tab strip).

All state is **local** (`chrome.storage.local`). No backend.

## How aging works

- **`lastSeenAt`** is updated when a tab becomes **active** (and when an **http/https** tab **finishes loading** while active).
- **Age** is `floor((now - lastSeenAt) / AGING_UNIT_MS)` — in production that unit is one **day** (`86400000` ms); see fast test mode below.
- **Focusing a tab** sets `lastSeenAt` to now, so **age resets to 0** for that URL key while you are on it.
- **Other open tabs** keep their own `lastSeenAt`; when you switch away, their favicons/titles refresh to reflect **their** staleness.
- A **`chrome.alarms`** tick runs **cleanup** and **refreshes visuals** on open tabs (repeating **24h** in production; in fast test, a **30s** chained one-shot alarm).

### Fast test mode (development)

In **`utils.js`**, `FAST_TEST_MODE` is currently **`true`**: each threshold step uses **30 seconds** instead of one day, and the background schedules the next tick **every 30 seconds** so background tabs update quickly. Set **`FAST_TEST_MODE`** to **`false`** and reload the extension for real-world behavior. Reload the extension on `chrome://extensions` after changing the flag so alarms reset.

### Seeing favicon / title changes

The tab you are **actively using** is always treated as **fresh** (age 0), so its favicon stays normal. To verify aging, open **at least two** http(s) tabs, stay on one for **30+ seconds**, then look at the **other** tab’s icon/title (or switch away and back). Check the page console (F12) for `[Tab Aging] favicon dot badge level N` on the background tab when the alarm runs.

## Title markers (when enabled)

| Age (days, or 30s steps in fast test mode) | Marker |
|------------|--------|
| 0 | _(none)_ |
| 1–3 | 🔸 |
| 4–7 | 🔶 |
| 8–14 | 🔴 |
| 15+ | ⛔ |

Thresholds are configurable in storage as `settings.agingThresholds` (default `[1, 4, 8, 15]`). The options page **displays** them; editing numbers can be done via storage for now.

## Load unpacked in Chrome

1. Open **`chrome://extensions`**.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select the folder that contains **`manifest.json`** (this project root).

## Permissions (why they exist)

| Permission | Reason |
|------------|--------|
| `storage` | Persist `pages` + `settings`. |
| `alarms` | Periodic refresh + stale entry cleanup (daily in prod, 1 min when testing). |
| `tabs` | Read tab URLs / active state for “seen” and broadcasting visuals. |
| `scripting` | Inject `utils.js` + `content.js` when `sendMessage` fails (race / special frames). |
| `host_permissions` `http://*/*`, `https://*/*` | Content scripts and injection on normal websites only (MVP scope). |

Internal schemes (`chrome://`, `edge://`, `about:`, `chrome-extension://`, `file://`) are **not** matched by content scripts and are skipped in the background.

## File structure

| File | Role |
|------|------|
| `manifest.json` | MV3 entry, permissions, service worker, content scripts, options UI. |
| `utils.js` | URL normalization, age/level helpers, defaults (shared). |
| `background.js` | Service worker: alarms, tab events, storage, messaging, injection fallback. |
| `content.js` | Canvas favicon + growing red dot + title markers; listens for `APPLY_AGE_STATE`. |
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

- **Favicon**: Many sites use **CORS**; if the real icon cannot be drawn, we use a **neutral gray tile** with the same **growing red dot** so the badge still shows.
- **SPAs** (Google Calendar, Gmail, etc.) change `<title>` often; a `MutationObserver` on `<head>` re-applies the emoji marker when the app overwrites the title.
- **Discarded / unloaded tabs** may not run content scripts until loaded again.
- **Per-tab vs per-URL**: State is per **normalized URL**; two tabs on the same path share one `lastSeenAt`.

## Future ideas

- Tab groups / color hints where the API allows  
- Snooze (“don’t age until …”)  
- Custom curves, per-site rules, query-aware keys  
- Optional popup with “oldest tabs” list  

## License

Use and modify freely for personal projects.
