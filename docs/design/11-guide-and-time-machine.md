# 11 — Guide and time machine

Status: proposed (P2–P3; small, can start early). Depends on: C2 (02), C1 + actions (01),
C4 (04). Consumed by: 09 (record from guide).

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
  picture shrinking instead of rows.
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
