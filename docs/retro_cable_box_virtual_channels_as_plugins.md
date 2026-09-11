---
name: retro-cable-box-virtual-channels-as-plugins
description: "ALL virtual channels including PREVUE+PUBLIC ACCESS are now full-ownership plugins — zero core-rendered virtual channels left except PARTY_CH (hybrid)"
metadata: 
  node_type: memory
  type: project
  originSessionId: cb18192e-9b5c-467c-b624-7ac340e7b0a4
  modified: 2026-08-18T22:19:46.918Z
---

**2026-08-18 update: PREVUE (CH1) and PUBLIC ACCESS (CH2) migrated too** — the last two virtual channels that stayed core after the 2026-08-17 batch below. User's explicit ask: "split the public access and prevue channels to their own separate plugins" + "make the core of the app as lightweight and the app as modular as possible." Now `plugins/prevue/` and `plugins/public-access/` follow the exact same `registerChannelType` pattern as the other 9.
- New generic registry capability added to support this: `registerChannelType`'s definition now accepts an optional `enabled(ctx)` predicate — gates whether a plugin channel shows up in `virtualChannelNumbers()` at all, beyond "is the plugin installed/enabled." Needed because Public Access has always had its OWN independent CH2 on/off toggle (distinct from the plugin-level enable/disable) — `public-access`'s `registerChannelType` call supplies `enabled(ctx) { return !!(ctx.S.config.publicAccess && ctx.S.config.publicAccess.enabled); }`. Reusable by any future channel with the same "installed but toggled off" need.
- `window.RCBPlugins.ctx` (plugins.js) extended with `sortedChannels`, `buildChannelBadge`, `getChannelSchedule`, `getDisplayTitle`, `formatSlotLabel`, `saveConfigDebounced` — Prevue's listing has to read the box's REAL channel lineup and live schedule, which can't be duplicated/reimplemented plugin-side without risking drift from core's actual scheduling engine (unlike e.g. local-weather's synthetic-forecast math, which WAS safely duplicatable).
- `virtual.js`'s three plugin-dispatch call sites (`triggerVirtualChannelOk`, `triggerVirtualChannelKey`, `showVirtualChannel`'s render call) now pass `window.RCBPlugins.ctx` directly instead of each building its own ad-hoc `{S, viewNow, player}` literal — simplification that also means any future ctx addition reaches all three for free.
- `virtual.js` lost ~140 lines of PREVUE/PUBLIC-ACCESS-specific code (`buildLandingRows`, `rebuildLandingScroll`, `updateVirtualClocks`, `showPubAccessSlide`, `playVirtualAudio`, plus every `if (number === LANDING_CH/PUBACCESS_CH)` branch) — every remaining function now goes through the generic plugin-registry path uniformly. `LANDING_CH`/`PUBACCESS_CH` constants removed from state.js entirely (nothing references channel 1/2 by name anymore, just the plugins' own hardcoded `number: 1`/`number: 2`).
- Settings UI fully moved from static `index.html` panels + hand-wired `setup-settings.js` code into each plugin's own `registerSettingsPanel` (mirrors `local-weather`'s audio-picker pattern for Prevue; Public Access additionally needed the enable checkbox + slide-list CRUD, following the exact same in-place-rebuild convention).
- Verified via CDP against the real config (Public Access WAS enabled with a real background-audio file assigned): both channels tune correctly, real schedule/channel data renders in Prevue's listing, Public Access's audio plays, slide add/edit/remove works, and toggling the independent enable checkbox correctly adds/removes CH2 from `virtualChannelNumbers()` live. Only config diff after testing was `lastChannel` (expected side effect of tuning during the test) — restored before considering it clean.
- All touched core files + the 2 new plugin folders synced byte-identical to FOSS.
- **Net result**: PARTY_CH is now the ONLY channel that isn't a full `registerChannelType` plugin (it's a documented hybrid — core-rendered via `party.js`, with the `party-channel` plugin owning just the LAN server + settings panel). Every other virtual channel, including the two that were "permanently core" as of the previous migration below, is a plugin now.

2026-08-17 session: completed "make all virtual channels except prevue guide and public access their own plugins" — full-ownership depth (like Spotify/YouTube), confirmed via [[retro_cable_box_plugin_system]] AskUserQuestion answer, not a thin core-delegating shim.

