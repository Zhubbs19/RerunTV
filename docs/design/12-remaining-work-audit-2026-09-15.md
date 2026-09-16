# Design implementation audit — 2026-09-15

Scope: all twelve design documents, current working-tree source, recent commits,
and existing UI verification records. This includes the uncommitted directory
reorganization and theme work; it is not an audit of only committed HEAD.

## Summary

The timeline, setup shell, usage modes and guide are substantially implemented.
The next work is to restore validation after the file moves, finish the theme
contract migration, and complete command transport with the web control panel.
The shared library, channel builder, household features and era layer remain
larger future projects. Existing plugins and partial features should be reused.

## Status by document

| Doc | Current assessment | Remaining work |
| --- | --- | --- |
| 00 Roadmap | Reference needs maintenance | Reconcile completion labels, transport decisions, API version and migration order with current code. |
| 01 Usage modes | Built in source; hardware acceptance open | Hisense remote/APK verification, native keyboard and long-press checks; real gamepad/CEC/Tizen/webOS checks; Tizen/webOS packaging. Control-panel deep links depend on 06. |
| 02 Timeline | Built; storage decision closed | Restore tests after moves and rerun acceptance. Keep the derived rule stack and layered storage; schema replacement is not outstanding work. |
| 03 Setup shell | Built | Restore current validation and recheck acceptance timings/keyboard/layout after the reorganization and component changes. No evidence warrants rebuilding the shell. |
| 04 Components/themes | Kit and plugin surface built; migration partial | Finish reference pack, conversion guide, remaining packs, structural CSS cleanup and visual/contrast gates. |
| 05 Commands/sync | Local commands, undo, host reconciliation and viewer notifications built | Send renderer commands to the host; finish multi-editor conflict/revision handling, plugin command registration and control authorization with 06. |
| 06 Web control | Proposed, with reusable host/viewer foundations | Full control route, writable shim, scoped sessions, command endpoint, host folder browser/uploads, handoff/deep links, presence and administration UX. |
| 07 Library/tagging | Shared catalogue not implemented | Stable item IDs/index, roots, provenance, review queue, saved queries, explicit rematerialization and schedule-preserving migration. Existing tags, curation and relinking are foundations. |
| 08 Builder/templates | Proposed | Plan/slot schema, resolver, previews, built-ins, import/export, local grammar and one-batch apply/undo. Reuse channel packages and existing curation. |
| 09 Households/DVR | Proposed, with recording foundations | Personal stores/profiles, migration, DVR request scheduler and My Shows, playback handoff/resume, shared sessions and drift correction. Guide recording via the tape-deck plugin already exists. |
| 10 Eras | Proposed | Effective presentation resolver, era data/picker, override provenance, channel pins, accessibility overrides and plugin hints. Existing theme and Music Choice era controls are not the shared layer. |
| 11 Guide/time machine | Built with one explicit layout omission | Shrink the picture in TV docked mode; verify real Hisense acceptance. Components are now available, despite older notes saying otherwise. |

## Priority 1 — Complete (2026-09-15)

All test imports, fixture paths, injected renderer imports and UI-wrapper docs now
use the reorganized source tree. The config-write audit recurses through the new
renderer subdirectories: **0 untyped writes** and 11 intentional labelled patches.

The repair exposed two application startup bugs caused by the move:

- isolated plugins still forked `main/plugins/plugin-isolation-runtime.js` instead
  of `main/plugins/isolation-runtime.js`, producing the eight-plugin error dialog;
- bundled-plugin discovery resolved `main/plugins` as the catalogue and removed
  copied bundled plugins from the disposable profile. It now resolves the top-level
  `plugins/` directory. Regression checks cover both resolved paths.

Fresh validation against a protected copy of the installed lineup:

- `npm test`: **185/185 pass**, 0 fail, 0 skipped; plugin contract validation passed;
- real-Electron UI suite: **36/36 pass**;
- usage modes / TV surfaces: **26/26 pass**, including all 26 themes for the TV
  menu and keyboard;
- editable timeline: **38/38 pass**;
- guide and time machine: **34/34 pass**, including its popover and scrubber in
  all 26 themes;
- full real-lineup theme sweep: **26 themes × 26 screens = 676 captures**, with
  **0 renderer runtime errors**.

