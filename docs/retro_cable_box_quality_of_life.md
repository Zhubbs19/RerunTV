---
name: retro-cable-box-quality-of-life
description: "Status of the usability/workflow (not content-feature) improvement track for RerunTV's setup screen and config handling — re-verified against the code 2026-09-11; this track now has nothing outstanding"
metadata: 
  node_type: memory
  type: project
  originSessionId: 8f600dc2-f21d-41df-ba0f-7e7172f83cb0
  modified: 2026-09-11T00:00:00.000Z
---

## Update (2026-08-21): the "deliberately deferred" QOL items are NOT deferred anymore
The 2026-08-17 overview memory said undo/redo, a command palette, setup keyboard-nav, and OS drag-and-drop were explicitly flagged as out-of-scope-for-that-batch and not built. That's stale — at some point after that they were all shipped:
- **Undo/redo**: `undoStack`/`redoStack`/`performUndo`/`performRedo`/`pushUndoSnapshot` in [state.js](../renderer/js/state.js), integrated into the debounced-save path via a `skipUndo` opt-out so incidental writes (e.g. last-channel-changed) don't spam undo steps.
- **Command palette**: [setup-command-palette.js](../renderer/js/setup-command-palette.js) — Ctrl+K, drives existing buttons/inputs via `.click()`/`.focus()` rather than duplicating their handlers, includes Undo/Redo entries.
- **Setup keyboard-nav**: [setup-keyboard.js](../renderer/js/setup-keyboard.js) — cuts across tab bars/channel rows/interstitial cards, wires undo/redo keys too.
- **OS drag-and-drop from Explorer**: [setup-dragdrop.js](../renderer/js/setup-dragdrop.js) — drop video files onto a channel row (appends to playlist) or the interstitials pool list (adds pool entries); deliberately files-only, not folders (folder scanning stays owned by the existing CHOOSE FOLDER flow).

**How to apply:** Don't trust the "deliberately deferred" framing in older overview/backlog memories without grepping the actual renderer/js files first — this file is the up-to-date source for this specific QOL track. If a future session is doing a pre-release/FOSS-sync audit, verify current code state before repeating old backlog items as if still open.

## Update (2026-09-11): the old "Still open" list was almost entirely shipped
Checked against the code, not carried forward on trust:
- **Closed-captioning toggle — DONE.** Not the fake/generic bar this file assumed was the
  only honest option: `plugins/closed-captions` reads real sidecar `.srt`/`.vtt` and embedded
  subtitle streams through the native `<track>` API, styled per theme. The "no real
  caption-file data model" premise is obsolete.
- **Orphan-reference validation — DONE.** The channel health check
  (`setup-channels-diagnostics.js`) reports orphaned ad presets, orphaned pool entries and
  dangling pool entries alongside missing files.
- **"Force this break now" QA button — PARTLY DONE, still worth finishing.** PREVIEW POOL
  (setup-interstitials.js) plays pool entries in sequence on the setup screen, and the flow
  builder's FORCE options control schedule-time placement. Neither fires a chosen
  interstitial into the *live* broadcast on demand. That last piece is small and is the one
  genuinely useful remainder — it now lives in [[retro-cable-box-feature-backlog]]'s Open
  list rather than here, since it is a broadcast action, not a setup-screen workflow.
- The tier-0 content ideas that were parked here have all been resolved one way or the
  other — see [[retro-cable-box-feature-backlog]], rewritten the same day.

## Still open on this track (2026-09-11)
Nothing outstanding. The setup screen has undo/redo, a command palette, keyboard nav,
OS drag-and-drop, bulk actions, backups with comparison and pinning, channel packages,
the Air Check console, cross-channel diagnostics, the overlay position editor, library
sync and the relink workflow. If a new workflow annoyance turns up, add it here rather than
to the content backlog — the two tracks stay separate on purpose (this one improves
*making a config*; that one improves *what airs*).

## Historical detail (2026-08-05 through 2026-08-09 sessions)
The original Tier 0-4 audit, channel-detail-view redesign, calendar UI (formatting + interactivity rounds), bulk actions, volume-layer rework, and the 2026-08-09 batch (bulk-tag/autocomplete, rotating backups, PREVIEW modal + quick-jump buttons, health check, SMPTE test pattern, episode countdown, interstitials/ad-preset card redesign, settings sub-tabs) are all shipped and verified — see git history / TODO-AUDIT.md for specifics if needed. Full narrative detail was pruned from this memory on 2026-08-21 to keep it current; the overview memory ([[retro-cable-box-overview]]) still has the play-by-play if wanted.

**Why:** worth recording that this track exists and is distinct from the content-feature backlog ([[retro-cable-box-feature-backlog]] improves *what airs*; this improves *making a config*) and from the spec-phase tracker ([[retro-cable-box-interstitials-spec-progress]]).

**How to apply:** When the user asks to continue QOL work or do a pre-release audit, start from "Still open" above, but grep the actual code first — this list has gone stale on exactly this point before.
