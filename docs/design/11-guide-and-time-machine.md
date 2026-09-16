# 11 — Guide and time machine

Status: **built** — all four phases (§4) plus §2.2's TV docked picture shrink, verified live against
the real lineup (see "Verification"). Real-hardware acceptance on the Hisense is the only thing left,
and it is 01's to close. Depends on:
C2 (02), C1 + actions (01), C4 (04, kit built; theme migration in progress). Consumed by: 09 (record from guide).

### Built (§4 phase 1: specials, selection, layout)

- `renderer/js/guide/model.js` (DOM-free, `tests/guide-model.test.js`): `guideRows(channels, specials,
  { specialsAtTop, query })` is one ordered row list; a special channel is `{ kind: 'special' }` in its
  numeric place. Selection is `S.guideSelNumber` (replaces `S.guideSelRowIdx`); `selectedIndex` falls back
  to the first row, `moveSelection` wraps for ▲▼ and stops at the ends for CH± pages. `rowScrollTop`
  keeps the selected row whole: one row of margin docked (never a row cut at the top edge), centred on
  the full page.
- `renderer/js/guide/guide.js`: special rows are normal focusable rows with one full-width cell from `virtualChannelInfo`
  (Enter/OK tunes, ◀▶ do nothing). The render signature includes the row numbers; the 30 s fast path
  refreshes special `nowText` in place. `renderer/js/tv/input.js` pages with `pageGuideSelection`.
- Settings (Picture & Sound › Guide), all `settings.set` under `display`: **Special channels at the top**
  (`guideSpecialsAtTop`, default off) and **Channel names** (`guideChannelNames`: `full` wraps to two lines,
  `short` shows call letters — see phase 2).
- Docked height: `.guide-grid` is a CSS size container, so it can't grow to its content.
  `fitDockedGuideHeight()` measures the chrome and sets `--guide-docked-h` to chrome + `--guide-docked-rows`
  (5 desktop, 4 TV at a 64 px row) rows, which CSS clamps to 46–75% of the screen; re-measured on window
  resize. The docked info panel and search share one line. A fixed-height rows box was tried first and
  pushed the hint bar off-screen and broke window resizing.
- Names wrap to two lines (`-webkit-line-clamp`) in the `--guide-chan-col` rail.
- C4 (04) now supplies the kit: guide popovers use Menu and TV guide rows read
  `--target-min`. Guide-specific row markup remains in `renderer/js/guide/guide.js`;
  remaining theme-contract work is tracked in 04.
- Render cost unchanged: synchronous `renderGuideGrid` median 11.7 ms docked before, 11.8 ms after
  (25 rows, 1280×720, real lineup).
- TV-mode "picture shrinks instead of rows" (§2.2) is now built. `guide.js` publishes the strip's
  RESOLVED height (offsetHeight, after guide.css has clamped it) as `--guide-picture-h` on the CRT
  container; `power.js`'s `pictureAreaHeight()` feeds that to the EXISTING framing math in place of
  `crtContainer.clientHeight`. Doing it that way rather than with an `!important` geometry override
  (how full-page mode shrinks into its corner preview) is what keeps the bezel, the safe area and a
  named crop ratio all framing the smaller picture instead of the whole screen. `object-fit: contain`
  already letterboxes, so the aspect ratio is preserved by construction. Desktop is unchanged: the
  spec scopes this to TV mode, and desktop keeps the picture full-size behind the strip.

### Built (§4 phase 2: shorts & bumpers, break band, call letters)

- `renderer/js/guide/model.js` `mergeMicroPrograms(entries, minMs)`: runs of two or more back-to-back entries each
  shorter than `minMs` become one `{ kind: 'run', items }` cell; whole durations decide, so a long show cut
  at the window edge stays itself. `renderer/js/guide/guide.js` `microProgramMs()` turns the label-hiding width (guide.css
  `@container (max-width: 52px)`) into ms for the current window, measured once per render and part of the
  render signature; window resize re-renders.
- A run cell reads "SHORTS & BUMPERS (N)". OK/click opens a list over the grid (▲▼ move, OK tunes that
  entry — from its start with the time machine on — Back closes); ◀▶ step over a run as one cell, and I does
  nothing on it. Setting **Group shorts and bumpers** (`display.guideMergeShorts`, default on).
- Break display draws pods as a 5 px band under the programs (programs lift 9 px off it) instead of full-height
  hatched blocks; bands aren't selectable, click still jumps to the pod.
