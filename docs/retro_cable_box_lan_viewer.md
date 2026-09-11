---
name: retro-cable-box-lan-viewer
description: "LAN viewer feature (Jellyfin-style multi-device watching) shipped 2026-08-07 — architecture, what it covers, known v1 gaps, and the Android TV client scaffold"
metadata: 
  node_type: memory
  type: project
  originSessionId: 1eb5e613-ce18-4203-8e1d-a0089629a12b
  modified: 2026-08-07T15:09:23.763Z
---

Shipped 2026-08-07: any device on the LAN (phone, tablet, another TV's
browser) can now watch the live simulated broadcast, full-fidelity (breaks,
bumpers, CRT overlay, EAS — not a bare video player), read-only, no auth
(same trust model as the existing phone remote).

**Architecture — read this before touching it.** A LAN "viewer" is not a
separate thin client; it's a second, independent instance of the exact same
`renderer/` bundle the Electron host runs. `main.js` gained a new server
(`startViewerServer`, `VIEWER_PORT = 8724`, bound `0.0.0.0`) that serves the
whole `renderer/` directory statically plus `/api/config` (JSON snapshot via
the existing `loadConfig()`) and `/media?p=<path>` (same `serveFile()` the
`app://` protocol already used, just reachable over the LAN port too). The
only thing that differs between the Electron host and a LAN browser tab is
how `window.api` gets defined: `preload.js` (Electron, unchanged) vs. a new
classic `<script>`, `renderer/js/browser-api-shim.js`, loaded in
`index.html` *before* the `type="module"` `app.js` script and gated on
`if (window.api) return;` — a complete no-op inside Electron, the real
implementation in a plain browser. It also sets `window.__isViewer = true`,
which `app.js`'s `init()` checks to force straight-to-TV-screen boot (no
setup-screen-on-empty-config flow) and skip `startSpotifyIfEnabled()`
(host-only child process), plus starts a 10s `/api/config` poll
(`startViewerConfigPolling`) so edits made on the host propagate to already-
open viewers.

**Why this shape and not a thin re-implementation:** the payoff is that
every existing feature (breaks/bumpers, block themes, VHS quality, time
machine, CRT effects) works identically on a viewer with zero duplicated
logic to drift out of sync — see [[retro-cable-box-architecture-constraints]]'s
"deterministic pure function of time" entry, which is exactly what makes
independent devices agree on "what's airing now" without any real
broadcast-sync protocol. Confirmed live during the build: a fresh viewer tab
independently resolved and landed mid-commercial-bumper, matching what a
second tab landed on for a different channel — genuinely independent, not
mirrored, each device its own "TV."

**Read-only enforcement:** `browser-api-shim.js`'s `saveConfig`/
`exportConfig`/`importConfig`/`selectFolder`/etc. are all no-ops (resolve
harmlessly) — a viewer can still open its own Setup screen and click around,
but nothing persists. `resolvePlayablePath` always reports
`alreadyFixed: true` so a broken file on a viewer shows the existing
PLAYBACK ERROR/OFF THE AIR card instead of attempting a transcode — transcode
stays strictly host-only since it does a backup-swap file dance on disk that
must never run from two processes at once.

**Known, deliberate v1 gap:** EAS tests aren't synchronized across devices —
host and every viewer each independently run their own `scheduleNextEas()`
random timer, so an EAS test's *content* is identical everywhere but its
*timing* isn't a simultaneous broadcast event the way real EAS is. True sync
would need the host to push its trigger to viewers over SSE/WebSocket — not
built, flagged as a clean follow-up if it matters later.

**Real bug caught and fixed during the build, not just a v1 simplification:**
`/api/config` calls `loadConfig()` (main.js) on every request — with viewers
polling every 10s, a genuinely corrupted `channels.json` would otherwise get
a fresh `.corrupt-<timestamp>` backup file written on every single poll
forever. Fixed with a module-level `corruptConfigBackupAttempted` flag so the
backup write happens at most once per process run regardless of how many
times `loadConfig()` gets called — the `_configLoadError` flag itself is
still returned accurately on every call, only the disk-write side effect is
deduped. Worth remembering: any function with a disk-write side effect that
gets exposed behind a *polled* HTTP endpoint needs this kind of dedup check
before shipping, even if the function was already safe as a one-shot boot
call.

