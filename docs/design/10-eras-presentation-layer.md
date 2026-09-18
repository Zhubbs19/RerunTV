# 10 — Eras as a presentation layer

Status: built (P5, 2026-09-16), v1 scope — see below. Depends on: C4 tokens (04), C3 (05), 08 templates (optional).
Owns contract **C7** (presentation overlay).

## Implementation status

`renderer/js/display/eras.js` is the pure data/logic layer: five built-in eras (1970s, 1980s,
1994, 2000s, 2016), each naming an existing `registerThemePack` id and values for `crtEnabled`,
the three main CRT intensity sliders, `displayMode.resolution`/`aspect`/`uiExtent`, and
`display.clock24` — the box-wide settings with one clean config path each that together answer
"what year is this box." `applyEra`/`clearEra` mutate `config.era` (touched fields, their
pre-era values, and which fields have since been hand-overridden) so a plain apply-then-clear
with no edits in between restores every value exactly, satisfying the doc's own acceptance test;
a hand-edit of one of those fields (via the normal settings.set command, `core/commands.js`'s
`noteEraOverride`) becomes a box-level exception that survives clearing. `renderer/js/setup/eras.js`
is the ERA panel (Guide & theme tab): era buttons, notes, and a per-field source list ("set by
era" / "box override" with a reset action) — the "every setting an era changes shows its source"
criterion is satisfied there rather than annotating each individual CRT/display-mode control
across two tabs. `renderer/js/tv/setup.js` adds an ERA value-item (Left/Right steps built-ins)
as the first row of TV menu › Guide & Theme. `registerEra` is exposed to plugins via
`window.RCBPlugins` alongside `registerThemePack`.

**2026-09-17 correction:** channel-level "follow/pin era" was listed here as not built — wrong.
`renderer/js/setup/panels.js`'s `buildChannelIdentityPanel` (predates this doc, `3d0781d`) already
has a per-channel "THEME / ERA" select with an explicit "INHERIT BOX THEME" option that clears
`ch.broadcastIdentity.theme` back to following the box, plus a "CLEAR ALL IDENTITY OVERRIDES"
button — exactly the §4 "Follow era" toggle this doc asked for, for the one identity field that
exists. Nothing to build there.

**v1 scope decisions** (see doc §7's phase list): plugin era hints (Music Choice's ERA dial,
ticker/EAS style) and template/pool suggestions (phase 5) are not wired. Rating-bug era rules are
not a controlled field — the existing gate is per-channel (`ch.hideRatingBug`), not box-wide, and
doc 10's own accuracy-rules risk (§5, low-resolution TV-mode accessibility override) is not
built. Per-profile era preference (doc 09's `profile.state.era`, already reserved in the schema)
is not wired to this layer yet — a natural follow-up, not required by this doc's acceptance
criteria.

**Bug found during live validation:** the ERA panel's per-field "source" list only refreshed
when its own buttons were clicked — a hand-edit of an era-controlled setting elsewhere in setup
(e.g. toggling the CRT checkbox directly) changed `config.era.overrides` correctly but the panel
kept showing "set by era" until something else re-rendered it. Fixed by turning `state.js`'s
single-listener `onHistoryChange` into a proper multi-listener set (it was already effectively a
pub/sub with one subscriber) and having the ERA panel subscribe alongside the existing undo/redo
button listener.

Verification: `tests/eras.test.js` (unit, pure apply/clear/override logic, part of the 339/339
tracked suite) plus a live pass (`tests/ui/verify-doc10.mjs`, 11/11) against the real installed
lineup — applying/clearing an era, control resync, override tracking and reset, the TV menu's
Left/Right stepping. A full per-era × desktop/TV theme-contrast sweep (§8's third criterion) was
not re-run this session — each built-in era only points at an existing theme pack that already
passed doc 04's contrast sweep individually, and eras never define their own CSS, so the
remaining risk is narrow, but it hasn't been exercised directly.

## 1. Problem

"What year is this TV?" is spread across unrelated settings:
- theme packs (26);
- CRT intensity and theme CRT bias;
- display mode / simulated resolution and aspect;
- static style;
- rating-bug era rules;
- ticker, EAS and news-bulletin styles;
- screensaver variant;
- the Music Choice ERA dial;
- guide era fonts;
- sound profile.

Getting a coherent 1994 box means setting a dozen of these by hand, and switching back to
2006 means remembering them all.

## 2. Goal

Pick an **era** (a year or a named period) and the whole presentation stack follows, without
touching channels or programming, and switching is lossless.

## 3. What an era is

An era is data, not code:

```jsonc
{
  "id": "1994",
  "label": "1994 — Analog cable",
  "range": [1992, 1996],
  "presentation": {
    "theme": "prevue-guide-94",
    "crt": { "enabled": true, "scanlines": 70, "curvature": 45, "grain": 55 },
    "display": { "resolution": "sd-480", "aspect": "4:3", "uiExtent": "confined" },
    "static": "analog-snow",
    "ratingBug": "none",                 // TV parental guidelines arrived 1997
    "clock": "12h",
    "guide": { "slots": 3, "preview": "prevue-scroll" },
    "sounds": "analog-cable-box",
    "overlays": { "ticker": "crawl-cg", "eas": "eas-1994", "logoBug": "none" }
  },
  "plugins": { "music-choice-channel": { "era": "90s" } },
  "suggestions": { "templates": ["kids-network-1998"], "pool": { "facets.era": ["1990s"] } }
}
```

- **Built-in eras** ship with core as data referencing first-party theme packs; theme packs
  may declare `eras` they belong to; plugins may register eras (`ctx.eras.register`).
- `plugins` entries are *hints* each plugin interprets through its declarative settings
  schema; a plugin ignoring them is fine.

## 4. Contract C7 — resolution order

```
core defaults → box settings → era overlay → channel identity → profile overrides (09) → usage-mode density (01)
```

- Implemented as a resolver (`effectivePresentation(ch, client)`) generalizing today's
  `effectiveThemeId()` (`renderer/js/display/identity.js`). Every consumer (themes, power/CRT,
  display-mode, guide, overlays) reads effective values instead of raw config.
- **Box settings vs. era**: when an era is active, box presentation settings the era defines
  show as "Set by era 1994 — override" in setup (03). Overriding records a box-level
  exception; clearing the era leaves box settings exactly as they were.
- **Channel identity** still wins (a channel pinned to a theme keeps it), with a per-channel
  "Follow era" toggle that clears identity presentation fields.
- **Density** multiplies whatever the era chose, so TV mode stays readable even in a 480p era.

## 5. Accuracy rules

Eras are allowed to be opinionated, but visibly so:

- An **era notes** panel explains each choice ("No TV rating bug: the TV Parental Guidelines
  began January 1997").
- Settings that would reduce usability (very low simulated resolution in TV mode,
  captions style) show the era's value but keep an accessibility override that eras can't
  remove.
- **Programming suggestions** (templates, pool facets) are offered, never applied
  automatically; applying one goes through 08's preview.

## 6. UX

- **Guide & theme › Era** (03): a timeline strip 1970–2020 with snap points for built-in eras;
  live preview panel (guide + banner + picture) updates as you scrub.
- **TV mode** (01): TV menu › Guide & Theme › Era with Left/Right years and live preview behind
  the menu.
- **Per channel** (Channel › Look): "Era: follow box / pin to …" for channels that should
  always look like their network's heyday.
- Time-machine tie-in (off by default): "Shift era with the time machine" follows the scrubbed
  date's year when jumping far back. It's an easter egg, so it's clearly labelled.

## 7. Implementation phases

1. `effectivePresentation` resolver with current settings only (no behaviour change);
   consumers migrate to it.
2. Era data format + five built-in eras mapping existing theme packs; setup page.
3. Channel "follow/pin era"; era notes; override indicators in setup.
4. Plugin hints (Music Choice era, EAS style, ticker style); TV-mode era picker.
5. Template/pool suggestions (after 08).

## 8. Acceptance criteria

- Selecting "1994" then clearing it restores every previously set presentation value exactly
  (config diff empty).
- Every setting an era changes shows its source in setup.
- Theme sweep passes for each built-in era × desktop/TV density.

## 9. Risks

- Coupling many subsystems to one resolver; mitigated by migrating consumers one at a time
  behind phase 1 with zero behaviour change.
- Era packs becoming a second, conflicting theme system; eras reference themes, never define
  CSS.
