---
name: retro-cable-box-blue-screen-boot-bug
description: "2026-08-10 boot bug where the box showed a solid blue screen instead of tuning in, caused by a Gemini-made HTML edit that unbalanced a div in index.html"
metadata: 
  node_type: memory
  type: project
  originSessionId: 5bdb20ba-1103-4847-912f-b2c8dc744d89
  modified: 2026-08-10T14:33:13.208Z
---

Fixed 2026-08-10: box booted to a solid blue screen (no guide, no video) instead of live playback.

Root cause: in [renderer/index.html](renderer/index.html), the `#preview-modal` block had been
inserted before `#setup-screen`'s closing `</div>`, but the tag that used to close
`#setup-screen` right after it was never re-added. That left `#tv-screen` nested *inside*
`#setup-screen` instead of as a sibling under `#app`. Since `#setup-screen` gets
`display:none` once booted, its now-child `#tv-screen` collapsed to 0×0 — the only thing
visible was the page's default blue background color (`--ink`, tokens.css).

The user said this HTML change came from a Gemini editing session doing theming updates,
not from Claude Code work in this project.

Why this is worth remembering: it wasn't caught by any runtime error — no console error, no
renderer crash, valid CSS, valid config. Diagnosis required actually measuring DOM geometry
(getBoundingClientRect + parentElement) via a CDP/Playwright boot test, not just reading
code or checking devtools console. A simple `<div>` vs `</div>` count between a container's
opening tag and a landmark comment/tag after it (see the ad-hoc script used this session)
is the fast way to catch this class of bug in this codebase's fairly deeply-nested index.html.

How to apply: after any external/non-Claude-Code edit to renderer/index.html (or other large
hand-nested HTML in this project), if something renders blank/blank-colored with no JS
errors, suspect unbalanced div nesting before suspecting CSS or JS logic — check DOM
parent/geometry directly rather than just re-reading the source top-to-bottom.

See [[retro_cable_box_architecture_constraints]] for this project's existing CDP
boot-test discipline (which this session's ad-hoc test followed: no scratch-channel
tuning, checked config mtime afterward to confirm no unwanted autosave).