- `renderer/js/timeline/render.js` (tested): `BREAK_LABELS` (re-exported as `GUIDE_BREAK_LABELS`),
  `clampSpan`, `spanPercent`, `timeAtFraction`, `breakMarkClass`/`breakMarkEl`. ON AIR's break marks and the
  guide's band both use `breakMarkEl` and the shared `.tl-break-*` palette (guide.css); the scrubber will too.
- **Call letters** (user request, replacing a truncate option): `display.guideChannelNames: 'short'` shows
  `channelCallLetters(ch)` — a channel's own `callLetters` (new `channel.set` field, a 6-character box beside
  the name in the channel editor, placeholder = the automatic value) or `abbreviateChannelName`: initials for
  several words (The Movie Channel → TMC; a capitalised short word like WV keeps its letters), a word of 6
  letters or fewer as itself, longer words first letter + consonants (Nickelodeon → NCKLDN). Special rows use
  the automatic value. The full name stays in the cell's tooltip.
### Built (§4 phase 3: remote actions and hints)

- `renderer/js/remote/input.js` GUIDE table: hold OK → `guide.programActions` (was `key:i`; Info stays on the Info button),
  red/green → `guide.dayBack`/`guide.dayForward`; yellow/blue keep breaks/dock. `renderer/js/tv/input.js` runs them.
  Desktop keys are unchanged: `handleGuideGridKey` only differs while a guide popover is open, and popovers
  only open from the new TV action or a click/Enter on a merged shorts cell.
- **Program actions** (`renderer/js/guide/guide.js` `openGuideProgramActions`), a popover beside the cell sharing the shorts list's
  component (`openGuidePopover`): WATCH FROM START (first, when the time machine is enabled), INFO, plugin
  items, REMIND ME (future programs), GUIDE −24 HOURS / +24 HOURS (`shiftGuideDay`, which still can't go
  before the current slot without the time machine), TV MENU. A special row offers TUNE; a shorts cell OPEN
  LIST.
- New core hook `guide-program-actions` (`{ channel, entry, actions }`, documented in PLUGIN_DEVELOPMENT.md).
  The tape deck adds RECORD (tapes an airing or past program from the schedule now) or RECORD (SET TIMER)
  for a future one, written to its existing `scheduled` timers. Record from the guide without the plugin is doc 09.
- TV menu while the guide is open starts with FULL PAGE / DOCK GUIDE, SHOW / HIDE BREAKS and SEARCH GUIDE
  (focuses the filter box; on Google TV that should raise the system keyboard — unconfirmed on hardware).
- Guide hints: TV mode shows OK TUNE · HOLD OK: OPTIONS · CH ▲▼ PAGE · MENU: DOCK · BREAKS · SEARCH · BACK
  CLOSE. The RED/GREEN −/+ DAY hint has `data-hint-requires="colour"` and only appears once this device has
  sent a colour key (`OPTIONAL_KEY_GROUPS`, `html.remote-has-colour`, per session) — the Hisense remote has
  none, so it never shows there.
### Built (§4 phase 4: scrubber strip and Go to…)

- `renderer/js/timeline/scrubber.js` (DOM-free, `tests/scrubber-model.test.js`): `scrubWindow` (±3 h, re-centres
  within 30 min of an edge), `isFarJump`, `scrubStepMs` (10 s until 1.5 s held, 30 s until 3.5 s, 2 min until
  6 s, then program boundaries), `boundaryAfter`/`boundaryBefore` (a press within 2 s of a start goes to the
  previous one), `goToTargets` (yesterday same time, start of this show, this morning 6 AM, last Saturday 8 AM,
  in local time), `pickerTime`/`clampPicker` (±7 days).
- `renderer/js/playback/timemachine.js`: the VCR OSD becomes a bottom strip (`.vcr-osd.has-scrubber`, the theme's panel
  background) keeping its readout row, over a track from `querySchedule`: program segments, break ticks
  (`breakMarkEl`, shared palette), a gold cursor at the viewed time and a LIVE marker at `Date.now()`
  (commented exception). Segments rebuild only when the window, channel or `configGeneration` changes.
- Scrubbing is paused-and-positioned: `S.scrubPending`. `beginScrub` runs the same `pauseForScrubbing`
  resets as `startShuttle` (break state cleared, timers cancelled, player paused, tape FX); `stopShuttle`
  clears it, so `shuttlePlay`/`returnToLive` paths are unchanged. Enter and T commit a pending scrub like a
  shuttle. Preview seeks are throttled to 150 ms.
- TV mode (`renderer/js/remote/input.js` TIME_MACHINE): ◀▶ `scrub.back`/`scrub.forward` with hold acceleration from the
  key's repeat flag, ▲▼ `scrub.prevProgram`/`scrub.nextProgram`, OK plays, Back returns to live; Rewind/FF
  still shuttle and CH± still change channel. The global remote hint bar hides while the time machine is
  open; the strip has its own hints. Desktop keys unchanged (← → shuttle, [ ] breaks); the pointer can click
  or drag anywhere on the strip.
