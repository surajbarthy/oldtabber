# Tab Aging

A **Chrome extension (Manifest V3)** that makes tabs feel like an “impossible list”: the longer a page goes **without being the active, focused tab**, the more **urgent** it looks.

Because **Chrome does not allow extensions to paint native tab backgrounds**, Tab Aging instead:

- **Overlays the page favicon** (red tint / badge by age bucket), and optionally  
- **Prepends small markers to `document.title`** (which usually appears on the tab strip).

All state is **local** (`chrome.storage.local`). No backend.

## How aging works

- **`lastSeenAt`** is updated when a tab becomes **active** (and when an **http/https** tab **finishes loading** while active).
- **Age** is `floor((now - lastSeenAt) / AGING_UNIT_MS)` — in production that unit is one **day** (`86400000` ms); see fast test mode below.
- **Focusing a tab** sets `lastSeenAt` to now, so **age resets to 0** for that URL key while you are on it.
- **Other open tabs** keep their own `lastSeenAt`; when you switch away, their favicons/titles refresh to reflect **their** staleness.
- A **`chrome.alarms`** tick runs **cleanup** and **refreshes visuals** on open tabs (every **24 hours** in production, **every minute** while fast test mode is on).

### Fast test mode (development)

In **`utils.js`**, `FAST_TEST_MODE` is currently **`true`**: each threshold step uses **one minute** instead of one day, and the alarm runs **every minute** so background tabs update without waiting. Set **`FAST_TEST_MODE`** to **`false`** and reload the extension for real-world behavior. After changing the flag, reload the extension on `chrome://extensions` so the alarm schedule updates.

## Title markers (when enabled)

| Age (days, or minutes in fast test mode) | Marker |
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
| `content.js` | Applies favicon canvas overlay + title markers; listens for `APPLY_AGE_STATE`. |
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

- **Favicon**: Many sites use **CORS**; reading the real favicon into a canvas may fail — the extension falls back to a **generated badge**.
- **SPAs** that change `document.title` often may fight the title marker; the script tries to keep a single stored “original” title in a `data-*` attribute.
- **Discarded / unloaded tabs** may not run content scripts until loaded again.
- **Per-tab vs per-URL**: State is per **normalized URL**; two tabs on the same path share one `lastSeenAt`.

## Future ideas

- Tab groups / color hints where the API allows  
- Snooze (“don’t age until …”)  
- Custom curves, per-site rules, query-aware keys  
- Optional popup with “oldest tabs” list  

## License

Use and modify freely for personal projects.
