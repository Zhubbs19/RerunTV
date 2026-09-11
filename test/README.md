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
you create while debugging with this suite. Don't add new files under `test/` to git
without checking they belong in the tracked harness, not the scratch pile.

## Running it

```powershell
powershell -ExecutionPolicy Bypass -File test\run-ui-tests.ps1
```

That's the only supported entry point. It:

1. Backs up the real `userData/` folder (see **Safety** below), pre-seeds a
   throwaway one with a maximized window state.
2. Launches Electron with CDP on port 9222.
3. Runs `run-ui-tests.mjs`, which drives the app and writes
   `screenshots/*.png` and `results.json`.
4. Kills every `electron.exe` process for this repo and restores the real
   `userData/` folder, even if the test script crashed.
5. Exits 0 on all-pass, non-zero otherwise.

Running `node test/run-ui-tests.mjs [port]` directly only works if something
else already has a matching Electron instance up with CDP enabled — normally
that's the `.ps1` script's job, not yours.

## Safety: why this needs a wrapper at all

`main-config.js`'s `portableUserDataDir()` hardcodes RerunTV's dev-mode
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
  fixture video, so `test/fixtures/` only has two tiny synthesized PNGs
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
powershell -ExecutionPolicy Bypass -File test\theme-visual-sweep.ps1
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

Output: `test/theme-sweep-screenshots/theme-<id>/*.png` (override with
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
  `(await import('app://bundle/renderer/js/playback-core.js')).tuneToChannel(number)`.
  (`playback.js` was split into `playback-core.js`/`playback-breaks.js`/
  `playback-broadcast-fx.js` — `tuneToChannel` now lives in `-core`.)
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
- `fixtures/` — tiny synthesized PNGs used as stand-ins for real media.
  Regenerate with `node test/fixtures/make-fixtures.js` if ever missing.
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
