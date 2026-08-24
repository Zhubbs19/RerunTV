# AGENTS.md

Guidance for Codex (or any AI agent) working in this repository.

## What this is

RerunTV is an Electron desktop app that simulates an old broadcast cable box. Channels are
folders from the user's own media library; the app never "restarts" a channel — it computes
what would be playing right now if that folder had been looping continuously since the
channel's anchor time, so tuning in mid-show works like real live TV. See `README.md` for
the user-facing feature list and `PLUGIN_DEVELOPMENT.md` for the plugin API.

Three processes: Electron **main** (`main/`, Node/Electron, single-threaded), the **renderer**
(`renderer/js/`, the on-screen "TV"), and optional **isolated plugin** processes
(`utilityProcess.fork()`, only for plugins whose manifest sets `"isolated": true`).

## The one invariant that matters most

Everything that reads "now" for schedule/playback purposes must go through `viewNow()`
(`renderer/js/state.js`), not `Date.now()` — it's time-machine-aware, so scrubbing
backward/forward in time and tuning in produce the correct schedule state with no separate
history to maintain. `Date.now()` is only correct for a short, closed list of deliberately
real-time exceptions (channel anchor timestamps, UI gesture timing, background scheduler
ticks) — each of those has a comment explaining why. When adding new schedule/playback code,
default to `viewNow()` and treat a bare `Date.now()` as a bug unless you can point to why it's
one of the exceptions.

Schedule resolution is a pure function of `(channel, timestamp)` — `resolveActiveSource`,
`computeSourcePosition`, `boundarySlot`, `resolveActiveCommercials`, `resolveBreakAt`
(`renderer/js/schedule.js`, `renderer/js/interstitials.js`). This is what makes the
time-machine possible: no separate playback log, just re-evaluating the same functions at a
different timestamp.

## Config mutation — read before caching anything

Config objects (channels, interstitial flows, blocks) are mutated **in place** throughout
the codebase — e.g. `setup-interstitials-flowbuilder.js` does `.steps.splice()` /
`.steps.push()` on the same object reference, and several `main.js` IPC handlers mutate a
`loadConfig()` result before calling `saveConfig()` with it. **Do not add reference-based
memoization of anything derived from config** without first keying it on real invalidation
— a stale cache here means a wrong schedule airing.

`S.configGeneration` (`renderer/js/state.js`) is that invalidation: a counter bumped by
`bumpConfigGeneration()` on every known write to `S.config` — in-place mutation via
`saveConfigDebounced()` (the funnel almost every setup-screen edit already goes through,
bumped synchronously before its debounce timer, not inside it) and wholesale replacement via
`resetUndoBaseline()`/`pushUndoSnapshot()`/undo/redo, plus three call sites in `app.js` that
reassign `S.config` outside that funnel (screen-switch refetch, LAN-viewer config poll) and
bump it directly. Any new mutation site that doesn't already flow through one of those funnels
needs its own explicit `bumpConfigGeneration()` call, or a config change through it will go
unnoticed by every cache keyed on the generation. Two caches now key on it:
`resolveActiveCommercials`'s memoization (`schedule.js`) and `guide.js`'s render-signature
fast path (skips the per-channel `getChannelSchedule()` sweep on the 30s guide tick when
config/window/filter/selection are all unchanged, just moving the live line and
`past`-dimming instead).

## Directory map

- `main/main.js` — app lifecycle, window creation, `ipcMain` registrations (grouped by
  `// ---------- Section ----------` divider comments — keep that convention when adding
  handlers).
- `main/main-*.js` — focused modules split out of `main.js`: config/backups (`main-config.js`),
  plugin discovery/loading (`main-plugins.js`), plugin capability-checking
  (`main-plugin-capabilities.js`), isolated-plugin process management
  (`main-plugin-isolation.js`), LAN servers (`main-viewer-server.js`,
  `main-discovery-server.js`), media/transcode (`main-media.js`), etc. Each has a header
  comment explaining its scope.
- `renderer/js/` — one file per concern (`playback.js`, `schedule.js`, `interstitials.js`,
  `guide.js`, `timemachine.js`, `power.js`, the `setup-*.js` files for the Channel Setup
  screen). `state.js` holds the single shared `S` object; `util.js` holds small pure helpers
  used across files (`formatClock`, `autoHideAfter`, `isEnabledByDefault`, etc.) — check there
  before writing a new one-off helper.
- `plugins/<id>/` — each plugin is self-contained: `manifest.json`, optional `style.css`,
  `renderer.js` (ES module, dynamic-imported from `app://plugins/`), optional `main.js`
  (main-process code). Plugins cannot `import` core JS or each other's files directly
  (different origins) — shared core helpers are exposed via `window.RCBPlugins.ctx`
  (`renderer/js/plugins.js`'s `installGlobalApi()`). If two plugins need the same logic,
  expose it through `ctx` rather than duplicating it or having one plugin depend on another.
- `PLUGIN_DEVELOPMENT.md` — the plugin author's guide; keep it in sync with `ctx`'s actual
  shape when you add/remove something from `installGlobalApi()`.

## Working conventions

- **No test suite and no way to run the Electron app in most sandboxes** (no display,
  `node_modules` often not installed). After every edit, verify syntax with
  `node --check <file>`. For anything UI-facing, say explicitly that it's unverified rather
  than claiming it works.
- Prefer editing existing files; keep helpers in their established home (`util.js` for
  renderer-wide helpers, a plugin's own file for plugin-local ones) rather than introducing a
  new shared module for a single use.
- The `Edit` tool's `replace_all` does plain substring matching, not word-boundary regex — a
  blind rename of a short identifier (`p`, `cc`, `sd`) can corrupt unrelated words or other
  scopes reusing the same name. Check `\b<name>\b` occurrences and scope renames per-function
  before using `replace_all`, or do it by hand.
- This app has no separate "staging" environment — `master` is deployed as-is. Commit with
  descriptive messages; only commit/push when asked.

## Recent work (context for future sessions)

An extensive audit-and-fix pass (see git log on `master`) covered, in order: security fixes
(path traversal, missing timeouts, unbounded request bodies), a broken feature, stale docs,
main.js/main-plugins.js decomposition into focused modules, general polish, a round of
performance fixes (async I/O instead of blocking calls, caching, bounded queues/caches,
debouncing), and a readability pass (naming, dense conditionals, comment trims, small
dedup). Two items — a `resolveActiveCommercials` memoization and a `guide.js` DOM-diffing
fast path — were deferred twice for the config-mutation reason above before finally landing,
gated on the `S.configGeneration` counter described there. Any future cache derived from
config must key on that same counter (or extend it) rather than inventing its own
invalidation story.
