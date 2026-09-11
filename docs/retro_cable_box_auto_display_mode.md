---
name: retro-cable-box-auto-display-mode
description: "AUTO resolution/aspect detection cascade for the simulated display mode — race guard, call-order bug, tune-flash fix, metadata cache, configurable priority"
metadata: 
  node_type: memory
  type: project
  originSessionId: bbed1486-2f4c-4f63-90fb-41f16ca2e690
  modified: 2026-08-21T15:35:31.916Z
---

2026-08-21: AUTO resolution + AUTO aspect (box-wide DISPLAY tab + per-channel override, both with independent 'auto' choices) fully shipped and hardened through several live-bug rounds, core+FOSS synced, CDP-verified.

Bugs found and fixed this thread:
1. **Race condition on rapid channel flipping** — `S.currentPlayerChannelNumber` guard added (state.js) so `player.videoWidth/videoHeight` is only trusted once the CURRENT channel's own `loadedmetadata` confirms it, not a lingering previous channel's reading.
2. **Video cropped on SD-content channels (Boomerang/WVU Sports/Nickelodeon)** — real call-order bug: `applyTvBezel()` was measuring `#display-frame`'s size BEFORE `applyDisplayMode()` had resized it for AUTO-detected SD content, leaving `#player` oversized vs its now-smaller container. Fixed by reordering all 3 onMeta call sites (`applyDisplayMode()` always before `applyTvBezel`/`applyLogoBugPlacement`) in playback.js (playChannelLive + both startBreak onMeta callbacks).
3. **"Brief crop jump" flash on every tune** — `applyDisplayMode()` was called twice per tune: once early (pre-metadata, guessing via era/default) and once for real onMeta. When the guess differed from confirmed reality, the frame visibly double-jumped. This was very likely the actual cause of the user's earlier, harder-to-pin-down "auto aspect ratio channel flipping issue" reports.

Fix + feature (final design): added `S.videoSizeCache` (state.js, in-memory only, keyed by file path) — `cacheVideoSize(path, w, h)` (display-mode.js, called from all 3 onMeta sites in playback.js) remembers every file's REAL decoded size the first time it plays. The early speculative `applyDisplayMode()` call in `playChannelLive` was reinstated but now checks this cache FIRST (`realVideoSizeFor` = live-confirmed reading if available, else cache, else nothing) — so any file that's aired before this session (the common case: channels loop the same pool) gets its correct AUTO tier/aspect from frame one, no flash at all. Only a genuinely never-before-seen file still has a one-time possible guess-then-correct flash (falls through to era/default cascade), not a per-tune one.

Also added a configurable fallback-priority option per user request: `S.config.displayMode.autoPriority` ('metadata' default | 'era') — DISPLAY tab AUTO PRIORITY select. Lets a user who's deliberately era-tagged a modern remaster (real metadata would say "not old") force the era tag to win instead of the file's real decoded size.

Verified live via a geometry-polling CDP script (poll every 15ms during a tune, dedupe consecutive states): cold/first-view tune = exactly 1 geometry transition (was 2 before the fix); warm/cached repeat view = correct frame size from the very first poll (~23ms), only a tiny bezel/crop rounding correction (~9px) at onMeta, no full-frame jump.

See also [[retro_cable_box_architecture_constraints]] for the general call-order/race patterns this fits.