**Real bug found via actual user testing on a phone, same session (2026-08-07): "video shows a frame but never advances" was a browser autoplay-policy block, not a broken stream.** `power.js`'s `applyMuteState()` sets `player.muted = !!S.config.muted` — on a host box that's normally unmuted, so a fresh viewer's very first `playChannelLive`/`player.play()` call was for an *unmuted* video with no preceding user gesture. Every browser blocks that entirely (not just the sound — the whole `.play()` call gets rejected), and `playChannelLive` already swallows the rejection (`.catch(() => {})`), so it failed completely silently: the element sat on its first decoded frame forever, looking exactly like "stuck"/"frozen," while my own verification only ever used same-machine Chromium (no autoplay restriction there) so it never caught this. Fixed with the standard muted-autoplay-then-unlock-on-gesture pattern: `applyMuteState` force-mutes whenever `window.__isViewer && !S.viewerAudioUnlocked`; `initViewerAudioUnlock()` (app.js) listens once for the first real `pointerdown`/`touchstart`/`keydown` — **must be a genuinely browser-trusted event, a JS-`dispatchEvent`-synthesized one does not count for unlocking autoplay** (confirmed live: touch-controls.js's swipe/tap handling and the Android wrapper's D-pad key injection both dispatch synthetic `KeyboardEvent`s for actual app control, which is fine for that, but neither can be the thing that unlocks audio) — then flips `S.viewerAudioUnlocked`, re-runs `applyMuteState()`, and nudges `player.play()` defensively. The Android TV wrapper (`MainActivity.kt`) sidesteps this differently and doesn't need the same fix: `WebSettings.mediaPlaybackRequiresUserGesture = false` is an Android-WebView-only escape hatch that bypasses the browser gesture requirement entirely — real browser tabs (phone/tablet/desktop) have no equivalent, so they need the mute-then-unlock dance.
**How to apply:** any future autoplay-dependent feature added to the viewer path must go through a real trusted gesture to unlock, never a synthetic one — check `S.viewerAudioUnlocked` (or add a similar flag) rather than assuming `player.play()` succeeding once means it'll keep succeeding on the *next* fresh element/src swap after a mute-state change.

**Touch support, same session:** `renderer/js/touch-controls.js` (new), feature-detected via `'ontouchstart' in window || navigator.maxTouchPoints > 0` (never user-agent/device sniffed) — a no-op on any non-touch LAN browser. Swipe up/down on the bare picture = channel change, swipe left/right = time-machine shuttle (harmless no-op unless already engaged), tap = toggle a small on-screen button bar (CH▲/CH▼/GUIDE/INFO/MUTE, auto-hides after 4s). Gesture detection is scoped to taps/swipes that *start* on `player`/`crtContainer`/`tvScreen` directly (`isBackgroundTarget`) so it never hijacks touches on real buttons/guide rows/setup controls, which already have their own click handlers. All control actions route through a real `window.dispatchEvent(new KeyboardEvent('keydown', ...))` (same technique as the Android wrapper) hitting the existing global `handleKey` listener — no new command surface, no circular import with `app.js` (which imports `initTouchControls` from here) since nothing is imported back.

**Landscape mode + fullscreen, same session:** `renderer/index.html` was missing a `<meta name="viewport">` tag entirely — a real oversight from the initial LAN-viewer build, only surfaced once actual mobile testing happened. Without it, a phone browser renders the page at a virtual desktop-width viewport and scales it down, breaking both portrait and landscape layout equally (nothing reflows at its true size). Added `width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover`. Once that was in place, the existing TV-screen layout (`#tv-screen`/`.crt`/`#player`, all percentage/flexbox-based, no fixed aspect-ratio container) turned out to already reflow correctly to a landscape-shaped viewport with zero further CSS work — confirmed via a resize test (812×375 viewport → the video area filled 812×316, full width). The touch control bar (above) gained a `⛶ FULL` button — reuses the existing `f` keyboard shortcut (`window.api.toggleFullscreen()`) rather than a new code path; `browser-api-shim.js`'s `toggleFullscreen` now also attempts `screen.orientation.lock('landscape')` right after a successful Fullscreen API grant (wrapped safely — unsupported entirely on iOS Safari, but the fluid layout still works fine there via plain physical rotation with no JS needed). Also added left/right `env(safe-area-inset-*)` padding to the touch bar (not just bottom) since a landscape phone's notch/pill sits on the long edge, not the bottom.

