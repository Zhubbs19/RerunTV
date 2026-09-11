---
name: retro-cable-box-plugin-settings-relocation-and-eas-news-split
description: "Plugin settings moved from PROGRAMMING tab to expand-in-place under each plugin's PLUGINS tab row; EAS and Breaking News split into two new plugins"
metadata: 
  node_type: memory
  type: project
  originSessionId: cb18192e-9b5c-467c-b624-7ac340e7b0a4
  modified: 2026-08-18T02:22:06.308Z
---

2026-08-17 session: two changes, both shipped in both repos with full CDP verification.

**1. Plugin settings UI relocated.** The old `#plugin-settings-slot` (a flat list of every plugin's settings panel dumped into PROGRAMMING → ON-SCREEN EXTRAS, regardless of which tab it belonged to) is gone. Each plugin row in the PLUGINS tab now gets a SETTINGS toggle button — only shown if that plugin actually called `registerSettingsPanel` — that expands/collapses the panel in place right below the row (`setup-plugins.js`'s `renderPluginsList`). Same "rebuild from scratch on every show" contract as before, just relocated. Fixes real UI crowding (7+ plugin panels were piling up in an unrelated subtab).

**2. EAS and Breaking News split into separate plugins** (`plugins/eas-alerts`, `plugins/breaking-news`), migrated at the same full-ownership depth as [[retro_cable_box_virtual_channels_as_plugins]]:
- Both are persistent full-screen interrupt overlays (not `registerChannelType` channels — they're not tuned to, they interrupt whatever's playing), built once at plugin module top-level and appended into `document.querySelector('.crt')` directly. Confirmed a plugin's renderer.js CAN safely call plain `document.querySelector`/`appendChild` on core-owned DOM — the app://bundle vs app://plugins cross-origin restriction only blocks `import` statements between the two, not live DOM manipulation, since both run in the same page.
- Core previously imported `runEasTest`/`cancelEas`/`scheduleNextEas` and `runBreakingNewsAlert`/`cancelNewsAlert`/`scheduleNextNewsAlert` directly in 5 files (app.js, playback.js, power.js, tv-menu.js, setup-settings.js) — all converted to guarded `window.RCBPlugins.easAlerts.*` / `window.RCBPlugins.breakingNews.*` calls, matching the established escape-hatch pattern.
- New core window exposures added for functions eas.js/news.js used to import freely as core code: `window.getChannel`, `window.isVirtualChannel`, `window.cancelUpNextBar`, `window.playChannelLive`, `window.playNoiseBurst` (alongside the existing `getAudioCtx`/`checkBreakState`/etc.) — `playNoiseBurst` joins `playPpvOrderSound` as a "too foundational to duplicate" exposure (22+ other core usages).
- **NOAA real-alert polling moved out of core eas.js into the noaa-weather plugin itself** (not into eas-alerts) — `pollNoaaAlerts`/`scheduleNextNoaaPoll` now live in `plugins/noaa-weather/renderer.js`, self-invoking `scheduleNextNoaaPoll()` at module top level instead of relying on core's `init()` to call it (that call was never actually awaited-safe — `loadPlugins()` isn't awaited in app.js, so a plugin self-invoking its own boot-time work at its own module top level is more reliable than core trying to call into a plugin that might not have loaded yet). A genuine Severe/Extreme alert calls `window.RCBPlugins.easAlerts.runEasTest({real: alert})` — cross-plugin call, guarded.
- `breaking-news` also self-invokes `scheduleNextNewsAlert()` at its own top level for the same reason (core used to kick this off once at boot).
- Both plugins ship their own `registerSettingsPanel` (EAS: enabled+voiceover toggle; Breaking News: full config incl. the dynamic headline-bank list editor, ported verbatim from the old setup-settings.js wiring). The `S.config.eas` namespace stays shared between eas-alerts and noaa-weather (same "plugin config inside a core-shared namespace" pattern as before — NOAA's lat/lon/noaaEnabled fields live alongside EAS's enabled/voiceover fields in one object, since NOAA-triggered alerts and EAS-test alerts are genuinely the same interrupt mechanism).
- Deleted core files: `renderer/js/eas.js`, `renderer/js/news.js`. Removed the `live-pulse` CSS keyframe from core overlays.css once confirmed it had become breaking-news-exclusive after the earlier virtual-channel migrations already claimed its other usages.

Verification: CDP-tested E/B keyboard shortcuts, the tv-menu EAS TEST/NEWS ALERT buttons, cancelEas mid-test, the "press B again to dismiss" shortcut, both settings panels' presence/toggle-behavior in the PLUGINS tab, and a full channel sweep — all clean in both repos. FOSS's fresh-install test initially showed EAS/News not firing on E/B, which was correctly diagnosed as expected behavior (both require a real tuned channel, not virtual/none) rather than a bug, confirmed by adding a temporary test channel.

No commits made in either repo per [[retro_cable_box_workflow]].

**Update 2026-08-17 (later session): the "still open" plugin-dependency-info item is now closed — see [[retro_cable_box_plugins_tab_redesign]] for the PLUGINS tab overhaul that added it (inline REQUIRES: lines) alongside a filter/search box, an enabled-count summary, and broken-plugins-sort-to-top.**