Two contrast failures found by the restored gate were corrected in Hotel Headend
'92 and Slate Grid '10 without exemptions. The wrappers restored portable
`userData` byte-for-byte and left no backup folder or test Electron process.

The sweep's main-process log repeatedly reports that `gdrive` is unavailable. The
installed profile's Google Drive approval predates its new `shell.openExternal`
capability, so core correctly refuses to activate it until the user reviews the new
permission. That does not invalidate the theme sweep; Google Drive behavior was not
claimed as covered. Real Hisense hardware verification remains outside this priority.

## Priority 2 — Finish 04 without losing theme character

`renderer/js/display/theme-check.js`, `contrast.js` and `theme-contract.js` now
exist. Theme results feed setup badges and plugin diagnostics. The migration is
therefore further along than simply “build a checker,” but not complete:

- `tests/theme-contract.test.js` lists **only `widescreen-grid-13`** in `CONVERTED`.
- Doc 04 names `dual-tuner-dvr-05` as the intended reference. Resolve/document
  that mismatch; do not count the other packs as converted.
- Write the theme conversion/slot guide in `PLUGIN_DEVELOPMENT.md`.
- Convert remaining packs and enforce structural lint across all first-party packs.
- Remove compatibility overrides and specificity chains only after conversion.
- Verify contrast and appearance on desktop and TV, including selected, focused,
  disabled and popup states. Current broken test imports prevent a fresh gate result.

## Priority 3 — Complete 05 and 06 together

`renderer/js/core/state.js` still calls `window.api.saveConfig(S.config,
hostRevision)`; `main/config/host.js` reconciles whole-config saves against a
bounded host-command history. This protects existing host edits but is not the
complete multiple-editor protocol described in the design.

Implement the host command write path, revision/conflict responses, duplicate
handling and client reconciliation before enabling browser writes. Add separate
control authorization, retain viewer redaction, and keep admin-only operations
host-only. Then build folder browsing/uploads, control deep links and presence.
Plugin-owned writes still use patches; `ctx.commands.register` remains future work.

Viewer config notifications already use `/api/remote-events` with a 250 ms poll
and a slower config fallback. Doc 06 should not treat 10-second-only config polling
as current. Decide whether to extend this transport or adopt SSE; avoid building
both merely because older prose names SSE. Existing headless launch and the small
server status page do not constitute the planned `/control` editor.

## Priority 4 — TV closure and later features

The docked-picture omission is confirmed by `renderer/css/guide.css`: shrinking
the player applies to full-page mode; docked mode keeps it full-size. Finish this
with aspect/bezel, overscan and all-theme checks. Real-device acceptance also
remains open: remote long press, guide search invoking the native keyboard and
the three/five-press time-machine flows.

After these foundations, build **07 → 08**. Personal stores in **09** can be
developed after command/control work; series recording also needs library identity.
**10** can follow the theme contract independently of library/template completion;
its template suggestions can arrive later.

## Design corrections needed before implementation

- **07 append safety:** appending preserves the anchor timestamp, but changes
  total loop duration. `(time - anchor) % duration` can then point to different
  content. Automatic appends need schedule-impact evaluation; they are not
  inherently safe merely because files were added at the end.
- **07 identity:** size/mtime/first-megabyte hashes are matching evidence, not a
  guaranteed identity. Specify ambiguous-match and changed-mtime behavior before
  automatic relinking, plus a deterministic metadata conflict policy.
- **09 staleness:** “no record from guide” predates the tape-deck guide hook.
  Remaining DVR work is the household scheduler and personal recording experience.
- **10 precedence:** explicitly define how an “override era” exception outranks
  the era, while clearing the era restores saved box settings. The current linear
  precedence diagram alone does not describe both operations.
- **00/04/11 metadata:** API is v6, the in-house kit decision is made, and the
  rule-storage migration was declined. Keep these decisions synchronized rather
  than presenting them as new implementation requirements.

## Changes made by this audit

Updated design-document source references to the current `main/` and
`renderer/js/` subdirectories. Historical removed-file mentions remain where they
explain an actual migration. Added this audit and corrected the most misleading
status/context notes. No application or test code was changed.
