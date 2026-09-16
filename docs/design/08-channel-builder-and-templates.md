# 08 — Channel builder and templates

Status: proposed (P4). Depends on: C2 `diffSchedules` (02), C3 batches (05), C6 queries (07).
Consumed by: 01 (TV first run), 06, 10.

## 1. Problem

Recreating a real network block — Saturday morning cartoons, 25 Days of Christmas, a Friday
movie premiere, TGIF — takes blocks, calendar days, presets, flows, pool entries, a logo and a
theme, built across a dozen screens. The block presets menu (`+ ADD BLOCK ▾`) and auto-curate
profiles help with pieces. There is no way to get a whole channel from an intent, and no way
to share one.

## 2. Two front doors, one engine

```mermaid
flowchart LR
  I1["Describe it<br/>'90s cartoons Saturday 7–11, sitcoms weeknights 8–10'"] --> PL
  I2["Pick a template<br/>'1998 Kids Network'"] --> PL
  I3["Channel package import<br/>(existing)"] --> PL
  PL["Plan<br/>= ordered command batch (05)<br/>+ unresolved slots"] --> RS["Resolve slots<br/>against library (07)"]
  RS --> PV["Preview<br/>ON AIR week via diffSchedules (02)"]
  PV -->|Apply| AP["dispatch.batch → one undo step"]
  PV -->|Adjust| RS
```

Everything becomes a **plan**: a list of commands with *slots* that refer to content by intent
(`{ slot: 'cartoons', query: { genre: 'cartoon', era: '1990s' } }`) rather than by path.
Resolving binds slots to library queries or folders; preview renders the result; apply dispatches
one batch. Channel package import (`renderer/js/library/channel-package.js`) becomes a plan source too, getting the
same preview.

## 3. Templates

### 3.1 Format
```jsonc
{
  "templateVersion": 1,
  "id": "kids-network-1998",
  "name": "1998 Kids Network",
  "era": "1998",                             // optional link to 10
  "slots": {
    "cartoons": { "label": "Classic cartoons", "match": { "genre": ["cartoon"], "era": ["1980s", "1990s"] }, "min": 20 },
    "live":     { "label": "Live-action kids shows", "match": { "genre": ["kids"], "kind": "episode" } },
    "bumpers":  { "label": "Network bumpers", "match": { "kind": ["bumper"] }, "optional": true }
  },
  "channel": { "name": "Kids Network", "identity": { "theme": "analog-90s" }, "rating": "TV-Y7" },
  "programming": [
    { "block": { "days": [6], "hours": [7, 11], "play": { "slot": "cartoons" } } },
    { "block": { "days": [1,2,3,4,5], "hours": [15, 18], "play": { "slot": "live" } } }
  ],
  "breaks": { "cadence": { "everyMinutes": 11 }, "pool": { "slot": "bumpers" } }
}
```
Templates contain **no paths and no media**. Slots are matched against the user's library (07).
They compile to today's commands (blocks, presets, pool tags), and would compile to rules if 02
step 3 ever happens.

### 3.2 Sources
- **Built-in** first-party templates (Saturday Morning, Christmas Countdown, Movie Night,
  Primetime Sitcoms, Late Night, Marathon).
- **Export from a channel** ("Save as template"): the exporter replaces concrete folders
  with slots inferred from tags/facets, and asks the user to name each slot.
- **Plugin-provided** templates via `ctx.templates.register`, shipped as data.
- **Files**: `.rerun-template.json` import/export. No online gallery in v1 (offline
  invariant); a later opt-in gallery plugin could add one.

### 3.3 Slot resolution UX
For each slot: best matching library query (item count, sample titles, total hours), with
alternatives (pick folder, pick series, loosen match). Unfilled required slots block apply;
optional slots can be skipped. "Too little content for a daily block" warnings come from the
plan's hours ÷ available duration.

## 4. Describe-a-channel

- **Parser, local-first**: a deterministic grammar for scheduling language covers the common
  cases offline — days ("weeknights", "Saturday mornings"), times ("7–11", "prime time" =
  20–23), date ranges ("December 1st to 25th"), content phrases matched to taxonomy terms and
  series names from the library ("cartoons", "90s sitcoms", "The Office"), break language
  ("ads every 10 minutes", "no commercials during movies").
- Output is a plan with slots, shown as editable **chips** ("Sat · 7–11 AM · cartoons · 1990s")
  so misunderstandings are fixed by editing chips, not rephrasing.
- **Optional LLM assist** as a plugin (explicit network exception, off by default) that turns
  free text into the same plan JSON, validated by the same schema. The core never depends on it.

## 5. Where it appears

- **Channels › Add** (03): Empty channel · From folder · From template · Describe it.
- **TV first run** (01 §6.5): "Start with a template" picks from built-ins using the device
  library or the handoff flow.
- **Web panel** (06): identical.
- **ON AIR** (02): "Save this week's structure as a template".

## 6. Acceptance criteria

- "Saturday morning cartoons 7 to 11, 90s sitcoms weeknights 8 to 10" builds a previewable
  channel offline in < 10 s on the installed library (once 07 tags exist).
- Applying a template is one undo step; undo leaves an empty `diffSchedules` against before.
- Round trip: save channel as template → apply on a copy of the library → same block
  structure.

## 7. Risks

- Tag coverage limits everything here; 07's tagging queue ships first and templates show
  "needs tagged content" guidance when slots match too little.
- Grammar scope creep: keep a published phrase list in the manual; everything else via chips.
