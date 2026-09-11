---
name: retro-cable-box-hintbar-per-item-toggle
description: "Per-item hint-bar visibility toggles added 2026-08-17 (DISPLAY > INTERFACE) alongside a fix for cramped Breaking News headline textareas — both requested together, both shipped in one pass, synced to FOSS"
metadata: 
  node_type: memory
  type: project
  originSessionId: 86d9f1bd-c3a1-4f78-be0f-b3a872f80695
  modified: 2026-08-18T02:33:09.681Z
---

Two small fixes shipped together 2026-08-17, both user-requested in one message ("breaking news alert input boxes are unusually small, also allow users to toggle on/off parts of hint bar"):

**1. Breaking News headline textareas fixed** — see [[retro_cable_box_architecture_constraints]]'s `.panel-body` shrink-wrap CSS gotcha entry for the root cause and fix (`plugins/breaking-news/renderer.js`). Also surfaced [[retro_cable_box_cdp_autosave_gotcha]]'s 6th gotcha (editing a bundled plugin's repo source doesn't affect the already-seeded `userData/plugins/` copy — had to manually `cp` the fix in before it was testable).

**2. Per-item hint-bar visibility** — previously the only control was a single whole-bar `H`-key/checkbox toggle (`S.config.display.hintBar`); the 18-item bar itself was all-or-nothing. Added `S.config.display.hintBarHidden` (array of item keys, default `[]`) plus a new "HINT BAR ITEMS" panel (DISPLAY > INTERFACE tab) with one checkbox per hint. Implementation:
- Each `#hint-bar` `<span>` got a `data-hint-key` attribute (`channel`, `favorites`, `direct-entry`, `last`, `guide`, `setup`, `mute`, `volume`, `crt`, `picture-mode`, `aspect`, `sleep`, `fullscreen`, `power`, `time-machine`, `alert-test`, `news-alert`, `hide-hints`).
- `applyHintBarState()` (`power.js`) now also toggles each span's own `.hidden` class based on `hintBarHidden` membership, independent of the whole-bar toggle.
- The settings checklist (`renderHintBarItemsList()`, `setup-settings.js`) is built dynamically from `hintBarEl.children` rather than hand-duplicated — same "one source of truth" principle the HELP tab's shortcuts-grid clone already uses (`renderHelpTab()`, same file). A hint added to the bar in the future automatically gets a checkbox with zero extra wiring.
- Deliberately, hiding an item from the bar does **not** remove it from HELP > SHORTCUTS — that reference list clones all of `hintBarEl.children` unconditionally (hidden or not) since it documents what the app *can do*, not what's currently decluttered off-screen. Stated explicitly in the new panel's own `.panel-status` text so this isn't a surprise to the user.

Verified via CDP: 18 checkboxes render, toggling one hides only that span in the live hint bar (confirmed via `classList`/`getBoundingClientRect`, not just class presence), the config array updates correctly both directions, zero console errors. Config schema addition (`hintBarHidden: []`) is additive/migration-safe per [[retro_cable_box_workflow]]'s config-migration rule — confirmed the only diff introduced into the real config was that one new default field.

Both fixes synced to `retro-cable-box-foss` (diff-confirmed identical after copy, no separate FOSS CDP re-test needed per [[retro_cable_box_workflow]]'s "already-verified, byte-identical" shortcut).
