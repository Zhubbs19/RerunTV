---
name: retro-cable-box-foss-repo
description: "The FOSS-clean fork at C:\Users\zhubb\VSCodeProjects\retro-cable-box-foss — what it is, current state, how it was built"
metadata:
  type: project
  node_type: memory
---

Created 2026-08-18: a git repo at `C:\Users\zhubb\VSCodeProjects\retro-cable-box-foss`, a FOSS-clean fork of the main app. See [[retro_cable_box_foss_parity]] for the hard rule governing how it's kept in sync with the original.

**Differences from the original** (everything else is identical — see the parity memory):
- Doesn't ship `spotify-connect`, `youtube-music`, or `party-jukebox` plugins — third-party ToS grey areas (librespot reverse-engineers Spotify's protocol, yt-dlp scrapes YouTube). No README/help-text/UI mentions of them either — the user explicitly didn't want their existence advertised, not just the plugins omitted.
- `ffmpeg-transcode` plugin has a different implementation: resolves a system-installed `ffmpeg` from PATH (with a `registerSettingsPanel`-based custom-path field) instead of bundling one via the `ffmpeg-static` npm package — avoids redistributing a GPL-3.0 binary. `package.json` has no `ffmpeg-static` dependency at all in this repo.
- Distinct Electron app identity (`package.json` `name`/`productName`/`appId` all suffixed `-foss`) — **load-bearing, not cosmetic**: same identity as the original meant Electron resolved the same default OS-profile userData path, and on first boot the FOSS copy's "migrate old userData" logic silently copied the user's real personal channel data into it. Caught via a real boot test, fixed by renaming.
- Doesn't include `android-remote-client/`, `android-tv-client/`, or `video-splicer/` — companion tools/utilities the user asked left out of this build entirely.
- `LICENSE` file (MIT) at root — the original app doesn't have one on disk despite `package.json` declaring MIT (a separate, still-open gap in the original — see the FOSS/main-app audit conversation from 2026-08-17).
- Clean-slate `userData/` — no personal channels/backups/caches ship with the repo; gitignored.

**Build/verify notes:**
- `npm install` run fresh in this repo (not copied from original) — own `node_modules`/`package-lock.json`.
- Git init hit a real Windows quirk: `git add`/PowerShell `Copy-Item` both refuse `renderer/js/aux.js` (Windows reserves "AUX" as a device name regardless of extension) — fixed by renaming to `aux-channel.js` in **both** repos (parity), not by working around git config.
- A stray `Copy-Item -Recurse` bug nested `android-remote-client/android-remote-client/...` and dragged in Gradle `.gradle`/`.idea`/`build` artifacts before those three companion-tool folders were dropped entirely — worth remembering if ever copying Android project folders on Windows again: verify destination doesn't already exist first, and never commit `.gradle`/`.idea`/`build`/`local.properties` regardless.
- First commit was made, then explicitly removed from history at the user's request (`git update-ref -d HEAD` — safe for a root commit, keeps working tree/index intact) — the user wants to control commit timing themselves going forward, in this repo and the original.