**Settings UI:** a new "WATCH ON OTHER DEVICES" panel (mirrors the existing
REMOTE CONTROL panel's pattern exactly — `renderViewerUrlStatus`,
`setup-settings.js`) lists every real LAN URL via `getViewerUrls()`
(main.js), reusing `getLanAddresses()`'s existing VPN/link-local adapter
filtering.

**Phase 2 — Android TV client (`android-tv-client/`, separate Gradle
project, not part of the Electron app):** a minimal WebView wrapper for
sideloading onto a Hisense Google TV — `MainActivity.kt` loads the viewer
URL (entered once via a first-run form, saved to SharedPreferences, Menu
button reopens the form to change it) and forwards D-pad presses as real
`KeyboardEvent`s injected via `webView.evaluateJavascript` (Android's native
WebView D-pad handling isn't reliable enough to depend on directly) — mapped
to the exact `.key` values `handleKey()` (`app.js`) already expects
(`ArrowUp`/`ArrowDown`/etc., `Enter`, digits), the same shape the existing
phone-remote's `onRemoteCommand` relay uses on the Electron side, just
produced via JS injection instead of IPC. **This was written without access
to an Android SDK/compiler in that session — it was never actually built or
run, only checked for XML well-formedness and hand-reviewed Kotlin syntax.**
Treat it as a solid first draft, not verified-working, until someone
actually runs a Gradle build. No Vizio equivalent exists or is planned —
SmartCast has no sideloading/browser path at all; Chromecast tab-casting
from another device is the only route there, and needs no app-side code.

**Android TV remote-mapping correction, same session, driven by a photo of the user's actual Hisense remote:** the first draft only mapped D-pad/OK/digits/Menu, on the assumption a Google TV remote has a keyboard-like button set. A real remote turned out to have no letter keys at all — just D-pad/OK, Back, Home, a dedicated **CH channel rocker** (previously completely unmapped — a real, confirmed gap, since it's the single most natural channel-surf button), VOL rocker + Mute, Play/Pause, a "123" numeric toggle (uncertain whether it delivers real digit keycodes or opens a system overlay — not relied upon), a Settings gear icon, and fixed streaming-app shortcut buttons the OS reserves for launching those apps directly. Fixed: `KeyEvent.KEYCODE_CHANNEL_UP`/`KEYCODE_CHANNEL_DOWN` now map to the same `ArrowUp`/`ArrowDown` as D-pad; `KEYCODE_MEDIA_PLAY_PAUSE` maps to `Enter`; `KEYCODE_SETTINGS` (the real, standard Android code a physical gear button sends — more reliable than guessing an unlabeled icon's vendor keycode) opens the app's own overlay screen, which now doubles as a small D-pad-navigable "TV menu" (`quick_actions_row` in `activity_main.xml`) with real focusable buttons for GUIDE/SETTINGS/INFO/MUTE — since those `handleKey()` (app.js) shortcuts are letter-key-bound and have no 1:1 physical button on a remote like this, and there aren't enough spare buttons to map one each. `KEYCODE_MENU` is kept as a fallback trigger for the same overlay in case a different remote's "..."/hamburger icon happens to send that instead.
**How to apply:** don't assume a Google TV remote has enough buttons for 1:1 shortcut mapping — check what buttons a real target remote actually has (ask for a photo if unsure) before mapping, and prefer standard documented Android KeyEvent codes (`KEYCODE_SETTINGS`, `KEYCODE_CHANNEL_UP/DOWN`, `KEYCODE_MEDIA_PLAY_PAUSE`) over guessing what an unlabeled icon sends. For any future keyboard-only shortcut, the on-screen "TV menu" pattern (real Android Views, D-pad-focusable, dispatching via `sendJsKey`) is the way to expose it to remote-only users rather than trying to find another physical button.

**Android TV client, real build confirmed working (2026-08-07):** the user actually got `app-debug.apk` to build in Android Studio after the Groovy-DSL fix (proof: `app/build/outputs/apk/debug/app-debug.apk` exists on disk) — this project genuinely compiles, not just statically reviewed. Later additions in the same session, all built on top of that working base: LAN auto-discovery (a tiny custom UDP broadcast/reply protocol on `DISCOVERY_PORT = 41234`, `main.js`'s `startDiscoveryServer` using bare `dgram` — deliberately not real mDNS/Bonjour, which would need a new dependency on both sides for a single-purpose tool; end-to-end tested live with a real UDP client script, confirmed exact reply shape `{magic, viewerPort, name}`), a branded connection-lost/auto-retry screen (`RetroCableBoxWebViewClient.onReceivedError`, main-frame-only), `onRenderProcessGone` crash recovery (full activity restart, not in-place WebView reconstruction — deliberately simpler), `onPause`/`onResume` pausing the WebView when backgrounded, a debounce on rapid-fire channel changes from a held remote button (`CHANNEL_DEBOUNCE_MS = 200`), D-pad focus-state styling (`tv_button_background.xml` + `tv_button_focus_anim.xml`, reused on every button and the host-address field), and a hand-drawn flat-vector retro-TV launcher icon/banner (antennas + screen + stand, no gradients — deliberately avoided vector-drawable gradient syntax to minimize uncompiled-code risk; the banner reuses the icon's exact path data unscaled inside a translating `<group>` rather than hand-recalculating coordinates for the wider 320x180 canvas).
**Why the UDP approach:** matches this project's established pattern (see the LAN viewer/remote server sections above) of preferring a small custom protocol over pulling in a new dependency for a single, personal-LAN-tool-scoped need.
**How to apply:** any new Android-side network feature should follow the same "plain `dgram`/`DatagramSocket`, no new dependency" pattern rather than reaching for mDNS/NSD libraries, unless a second real use case for real service discovery emerges.

**Hint-bar overflow bug + Android TV menu expansion (2026-08-07, real-device report on a 4K TV):** `.hint-bar` (`guide.css`) had `display:flex; gap:22px` with 14 (now 17) `<span>` items and no wrapping — on a narrower reported CSS viewport than a desktop window (confirmed via live testing at 960px and 1280px widths, standing in for whatever an actual TV's WebView reports regardless of the panel's real 4K resolution — Android density scaling means this is never a 1:1 pixel match anyway) the items overflowed past `#tv-screen`'s `overflow:hidden` and were silently clipped off-screen. Fixed with `flex-wrap:wrap` + `max-height:46px` (2-line cap). Separately, the user misread this as "D-pad won't let me select hint bar options" — those spans were never interactive, just a legend naming which *letter key* does what, and a letter-keyless remote can't reach most of them. Real fix: expanded the Android app's `quick_actions_row`/`quick_actions_row2` TV menu (reached via the Settings gear button) with 7 more buttons — VOL−/VOL+/CRT FX/PICTURE/ASPECT/SLEEP/POWER — covering everything the hint bar advertises except Fullscreen (excluded: the Android app is already always-fullscreen at the OS level, so the page's own Fullscreen API toggle has nothing to do there).

**Headless "server mode" (2026-08-07):** `--headless`/`--server` CLI flag (`HEADLESS` const, `main.js`) skips `registerAppProtocol()` + `createWindow()` entirely — every LAN-facing server (viewer :8724, remote :8721, discovery :41234, Spotify bridge/stream) still starts normally, so connected devices get 100% of normal functionality with zero host-side window. This worked with almost no new guarding needed: every existing `mainWindow` reference was already either null-checked (the remote `/command` handler, `spotifySend`, `second-instance`, `toggleFullscreen`) or only reachable via IPC calls a host renderer would make — which simply never happens in this mode. `window-all-closed` never fires with zero windows ever created, so the process runs until externally stopped (Ctrl+C / killed) — this is correct, not a bug, and doesn't need a Tray icon or other "keep alive" mechanism. Launched via `npm run server` or the new `run-server.bat` (kept simple — a real console window with clear status output and a `pause` on exit — deliberately not a system-tray-icon approach, since that would've needed a hand-crafted binary icon asset with no image-generation tool available to make one reliably). Verified end-to-end live: no window created (`MainWindowHandle: 0` on every electron.exe process), console prints the correct LAN URLs, and a real LAN client (Browser pane) successfully loaded config, tuned a channel, and resolved a real media URL — full functionality confirmed despite zero host UI.
**How to apply:** any future `mainWindow`-touching code must stay null-safe (it already all is) — headless mode isn't a separate code branch to keep in sync, it's just "don't call `createWindow()`," so this should stay low-maintenance as long as that discipline holds.

