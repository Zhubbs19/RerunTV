# 02 — Programming timeline

Status: step 1 shipped (`4eeff1b`); steps 2–3 proposed.
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
| 1 | **ON AIR, read-only**: resolved week per channel, explain on click | none | ✅ `renderer/js/setup-onair.js` |
| 2 | **Editable timeline**: act on the resolved view; edits write existing blocks/overrides/presets via commands | none | proposed (P2) |
| 3 | **Single rule stack**: replace the layered model with one ordered list of rules | config schema migration (next free version, see 00 §5) | **gated** — decide after step 2 |

## 3. Contract C2 — `schedule-query.js`

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

### 5.3 If migrating
- a `config-schema.js` migration (next free version), mechanically translating each layer into rules with
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
- The real installed lineup has no blocks at all today; step 2 must be exercised with
  scratch blocks in the throwaway userData, never the real config.
