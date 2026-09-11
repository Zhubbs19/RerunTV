---
name: retro-cable-box-core-plugin-agnosticism
description: "2026-08-19: core made fully plugin-agnostic — no core file (text, comments, or code) assumes any specific plugin exists, with FFmpeg as the one accepted exception. Two new generic extension points shipped; several real hybrid core+plugin bugs fixed along the way."
metadata:
  node_type: memory
  type: project
  originSessionId: 197079ed-3170-4dd9-aff2-1ac59526b030
  modified: 2026-08-19T13:40:50.052Z
---

## What this was

Started as "check for FOSS/original inconsistencies" (a stray "YOUR 13 CHANNELS"
hardcoded into a generic empty-state message, a PIN-lock blurb naming
PPV/HBO/Area 51 by name) and escalated, at the user's explicit direction, into
a full pass making **core genuinely plugin-agnostic** — no core file (not just
user-facing text, but code comments and functional code too) may assume any
specific plugin exists, with **FFmpeg as the sole named exception** (a real
generic tool, not a proprietary plugin brand). "Do large refactors if needed,
no cheap workarounds" and "close the gap fully" were both explicit
instructions — this was not meant to stop at cosmetic text edits.

## Two new generic extension points (registerable via `window.RCBPlugins`)

- **`registerTitleRowAction(id, {renderRowCell, renderBulkAction})`** —
  replaces a single hardcoded "MATCH TMDB" button that used to be built
  directly into core `setup-panels.js`. A plugin now injects its own per-file
  action into the TITLES tab's file rows (and, since that row renderer is
  reused, a SCHEDULE block's file list too). `tmdb-metadata` is the only
  current consumer — its whole match/bulk-match/re-match UI moved out of
  core into `plugins/tmdb-metadata/renderer.js` using this.
- **`registerCoreHook(event, fn)`** — replaces every ad-hoc
  `window.RCBPlugins?.<pluginName>?.method?.()` call site core used to have
  (`screensaver.cancelTimer/scheduleTimer`, `vintageAudio.applyThemeAudio`,
  `smpteTestPattern.draw`). Core now fires named events
  (`power-off`/`power-on`/`enter-setup`/`idle-reset`/`idle-armed`/
  `theme-audio-refresh`/`draw-test-pattern`) with zero knowledge of who (if
  anyone) is listening; a plugin subscribes instead of core calling it by
  name. Multiple plugins can share an event; a throw in one handler is
  caught/logged without blocking others (same per-plugin isolation every
  other registry already gives). This closes what was the last known
  systematic gap — see [[retro_cable_box_plugin_system]] for the other
  registries (registerChannelType/registerSettingsPanel/registerThemePack/
  registerInterrupt/registerTuneGate/registerOverlayAudioSource) this now
  sits alongside.
- **`registerChannelType`'s new optional `viewerLink: {fetchUrl()}` field** —
  lets a channel plugin offer a "watch live" link on the LAN viewer page.
  Replaces `app.js` hardcoding `PARTY_CH`/`isVirtualChannel(PARTY_CH)` to
  gate a party-specific link — core now asks generically (`findLiveViewerLinkChannelType()`,
  `virtual.js`) whether ANY registered channel type currently wants to offer
  one. The actual URL comes from a new generic main-process endpoint,
  `GET /api/viewer-live-link` (`main-viewer-server.js`), which reads
  `pluginServices.viewerLiveLinkUrls` — a plain `ctx.services` value any
  plugin's `main.js` can publish (party-channel does, via
  `ctx.services.viewerLiveLinkUrls = getPartyUrls()` with its own now-locally-declared
  `PARTY_PORT`, not a core-provided one — see below).

## Real hybrid core+plugin bugs found and fixed along the way

These weren't cosmetic — core genuinely depended on specific plugins by name
in ways that would break if that plugin were ever removed/renamed, exactly
the kind of thing this pass was meant to catch:

- **`app.js`'s `applyConfigDefaults` was seeding `config.party`, `config.tmdb`,
  `config.publicAccess`, `config.screensaver`, and `config.breakingNews`
  directly in core** — despite a comment right above them stating the rule
  "a plugin seeds its own config namespace, not here." All five moved to
  their owning plugin's own `renderer.js` top-level seeding (the same
  pattern `spotify-connect`/`youtube-music` already used correctly). Verified
  nothing else in core actually read any of these fields before removing them.
