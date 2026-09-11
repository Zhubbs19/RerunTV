---
name: retro-cable-box-plugin-sandboxing-phase2
description: "Phase 2 (real process-level plugin sandboxing) SHIPPED 2026-08-19 — all 10 target plugins converted to utilityProcess isolation, verified via real Electron+CDP across both repos"
metadata: 
  node_type: memory
  type: project
  originSessionId: 197079ed-3170-4dd9-aff2-1ac59526b030
  modified: 2026-08-19T11:40:55.831Z
---

## Status: SHIPPED (2026-08-19, same day as the Phase 1 handoff)

The user asked to complete all 10 plugins in one sitting, explicitly waiving
the "confirm scope before implementing beyond the first prototype" checkpoint
from the handoff. What was built:

## Core infrastructure (new files, both repos, byte-identical)
- **`main/rpc-channel.js`** — generic symmetric request/response + event
  channel (`createRpc(post, subscribe)`) used identically on both sides of
  the process boundary. No Electron dependency.
- **`main/plugin-isolation-runtime.js`** — the entire contents of an isolated
  plugin's forked process. Builds the isolated `ctx`, requires the plugin's
  real `main.js` from disk, calls `activate(ctx)`, reports back over
  `process.parentPort`.
- **`main/main-plugin-isolation.js`** — host-side broker. `activateIsolatedPlugin()`
  forks via `utilityProcess.fork()`, handshakes, wires every RPC handler,
  waits for activation. Owns cross-plugin registries (service providers,
  party-route registry, before-quit fanout).
- **`main/main-mime.js`** — `mimeFor`/`MIME_TYPES` extracted out of
  `main-protocol.js` (which needs `electron`) specifically so the isolated
  runtime can require it directly with zero Electron dependency.
- **`main/main-connections.js`** — added `recordConnection(serverName, ip,
  userAgent)`, split out of `trackConnection(serverName, req)` so an isolated
  plugin can relay the two plain fields instead of a live `req`.
- **`main/main-plugins.js`** — `loadMainPlugins()` is now `async`, loops
  `for...of` (was `.forEach`) and awaits each plugin strictly in dependency
  order — critical, since Phase 2's `ctx.services` is a **snapshot taken at
  fork time**, not a live shared reference, so the "publisher finishes before
  dependent reader starts" guarantee had to move from "same synchronous tick"
  to "this await resolved." A plugin's manifest `"isolated": true` branches
  to `activateIsolatedPlugin()` instead of `require()`.
- **`main.js`** boot sequence `await`s `loadMainPlugins()` now, calls
  `wireAppQuitPropagation()` once at boot.