**Real interactive TV menu (2026-08-07), replacing the passive shortcuts legend:** the old `?`-triggered "REMOTE CONTROL REFERENCE" overlay (`shortcuts-overlay`) was just a static `<span>` legend — "press C for CRT effect" — exactly as unusable on a letter-keyless remote as the hint bar's own text, and the user correctly kept pushing back on this ("d pad wont let me select hint bar options", twice). New `renderer/js/tv-menu.js`: the same overlay element now hosts a real focusable `<button>` grid (`.tv-menu-grid`, 4 columns, `GRID_COLUMNS` const) built from an `actions()` array — each button calls the actual underlying function directly (`changeChannel`, `toggleMute`, `cyclePictureMode`, etc. — no synthetic-key indirection needed since this runs in-page) and closes the menu on activation. `handleTvMenuKey` (app.js's `shortcutsOverlayEl`-visible branch now calls this instead of just closing on any key) implements real 2D grid navigation by hand — arrow keys move `document.activeElement` by ±1/±`GRID_COLUMNS` index math, since plain Tab focus order has no "up/down" concept for a grid. `:focus-visible` styling is free — already global/app-wide (tokens.css) since a past audit. Verified live via real dispatched arrow-key events: opening focuses the first button, Right+Right+Down correctly landed on index 6, Enter activated that button's real action and closed the menu, zero errors. This is a genuine, if partial, answer to the user's separate "genuinely different interaction model for TV" ask (their explicit answer when asked to disambiguate scope) — a real action grid rather than a re-skinned keyboard-shortcut list — but is NOT a full redesign (e.g. no grid-first channel browser); flag that gap explicitly if asked to continue this thread.

