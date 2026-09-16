# 02 — Programming timeline

Status: step 1 shipped (`4eeff1b`); step 2 built (see §4.5); step 3 closed: rule stack built as a derived view (§5.2a), storage stays layered (decided §5.2b).
Depends on: C3 commands (05), C4 components (04). Owns contract **C2** (schedule query).
Consumed by: 06, 08, 09, 11.

## 1. Problem

What a channel airs is decided by up to seven layers:
1. the default folder;
2. blocks (day/time, or date range with daily/weekly modes);
3. calendar day overrides;
4. broadcast hours;
5. ad cadence (channel or global);
6. tagged-content presets;
7. show/ad flows (plus plugin interrupts on top).

Each layer has its own editor on a different tab, and until ON AIR nothing showed the combined
result except Air Check, one instant at a time. Users can't answer "what's on Friday at 8?"
or "why did this show air here?" without trial and error.

## 2. Plan in three steps

| Step | What | Data model change | Status |
|---|---|---|---|
| 1 | **ON AIR, read-only**: resolved week per channel, explain on click | none | ✅ `renderer/js/setup/onair.js` |
| 2 | **Editable timeline**: act on the resolved view; edits write existing blocks/overrides/presets via commands | none | ✅ §4.5 |
| 3 | **Single rule stack**: replace the layered model with one ordered list of rules | config schema migration (next free version, see 00 §5) | ✅ derived view (§5.2a); no migration, decided §5.2b |

## 3. Contract C2 — `renderer/js/core/schedule-query.js`

Extract the query side of ON AIR and Air Check into one pure module:

```js
queryDay(ch, dayStart)                    // { programs, breaks, offAir, ms } — cached on configGeneration
querySchedule(ch, from, to, opts)         // arbitrary window, stitched from days
explainAt(ch, t)                          // { source, block, position, commercials, reason, break, onAir }
diffSchedules(chBefore, chAfter, from, to)  // for previews of commands (steps 2, 07, 08)
```

Rules: no DOM; "now" is always a parameter (callers pass `viewNow()`); cache keys include
`S.configGeneration`; bounded caches. Consumers after extraction: ON AIR, Air Check, guide
(`getChannelSchedule` stays the primitive underneath), program search, reminders (09), DVR
scheduling (09), template/builder previews (08), web panel (06, runs in the browser client, so
no server-side port is needed).

**Built (Phase 1, first piece):** `renderer/js/core/schedule-query.js` with `startOfDay`,
`addDays`, `offAirRanges`, `queryDay`, `querySchedule`, `explainAt`, `diffSchedules`; unit tests
in `tests/schedule-query.test.js`. Moved onto it: ON AIR, Air Check (`explainAt`), and guide
program search. Findings while verifying against the real lineup:
- **Float noise.** The same airing's start differs by sub-millisecond amounts depending on
  which day it was computed from (fractional durations over long playlists). Stitching
  matches the same file within 1 ms at day junctions, and diff keys round to whole ms. Exact
  matching duplicated an airing at midnight on 7 of 14 real channels.
- **`getChannelSchedule` caps at 1000 entries per segment**, so the old 7-day program search
  silently stopped mid-week on short-clip channels (CH 5, 11, 420). Per-day queries don't hit
  it, and search now finds those later airings.
- **The guide stays on `getChannelSchedule`** for its 2–3 h windows. Moving it onto whole-day
  queries would compute a full day per channel on first open, which is slower than today's
  small windows and against the guide's one-frame budget. Revisit if the guide gains a
  multi-day view (11).

Cache keying: per channel **object** (WeakMap) + `configGeneration`, never `ch.number`, so a
proposed deep copy used by `diffSchedules` can't share or poison the live channel's days.

`diffSchedules` is the key new capability: it runs the query against a *proposed* channel
object (a deep clone with the command applied) and returns changed intervals. That powers
"this change will move 14 programs this week" confirmations everywhere.