- TV menu: **TIME MACHINE ›** sits at row 2 column 1 (INFO moved one slot right) and opens a submenu — the
  Go to… targets, PICK DAY & HOUR… (◀ DAY / DAY ▶ / ◀ HOUR / HOUR ▶ keep the menu open, then GO TO …), OPEN/CLOSE
  TIME MACHINE, RETURN TO LIVE. Back pops a submenu level. With the time machine disabled in settings it
  stays the plain toggle. `timeMachineGoTo`: a target inside the strip window plays at once; a far one
  lands paused with a banner ("YESTERDAY SAME TIME · SUN SEP 13 12:29 AM — OK TO PLAY") and plays on OK.

### Verification (2026-09-14, installed app's lineup, 1280×720 unless noted)

- Unit tests: 129 pass (`npm test`).
- Scratch `tests/ui/verify-guide-rows.mjs`: every row, specials included, reachable with ▼ and never clipped —
  desktop and TV, docked and full, 1280×720 and 1920×1080, and while resizing 800×480–1920×1080; docked shows
  ≥ 5 rows desktop, ≥ 4 TV; selection survives a filter; Enter on a special tunes it; names ≤ 2 lines. Theme
  sweep: selected row never clipped in all 26 themes, docked and full.
- Scratch `tests/ui/verify-doc11.mjs` 34/34: strip, pointer click/drag + Enter, desktop ← still shuttles, shorts
  list, grouping off, break band, call letters, TV actions menu, colour-key hint, TV menu guide items, scrubber
  hold ramp (10 s → 30 s → 2 min → program start), ▲▼ program starts; actions menu and strip on screen in all
  26 themes (screenshots checked by eye for the light themes).
- **§5 press counts**, through both `RerunTVInput.native({ key })` and trusted key events in TV mode: start of
  the current show in **3** (◀, hold OK, OK — landed 3 s after the start, the time the presses took); yesterday
  same time in **5** (Play/Pause, ▼, OK, OK, OK — within 1 s).
- Guide render cost: synchronous rebuild median 11.8 ms (25 rows), same as before phase 1 (11.7 ms).
- Regression: full UI suite 36/36; `verify-timemachine-live-ui`, `-midshow` (12/12), `-real-keys` pass (the
  two scratch drivers still imported the removed `playback.js` and were pointed at `renderer/js/playback/core.js`);
  `verify-onair` and `verify-timeline` (38/38) pass.
- After a far Go to jump, a plugin-backed channel (CH 69) starts playing in 3.2–3.4 s against 2.3 s for a
  plain tune (the paused preview fetches first); local-file channels start in under 1 s.
- **Not verified:** the Hisense 50QD6030G and its remote. The acceptance counts were driven through the Android
  bridge entry point and injected keys on the desktop build; confirming them on the TV, the long-press OK
  timing from the real remote, and SEARCH GUIDE raising the Google TV keyboard is left to the user.
- TV-mode picture shrink (§2.2) verified live: `tests/ui/verify-docked-picture.mjs`, 15/15, 0 renderer
  runtime errors — the picture ends exactly at the strip (384 px of 384 available), shrinks rather than
  clipping, keeps its aspect ratio to within measurement error, clears the strip in **all 26 themes**,
  is re-fitted when the strip changes height, and gets the whole screen back on undock and on close.

## 1. Problems (from the 2026-09-12 audit and TV-remote constraints)

Guide
- **Special channels are pinned above real channels** (CH 00, 93 before 05) and are **not
  reachable with the arrow keys** (`renderGuideGrid`: "outside the arrow-key selection model").
  On the Hisense remote that makes them unreachable from the guide entirely.
- The docked guide shows about 4 rows and doesn't keep the selected row fully in view.
- Channel names truncate at ~117 px ("THE OFFICE C…").
- Very short programs (bumpers, shorts) crowd rows. Sliver cells now hide their labels
  (fixed `af25fe4`), but runs of them are still visual noise.
- Hints assume letter keys (`D DOCK / FULL PAGE`, `B SHOW BREAKS`).

Time machine
- Only a text OSD ("◀◀ REW ×5, SEP 12 7:42 PM (−0:05)") with no sense of where you are in
  the show, the day or the breaks. Moving far requires long shuttling or the prev/next-break
  keys, which have no button on the Hisense remote.

## 2. Guide changes

