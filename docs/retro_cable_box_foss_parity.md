---
name: retro-cable-box-foss-parity
description: "Hard rule: retro-cable-box (original) and retro-cable-box-foss must be the same app — core files identical, the ONLY difference is which plugins ship and personal config/userData"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: cb18192e-9b5c-467c-b624-7ac340e7b0a4
  modified: 2026-08-17T19:30:34.992Z
---

The original app (`C:\Users\zhubb\VSCodeProjects\retro-cable-box`) and the FOSS copy (`C:\Users\zhubb\VSCodeProjects\retro-cable-box-foss`) must be treated as **the same application** going forward. Every core file (main.js, main-*.js, preload.js, renderer/**) should stay byte-identical between the two repos. The only allowed differences are:

- **Which plugins are present** in `plugins/` — FOSS deliberately omits `spotify-connect`, `youtube-music`, and `party-jukebox` (third-party ToS grey-area integrations — librespot reverse-engineers Spotify's protocol, yt-dlp scrapes YouTube). A plugin that DOES ship in both may still differ in implementation between the two (e.g. `ffmpeg-transcode`: original bundles ffmpeg via `ffmpeg-static`, FOSS resolves a system-installed `ffmpeg` from PATH — deliberate, to avoid the FOSS repo auto-downloading/redistributing a GPL binary). See [[retro_cable_box_plugin_system]].
- **Personal config/userData** — FOSS starts from a clean slate (no channels, no backups, no caches); the original keeps the real user's data. This also means the two apps must have **distinct Electron app identities** (package.json `name`/`productName`/`appId`) — same identity meant Electron resolved the same default OS-profile userData path and the FOSS copy's first boot silently migrated the user's real personal channel data into it. Caught and fixed 2026-08-18; watch for this again if either package.json's identity ever gets touched.

**Why this matters:** any feature that's "core" (channel routing, settings UI, state shape) must not be hardcoded around a specific plugin's existence — see [[retro_cable_box_plugin_system]]'s note on the `registerSettingsPanel` extension point, added 2026-08-18 specifically so Spotify Connect/YouTube Channel's full UI (channel display AND settings panel) could move out of core `index.html`/`state.js`/`virtual.js`/`dom.js` and into their own plugins, exactly so core stays identical between both repos while FOSS simply doesn't ship those two plugin folders.

**How to apply:** Before editing any core file in either repo, check whether the same edit belongs in the other one too. When adding a new feature that talks to an external service/tool, build it as a plugin from the start (main-process AND renderer halves) rather than wiring anything into core, specifically so it can be included/excluded per-repo without diverging core.