## 4. Step 2 — editable timeline

### 4.1 Interactions (desktop mode)

| Gesture | Effect | Written as |
|---|---|---|
| Drag on empty track | Create a block for that span, pick a source folder/tag | `block.create` |
| Drag a block edge | Change start/end hour | `block.setHours` |
| Right-click / ⋯ on a program → "Only this day" | Day override for that date | `block.overrideDay` |
| ⋯ → "Replace with…" | Override that occurrence with a chosen file/folder | `block.overrideDay` |
| ⋯ → "Add break here" / "No breaks in this show" | Per-file breakpoints / exclude tag | `file.setBreakpoints` / `preset.exclude` |
| Drag a block's colour chip to another day | Copy block trigger to that weekday | `block.addDay` |
| Toggle "Signed off" range | Broadcast hours | `channel.setBroadcastHours` |
| Delete key on a selected block span | Remove block (confirm shows schedule diff) | `block.remove` |

Every edit shows an inline **impact preview** (via `diffSchedules`): changed programs are
outlined before commit; the confirm only appears when the change re-anchors content or touches
more than one week.

### 4.2 Resolution of ambiguity
The resolved view can show a program that several layers contributed to. Edits target the
**winning** layer by default, and the explanation panel lists all layers with their order
("Block *Saturday Cartoons* (priority 2) beat *Default lineup*"), each with "Edit this layer".
Priority changes are a drag in that list (`block.setPriority`).

### 4.3 TV mode
Read-only week with remote navigation (Left/Right across time, Up/Down across days, OK
explains, colour keys page weeks). Editing hands off to the web panel (01 §7).

### 4.4 Guardrails
- Anchoring: edits that change a source's file list or anchor show "Channel will re-anchor —
  what's on now will change" with the diff; the command is undoable (05).
- Performance: a drag previews against one day only; the full week re-resolves on drop.
- Plugins: flows and presets owned by plugins aren't editable here, only explained.

### 4.5 Built (step 2)

**Commands.** Named ones in `renderer/js/core/commands.js`, rather than reusing `item.*` on blocks:
- The undo label reads as the edit ("Set "Saturday Cartoons" to 7 AM–11 AM").
- Remote editors (06) get the names doc 05's catalogue already lists.
- `block.create` and `block.remove` are each other's inverse.
- `block.setHours`, `block.setDays`, `block.setPriority`, `block.overrideDay` and
  `channel.setBroadcastHours` each invert to themselves, and each sets a value, so applying one
  twice is harmless.
- `block.addDay` from the table above is `block.setDays` with the day added, because an append
  isn't safe to replay.
- Break edits are `file.set` plus `item.*` on presets, with their own labels.

**Preview plumbing** (`renderer/js/core/schedule-query.js`):
- `proposeEdit(config, channel, commands)` returns a proposed config and channel without
  touching live config. The channel is always a copy. The box-wide programming lists are copied
  only when a command edits them.
- `diffSchedules(…, { afterConfig })` resolves the proposal against that config.
- `resolveActiveCommercials`' memo moved from `ch.number` to a per-channel-object key. Before,
  a proposed copy read the live channel's cached ad policy.

**Explanation.** `explainLayers(ch, t)` lists every layer that matched at an instant, in the
order they're consulted, each marked `wins`, `outranked`, `skipped` or `passes`.
- The content layers are broadcast hours, blocks, the day override and the default lineup.
- The break layers are the ads switch, flows, presets, block ad overrides and the default
  cadence.
- The matching lists are the resolvers' own: `matchingFlows`, `matchingPresets` and
  `matchingAdBlocks` were extracted from `computeActiveCommercials`. So the winners agree with
  playback by construction, and a weekend-long unit test checks it.