### 2.1 Channel model in the grid
- **One ordered list** (numeric order, favorites filter optional), special channels
  included in their numeric position, each a normal focusable row. Special channels render
  their row content from `registerChannelType`'s info (`virtualChannelInfo`) as a single
  full-width cell: "Search & Play", "Music Choice — 12 stations".
- Option "Specials at the top" keeps today's layout for users who like it, still focusable.

### 2.2 Layout
- **Selected row always fully visible**, scrolled with a one-row margin (docked) or
  centered (full page).
- **Docked height by mode**: desktop ≥ 5 rows; TV mode (01) ≥ 4 rows at 10-foot size, with the
  picture shrinking instead of rows. Built — see the Verification notes. The picture area is one
  published number feeding the bezel's own math, not a geometry override, so the frame follows the
  picture down.
- **Channel rail** name width from the `--guide-chan-col` token (already shared with the time
  header since `af25fe4`); names wrap to two lines before truncating.
- **Micro-program runs**: consecutive entries shorter than the label threshold merge into one
  cell "Shorts & bumpers (6)", expandable with OK / click into a small list. Pure presentation
  over `getChannelSchedule`.
- **Break display** (B / TV menu toggle) draws pods as a thin band under programs, like ON AIR
  (02), instead of overlapping blocks.

### 2.3 Actions (01)
| Action | Keyboard | Hisense remote (Minimal profile) |
|---|---|---|
| Open guide | G | D-pad ◀ from live TV, or TV menu › Guide |
| Move selection | arrows | D-pad |
| Page channels | PgUp/PgDn | CH ▲▼ |
| Tune / program actions | Enter | OK (tune) · long-press OK = this program's actions (Info, Record, Remind, Watch from start, TV menu) — per 01 §5.3 |
| Jump ±24 h | Shift+←/→ | colour keys if present; else in program actions menu |
| Dock / full page | D | guide-only item in the TV menu |
| Search | / | TV menu › Search (on-screen keyboard or "type on phone") |
| Close | Esc / G | Back |

Hints show only what the current remote delivers (01 §5.2).

## 3. Time machine redesign

### 3.1 Scrubber
While the time machine is on, a bottom **scrubber strip** replaces the text-only OSD:

```
 7:00 PM ─────────────[ It's A Wonderful Life 1946 ]──────────────── 10:30 PM
          ▮  ▮   ▮  ▮   ▮   ▮  ▮      ▲ 8:12 PM (−0:05)         LIVE ▶
          ads/bumpers              you are here
```

- A window of ±3 hours around the viewed time, built from `querySchedule` (C2), programs as
  segments, break pods as ticks, a LIVE marker at real now.
- **Left/Right** moves by 10 s → 30 s → 2 min → program boundary with hold acceleration;
  **Up/Down** jumps program boundaries (replacing `[`/`]` for remotes); **OK** commits
  (VCR "play"); **Back** returns to live.
- Program labels and the date stay visible; the existing VCR tracking effect still plays
  during shuttle.
- Desktop pointer: click/drag anywhere on the strip.

### 3.2 Beyond the window
- TV menu › Time Machine › "Go to…" offers Yesterday same time, Start of this show, This
  morning, Last Saturday 8 AM, and a day/hour picker. Far jumps land paused on a banner, then
  play on OK.
- The scrubber and ON AIR (02) share rendering helpers, so both look like the same timeline.

### 3.3 Invariants kept
- Still only `S.timeOffsetMs` + pure schedule; nothing recorded.
- State resets on entering/leaving shuttle as documented in the architecture constraints
  (break-tracking state cleared on shuttle start; resume paths call `playChannelLive`).

## 4. Implementation phases

1. Special channels focusable in numeric order; selected-row-in-view; name wrapping. (P2)
2. Micro-program merging; break band. (P2)
3. Action-based guide keys and remote-aware hints. (P3, after 01 Phase A)
4. Scrubber strip + boundary jumps; "Go to…" menu. (P3)

## 5. Acceptance criteria

- On the Hisense TV, every channel including specials is reachable in the guide with D-pad only.
- Selected row never partially clipped in docked or full mode (checked across all themes by
  the sweep).
- From live TV with the Hisense remote: start of the current show in ≤ 3 presses; yesterday
  same time in ≤ 5.
- Guide open stays within one frame of main-thread work for ≤ 30 channels (existing budget).

## 6. Risks

- Merged micro-program cells hide individual bumpers users may want to see. Mitigation:
  expandable cell, and a guide option to disable merging.
- Making special channels selectable changes arrow-key row indices that `S.guideSelRowIdx`
  consumers assume. Mitigation: select by channel number rather than index, migrated in
  phase 1.
