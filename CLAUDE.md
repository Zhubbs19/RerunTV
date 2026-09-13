# CLAUDE.md

Guidance for Claude Code (or any AI agent) working in this repository.

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
different timestamp. A channel file's `path` can now be a plain local path (unchanged) or a
`mediasource:<providerId>:<opaque-ref>` string routed to a plugin (`main/main-media-dispatch.js`,
`PLUGIN_DEVELOPMENT.md`'s `mediaSource` capability) — that abstraction lives entirely below
this layer (parsing/fetching a ref), so schedule.js's scheduling math never had to change to
support it.

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
`past`-dimming instead). A third, `schedule-query.js`'s per-day cache, keys on the channel
object plus the generation.

**Commands (`renderer/js/commands.js`, docs/design/05).** New edits should go through
`dispatch({ type: 'channel.set', channel, field, value })` (or another registered command)
rather than mutate-then-`saveConfigDebounced()`: a command applies in place, records its
inverse, bumps the generation, saves, and gives undo a readable label ("Rename CH 7"). Pass
`{ coalesce: key }` for typing/slider drags so a burst is one undo step. Unconverted call sites
still work: the burst since the last settle point becomes a `config.patch` structural diff
when its save fires. Undo history stores commands and inverses, not config snapshots, and undo
rewinds `S.config` **in place** (object identity survives). Don't store live config objects
inside a command payload that is kept in history — commands copy what they insert, and the
aliasing bug this prevents was real.

## Directory map

- `main/main.js` — app lifecycle, window creation, `ipcMain` registrations (grouped by
  `// ---------- Section ----------` divider comments — keep that convention when adding
  handlers).
- `main/main-*.js` — focused modules split out of `main.js`: config/backups (`main-config.js`,
  also where `backupUserDataForUpdate()`/`restoreUserDataIfWiped()` protect the portable
  userData folder across an auto-update install), plugin discovery/loading (`main-plugins.js`),
  plugin capability-checking (`main-plugin-capabilities.js`), isolated-plugin process
  management (`main-plugin-isolation.js`), LAN servers (`main-viewer-server.js`,
  `main-discovery-server.js`) plus their shared pairing/session auth (`main-lan-security.js`)
  and viewer-config redaction (`main-viewer-projection.js`), media/transcode (`main-media.js`),
  the local-vs-plugin media-ref dispatch layer (`main-media-dispatch.js`), auto-update via
  electron-updater (`main-updater.js`, plus pure history/version-transition helpers in
  `main-updater-state.js`), bounded/redacted logging for the support-bundle export
  (`main-diagnostics.js`), and pure config-summary/diffing for diagnostics (`config-diff.js`).
  Each has a header comment explaining its scope.
- `renderer/js/` — one file per concern (`playback.js`, `schedule.js`, `interstitials.js`,
  `guide.js`, `timemachine.js`, `power.js`, the `setup-*.js` files for the Channel Setup
  screen). `state.js` holds the single shared `S` object; `util.js` holds small pure helpers
  used across files (`formatClock`, `autoHideAfter`, `isEnabledByDefault`, etc.) — check there
  before writing a new one-off helper. Recent additions worth knowing about:
  `plugin-settings-schema.js`/`setup-plugin-settings.js` (the declarative plugin-settings
  contract and the PLUGINS-tab renderer that composes core + plugin sections, isolating one
  broken section from the rest of the tab), `update-notice.js`/`update-progress.js` (the
  update-ready toast and the separate `update-progress.html` window), `library-sync.js`/
  `library-sync-core.js`/`library-relink.js` (opt-in folder resync and the channel-health
  relink workflow), `channel-package.js` (portable single-channel export/import), and
  `api-contract.js` (the canonical `window.api` surface list that `test/contracts.test.js`
  used to check the sandboxed preload against — see the test-suite note below).