- **Plugin-owned runtime state fields lived in core `state.js`'s initial `S`
  object literal** even though nothing in core read them — `partyQueue`,
  `partyCurrentItem`, `partyItemTimer`, `partyTickerFeed`, `partyVoteTally`,
  `partyVoteTimer`, `partyCheckins`, `partyCaptionImagePath`,
  `partyTriviaRound`, `countdownTimer` (→ `party-channel/renderer.js`),
  `partyJukeboxSkipVotes` (→ `party-jukebox/renderer.js`), `newsScheduleTimer`/
  `newsEndTimer`/`newsSafetyTimer`/`breakingNewsActive` (→
  `breaking-news/renderer.js`), `noaaPollTimer`/`noaaSeenAlertIds` (→
  `noaa-weather/renderer.js`). A plain JS object doesn't care whether a field
  was in the initial literal or added later — each plugin now does
  `if (S.field === undefined) S.field = <default>;` at its own top level.
  `easScheduleTimer`/`easEndTimer`/`easSafetyTimer`/`easOscillators`/
  `easActive` deliberately stayed in core — those ARE genuine core state
  (the random EAS test slate is core behavior, not plugin-owned; see
  [[retro_cable_box_plugin_settings_relocation_and_eas_news_split]]).
- **`main-lan.js` hardcoded `PARTY_PORT = 8726` and a `getPartyUrls()`
  helper as core infrastructure**, exported and threaded through
  `main.js`'s `extraCtx`, `plugin-isolation-runtime.js`, and
  `main-plugin-isolation.js`'s init payload — purely to serve one specific
  plugin. Removed entirely; `party-channel/main.js` now declares
  `const PARTY_PORT = 8726` locally and builds its own `getPartyUrls()` from
  the still-generic `ctx.getLanAddresses()`, the same pattern
  `spotify-connect`/`youtube-music` already used for their own ports.
  `REMOTE_PORT`/`VIEWER_PORT` deliberately were NOT touched — `REMOTE_PORT`
  feeds `main-discovery-server.js`'s UDP auto-discovery broadcast
  unconditionally (a real core subsystem, not just a pass-through to one
  plugin), a materially different and larger blast radius than party's was.
- **Channel-flavor constants** (`HBO_CH`, `HSN_CH`, `AREA51_CH`, `GAME_CH`,
  `PPV_CH`, `SYNTH_CH`, `TELETEXT_CH`, plus already-dead `WEATHER_CH`/
  `AUX_CH`/`PARTY_CH`) removed from `state.js` entirely. `playback.js`'s
  channel-change static-burst tint used to keep its own hardcoded color copy
  per channel number (three of which had already silently drifted from the
  real plugin's own `badge.bg`) — now asks `getVirtualBadge(number)`
  (`virtual.js`, already existed for the guide-overlay logo, just not reused
  here before).

## Explicitly scoped OUT (judgment calls, not oversights)

- `browser-api-shim.js`'s per-plugin IPC method names (`spotifyStart`,
  `tmdbSearch`, etc.) — these must match `preload.js`'s real API surface
  exactly; renaming is a breaking API change, not a text/comment fix.
- `file.tmdb` as a data-schema field name on a channel's file objects —
  renaming touches the persisted `channels.json` schema for every existing
  user; same reasoning as above.
- `window.RCBPlugins.<pluginId>` direct exposure for genuine **plugin-to-plugin**
  calls (e.g. `party-jukebox` → `youtubeMusic`, `noaa-weather` →
  `getInterrupt('eas-alerts')`) — a plugin author's own choice to depend on
  another specific plugin (usually paired with `dependsOn`) is a different,
  legitimate category from core assuming a plugin exists. Only the
  **core-to-plugin** instances of this pattern were closed via
  `registerCoreHook`.
- The LAN viewer itself (`main-viewer-server.js`, serves the whole renderer
  bundle + config API) staying a core subsystem, not becoming an actual
  plugin — raised as a tangent mid-session, user immediately walked it back
  ("oh nvm, thinking of something else"). Not attempted.
- Fully genericizing `main-discovery-server.js`'s UDP broadcast (still
  advertises `remotePort`/`viewerPort` unconditionally) — same "REMOTE_PORT
  stays" reasoning above.

## Testing gotchas hit (again) during verification

