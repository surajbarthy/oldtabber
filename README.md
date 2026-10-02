# OldTabber

Chrome extension (Manifest V3, version 1.4.0) that marks tabs by how long it has been since you last used them. The longer a tab sits idle, the stronger the marker in its title.

Chrome does not let an extension paint the tab strip, so OldTabber prepends a marker to `document.title`. All state stays in `chrome.storage.local`. There is no account and no server.

## Markers

The toolbar popup has two indicator styles. While the extension is on, title markers stay enabled (there is no separate marker toggle). Turning the extension off restores the page title.

**Minimal** (default):

| Level | Marker |
| --- | --- |
| 1 | · |
| 2 | ○ |
| 3 | ● |
| 4 | ✖ |

**Emoji:**

| Level | Marker |
| --- | --- |
| 1 | 🥚 |
| 2 | ⏳ |
| 3 | 🔥 |
| 4 | ☠️ |

Below level 1 the title is left alone. A marker is a prefix (`· Example`). The content script removes a previous prefix before writing a new one, so markers do not stack. If the page rewrites `document.title`, the script puts the prefix back.

Favicon dot and tint drawing exists in the extension and is switched off for this release. `normalizeSettings` forces both flags off, and the popup has no control for them. This version changes titles only.

## Presets

Aging is four rising idle thresholds. **Balanced** is the default for a new install.

| Mode | Level 1 | Level 2 | Level 3 | Level 4 |
| --- | --- | --- | --- | --- |
| Balanced | 30 minutes | 2 hours | 1 day | 3 days |
| Focus | 10 minutes | 30 minutes | 2 hours | 8 hours |
| Chill | 1 hour | 6 hours | 2 days | 7 days |

**Customize timing** in the popup sets each level in minutes, hours, or days (minimum 1; caps are 10080 minutes, 720 hours, and 365 days). Each level is kept strictly later than the one before it, at least one minute apart. Overlapping values are moved forward automatically. Timing that matches a preset selects that mode. Anything else shows a Custom badge.

**Reset to mode defaults** restores the selected preset. If the timing is custom, it restores Balanced.

## How a tab ages

Each open tab has its own record, keyed by `tab:<tab id>`, with a `lastSeenAt` timestamp. A tab with no record yet has no marker. Idle time is `now - lastSeenAt`. Level *n* starts once idle time reaches that level’s threshold.

- The timer starts, and `lastSeenAt` is set to now, when you focus the tab.
- An http(s) page that finishes loading while it is the active tab does the same, and its marker clears.
- The clock keeps running after that. A refresh updates titles and does not reset timers, including on the tab you are looking at.
- Switching tabs refreshes every open tab and restarts the timer only for the tab you just focused.
- Closing a tab deletes its record. Two tabs on the same URL have separate timers.
- Every 5 minutes an alarm refreshes open tabs and removes records whose `lastSeenAt` is older than 180 days.

Only `http` and `https` pages are tracked. These are skipped: `chrome://`, `edge://`, `about:`, `chrome-extension://`, `moz-extension://`, `devtools://`, `view-source:`, and `file://`.

In `utils.js`, `FAST_TEST_MODE` is `false`, so thresholds use real time and the refresh alarm repeats every 5 minutes. Set `FAST_TEST_MODE` to `true` and reload the extension to use a 30-second alarm instead. Thresholds stay on wall-clock time either way. Set `DEBUG` to `true` in the same file for service-worker and content-script logs.

To see a marker quickly: open two http(s) tabs so each one has been focused, choose Focus or set Level 1 to 1 minute, stay on one tab, then read the other tab’s title. A tab that has never been focused has no timer yet.

## Toolbar and options

Click the toolbar icon.

- **Extension on** — master switch. Off restores normal titles.
- **Mode** — Balanced, Focus, or Chill.
- **Indicator style** — Minimal or Emoji. The customize panel shows the matching glyphs.
- **Customize timing** — the four levels, plus reset to the current mode’s defaults.
- **Reset all tab timers** — clears every stored last-focus time after a confirm.
- **Extension settings** — opens the options page.

The options page (also under the extension’s Details) repeats the master switch and **Reset all tracked tabs**. Mode, indicator style, and step timing stay in the popup.

The popup and options page request Inter from Google Fonts. Without that request they use a system font.

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | Save per-tab last-seen times and settings in `chrome.storage.local`. |
| `alarms` | Refresh open tabs and drop records older than 180 days, every 5 minutes. |
| `tabs` | Read each tab’s URL and active state, then send the current age to the page. |
| `scripting` | Inject `utils.js` and `content.js` when a tab does not have them yet. |
| `http://*/*`, `https://*/*` | Inject the content script into matching pages, and let the service worker request those sites. |

Content scripts are `utils.js` then `content.js`, on `http://*/*` and `https://*/*`, at `document_idle`.

## Storage

Two keys in `chrome.storage.local`. A fresh install saves the settings below (Balanced, minimal). `pages` stays empty until a tab is focused; the `tab:123` entry is the shape of one record.

```json
{
  "pages": {
    "tab:123": {
      "lastSeenAt": 1710000000000
    }
  },
  "settings": {
    "enabled": true,
    "useTitleMarkers": true,
    "useFaviconDot": false,
    "useFaviconTint": false,
    "indicatorStyle": "minimal",
    "agingSteps": [
      { "value": 30, "unit": "minutes" },
      { "value": 2, "unit": "hours" },
      { "value": 1, "unit": "days" },
      { "value": 3, "unit": "days" }
    ],
    "agingThresholdsMs": [1800000, 7200000, 86400000, 259200000]
  }
}
```

`agingThresholdsMs` is derived from `agingSteps`. `useTitleMarkers` is forced on. `useFaviconDot` and `useFaviconTint` are forced off. If saved settings have no four-step `agingSteps`, an older day-count `agingThresholds` array is converted into day steps. Page records whose keys do not start with `tab:` are discarded on read.

## Load unpacked in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select the folder that contains `manifest.json` (the repository root).

There is no install step and no package to build.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | Manifest V3: name, version, permissions, service worker, content scripts, popup, options. |
| `utils.js` | URL checks, presets, idle time to level, title markers, settings normalization. |
| `background.js` | Tab events, the 5-minute alarm, storage, and messages to pages. |
| `content.js` | Writes and restores the title prefix. |
| `popup.html`, `popup.js`, `popup.css` | Toolbar: on/off, mode, indicator style, custom timing, reset timers. |
| `options.html`, `options.js` | Master switch and reset all tracked tabs. |
| `icons/` | Extension icons (`icon16`, `icon32`, `icon48`, `icon128`) and `popup-logo.png`. |