**The timeline** (`renderer/js/setup/onair.js`, with the gesture-to-command logic in DOM-free
`renderer/js/timeline/edits.js`, `tests/timeline-edits.test.js`).
- **Merged, not added.** ON AIR is the editable timeline, and the hourly TIMELINE view is
  gone. SCHEDULE is now ON AIR · BLOCKS · CALENDAR.
  - TIMELINE drew the same dayOfWeek spans ON AIR's block lane now draws at real resolution.
  - BLOCKS stays as the every-field editor, and CALENDAR as the by-month view of date ranges.
- **Block lane.** Each day row has a lane above its programs showing which block owns each
  hour (`blockSpansForDay`, from `resolveActiveSource`). A matching block with no folder shows
  hatched.
  - A span's edge handle appears only where that edge is the block's own start or end hour,
    not where a higher block covers it.
- **Gestures, each one named command (one undo step):**
  - **Drag in an empty lane** opens the new-block editor for those whole hours (`block.create`).
    It picks a folder or tag from the library without scanning (`librarySources`), or browses
    for a folder. The new block gets one more than the priority of any time block overlapping
    that weekday. Date-range specials stay above it.
  - **Drag an edge** calls `block.setHours`. It previews that day live (programs only), then
    re-resolves the whole week on drop.
  - **Drag the colour chip** onto another day calls `block.setDays`.
  - **Click a span, then Delete** removes it. The confirm states the diff.
  - **The span menu** has *Change what it plays…* (re-anchors, so it confirms), *Also air on …*
    and *Stop airing on …*.
- **Program menu** (right-click, or CHANGE THIS AIRING ⋯ in the detail panel):
  - **Replace this airing with…** adds a one-day date-range block over the program's hours,
    above everything matching there. On a daily/weekly block, picking one of its own episodes
    sets that date's day override instead (`block.overrideDay`).
  - **Only this day** adds the same one-day block, copying the live source's files and anchor.
    So the programs don't change, and later edits to it touch only that date.
  - **Add a break here** edits the layer that decides the show's breaks. A set-points preset
    gains a point. A show on a timed cadence gets its own set-points preset, tagged to that
    file.
  - **No ad breaks in this show** adds a `no-breaks` file tag and a first-in-list preset with no
    break points.
  - Both break edits are disabled, with the reason as the item's tooltip, when a flow or a
    plugin-owned preset decides the show's breaks.
- **SIGN-OFF HOURS** (the toolbar button, or a click on a signed-off stretch) calls
  `channel.setBroadcastHours`, with a preview.
- **Impact preview.**
  - A bar above the grid and gold outlines on the grid show what an edit changes before it
    commits: live during drags, and in the editor as soon as a source is picked.
  - After commit they show what did change.
  - The bar never collapses, so it can't push the grid out from under a drag.
  - A confirm appears only for re-anchoring or a date range longer than a week
    (`guardrailsFor`).
- **Explanation.** Clicking a program lists `explainLayers` as WHAT AIRS and BREAKS. Each row
  has its role and a sentence, and **Edit this layer** jumps to the block, CONTENT, BREAKS,
  the preset or the flow.
  - Content block rows reorder by drag or ▲▼ (`block.setPriority`). `reorderCommands` changes
    as few priorities as possible.
  - A flow or preset carrying `pluginId` shows OWNED BY … and no edit button.
- **TV mode** (`html[data-mode="tv"]`) shows the same week read-only: no lane gestures, menus
  or edit buttons.
  - ◄► move between programs and ▲▼ between days at the same time of day. OK explains.
  - Red or CH− go to the previous week, green or CH+ to the next, with focus kept.
  - Desktop gets the same arrows, as grid-local roving focus. Global keyboard behaviour is
    unchanged.

**Verified live** (scratch `tests/ui/verify-timeline.mjs`, 1280×720, against a copy of the
installed config):
- Saturday 7–11 AM from a library folder took one drag, one pick and one click, with the
  preview outlined.
- Undoing every edit left the channel byte-for-byte identical, and `diffSchedules` was empty.
- The slowest real channel's week resolved in 210–213 ms across runs (CH 5, 1329 files).
- Drag previews took at most 1.8 ms a frame.
- 12 of 12 sampled program explanations matched `explainLayers` layer for layer.

