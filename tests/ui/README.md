# UI test suite

Drives the REAL app (not a mock) over the Chrome DevTools Protocol: launches
Electron with `--remote-debugging-port`, clicks through every top-level tab,
sub-tab, and per-channel edit tab, screenshots each, and runs targeted
functional checks for the dynamic-overlays / logo-motion / opacity /
CRT-overlay-guide-coverage / auto-update-theming features.

The harness itself (this file, `run-ui-tests.ps1`/`.mjs`, `theme-visual-sweep.ps1`/`.mjs`,
`lib/`, `fixtures/`) is tracked in git. Its *output* is not — `screenshots/`,
`theme-sweep-screenshots/`, `results.json`, and anything else a run produces stay
gitignored (see the repo's `.gitignore`), along with any ad-hoc scratch script or log
you create while debugging with this suite. Don't add new files under `tests/ui/` to git
without checking they belong in the tracked harness, not the scratch pile.

Note: the repo's `.gitignore` ignores every `*.mjs`, so a new harness `.mjs` file needs
`git add -f <file>` to be tracked (the existing tracked `.mjs` files were added that way).

## Running it

```powershell
powershell -ExecutionPolicy Bypass -File tests\ui\run-ui-tests.ps1 -UserDataSource "C:\Users\<you>\Apps\RerunTV\userData"
```

`-UserDataSource` points the run at an existing config to start from. Pass the
**installed app's** userData: a fresh, empty profile has no channels, no
installed plugins and no approved capabilities, so the sweep screenshots an
empty app and passes checks that real data would fail. The folder is copied
into the throwaway working copy and is never written to. Omit the flag only
when you specifically want to exercise genuine first-run behaviour.

Starting from a real config also means the post-update "WHAT'S NEW" modal
appears (the config carries an update history); the suite waits for that IPC
and dismisses it before the sweep, so don't be surprised to see that check.

That's the only supported entry point. It:

1. Backs up the real `userData/` folder (see **Safety** below), then creates a
   throwaway one - copied from `-UserDataSource` if given, otherwise empty -
   with a maximized window state.
2. Launches Electron with CDP on port 9222.
3. Runs `run-ui-tests.mjs`, which drives the app and writes
   `screenshots/*.png` and `results.json`.
4. Kills every `electron.exe` process for this repo and restores the real
   `userData/` folder, even if the test script crashed.
5. Exits 0 on all-pass, non-zero otherwise.

Running `node tests/ui/run-ui-tests.mjs [port]` directly only works if something
else already has a matching Electron instance up with CDP enabled — normally
that's the `.ps1` script's job, not yours.

### Running one targeted check instead of the full sweep

```powershell
powershell -ExecutionPolicy Bypass -File tests\ui\run-ui-tests.ps1 `
  -UserDataSource "C:\Users\<you>\Apps\RerunTV\userData" -Script my-check.mjs
```

`-Script` swaps in a different driver `.mjs` (resolved inside `tests/ui/`) against
the same launched app, so a single-feature check gets the userData backup and
process cleanup for free. Those drivers are scratch, not harness — leave them
untracked, same as the existing `verify-*.mjs` pile. The driver receives the
CDP port as its only argument and should exit non-zero on failure.

Add `-PreApprovePlugin <id>` (repeatable) when the plugin under test is new,
or its manifest's `capabilities` block changed at all — the `why` strings
included. An unapproved plugin's renderer still loads and registers its
channel, but its main-process half never activates, so every one of its IPC
handlers answers "No handler registered" and the run reads as a pile of
unrelated failures rather than one missing approval. It writes only into the
throwaway copy, through the same `lib/preapprove-plugin.js` the theme sweep
uses.

Wrap each logical check in its own try/catch rather than a single straight
line of `await`s: a busy renderer occasionally makes one `Runtime.evaluate`
fail with "Promise was collected", and an unguarded run throws away every
later result when that happens.

Put a timeout on every screenshot. `Page.captureScreenshot` sometimes never
answers on a busy renderer, and an unguarded `await` there stalls the whole
run indefinitely rather than failing — it stranded two runs of this suite
before `verify-recording.mjs` grew a `shot()` helper that races it against a
15s timer. A screenshot is a nicety; the assertions are the test, so skip a
slow one. If a run does hang, kill the DRIVER's node process rather than the
PowerShell wrapper: that lets the wrapper's own `finally` restore userData
and clean up Electron the normal way.

## Safety: why this needs a wrapper at all

`main/config/config.js`'s `portableUserDataDir()` hardcodes RerunTV's dev-mode
config location to `<repo>/userData` and ignores Electron's normal
`--user-data-dir` switch entirely (by design, for portable installs) — there
is no way to point a dev-mode launch at an isolated profile via a CLI flag.
That folder is your real, live channel library and settings.

`run-ui-tests.ps1` always moves `userData/` to `userData.test-backup/`
before launching, and moves it back in a `finally` block — including on a
crash or a killed script. If you ever see a `userData.test-backup/` folder
sitting in the repo root, the previous run didn't finish cleanly; the next
run auto-restores it before doing anything else, or you can rename it back
to `userData` by hand.

**Never run `run-ui-tests.mjs` (or any Electron launch with
`--remote-debugging-port`) directly against a live dev instance without this
wrapper** — the test script seeds a synthetic "UI TEST CHANNEL" into
`S.config.channels` and calls `saveConfig`, which would overwrite a real
channel lineup.

## What it can't test

- **Native OS dialogs** (`window.api.selectImage`/`selectVideo`, real file
  pickers) aren't reachable over CDP — they're OS-level modals, not page
  content. The suite stubs `window.api.selectImage`/`selectVideo` at the
  boundary to resolve a fixture path instead, so the UI flow around them
  (state update, thumbnail render, save) is still exercised for real; only
  the actual OS picker widget itself is untested.
- **Real video playback.** There's no ffmpeg in this environment to encode a
  fixture video, so `tests/ui/fixtures/` only has two tiny synthesized PNGs
  (`make-fixtures.js`). Video-logo/video-overlay support is verified at the
  branch-logic level (a `.mp4`-looking path renders a `<video>` element
  instead of `<img>`), not actual decode/playback.
- **The packaged auto-updater flow** (electron-updater needs a real
  published release and `app.isPackaged`, both unavailable in dev mode) —
  the auto-update popup's theming logic is checked indirectly by confirming
  `themes.js` resolves the right `--gold`/etc. CSS custom properties on
  theme switch, which is what that popup's IPC report is built from.

## Full-theme visual sweep (screenshot every screen, every theme, real data)

```powershell
powershell -ExecutionPolicy Bypass -File tests\ui\theme-visual-sweep.ps1
```

Same safety model as `run-ui-tests.ps1` (backs up the real `userData/`,
restores it in a `finally`, kills stray `electron.exe` processes by
command-line match) but works on a **full copy** of the real `userData/`
instead of a synthetic fixture — so real channel names, real local media
paths, and real guide data actually render, instead of "OFF THE AIR"
placeholders. The copy is what Electron launches against; the real
`userData/` on disk is never touched by the running app itself.

Add `-Theme <id>` (e.g. `-Theme cyberpunk-synth`) to sweep just one theme
for a quick check instead of all ~23 — useful when iterating on a single
theme's CSS.

Output: `tests/ui/theme-sweep-screenshots/theme-<id>/*.png` (override with
`--out=<path>`) — one subfolder per
theme, ~27 screens each (every top-level Setup tab/subtab, plus live TV and
guide-overlay views) — plus `report.json` (capture list + any per-theme
errors). A run across all themes takes roughly 15-20 minutes (real Electron
launch/navigation time × ~27 screens × ~23 themes) — budget for that; don't
assume it hung if it's still running after a few minutes.

**Known gotchas, already handled by the script — don't rediscover these:**
- A **real** (non-fresh) `userData/` means `main.js`'s startup update-check
  gate (`config.updates.strategy === "startup-auto"`) shows a separate
  "CHECKING FOR UPDATES" window first and delays the real renderer window
  by up to ~12s (network-timeout fallback) — a fresh/synthetic `userData/`
  skips this via the first-run flag, which is why `run-ui-tests.mjs`'s
  single immediate `context.pages()` grab doesn't need to account for it.
  `theme-visual-sweep.mjs` polls for the real page for up to 20s instead of
  grabbing once.
- **Never set `S.currentNumber` directly to "tune" a channel for a
  screenshot** — it doesn't invoke playback at all. Use
  `(await import('app://bundle/renderer/js/playback/core.js')).tuneToChannel(number)`.
  (`playback.js` was split into `renderer/js/playback/core.js`, `breaks.js`,
  and `broadcast-fx.js`; `tuneToChannel` now lives in `core.js`.)
- A `Start-Process`-launched `electron.cmd` gives you the `cmd.exe`
  wrapper's PID, not any real `electron.exe` PID — process cleanup finds
  every `electron.exe` whose command line contains the repo path instead
  (`Get-CimInstance Win32_Process`), same as `run-ui-tests.ps1`.
- One theme's runtime error must not abort the whole sweep — the per-theme
  loop in `theme-visual-sweep.mjs` is wrapped in try/catch, records the
  error into `report.json`, and moves on. (This is how the sweep itself
  caught a real bug: `theme-cyberpunk-synth/renderer.js` was missing the
  `const { playTone } = window.RCBPlugins.ctx;` top-level destructure every
  other theme pack has, so every channel change on that theme threw and
  silently ate the SFX — fixed once, not by this script, but the sweep is
  what surfaced it.)

## Files

- `run-ui-tests.ps1` — orchestrator; always use this, not the `.mjs` alone.
- `run-ui-tests.mjs` — the actual test steps.
- `theme-visual-sweep.ps1` / `theme-visual-sweep.mjs` — the full visual
  sweep above; same "always use the `.ps1`, never the `.mjs` directly"
  rule.
- `lib/cdp.mjs` — minimal CDP client (no npm deps; Node 22's built-in
  `fetch`/`WebSocket` are enough). Only implements the handful of domains
  this suite needs — not a general-purpose library.
- `lib/preapprove-plugin.js` — writes a plugin's current capability
  signature into a throwaway config, behind `theme-visual-sweep.ps1`'s and
  `run-ui-tests.ps1`'s `-PreApprovePlugin <id>`. Needed whenever a plugin manifest's
  `capabilities` block changed: any edit there (the `why` strings included)
  changes its approval signature, and an unapproved plugin is skipped at
  load, so a run without this silently tests a plugin that never activated.
  Only ever point it at a throwaway copy.
- `lib/dvd-fixture.js` — builds synthetic DVD structures for the tape deck's
  IFO parser: the index files, plus a real DVD-parameter MPEG-2 program
  stream via ffmpeg when a whole VIDEO_TS folder is wanted. Shared by
  `tests/dvd-ifo.test.js` (which runs in the `npm test` gate) and the
  end-to-end driver, so the byte layout is written down once. Read that
  test's header before trusting it: the fixtures are built to the same layout
  the parser reads, so they catch coding regressions and cannot catch a field
  being at the wrong offset in the real format. The deck covers that from the
  other side at runtime, by dropping a title's chapters when its IFO runtime
  disagrees with what ffmpeg actually decoded.
- `verify-embedded-art.js` — plain `node tests/ui/verify-embedded-art.js`, no
  Electron. Unit checks for the music-choice plugin's tag parser (ID3v2.2/
  2.3/2.4, FLAC, MP4) against hand-built tags, including malformed input
  that must return null rather than throw. Byte parsing is easy to regress
  and cheap to cover, so this is tracked rather than left as scratch.
- `fixtures/` — tiny synthesized PNGs used as stand-ins for real media.
  Regenerate with `node tests/ui/fixtures/make-fixtures.js` if ever missing.
- `screenshots/` — output, one PNG per step (plus `-scrolled` companions for
  any panel taller than the window — `#setup-screen` is an internal
  `overflow-y:auto` pane, not normal document flow, so a plain screenshot
  alone would miss anything below the fold).
- `results.json` — machine-readable pass/fail summary of the last run.

## Extending it

Each check is a `record(name, ok, detail)` call in `run-ui-tests.mjs` — grep
for existing ones as a template. Prefer asserting on real app state
(`S.config`, computed styles, element presence) over just "did a screenshot
get taken" — screenshots are for human/visual review, not the pass/fail
signal.
