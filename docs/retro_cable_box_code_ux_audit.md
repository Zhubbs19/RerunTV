---
name: retro-cable-box-code-ux-audit
description: TODO-AUDIT.md tracks a full code + UI/UX audit (static review + live screenshots + measured perf fix) from 2026-08-05 — nearly all items now implemented across two parallel sessions
metadata: 
  node_type: memory
  type: project
  originSessionId: f68d75e2-6323-415f-9915-db6f47053e8a
  modified: 2026-08-17T01:29:52.535Z
---

`TODO-AUDIT.md` (project root) is a checklist compiled from a full code +
UI/UX audit of Retro Cable Box: static code review across all renderer
modules, live screenshots of every setup tab and channel-edit sub-tab
(driven via a Playwright `_electron` script, not the computer-use MCP —
this dev build isn't Start-Menu-installed so computer-use's app resolver
can't find it), and a measured performance fix for a user-reported "screen
shake" bug in the docked program guide.

**Why:** this is a separate, later effort from the setup-UI Tier 0-4 audit
already closed out in [[retro-cable-box-quality-of-life]] — that one covered
workflow/setup-screen redesign (channel EDIT view, calendar, bulk actions);
this one is a broader pass over code quality (duplication, file-size,
accessibility) plus fresh UI polish found only by actually running the app
and zooming into screenshots (e.g. a trivia-interval field visually
orphaning from its toggle on line-wrap — not visible from reading the CSS
alone).

**Status as of 2026-08-05 (session 6 — final):** every item on `TODO-AUDIT.md`
is now shipped. The two items intentionally left open after the first pass —
splitting the 2200-line `setup.js` into modules, and unifying the
SCHEDULE/CALENDAR tabs into one entry point — were completed in session 6,
along with the full (not partial) guide-freeze fix:
- `setup.js` split into `setup-util.js`/`setup-panels.js`/`setup-schedule.js`/
  `setup-channels.js`/`setup-interstitials.js`/`setup-settings.js`, with
  `setup.js` reduced to a ~20-line entry point (imports submodules for their
  side-effect listeners, re-exports what `app.js`/`channels.js` need).
- SCHEDULE and CALENDAR unified into one channel-EDIT tab
  (`buildUnifiedSchedulePanel` in `setup-schedule.js`) with an internal
  BLOCKS/CALENDAR view toggle, replacing the two separate tab entries.
- The guide-freeze fix (previously only the `setTimeout(0)`-deferral partial
  fix) now also does the originally-scoped-but-undone part: render only
  enough real-channel rows to cover the viewport synchronously, lazy-fill
  the rest via chunked passes — see [[retro-cable-box-architecture-constraints]]
  for the implementation details.

Earlier in this same overall effort: the calendar-tab/schedule-tab
day-override NOTE-field bug (both now share one `renderDayOverrideRow`
helper — now living in `setup-schedule.js`), `dom.js`'s duplicate
object+named-exports, the `.commercials-*`/`.standby-*` CSS duplication,
several accessibility gaps, and the docked-guide-mode-shows-only-1-row UX
issue (docked height increased) were all fixed in the first pass.

The "screen shake" bug specifically: root-caused via **in-page**
`requestAnimationFrame` sampling of `#player`'s `getBoundingClientRect()` —
external CDP/`page.evaluate()` polling gave misleading numbers here, so for
any future frame-timing investigation on this codebase, sample natively
inside the page, not via external polling. Real cause was `renderGuideGrid()`
(guide.js) blocking the main thread ~190ms on open (recomputes full
schedules for all 70+ channels every time), partially fixed via
`setTimeout(fn, 0)` deferral (down to ~108ms) — the full fix (render only
visible rows first, lazy-fill the rest) was scoped but not implemented,
left as a documented follow-up. Two dead-end fix attempts are recorded in
the file specifically so a future session doesn't retry them: moving
`renderGuideGrid()` into the first `requestAnimationFrame` (made it worse),
and adding `will-change: transform` to `#player`/`.crt` (zero measured
effect).

**How to apply:** before starting new UI/code-quality work on this project,
check `TODO-AUDIT.md`'s checkbox state first — most of it may already be
done. If continuing the guide-freeze fix, reuse the in-page rAF sampling
technique described above and in the file rather than re-deriving it.

**2026-08-16 follow-up audit:** a fresh code/UI/feature audit found the
codebase otherwise clean (zero TODO/FIXME markers anywhere) except one
carried-over outlier — `main.js` had never gotten the same module-split
treatment `setup.js` got above, and had grown to 1680 lines mixing six
unrelated concerns (remote/viewer/discovery/party HTTP servers, Spotify
child-process management, YouTube search-and-play, window/app lifecycle,
ipcMain registrations). Split into `main-window-ref.js` (a shared
`getMainWindow()`/`setMainWindow()` getter — the key piece that let the
split happen at all, since every extracted module needs to reach the same
`BrowserWindow` main.js creates and re-assigns), `main-remote-server.js`,
`main-viewer-server.js`, `main-discovery-server.js`, `main-party-server.js`,
`main-spotify.js`, `main-youtube.js` — `main.js` itself is now down to app
lifecycle, window creation, and the ipcMain registrations that tie it all to
the renderer, mirroring exactly what the old `setup.js`'s own top comment
described as the "genuinely coupled" stuff worth keeping together. Verified
via a real CDP boot test (isolated `--user-data-dir`, never touched the real
config): page loaded, zero console errors, all LAN-facing server ports
(remote/viewer/party/discovery/spotify bridge+stream/youtube stream) bound
successfully.