Found while verifying:
- Stitching now folds a repeated airing anywhere in a window, not only at midnight.
  `getChannelSchedule` cuts a program at every source boundary, so a one-day copy of a source
  read as two changed programs.
- `block.create` on a channel with no blocks list drops that list again on undo, so undo is
  exact.
- A span's start-edge handle covered its colour chip.
- An "Only this day" copy changes the break pods' ad picks (they're seeded by block id), so its
  preview reports changed breaks but no changed programs.
- On the setup screen the Android client's native bridge still sends arrows only to the TV-screen
  keyboard handler, so the read-only week is reachable by injected key events (keyboard, TV
  browsers) but not by that bridge. Editing belongs on the desktop or the web panel (06).

**Found on the way.** Several BLOCKS editor controls changed config without recording a
command, so they saved only with a later edit and were never undoable. This had been true since
the initial commit. They now record one:
- the broadcast-hours toggle and its hours;
- the day buttons;
- the date-range dates;
- the THEME colours;
- "+ ADD DAY OVERRIDE".

## 5. Step 3 — the rule-stack question

### 5.1 Candidate model
```jsonc
"programming": {
  "rules": [
    { "id": "r1", "when": { "days": [6], "hours": [7, 11] }, "play": { "folder": "f-cartoons", "order": "rotate-weekly" }, "breaks": { "preset": "saturday" } },
    { "id": "r2", "when": { "dateRange": ["12-01", "12-25"], "hours": [18, 22] }, "play": { "tag": "christmas", "mode": "advent" } },
    { "id": "r0", "when": "always", "play": { "folder": "*" }, "breaks": { "cadence": 10 } }
  ],
  "signOff": { "hours": [2, 6] }
}
```
Top-down, first match wins, a rule may set only content or only breaks (the rest falls
through). Blocks, day overrides, broadcast hours, per-block ads and presets all map onto it.

### 5.2 Decision gate (after P2)
Migrate only if, after users have the editable timeline:
- support/usage shows people still can't predict results **because of layer interplay**
  (not because of missing features), or
- flows/presets need cross-layer conditions the current model can't express.

Otherwise keep the current model; the timeline already hides the layers.

### 5.2a Built (step 3a): the rule stack in memory, proven equivalent

Built with no config change. `renderer/js/core/programming-rules.js`:
- **`rulesFromLayers(ch, config)`** translates a channel's layers into `{ signOff, rules }` in the
  §5.1 shape. The order is: ads off, then flows that can apply to the channel, then presets that
  can apply, then blocks by priority (ties by position), then the default lineup and cadence.
  - Content and break rules keep their own relative orders, which is all first-match-per-kind
    resolution needs.
  - A block rule plays the block through renderer/js/core/schedule.js's `sourceFromBlock`, which was extracted
    from `resolveActiveSource`. So loop, daily/weekly runs, day overrides and finale behave
    identically, and the rules decide only order and `when`.
- **`rulesSource`, `rulesCommercials`, `rulesOnAir`** return the same shapes as
  `resolveActiveSource`, `resolveActiveCommercials` and `isWithinBroadcastHours`. Flow policies
  come from `flowCommercials`, extracted from `computeActiveCommercials`.
- **`compareRulesToLayers(ch, config, from, to)`** compares the two at every decision instant:
  - each hour start, half hour and last millisecond;
  - each day-override unlock minute;
  - ad policy for every distinct tag list an airing on the channel can carry.

Verification:
- **Unit tests** (`tests/programming-rules.test.js`):
  - `matchesWhen` agrees with `matchesTrigger` over 400 random triggers.
  - The translation order is pinned.
  - 60 random channels exercising every layer are equivalent for 60 days (over 100k checks).
  - Three deliberately planted translation bugs (reversed priority, the flow untagged rule,
    inverted sign-off hours) each fail the test.