**Android app's own embedded phone-remote server (2026-08-07):** `android-tv-client/app/src/main/java/com/retrocablebox/tvclient/RemoteServer.kt` (new) — a hand-rolled HTTP server (raw `ServerSocket`/`Socket`, no library; Android's core lib excludes `com.sun.net.httpserver` unlike a desktop JRE) on port 8725, serving `assets/remote/*` (verbatim copies of the Electron app's own `remote/index.html`/`remote.js`/`style.css` — those already fetch `/command`/`/state` as same-origin relative paths, so zero changes were needed to reuse them). `POST /command` calls back into `MainActivity`'s `sendJsKey(key, shift)` (now takes an optional shift param, threaded through into the dispatched `KeyboardEvent`'s `shiftKey`); `GET /state` serves `latestState`, kept current via a new `@JavascriptInterface` bridge (`window.AndroidRemoteBridge.reportState(json)`) that `browser-api-shim.js`'s `sendRemoteState` now forwards into whenever that bridge exists (never true outside this specific Android WebView, so a no-op everywhere else, including the Electron host and phone/desktop LAN viewers) — reuses the *existing* `tuneToChannel` call site in `playback.js` with zero changes needed there. The TV menu screen (`setup_overlay`) shows this device's own LAN IP (`getLanAddresses()`, a Kotlin port of the same NetworkInterface-enumeration idea `main.js`'s own `getLanAddresses` already uses) so the user knows what URL to open on their phone. **Unverified — could not compile/run any of this session's Android/Kotlin work**, same caveat as the rest of `android-tv-client/`; reviewed carefully by hand (brace/paren balance, every `R.id.`/`R.string.` reference cross-checked against what's actually defined in the layout/strings XML) but genuinely untested until a real build.

**How to apply:** any future change to `app.js`'s boot sequence, `index.html`'s
script tags, or `preload.js`'s `window.api` surface must keep
`browser-api-shim.js` in sync (same method names/shapes) or a LAN viewer
will throw on whatever new method was added without a matching shim entry —
there's no automated check for this today, it's a manual parity requirement.