## The ctx surface for an isolated plugin
Documented in full in **`PLUGIN_DEVELOPMENT.md`'s "Isolated plugins" section**
(both repos, adapted per repo's actual plugin set) — that's the reference,
not this memory. Summary of what changed vs. the same-process Phase 1 ctx:
- `ctx.ipcMain`/`ctx.fs`/`ctx.spawn`/`ctx.createServer` — same API, `fs`/
  `spawn`/`createServer` now run as REAL native Node calls inside the child
  (not a JS proxy into the host), scoped by real `--experimental-permission`
  flags (`--allow-fs-read`/`--allow-fs-write`/`--allow-child-process`,
  derived from the manifest's `capabilities` + `dataDir`) in addition to the
  same JS-level per-value check Phase 1 already had.
- `ctx.services.X` (plain value) — still works, but is a snapshot at fork
  time, not live. `dependsOn` ordering is what makes this safe; **party-channel
  needed a NEW `dependsOn: ["ffmpeg-transcode"]`** it never needed in Phase 1
  (same-process `ctx.services` was a live reference, so read-order never
  mattered there — it does now).
- `ctx.registerService(key, fn)` / `ctx.callService(key, ...args)` — NEW,
  solves the "function can't cross a process boundary as a value" problem
  flagged as unresolved in the original handoff. youtube-music publishes
  `youtubeSearch` this way; party-jukebox calls it this way. Host brokers the
  call whether the provider is same-process or isolated (checks
  `typeof pluginServices[key] === 'function'` first, falls back to the
  isolated-provider registry).
- `ctx.registerPartyRoute(method, pathname, handler)` /
  `ctx.dispatchPartyRoute(requestDescriptor)` — NEW, replaces the old
  `ctx.services.partyRoutes` array extension point entirely (that mechanism
  assumed same-process array mutation, which can't cross a boundary).
  `handler` became a pure function `async ({method,pathname,headers,body}) =>
  ({status,headers,body})` instead of writing directly to a live `res` —
  this is the hardest piece of the whole migration (party-channel's server
  and party-jukebox's route can now run in two entirely different OS
  processes) and it's the one verified most thoroughly (see below).
- `ctx.sendToMainWindow(channel, data)` replaces `getMainWindow()` +
  `mainWindow.webContents.send(...)` everywhere — no real `BrowserWindow`
  handle can cross the boundary, and the host-side implementation is already
  a safe no-op if the window is gone.
- `ctx.fetchJsonCached`/`ctx.loadConfig`/`ctx.trackConnection` — proxied to
  the host via RPC (host owns the shared api-cache.json / channels.json /
  connectedDevices Map — no reason to duplicate that per isolated process).
- `ctx.mimeFor`/`ctx.readJsonBody`/`ctx.getLanAddresses`/`ctx.getPartyUrls`/
  `ctx.getViewerUrls`/`ctx.busboy`/`ctx.QRCode` — run NATIVELY inside the
  child (all electron-free utilities/npm packages, no reason to RPC them).
- Not available at all: raw `require('electron')`, `getMainWindow()` itself.

## All 10 plugins converted, `"isolated": true` in every manifest
video-in, tmdb-metadata, noaa-weather, universal-remote, video-splicer,
ffmpeg-transcode, party-channel, spotify-connect, youtube-music, party-jukebox.
Per-plugin source diffs were small — most needed only the manifest flag plus
a `getMainWindow`→`sendToMainWindow` swap and `await`ing `loadConfig()`;
only party-channel/party-jukebox (the route-relay redesign) and youtube-music/
party-jukebox (`registerService`/`callService`) needed real logic changes.

## Verification (real Electron + real IPC, not the LAN-viewer shim)
Two full passes, both via `playwright-core` + `chromium.connectOverCDP`
against a genuinely booted Electron process (`--remote-debugging-port`):
1. **A throwaway full copy of the original repo** (source + a `node_modules`
   junction to avoid a slow copy, pre-seeded with an EMPTY `userData/` before
   first boot specifically to avoid triggering the OS-profile-migration
   logic against the user's real leftover `%APPDATA%/retro-cable-box` data —
   see [[retro_cable_box_cdp_autosave_gotcha]] for why this matters). Booted
   twice (approve capabilities → restart → verify), confirmed via
   `Get-CimInstance Win32_Process` that all 9 capability-declaring plugins
   ran as separate `--type=utility --utility-sub-type=node.mojom.NodeService`
   processes with exactly the `--allow-fs-read`/`--allow-fs-write`/
   `--allow-child-process` flags their own manifest capabilities implied.
   Functional round trips: tmdb/noaa graceful-error paths, universal-remote's
   LAN server (`loadConfig` RPC), party-channel's `/queue`, and — the key
   test — `GET :8726/jukebox` correctly relayed cross-process through
   party-channel's `dispatchPartyRoute` to party-jukebox's isolated process
   and back. `youtube:search` actually spawned a real `yt-dlp` (installed on
   this dev machine) from inside an isolated child under
   `--allow-child-process` and returned real results. Zero console errors,
   `loadError: null` for all 10 before AND after every round trip.
2. **The actual FOSS repo** (6 of the 10 plugins ship there — no
   spotify-connect/youtube-music/party-jukebox/video-splicer) — same
   approve→restart→verify cycle, identical results. The only anomaly
   (`ffmpeg-transcode` failing with "ffmpeg-static not installed") is a
   pre-existing FOSS dev-environment gap (missing npm devDependency),
   present in that repo's stderr since before any Phase 2 code ran — not
   caused by this work.

Both repos' `main/` and the 6 shared plugins' `main.js`/`manifest.json` are
byte-identical after sync (`diff -rq` clean) — parity rule intact.
`PLUGIN_DEVELOPMENT.md` updated in both repos with a full "Isolated plugins"
section (adapted per repo — FOSS's examples only reference plugins it
actually ships).

## What's genuinely NOT done / accepted tradeoffs
- **No live cross-process runtime updates to `ctx.services` values** — a
  value published after a dependent's snapshot was taken is invisible to
  that dependent until restart. Fine for every current publisher (all are
  set once, near boot, never change) — would need solving for a
  hypothetical future service whose value changes at runtime.
- **A narrow party-route registration race at boot** — forking is genuinely
  async now (unlike Phase 1's "everything finishes within one synchronous
  tick" guarantee), so a request arriving in the first few ms after
  party-channel's server starts listening could theoretically beat a
  still-forking party-jukebox's route registration and 404. Documented
  inline in party-channel/main.js's top comment; not solved (LAN-only guest
  page, nobody polls that fast in practice).
- **`--experimental-permission`'s fs-read scope is app-root-wide, not
  per-plugin-folder** — necessary so the child can resolve `node_modules`
  and require this app's own electron-free `main-*.js` utilities; broader
  than ideal but still meaningfully narrower than the pre-Phase-2 unrestricted
  filesystem access.
- Node's `--allow-child-process` is all-or-nothing (can't OS-scope to "may
  spawn ffmpeg but not anything else") — the existing JS-level per-binary
  check (ported into the isolated runtime too) is still what enforces that
  narrower rule; the OS flag only stops a plugin bypassing `ctx.spawn`
  entirely via a raw `require('child_process')`.

## Related memories
[[retro_cable_box_plugin_system]] · [[retro_cable_box_plugin_disable_bug]] ·
[[retro_cable_box_foss_parity]] · [[retro_cable_box_real_ipc_testing]] ·
[[retro_cable_box_cdp_autosave_gotcha]] · [[retro_cable_box_cdp_visible_window_gotcha]]