- **`userData/plugins/` is a separate seeded copy that never auto-updates
  from repo source** — bit again mid-session (see
  [[retro_cable_box_cdp_autosave_gotcha]]'s existing note on this). A first
  test pass showed the new `registerCoreHook('draw-test-pattern', draw)`
  silently doing nothing (canvas stayed at its default 300×150 HTML size,
  never resized/painted) purely because `userData/plugins/smpte-test-pattern/renderer.js`
  was still the pre-edit copy — copying the updated `renderer.js` into
  `userData/plugins/` fixed it immediately, no actual code bug. A **planted
  probe hook** (`window.RCBPlugins.registerCoreHook('draw-test-pattern', () => {...})`
  called live via CDP) is a good technique for isolating "is the dispatch
  mechanism itself broken" from "is the specific plugin's own registration
  not taking effect" — used here to confirm `registerCoreHook`/`runCoreHooks`
  worked correctly before finding the real (test-setup) cause.
- **The user's real FOSS `userData/channels.json` had ~31 plugins disabled**
  (their own deliberate choice, matching the pattern already noted for the
  original app's real install). Needed several of those temporarily enabled
  to exercise the new hooks/features. Backed up the full file, made the
  minimal edit needed, tested, then restored byte-for-byte (verified via
  diff before deleting the backup) — never leave a user's real disabled-plugin
  list altered after a test session.
- `pluginsList()`'s `loadError: null` does NOT distinguish "loaded
  successfully" from "never attempted because disabled" — cross-reference
  against `config.plugins.disabled` (or `S.config.plugins.disabled` at
  runtime) before treating a clean `loadError` as proof a plugin actually
  ran.

## Verification performed

Real Electron + CDP (`playwright-core`, `chromium.connectOverCDP`) against
the actual FOSS install, not the LAN-viewer shim (per
[[retro_cable_box_real_ipc_testing]]) — confirmed: all 16 FOSS-shipped
plugins load with `loadError: null`; the test-pattern hook paints real pixels
(`rgba(192,192,192,255)` = `#c0c0c0`, the first SMPTE bar color) when tuning
to an unconfigured channel; `GET http://127.0.0.1:8724/api/viewer-live-link`
returns real party-server URLs end-to-end (party-channel's `main.js` →
`ctx.services.viewerLiveLinkUrls` → the generic endpoint); zero console
errors throughout. Core files (`main/`, `renderer/js/*.js`, `index.html`,
`setup.css`) confirmed byte-identical between both repos via `diff -rq`
after sync.

## Follow-up cleanup (same session)

- **Dead code + CSS sweep**: removed several genuinely-unused CSS classes
  (`.panel-field-group`, `.settings-section-header`, `.settings-subsection-header`,
  and old `.shortcuts-grid`/`.shortcuts-row`/`.shortcuts-key`/`.shortcuts-desc`
  superseded by `.help-shortcuts-grid`) and JS exports (`playKnobClick`,
  `withErrorAlert`, `pluginSettingsPanelIds`, `dom.js`'s orphaned
  `setupSaveStateEl`/`pinKeypadEl`) — all verified zero references anywhere
  before deleting. Also fixed several stale comments left over from this
  session's plugin migrations (`main/preload.js` had ~6 comments still
  saying "see main.js's X section" for features long since moved to
  `plugins/*/main.js`; `PLUGIN_DEVELOPMENT.md` in both repos was documenting
  `ctx.getPartyUrls`/`ctx.partyPort` as still-available when they'd been
  removed — genuinely wrong docs, not just stale wording).
- **Real bug found+fixed**: the setup screen briefly flashed on every boot
  before landing on the TV screen, even when going straight to TV (channels
  already configured). Root cause: `index.html`'s `#tv-screen` defaults to
  `class="screen hidden"` but `#setup-screen` was just `class="screen"` — no
  `hidden` by default — even though `app.js`'s `showSetupScreen()`/
  `showTvScreen()` both already assumed it started hidden (they explicitly
  `classList.remove('hidden')` to reveal it). Since `init()` `await`s
  `loadConfig()` before deciding which screen to show, setup-screen painted
  visible for that whole window on every single boot. Fixed by adding
  `hidden` to its default class list, matching `#tv-screen`'s convention.

## Related memories
[[retro_cable_box_plugin_system]] · [[retro_cable_box_foss_parity]] ·
[[retro_cable_box_plugin_sandboxing_phase2]] ·
[[retro_cable_box_cdp_autosave_gotcha]] · [[retro_cable_box_real_ipc_testing]]
