---
name: retro-cable-box-android-companion-remote
description: "Native Android companion remote app (android-remote-client/) replacing the phone-web remote as the primary target, shipped 2026-08-09"
metadata: 
  node_type: memory
  type: project
  originSessionId: adc140dd-fdcc-4bee-890d-a17e5bd007a8
  modified: 2026-08-09T23:39:27.987Z
---

> **Stale as of 2026-09-12.** The native-Kotlin UI described below was
> later replaced by a thin WebView shell around the page the desktop
> companion-app plugin serves, so Android and a phone browser show the
> same UI and a desktop update needs no new APK. `ApiClient.kt`, the
> native client this note describes, has been deleted. See
> `COMPANION_APP_AUDIT_2026-09-11.md` Part 2.

Built a native Kotlin Android app (`android-remote-client/`) as a companion remote, alongside (not replacing) the existing phone-web remote (`remote/`) — see [[retro_cable_box_universal_remote]]. User explicitly chose "native Kotlin app" over a WebView wrapper when asked, and selected all four settings-scope options offered (quick-access channels, playback/display toggles, basic remote, full config editor), so v1 scope was deliberately broad.

**Why:** user wanted one-tap buttons for specific channels at gatherings (a "party channel" or "public access" style channel) plus broader on-app settings control — the existing phone-web remote only does digit-entry channel surfing, no direct jump and no settings surface at all.

**What shipped:**
- New channel schema field `quickAccess: boolean` ([channels.js](../../../../VSCodeProjects/retro-cable-box/renderer/js/channels.js)) — same pattern as the existing `favorite` field. Editable both from the desktop channel editor (setup-channels.js, "REMOTE QUICK-TAP" checkbox) and from the phone app's CHANNELS tab.
- `main.js`'s existing remote-control server (port 8721) gained three routes: `POST /tune {number}` (direct jump, bypasses the digit-entry buffer), `GET /channels` (reads channel list straight off disk via `loadConfig()`, same staleness tradeoff as the LAN viewer's `GET /api/config`), `POST /channel/flag {number, field, value}` (relayed through IPC to the renderer so it goes through the normal debounced-autosave path, not a direct disk write — avoids the renderer's in-memory config clobbering an out-of-band write on its next save).
- `GET /state` extended from `{number, name}` to also include `powered, muted, volume, crt, pictureMode, aspectMode` — pushed via a new `pushRemoteState()` in [power.js](../../../../VSCodeProjects/retro-cable-box/renderer/js/power.js), called from every toggle function (toggleMute, adjustVolume, toggleCrt, cyclePictureMode, cycleAspectMode, powerOn/powerOff) plus `tuneToChannel` (playback.js).
- The UDP LAN-discovery protocol (`startDiscoveryServer`, main.js) — originally built just for the Android TV client's viewer-port discovery — now also replies with `remotePort`, reused by the new app's `Discovery.kt`.
- The Android app itself: single Activity, 3 tabs built programmatically (no Fragments — judged overkill for this size): REMOTE (full button layout + quick-tap channel grid + mute/CRT switches + picture/aspect cycle buttons, polls `/state` every 2s), CHANNELS (every channel with FAVORITE/QUICK-TAP switches), SETTINGS (UDP auto-discovery or manual IP:port entry, persisted via SharedPreferences). Plain `HttpURLConnection` + `kotlinx-coroutines`, no OkHttp — judged not worth the dependency for a handful of tiny JSON calls. Gradle project cloned from `android-tv-client/`'s skeleton (wrapper, launcher icon vectors, dark+gold palette) for consistency.
- Verified end-to-end against the real running desktop app via curl against the live HTTP endpoints (not just code review) — confirmed `/channel/flag` persists to `channels.json` and `/tune` actually changes the on-screen channel — then reverted the test channel's flag and tuned-back before quitting, so no test artifacts were left in the real config. Confirmed via `gradlew assembleDebug` that the Android app compiles clean.

**Deliberately out of scope for v1** (despite "full config editor" being selected): editing interstitials, ad presets, blocks, display/audio settings, or anything beyond a channel's FAVORITE/QUICK-TAP flags. The "full config editor" was scoped down to channel-flag editing only — reasonable for a companion remote, not a port of the entire desktop setup UI. If the user wants more of the desktop setup surface on the phone, that's a distinct follow-up, not assumed-included here.

**How to apply:** when extending the phone remote further (renaming channels, editing blocks, etc. from the app), follow the same relay-through-IPC pattern for writes (never write channels.json directly from main.js while the renderer is running) and the same "read straight from disk via loadConfig()" pattern for reads. The Android app's UI is built with plain View/LinearLayout/GridLayout in Kotlin, not XML-per-screen — match that style rather than introducing Fragments/Compose partway through.