**9 new plugins, all shipped in BOTH repos (original content, no ToS concerns unlike Spotify/YouTube):**
- `retro-game-hotline` (CH 88), `area-51` (CH 51), `hbo` (CH 95) — trivial rotating-card channels, own inlined audio (play8BitChiptune/playAlienSignalSound/playHboTheme duplicated per-plugin since core versions were channel-exclusive and got deleted from core)
- `pay-per-view` (CH 98) + `shopping-network` (CH 96) — first channels with real modals; introduced two new generic plugin-channel contract hooks to replace core special-casing:
  - `onOk(ctx)` — Enter/Space while tuned in (remote OK-button), dispatched via new `virtual.js` export `triggerVirtualChannelOk(number)`
  - `onKey(key, ctx)` — every keydown while tuned in (teletext-arcade's Snake arrows), dispatched via `triggerVirtualChannelKey(number, key)`
  - Modal Escape/Enter handling also generalized: any modal inside `#plugin-channel-container` with `data-modal-dismiss`/`data-modal-confirm` attributes gets free Escape-to-dismiss/Enter-to-confirm via one handler in app.js's keydown, instead of a per-channel special case
  - `playPpvOrderSound` stayed in core audio.js (built on `playTone`/`playNoiseBurst`, 30+ other usages, too foundational to duplicate) and is exposed as `window.playPpvOrderSound` — the one exception to "full ownership audio", matching the `getAudioCtx` exposure precedent
- `synthwave-radio` (CH 97) — canvas animation loop, `stop()` hook clears the interval (first channel needing real cleanup beyond a DOM hide)
- `teletext-arcade` (CH 99) — Ceefax pages + playable Snake game, uses the new `onKey` hook
- `local-weather` (CH 3) — most complex: has its own `registerSettingsPanel` (location + background-audio picker, replacing the old `S.config.weather.enabled` toggle entirely — plugin install/enable state is now the sole gate, matching every other migrated channel), duplicates `hashString`/`mulberry32`/`generateWeather`/`mapNoaaPeriods` inline (tiny pure functions, no state coupling) but calls the already core-exposed `window.api.noaaGetForecast` directly for the live-upgrade path — no new cross-plugin wiring needed since that IPC channel was already generic
- `video-in` (CH 0, AUX) — first plugin with its own `main.js`: moved `desktop:listSources` IPC handler out of core main.js into the plugin, which required adding `desktopCapturer` to the base plugin `ctx` in main-plugins.js (alongside the earlier `shell` addition from the video-splicer work). Renderer owns the getUserMedia capture + source picker, driving `ctx.player.srcObject` directly

**Real bug found and fixed along the way**: `.crt.power-off` CSS never included `#plugin-channel-container` in its hide-list — meaning Spotify/YouTube (and now all 9 new channels) stayed visible on screen when the box "powered off". Fixed by adding `#plugin-channel-container` to the power-off selector and removing the now-dead specific `#weather-channel`/`#video-in-channel` IDs. Verified via CDP by toggling the class directly and checking computed display.

**Deleted core files** (fully emptied by the migration): `renderer/js/ppv-hbo.js`, `synth.js`, `teletext.js`, `weather.js`, `aux-channel.js`. Also removed every per-channel `config.<name>.enabled` toggle and its settings-panel checkbox/wiring (game/area51/hbo/ppv/hsn/synth/teletext/weather) — PLUGINS tab install/enable is now the only gate for all of these, consistent with how Spotify/YouTube already worked.

**Verification discipline**: did per-channel CDP checks for the first few (game/area51/hbo), then batched remaining verification into one comprehensive pass at the end per explicit user instruction ("do verification at end of all 9") — full channel sweep + interactive flows (PPV order→confirm→unscramble, HSN order, Snake arrow keys, AUX picker, weather NOAA upgrade) all passed with zero console errors in both repos. One FOSS test run showed canvas errors that turned out to be a test-harness artifact (calling tuneToChannel while the TV screen was hidden behind a fresh-install SETUP screen), not a real regression — confirmed by re-testing with the TV screen forced visible.

Final diff check: every touched core file (virtual.js, app.js, dom.js, setup-settings.js, audio.js, plugins.js, playback.js, overlays.css, index.html) and all 9 plugin folders are byte-identical between retro-cable-box and retro-cable-box-foss.

No commits made in either repo per [[retro_cable_box_workflow]].

**Deferred (queued by user, not started yet)**: add plugin dependency info to the PLUGINS tab list UI; examine EAS and Breaking News alerts for further plugin-ification (non-core features not yet touched).
