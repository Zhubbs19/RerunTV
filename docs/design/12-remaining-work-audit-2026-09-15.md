# Design implementation audit — 2026-09-15

Scope: all twelve design documents, current working-tree source, recent commits,
and existing UI verification records. This includes the uncommitted directory
reorganization and theme work; it is not an audit of only committed HEAD.

## Summary

The timeline, setup shell, usage modes, guide and theme contract are substantially
implemented. Validation after the file moves is restored. The next work is to
complete command transport with the web control panel.
The shared library, channel builder, household features and era layer are
now all built (10 in a v1 scope — see its row below for what's deferred).
Existing plugins and partial features should be reused.

## Status by document

| Doc | Current assessment | Remaining work |
| --- | --- | --- |
| 00 Roadmap | Reference needs maintenance | Reconcile completion labels, transport decisions, API version and migration order with current code. |
| 01 Usage modes | Built in source; hardware acceptance open | Hisense remote/APK verification, native keyboard and long-press checks; real gamepad/CEC/Tizen/webOS checks; Tizen/webOS packaging. Control-panel deep links are now only waiting on this doc's TV surfaces, not on 06. |
| 02 Timeline | Built; storage decision closed | Restore tests after moves and rerun acceptance. Keep the derived rule stack and layered storage; schema replacement is not outstanding work. |
| 03 Setup shell | Built | Restore current validation and recheck acceptance timings/keyboard/layout after the reorganization and component changes. No evidence warrants rebuilding the shell. |
| 04 Components/themes | Complete in source and validated | All 25 packs use semantic tokens/slots; conversion guide, structural lint, contrast and fresh desktop/TV gates are complete. |
| 05 Commands/sync | **Built and verified** (`18d8144`): renderer and LAN clients both post commands, host merges or refuses them, duplicate/stale/conflict handling, authoritative resync, plugin commands at ctx v7 | None. Later docs extend the catalogue (08 batches, 09 personal scope); the layer itself is done. |
| 06 Web control | **Phases 1–4 built** (`18d8144`, 2026-09-17, 2026-09-18): control pairing code in-app, "Preview on…", asset upload, and TV/viewer handoff granting control scope directly | Real remote-device QR-scan acceptance (01's TV work); the per-item "also editing this" half of presence; headless tray. |
| 07 Library/tagging | **Built** (2026-09-16), plus a single-item editor and root/item removal (2026-09-17) | Embedded-tag, taxonomy and metadata-plugin tagging steps (§5 steps 2/4/5); queries in blocks (02) and templates (08); provider etags; ending dual-read of per-file metadata. See 07 §8. |
| 08 Builder/templates | **Built** (2026-09-16), plus a plugin template registry (2026-09-17) | Pure plan/slot engine, six built-ins + `registerTemplate`, local grammar, library resolution, guarded preview, path-free import/export and one-step apply/undo are in Channels and the shared web bundle. Inline chip editing remains an optional presentation follow-up. |
| 09 Households/DVR | **Built** (2026-09-16) | Personal store/profiles, migration, DVR request scheduler + My Shows, retention, handoff and shared sessions are in `main/personal/service.js`, `renderer/js/personal/*`, `renderer/js/setup/household.js`, the TV menu and guide. Drift correction and PIN-gated profile switching are both implemented (2026-09-17 re-check) — only real second-device acceptance is open, same class of gap as 01's Hisense item. |
| 10 Eras | **Built, v1 scope** (2026-09-16) | Five built-in eras, apply/clear with exact restore, box-override tracking + source display, TV-mode picker are in `display/eras.js` + `setup/eras.js` + `tv/setup.js`. Channel-level follow/pin-era already existed (`setup/panels.js`'s THEME/ERA identity field, pre-dates this doc — 2026-09-17 correction). Remaining: plugin era hints (Digital Music, ticker/EAS), template/pool suggestions (phase 5), the low-resolution TV-mode accessibility override, and a full per-era theme-contrast sweep. |
| 11 Guide/time machine | **Built** — the TV docked picture shrink closed the last omission | Real Hisense acceptance, which is 01's to close. |

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

## Priority 2 — Complete (2026-09-15)

All 25 first-party theme packs now declare semantic tokens and decorate only the
documented slots or native fields. `tests/theme-contract.test.js` enforces the
structural contract across the complete pack list, while the token test rejects
legacy palette declarations. `widescreen-grid-13` is documented as the migration
pilot and `dual-tuner-dvr-05` as the maintained reference.

`PLUGIN_DEVELOPMENT.md` now documents semantic/control/motion tokens, placement
tokens, every slot and supported state suffix, forbidden density/layout changes,
and the conversion/validation workflow. Core control states read tokens directly,
so the broad theme class overrides and the old eight-`:not()` specificity chain
are gone. The guide header, exit prompt and active channel rail expose the small
additional slots/state attributes needed to preserve the existing looks.

Fresh validation after conversion:

- `npm test`: **185/185 pass**;
- real-Electron UI suite: **36/36 pass**;
- full real-lineup theme sweep: **26 themes × 26 screens = 676 captures**,
  with **0 renderer runtime errors**;
- representative converted setup, full-guide and docked-guide screenshots were
  visually checked after the sweep.

## Priority 3 — complete except asset upload, deep links and presence (2026-09-16)

### A blocking regression from Priority 1, fixed first

`main/config/config.js` resolved the shared command registry as
`main/renderer/js/commands.js`: wrong twice over after the reorganization, since
`__dirname` became `main/config/` and the module moved to `renderer/js/core/`.
The loader is lazy, so nothing failed at boot — the first host command rejected
instead. That is every `configHost.applyCommands()` caller: plugin capability
approval and revocation, `plugin.forget`, `plugin.setEnabled`, and the headless
Companion settings patch. `tests/config-host.test.js` never caught it because
every test injects its own `loadCommands`; it now resolves and imports the path
the application really uses, and fails against the old one.

### Host command transport — complete

`renderer/js/core/state.js` posts named commands on the same 600 ms debounce it
used to save on, and `main/config/host.js` is the single writer. See doc 05 §4
step 6 for the design as built: `touches()` on every command definition,
duplicate batch ids answered rather than reapplied, typed conflict/stale-reset/
stale-window/invalid refusals, host-origin-only replay onto whole-config saves,
echo suppression, and a full authoritative resync (never a fine-grained
rollback) on refusal. Whole-config saves remain for import, restore, the DONE
flush, onboarding and window-recreating settings — and for a session's first
write, which is how the renderer's `applyConfigDefaults()` output first reaches
a host that does not apply defaults itself.

Validation:

- `npm test`: **201/201 pass** (was 185), including 20 in `tests/config-host.test.js`
  and 28 in `tests/commands.test.js`;
- real-Electron UI suite: **36/36 pass**;
- `tests/ui/verify-command-transport.mjs`: **17/17 pass**, 0 renderer runtime
  errors — duplicate delivery, a conflicting stale client, two clients editing
  different channels, renderer resync after refusal, and a host command applied
  through the real module path;
- `verify-config-host.mjs`: 9/9; `verify-step5-commands.mjs` still reports config
  byte-identical after undoing every step; `verify-viewer-config-push.mjs`: 7/7,
  a setup edit reaching a paired viewer 661 ms later.

Two scratch drivers needed correcting rather than the application:
`verify-config-host.mjs`'s stale-save check now asserts the new, stricter
behaviour (this client's own stale save is repaired by replay; another client's
is refused), and `verify-viewer-config-push.mjs` had a regex literal corrupted
by a path rewrite during the reorganization — `/\(push test\)$/` had become
`/\(push tests\ui\)$/`, which never matched, so that check had been failing
open.

### Control authorization and the LAN command endpoint — complete

`main/lan/security.js` now issues one pairing code per scope and stores sessions
as `token -> { expiresAt, scope }`. Scope is carried by the token, never by
anything the client sends. `scopeOf(req)` and `requireScope(req, res, 'control')`
are the gate; no `admin` scope is issued at all, so plugin installs, capability
approval, updates and network services remain host-window-only by construction.

Entering the control code on a device that already holds a view session mints a
**new** session rather than widening the old one — the design requirement not to
broaden a viewer into a writer is met by the token model, not by a check that
could be forgotten. A sessions file written before scopes existed reads back as
view-only rather than being promoted.

`main/lan/viewer-server.js` adds three control-scope routes: `POST /api/commands`
(256 KB cap, `origin` forced to `'client'` so a LAN batch cannot claim to be a
trusted host edit, 409 with the same typed refusal body the renderer gets),
`GET /api/control/config` (real host paths, which an editor needs, with every
credential-shaped key stripped) and `GET /api/control/state`. `/api/config` is
untouched and still returns the fully redacted viewer projection.

Validation:

- `npm test`: **210/210 pass** (was 201), including the new
  `tests/lan-control.test.js` (9);
- `tests/ui/verify-lan-control.mjs`: **18/18 pass**, 0 renderer runtime errors —
  a real LAN control session editing the real lineup, with the Electron window
  seeing the change **23 ms** later (doc 05 §5's "within 1 s"). Over the same
  config the control client saw 3493 real host paths and 0 opaque refs while the
  viewer projection saw 0 real paths and 3886 opaque refs;
- real-Electron UI suite: **36/36**; `verify-viewer-config-push.mjs`: **7/7**, so
  existing viewer pairing is unaffected by the scope change.

### The /control route and the writable shim — complete

`/control` serves the same renderer bundle, control scope only. It is served
**byte-identical to `/`**: index.html's Content-Security-Policy has no
`'unsafe-inline'` and the file deliberately contains no inline `<script>`, so
the planned injected `window.__controlClient = true` marker would have been
blocked. `browser-api-shim.js` reads the marker off `window.location` instead,
and `/control/` redirects to `/control` so the page's relative asset URLs still
resolve. The marker is a convenience, never a permission: the route 403s a view
session, and every write still passes `requireScope('control')` on the host.

The shim's write methods post to `/api/commands`. Whether this device may write
is the host's answer — a one-time `/api/control/state` probe — not something the
page decides about itself. There is deliberately no whole-config write over the
LAN, so `saveConfig` answers `unsupported` and `state.js` sends its commands
instead of trying to establish agreement that way; it does not need to, having
loaded its config from the host. `config:applied` now rides the existing
`/api/remote-events` bus, filtered per request so a `view` session never
receives it (those events carry real config values).

A control client deliberately does not run the viewer's config poll, which
replaces `S.config` wholesale and would discard an edit in progress.

Validation:

- `npm test`: **219/219 pass** (was 210);
- `tests/ui/verify-control-panel.mjs`: **13/13 pass**, 0 runtime errors, 0
  unexpected HTTP failures, twice — a real Edge/Chrome browser paired with the
  control code, booting the real setup shell against the real lineup (14
  channels, 3493 real paths, 0 opaque refs), editing it, and reconciling with
  the Electron window both ways (browser→host 87 ms, host→browser 84 ms).
  Undo in the browser travelled to the host as its own commands. Re-paired as a
  viewer, the same browser got 403 at `/control` and a `read-only` refusal from
  the shim, with nothing written;
- real-Electron UI suite **36/36**; `verify-command-transport.mjs` **17/17**;
  `verify-lan-control.mjs` **18/18**.

### Three pre-existing window.api contract bugs, found and fixed

Driving the bundle in a real browser for the first time showed that
`createApiSurface` **threw** there, so a LAN browser had no `window.api` at all
and the page was dead. Every automated run until now drove the Electron window,
where preload supplies `window.api` and the shim is a no-op, so nothing caught it:

- `quitApp` was declared a viewer method while the shim defined it as `null`;
- `digitalMusicScanFolder` and `digitalMusicEmbeddedArt` were declared viewer
  methods the shim never defined at all.

All three genuinely cannot work in a browser (a tab cannot close the app; both
digital-music calls read the host filesystem), so they moved to `hostOnlyMethods`.
A third, quieter bug came out of the same audit: `onCompanionTriggerNews` and
`onCompanionSetTicker` were listed host-only while the shim implemented them, so
`createApiSurface` silently dropped the implementations and the Companion ALERTS
relays went on doing nothing on a viewer — including in headless mode, where a
paired viewer is the only possible display. They are viewer methods now.

`tests/api-surface.test.js` (5) keeps the two lists honest: every viewer-facing
method implemented, none defined as `null`/`undefined`, nothing outside the
contract, no dead host-only stubs, and a real `createApiSurface` build.

**Note for the release:** the LAN viewer and the Android TV client have been
broken in a browser since the digital-music IPC methods were added to the
contract. This fix restores them.

### Administration stays on the host — enforced at the command layer

A gap in what shipped in step 2: a `control` session could dispatch *any*
command, including the ones doc 06 §4 reserves for the host. `main/config/host.js`
now refuses, for any batch that arrived over HTTP, `plugin.setApproval`,
`plugin.setEnabled`, `plugin.forget`, `settings.set` under `network`, `updates`
or `pinLock`, and any `config.patch`. The check keys on `remote`, which the route
sets itself rather than depending on whoever wires `applyCommands` up — the first
version set it in `main.js` and the test harness silently lost it, which is
exactly the failure mode the route-side version prevents. The Electron window is
an `origin: 'client'` writer too and keeps all of these.

### Host folder browsing — complete

`main/lan/control-browse.js` decides what is listable; `GET /api/control/browse`
and `/api/control/scan` carry the question, and `renderer/js/control-picker.js`
is the dialog `selectFolder`/`selectImage`/`selectAudio`/`selectVideo` now open
on a control client. Roots are the directories this config already refers to —
a control client can already see those paths in `/api/control/config`, so
listing inside them discloses nothing new — plus `network.controlBrowseRoots`,
which only the person at the host can set, because that key is in the
remote-denied list above. "Outside the roots" and "does not exist" give the same
answer, so the host's disks cannot be mapped by probing.

### Plugin commands — complete (ctx v7)

`ctx.commands.register(id, name, definition)` registers `plugin:<id>.<name>`.
The type is built by core from the id, so a plugin cannot register outside its
namespace or shadow a core command, and the plugin's `apply`/`validate`/
`describe` receive **that plugin's settings object and nothing else** — the
scope is what it is handed, not a rule it is asked to follow. Touch tokens are
prefixed `plugins/<id>/settings/`. Since the host has no plugin renderers, a new
`toHost` hook on a command definition states what to send in its place; a plugin
command travels as `plugin.setSettings` while undo history keeps the precise
command and its label. `PLUGIN_DEVELOPMENT.md` documents it under "Undoable
edits with `ctx.commands`".

### Validation for this batch

- `npm test`: **227/227 pass** (was 219);
- `tests/ui/verify-lan-control.mjs`: **24/24**, 0 runtime errors — every
  administration command refused 409/`forbidden` over the LAN with the host
  unchanged; 30 browse roots derived from the real lineup; `C:\Windows`,
  `C:\Windows\System32`, `<root>\..\..` and `C:\` all refused; a folder that
  was never listed cannot be scanned;
- `tests/ui/verify-command-transport.mjs`: **23/23**, 0 runtime errors — a real
  plugin command through the real plugin host at ctx v7, carrying its own undo
  label, writing only its plugin's settings, reaching `channels.json` as
  `plugin.setSettings`, and undoing precisely;
- `tests/ui/verify-control-panel.mjs`: **17/17**, 0 runtime errors, 0 unexpected
  HTTP failures — `selectFolder()` in a real browser opened the host folder
  browser, listed 30 real roots, kept "Use this folder" disabled until one was
  open, and resolved to a real host path;
- real-Electron UI suite **36/36**; config-write audit still 0 untyped writes.

### Remaining Priority 3 work

1. **Asset upload — closed (2026-09-18).** `POST /api/control/assets` (control
   scope, `main/lan/asset-upload.js`) accepts one PNG/JPEG/WebP/GIF up to 8 MB,
   using `busboy` the same way `plugins/party-channel`'s LAN upload route
   already did, and writes it into `userData/assets/`. `renderer/js/
   control-picker.js`'s image picker offers "Upload from this device instead"
   alongside the existing folder browser, for a file that only exists on the
   editing device (a phone photo, say) rather than anywhere on the host's
   disks. SVG is deliberately excluded (it can carry `<script>`, and this file
   is later referenced from real app surfaces, not shown back to a sandboxed
   guest the way party-channel's bulletin photos are).
2. **Deep links / QR handoff — closed for the control panel itself
   (2026-09-18).** `main-tv-client.js`'s `handoffInfo()` now prefers a
   control-scope viewer pairing URL (the same one-time-code mechanism as the
   Settings panel's control code) over the Companion page, so the TV's
   "EDIT ON PHONE OR COMPUTER" QR opens straight into an already-writable
   `/control` session — no separate code entry. `main/lan/viewer-server.js`'s
   own `/api/handoff-info` (reached by a paired viewer itself, not just the
   host window) does the same, minted off its own request's origin. Real
   remote-device QR-scan acceptance is still open, same class of gap as 01's
   Hisense item. "Preview on…" was already built (`68fe89c`).
3. **Presence — partially closed (2026-09-18).** The Settings screen's
   connected-devices list (`renderer/js/setup/settings.js`) now labels each
   LAN-viewer entry WATCHING or EDITING using the session's real scope
   (`main/lan/connections.js`'s `recordConnection` gained a `scope` field; the
   `/api/commands` route now calls `trackConnection` too, since only GETs did
   before — a control session's writes were invisible in that list until
   now). Still open: a per-item "also editing this" badge inside an actual
   editor screen, which is the harder half of doc 06 §7 and needs its own
   design pass, not a quick follow-on.
4. **Surfacing the control pairing code — closed (`68fe89c`, 2026-09-17).**
   Desktop Settings › Network services shows it via `getViewerControlUrl`.
   Not duplicated separately in TV setup: item 2 above means the TV's own
   "EDIT ON PHONE OR COMPUTER" QR already carries the code invisibly, which
   is a better fit for a remote than asking someone to read out or type an
   8-digit code on a TV keyboard. A way to add a browse root from Settings is
   still open.

### A tooling limit worth recording

Electron's CDP supports neither `Target.createBrowserContext` nor
`Target.createTarget`, so the Electron browser cannot be given a second page or
context at all — the same family of gap as the missing `Browser.*` window
methods. A driver that needs a second real client must launch an installed
Edge or Chrome through `playwright-core`'s `channel:` option;
`verify-control-panel.mjs` does that and skips its browser-side checks when
neither is installed.

## Priority 4 — TV closure and later features

**The docked-picture omission is closed (2026-09-16).** `guide.js` publishes the
strip's resolved height as `--guide-picture-h`; `power.js`'s
`pictureAreaHeight()` feeds it to the existing bezel/safe-area/crop math instead
of `crtContainer.clientHeight`, so the frame follows the picture down rather
than being overridden. `tests/ui/verify-docked-picture.mjs`: 15/15, 0 renderer
runtime errors, all 26 themes, aspect ratio preserved by `object-fit: contain`.

A note on that verification, because it cost three runs: the first two
"failures" were the measurement, not the feature. `.guide-grid` is a sibling of
`#display-frame` rather than a child, and the stage can be scaled, so a
`getBoundingClientRect()` comparison between the picture and the strip crosses
a transform boundary and is meaningless. Measuring in layout pixels
(`offsetTop`/`offsetHeight`/`clientHeight`) showed the picture had been landing
exactly on the strip's top edge all along. **Do not compare rects across those
two subtrees.** `page.setViewportSize()` also does not resize an Electron window
over CDP, so a driver cannot test a real window resize.

Real-device acceptance remains open: remote long press, guide search invoking
the native keyboard, and the three/five-press time-machine flows.

After these foundations, build **07 → 08**. Personal stores in **09** can be
developed after command/control work; series recording also needs library identity.
**10** can follow the theme contract independently of library/template completion;
its template suggestions can arrive later.

## Design corrections needed before implementation

- **07 append safety — resolved (2026-09-16):** re-anchoring keeps the airing file at its offset
  across any playlist change (07 §3). Library sync uses it, and smart channels rebuild
  unattended only when it succeeds.
- **07 identity — resolved (2026-09-16):** `classify()` returns same / moved / ambiguous /
  replaced / new; only same and moved apply unattended, and a deterministic conflict policy
  (provenance, recency, channel number) drives migration (07 §4, §7).
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