- **The real lineup** (scratch `tests/ui/verify-rules-equivalence.mjs`, a copy of the installed
  config): all 14 channels are equivalent for 60 days, at 2–28 ms a channel.

**Evidence for the gate (§5.2) from that lineup.**
- No channel uses blocks, and none uses broadcast hours.
- Every rule beyond the default is ad policy:
  - three flows, each scoped to one channel;
  - one channel-scoped preset;
  - the ads switch off on two channels;
  - one box-wide tag preset (`movie_channel`) that appears in all 14 channels' rules.
- So the layer interplay this lineup has is entirely box-wide break policy. None of it is
  content layering.

### 5.2b The storage question step 3b has to settle

Flows and presets are box-wide lists with their own channel and tag scopes. A per-channel rule
list can hold them in three ways:
1. **Copy them into each channel's rules.** This is the pure §5.1 model, but the `movie_channel`
   preset becomes 14 copies that drift apart when one is edited.
2. **Hybrid.** Each channel's `programming.rules` owns content order, sign-off and block ad
   overrides, while box-wide flows and presets stay global. One `breaks: { boxWide: true }`
   rule marks where they apply, so shared policy keeps one home.
3. **Don't migrate storage.** Layers stay the saved form, and the rule stack is a derived view
   (as in 3a) for the timeline, explanation and remote editors. §5.2's "otherwise keep the
   current model" applies, and the evidence above supports it.

**Decided (2026-09-13): don't migrate storage (option 3).** Layers stay the saved form, and no
schema version is allocated.
- `renderer/js/core/programming-rules.js` stays as the derived view. `rulesFromLayers` gives any consumer (a
  remote editor in 06, template previews in 08) the one ordered list.
- `tests/programming-rules.test.js` keeps the two resolvers from drifting apart.
- Revisit only under §5.2's conditions. If a migration is ever reopened, §5.3 below still
  applies, and `compareRulesToLayers` is its abort check.

### 5.3 If migrating
- a `renderer/js/core/config-schema.js` migration (next free version), mechanically translating each layer into rules with
  preserved priority; `diffSchedules` over 60 days before/after must be empty for every
  channel, or the migration aborts for that channel and leaves it on the old model
  (both resolvers coexist during transition).
- Commands (05) are the compatibility layer: `block.*` commands translate to `rule.*`, so
  templates/builder (08) and remote editors keep working.
- Plugins: `ctx.schedule` read APIs keep their shape via C2.

## 6. Acceptance criteria

- Step 2: "Make Saturday 7–11 AM cartoons" in under 30 s from ON AIR, with impact preview;
  undo restores the previous week exactly (diff empty).
- ON AIR week resolves < 300 ms for the slowest real channel; drag preview < 50 ms per frame.
- Every program cell's explanation names every contributing layer.

## 7. Risks

- `breakEntriesInWindow` correctness underpins the view (a phantom-break bug was found and
  fixed while building step 1). Break enumeration gets its own unit tests in `tests/` against
  synthetic channels before step 2.
  **Done:** `tests/break-enumeration.test.js` checks it against a one-second brute-force scan
  of `resolveBreakAt` (nothing missed, nothing invented) over fixed cases and seeded random
  channels. It found two more bugs, both fixed in `renderer/js/core/interstitials.js`:
  - **Sign-off bumpers were never found.** The bumper ends at the broadcast-hours boundary,
    and only the boundary itself was a candidate, where the channel is already off the air.
    Live playback's break timer used the same candidates, so the bumper aired only if you
    tuned in during it. Its start is now a candidate too.
  - **A pod starting under a text-only station-ID bar was skipped.** Stepping over the bar
    skipped its whole contiguous run, and the pod was part of that run. Now only the bar's own
    window is skipped (this also fixes the time machine's jump-to-next-break there).
- The real installed lineup has no blocks at all today; step 2 must be exercised with
  scratch blocks in the throwaway userData, never the real config.
