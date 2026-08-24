# RerunTV

A desktop simulator of an old broadcast cable box. Point channels at folders in your own
media library, then surf channels like it's live TV — complete with CRT scanlines, screen
flicker, a channel-change static burst, and an early-2000s digital program guide.

**The signature feature:** channels are never "restarted." Each channel gets an anchor time
the moment you assign it, and whenever you tune in, the app calculates what *would* be
playing right now if that folder had been looping continuously since then — just like
flipping to a real channel mid-show. Nothing runs in the background; it's arithmetic
against the wall clock, so closing the app for a week costs nothing and the schedule is
still "correct" when you come back.

## About RerunTV

- **No bundled/auto-downloaded binaries.** The main project's ffmpeg comes from the
  `ffmpeg-static` npm package, which downloads a prebuilt GPL-3.0-licensed binary at
  install time. This build drops that dependency entirely — the `FFmpeg Transcode`
  plugin instead resolves a system-installed `ffmpeg` from PATH (or a custom path you
  set under DISPLAY & SYSTEM → FFMPEG). Install ffmpeg yourself
  ([ffmpeg.org](https://ffmpeg.org/download.html)) for codec-compatibility transcoding

## Requirements

- [Node.js](https://nodejs.org) v22.12 or newer (required to install Electron 43)
- Optional: [ffmpeg](https://ffmpeg.org/download.html) on your system PATH, for codec
  transcode

## Setup

```bash
npm install
npm start
```

On first launch you'll land on the **Channel Setup** screen.

1. Click **+ ADD CHANNEL** for each channel you want.
2. Give it a number and a name (e.g. `07` / "CARTOON CHANNEL"). Channels 1 and 2 are
   reserved for the built-in virtual channels.
3. Click **CHOOSE FOLDER** and pick a folder from your media library. The app scans it
   recursively and reads each file's duration — this takes a moment on large folders.
   Click **+ ADD FOLDER** to merge in more folders on the same channel — everything
   plays from one combined loop. Open **FOLDERS (N)** to see what's assigned and
   remove one.
4. Repeat as desired, then click **START WATCHING**.

Setup is saved to Electron's app-data folder. Press **S** any time to go back.

### Headless / server mode

```bash
npm run server
```

Runs with no window on this machine — useful for running RerunTV on a headless box. Only
LAN services explicitly enabled in the saved config bind to the network, and clients must
open a host-issued pairing link before receiving controls, schedule data, or media.

## Controls

| Key | Action |
|---|---|
| `↑` `↓` / PgUp PgDn | Change channel |
| `0`–`9` | Type a channel number directly (auto-tunes after ~1.4s) |
| `Enter` | Confirm number entry, or show the guide banner |
| `G` | Open/close the full time-grid guide |
| `/` | Filter channels (inside the guide) |
| `I` | Show program details for the current channel |
| `S` | Back to Channel Setup |
| `M` | Mute / unmute |
| `SHIFT` + `M` | Cycle SAP audio mode (stereo / mono / SAP) |
| `+` `−` | Volume up / down |
| `C` | Toggle CRT effects |
| `V` | Cycle picture mode (standard / vivid / cinema) |
| `A` | Cycle aspect mode (contain / stretch / fill) |
| `Z` | Cycle the sleep timer (off / 30 / 60 / 90 / 120 min) |
| `F` | Fullscreen |
| `P` | Power off (any key wakes it) |
| `T` | Time machine — VCR shuttle mode |
| `L` | Return to live |
| `[` `]` | Jump to the previous/next commercial break (time machine only) |
| `B` | Trigger a breaking-news overlay on demand |
| `K` | Toggle closed captions |
| `SHIFT` + `↑`/`↓` | Jump between favorite channels |
| `BKSP` | Return to the last channel |
| `H` | Hide/show the hint bar |
| `?` | Open the TV menu |
| `CTRL` + `1`–`4` | Save the current channel to a quick-jump slot |
| `ALT` + `1`–`4` | Recall a quick-jump slot |

### Time machine

Enable it in **Box Settings** first. Press `T`, then `←`/`→` to rewind/fast-forward — tap
the same direction again to step up through ×60, ×300, ×1800, ×7200 (broadcast seconds per
real second). The picture scrubs like a tape under head-switching noise, and the readout
names the program you'd be landing on. `Enter` plays from there, `L` returns to live.

Easier for picking something specific: open the guide (`G`), select any program, press
`Enter` — it shifts time so that show starts from its beginning. With the time machine on,
the guide also scrolls backward into the past.

## Features

**Core, always available:**

- **Multi-folder channels** — merge several folders into one channel's loop; add/remove
  them independently without rescanning the rest
- **Time-grid guide** with half-hour columns, a live "now" line, channel icons, filtering
- **Channel icons** — assign an image per channel, or use the auto-colored number badge
- **Dayparting** — give a channel time blocks that swap in a different folder by hour
  (cartoons 6am–8pm, something else overnight); guide and playback both follow
- **Commercial breaks** — a box-wide default bumper folder and interval, overridable per channel
  (its own bumper folder, its own interval, or timed before/after each show instead of on a
  timer) and per schedule block (different ads for specific hours, or a block used purely to
  carve out an ad-free/ad-different stretch of the day without changing content)
- **Interactive Show & Ad Flow Builder** — a timeline canvas for scripting exactly when
  interstitials fire around a piece of content, with its own simulator
- **Up-next banner** ~45s before a program ends
- **Channel logo bug** in the corner, like a network watermark
- **Auto-curation** — tag content by facets (era, mood, rating, etc.), then let day-part
  templates and a scheduler assemble channel lineups from the pool automatically
- **AUTO display mode** — simulates an era-appropriate resolution/aspect ratio per file or
  per theme, with a curvature slider and CRT bias controls
- **Power & auto-standby** with a CRT collapse/warm-up animation
- **Synthesized sound effects** (channel click, volume tick, power thunk) — no audio files
- **Automatic codec repair** — files Chromium can't decode are transcoded to H.264 once via
  ffmpeg; the original moves to `_originals_backup/`, never deleted
- **Undo/redo, a command palette (Ctrl+K), full keyboard nav, and OS drag-and-drop** on
  the setup screen
- **18 theme packs** spanning six decades of TV/cable-box UI — from a 1978 wood-console
  set to a modern streaming-guide look — each with its own palette, SFX, and (where it
  fits the era) a physical border/bezel image; grouped by era in the theme picker

**Shipped as plugins** (install/remove from the **PLUGINS** tab — drop a folder in, or
install a `.zip` — or write your own, see [`PLUGIN_DEVELOPMENT.md`](PLUGIN_DEVELOPMENT.md)):

- **CH 0 — Video In**: shows a window/app running on this machine (KaraFun, PiKaraoke,
  anything) as a channel, like a real AUX input
- **CH 1 — Preview Guide**: branded header, live clock, and a scrolling now/next listing
  of every channel
- **CH 2 — Public Access**: a community bulletin board cycling text slides you write
- **CH 3 — Local Weather**: a synthetic forecast barker channel, or a real one via NOAA
- **CH 99 — Teletext Arcade**: a parody Ceefax-style teletext service, plus a playable
  Snake game
- **Closed captions** — sidecar `.srt`/`.vtt` or embedded subtitle streams, via the
  native `<track>` API, styled per-theme
- **Breaking news overlays** — random or on-demand, four visual styles, TTS readout
- **SMPTE test pattern** in place of a plain "no signal" card
- **Screensaver** — an idle-state overlay after a period of no interaction, themed per
  guide era
- **Ticker** — a bottom-of-screen scrolling text strip
- **Vintage audio texture** — ambient tape hiss/static/carrier hum tied to the active theme
- **Party Channel** — an opt-in, paired LAN guest page (photo/video bulletin, TTS announcements,
  soundboard, trivia, caption contest, vote-for-next, check-in wall, visual effects)
- **Universal Remote** — turns a paired phone on the same WiFi into a remote; also the API the
  Android companion app uses
- **TMDB metadata matching** for the TITLES tab (needs a free API key)
- **FFmpeg Transcode** — codec-compatibility fix-up (see "About RerunTV" above); resolves
  a system-installed `ffmpeg` from PATH or a custom path you set under DISPLAY & SYSTEM →
  FFMPEG

## Architecture

```
main/
  main.js                    Entry point: window creation, lifecycle, app:// protocol
  main-protocol.js           app:// scheme handler (HTTP Range support for media/plugins)
  main-plugins.js            Plugin discovery, install/enable, capability approval
  main-plugin-capabilities.js  Capability normalization + the checked spawn/http/fs
                                primitives shared by both plugin trust modes below
  main-plugin-isolation.js   Spawns an isolated plugin's main.js as its own OS process
  main-media.js              Folder scanning, codec-compatibility transcode
  main-config.js             channels.json load/save, backups
  main-lan.js                Local network address/port helpers
  main-discovery-server.js   LAN auto-discovery for the remote/viewer
  main-viewer-server.js      LAN viewer HTTP server
  main-connections.js        WATCH ON OTHER DEVICES connection tracking
  main-api-cache.js          Disk cache for third-party API responses (TMDB, NOAA, ...)
  main-window-ref.js         Shared BrowserWindow reference
  main-window-state.js       Remembers window size/position between launches
  main-http-util.js          Shared readJsonBody()/serveStaticFile() for the remote/party/
                              plugin HTTP servers
  main-mime.js               Extension -> Content-Type lookup, no Electron dependency
  main-path-safety.js        Shared path-containment/spawn-binary-name helpers
  rpc-channel.js             Request/response + event RPC used across the isolation boundary
  plugin-isolation-runtime.js  The entire contents of an isolated plugin's own forked OS
                                process — the counterpart to main-plugin-isolation.js, which
                                only covers the host side of that boundary
  preload.js                 contextBridge — exposes window.api.* to the renderer
plugins/
  <plugin-id>/manifest.json  id, category, capabilities, isolation
  <plugin-id>/main.js        optional — main-process half (IPC handlers, etc.)
  <plugin-id>/renderer.js    optional — renderer half (registers into core via
                             registerChannelType/registerThemePack/registerCoreHook/...)
  <plugin-id>/style.css      optional
renderer/
  index.html
  css/                       tokens · setup · tv · overlays · guide
  js/
    app.js                   Entry point: init, screen switching, keyboard map
    state.js                 Shared mutable state (S) + the viewNow() viewing clock
    dom.js                   Every element reference, resolved once
    plugins.js                     Plugin registry + the registerX() extension points
    channels.js, schedule.js       Channel lookup + the live-schedule/dayparting math
    playback.js                    Tuning, playback, commercials, up-next, logo bug
    interstitials.js               Deterministic commercial/interstitial-break resolver
                                    (resolveBreakAt) — the engine playback.js/guide.js/
                                    timemachine.js all read to decide what's airing when
    virtual.js                     Renders/tears down the currently-tuned plugin channel
    guide.js                       Now-playing banner and the time-grid guide
    themes.js, display-mode.js     Theme switching; AUTO resolution/aspect simulation
    timemachine.js                 VCR shuttle
    power.js                       Power, standby, volume, CRT state
    curation*.js, tagtaxonomy.js   Auto-curation engine (tagging, scheduler)
    setup*.js (family)             Setup screen: channel list, schedule/calendar,
                                    settings, interstitials + flow builder, plugins tab,
                                    tag taxonomy, command palette, keyboard nav, drag-drop
    tv-menu.js                     The D-pad-navigable action menu opened by `?`
    touch-controls.js              LAN-viewer touch input translation
    audio.js                       Shared AudioContext/SFX mix bus
    browser-api-shim.js            Browser fallback for window.api on the LAN viewer
    details.js                     Program-details overlay (`I` key)
    onboarding.js                  First-run welcome screen
    pin-lock.js                    PIN-lock parental control
    perf.js                        FPS counter
    util.js                        Title-cleanup/formatting/id-generation helpers
```

Core stays plugin-agnostic — nothing in `main/` or `renderer/js/` (outside `plugins.js`
itself) names a specific plugin. Every channel and on-screen feature registers itself
into core through `plugins.js`'s extension points (`registerChannelType`,
`registerThemePack`, `registerCoreHook`, `registerSettingsPanel`, `registerInterrupt`,
and a few more), so installing or removing a plugin folder is the entire surface area of
adding or dropping a feature.

The renderer is served over a custom `app://` scheme rather than `file://`, because
Chromium refuses to load ES modules from a `file://` origin. That choice cascades: a
non-`file://` page also can't load `file://` media, so video is streamed through the same
handler — which is why `serveFile` in `main/main-protocol.js` implements Range requests.
The schedule math seeks constantly, so partial requests are load-bearing, not optional.

No bundler and no build step; the modules load natively.

Every "what's airing" calculation reads the clock through `viewNow()` rather than
`Date.now()`, which is what makes the time machine possible — shifting one offset moves
playback, the guide, dayparting, and the on-screen clocks together. Channel anchors
deliberately keep using real time, since they record when a folder was scanned.

## Development

This project is built with [Claude Code](https://claude.com/claude-code), directed by a
single project owner — Claude writes the code, the project owner sets direction, makes the
product/architecture calls, and reviews and approves everything that ships.

Development happens primarily in the main app; features and fixes get ported to this FOSS
build as a deliberate sync pass, not automatically.

## Packaging

```bash
npm run pack    # unpacked build in dist/ (fast, for testing)
npm run dist    # installer (nsis / dmg / AppImage)
```

No ffmpeg binary is bundled or downloaded — see "About RerunTV" above.

Pre-built alpha installers (Windows) are published automatically as GitHub Releases from
the `deploy` branch — see the [Releases page](../../releases). **They're unsigned**, so
Windows SmartScreen and your browser will likely warn you before running one; that's
expected for a low-download-count unsigned executable, not a sign anything's wrong.
SmartScreen: "More info" → "Run anyway". Chrome's download bar: the dropdown arrow →
"Keep".

## Supported video formats

Best results with **.mp4 (H.264)** and **.webm**. `.mov` and `.m4v` are scanned too.
Anything Chromium can't decode is caught automatically and transcoded once — or use
**FIX PLAYBACK** on a channel row to convert a whole channel up front instead of
on-demand.