- `plugins/<id>/` — each plugin is self-contained: `manifest.json`, optional `style.css`,
  `renderer.js` (ES module, dynamic-imported from `app://plugins/`), optional `main.js`
  (main-process code), optional `settings.js` (manifest's `"settings"` field) for a plugin's
  PLUGINS-tab settings UI — kept separate from `renderer.js` so channel-render logic and
  settings-panel logic don't have to share a file; every first-party plugin now uses this
  split. Plugins cannot `import` core JS or each other's files directly (different origins) —
  shared core helpers are exposed via `window.RCBPlugins.ctx` (`renderer/js/plugins.js`'s
  `installGlobalApi()`). If two plugins need the same logic, expose it through `ctx` rather
  than duplicating it or having one plugin depend on another.
- `PLUGIN_DEVELOPMENT.md` — the plugin author's guide; keep it in sync with `ctx`'s actual
  shape when you add/remove something from `installGlobalApi()`.

## Working conventions

- **No sandboxed test suite, but this specific dev machine can actually run the real app.**
  Most sandboxes have no display and no `node_modules`, so the old default here was "verify
  syntax with `node --check <file>` and say UI changes are unverified." On Zhubbs19's own
  Windows dev machine, though, `node_modules` is installed and there's a real display — `electron
  . --remote-debugging-port=9222` launches an actual window with a working CDP endpoint (Electron
  supports `Page.captureScreenshot`/`Runtime.evaluate`/`Input.*`, but NOT the `Browser.*`
  window-management methods — no `Browser.setWindowBounds`; to start maximized, pre-seed
  `<userData>/window-state.json` with `{"isMaximized":true}` before launch instead, since
  `main.js` reads that file itself). A from-scratch CDP-driven UI test suite (`test/`, tracked —
  see `test/README.md`) was built and verified working end-to-end this way — full tab/subtab
  screenshot sweep plus targeted functional checks via `Runtime.evaluate` calling real exported
  functions (`S.config` mutations, dynamic `import()` of renderer modules, computed-style
  assertions), not just DOM presence checks. Two hard-won lessons if you rebuild or extend it:
  (1) **`main-config.js`'s `portableUserDataDir()` hardcodes config to `<repo>/userData` and
  ignores Electron's `--user-data-dir` switch entirely** — that's the developer's real live
  channel library, so any automated run MUST back it up (rename it aside) before launching and
  restore it after, in a `finally`/try-finally that also runs on a crash. (2) **`Start-Process`
  against `electron.cmd` returns the `cmd.exe` wrapper's PID, not any real `electron.exe`
  process** — killing "the" PID from `Start-Process` does not reliably kill anything and leaves
  orphaned processes holding file locks on `userData` (this actually happened and stalled a
  cleanup mid-session); find and kill every `electron.exe` whose command line mentions the repo
  path instead (`Get-CimInstance Win32_Process`), and wait for them to actually exit before
  touching `userData` again. Don't assume this capability exists in a fresh/different
  environment — verify `node_modules` and a working CDP handshake before relying on it, and
  never run the test suite's `.mjs` directly without its `.ps1` safety wrapper. For "screenshot
  every theme visually with real data" specifically (not the synthetic-fixture suite above), use
  `test\theme-visual-sweep.ps1` (`-Theme <id>` for just one) — see `test/README.md`'s "Full-theme
  visual sweep" section for what it does and two more gotchas specific to using a **real**
  (non-fresh) `userData` copy: the startup update-check gate delays the real window by up to 12s
  when `config.updates.strategy === "startup-auto"` (poll for the page, don't grab it once), and
  setting `S.currentNumber` directly does not tune a channel — use `tuneToChannel()` from
  `playback.js`. Keep this whole sweep scoped and bounded (one pass, one script) rather than
  spawning multiple overlapping agents at it — that happened once, produced three redundant
  partial runs, and was slower overall than just running the script directly.
  `package.json`'s `"test"` script (`node --experimental-vm-modules --test test/*.test.js`)
  still references a `node:test`-based suite that existed during an earlier audit pass and was
  deliberately deleted (see prior note below) — that's unrelated to the `test/` folder above and
  still doesn't work; don't "fix" it by resurrecting old test files from git history without
  checking with the user first.
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

A second, larger pass followed (still on `master`, all after the audit above): auto-update via
electron-updater (background checks, a settings panel, a guided/silent install flow, and the
userData-preservation fix in `main-config.js` after a real update wiped a user's channel
lineup — see `main-updater.js`/`main-updater-state.js`); the media-source abstraction letting a
plugin supply channel content from somewhere other than local disk (`main-media-dispatch.js`,
the `mediaSource` plugin capability, `library-sync*.js`, `playback-recovery.js` for
provider-backed fetch/recovery); a plugin-settings split (every first-party plugin's UI moved
from `renderer.js` into its own `settings.js`, formalized by `plugin-settings-schema.js` and
composed by `setup-plugin-settings.js`); LAN hardening (`main-lan-security.js`'s per-service
pairing-code + session-cookie auth, `main-viewer-projection.js`'s config redaction for the LAN
viewer); several new plugins and theme packs; and a UI/UX polish pass across `setup.css`/
`tokens.css`/`overlays.css`. This pass also produced (and later removed) a `test/` suite,
`AGENTS.md`, and an `AUDIT_2026-08-24.md` — see the test-suite note above; check git history on
`master` rather than the working tree if you need that audit's original findings. As with the
first pass, no new invalidation scheme was invented for config-derived state — the
`S.configGeneration` counter above is still the one to extend.
