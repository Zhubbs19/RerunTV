---
name: retro-cable-box-themed-dialogs
description: "In-theme confirm/alert dialog system (setup-dialogs.js) that replaced all native window.confirm/alert calls, 2026-08-17"
metadata: 
  node_type: memory
  type: project
  originSessionId: 52e76aac-40e2-49cc-b1c2-96da84ca1476
  modified: 2026-08-17T14:39:56.549Z
---

Replaced every `window.confirm()`/`window.alert()` call across the setup UI (and a few TV-screen error paths) with a themed dialog system in [setup-dialogs.js](../renderer/js/setup-dialogs.js) — `confirmDialog()` and `alertDialog()`, both Promise-based, styled via `.confirm-dialog*` classes in setup.css to match the retro chrome (uses the same `--danger`/`--gold` tokens as the rest of the theme, so it re-themes automatically across all the theme eras). A new `.btn-danger` class was added for destructive-action buttons.

**Why:** user asked for "error verification" (catch-block failures surfaced via a themed error alert instead of a native OS dialog) and in-theme popups — explicitly **only for destructive/potentially-destructive changes**, not gating every edit. Existing `window.confirm()` call sites already only guarded destructive actions (remove channel, delete backup, overwrite-on-import, etc.), so all of those were retheme'd; existing `window.alert()` calls (errors + info) were retheme'd too since that's the "error verification" ask, without adding any *new* confirmation gates on non-destructive actions.

**How to apply:** Any new destructive action (delete/remove/overwrite/replace-with-no-undo) should use `await confirmDialog(message)` (danger defaults to true — red accent, REMOVE/CANCEL buttons). Non-destructive-but-still-gated confirms should pass `{ danger: false, confirmText: '...' }` (gold accent, matches `.btn-primary`). Any catch block that currently surfaces an error to the user should use `alertDialog(e.message, { variant: 'error' })` instead of `alert()`. Click handlers that call `confirmDialog` must be `async` and `await` it — see the pattern in [setup-channels.js](../renderer/js/setup-channels.js) removeBtn handlers.

Verified via a real Electron CDP boot test (playwright-core connectOverCDP on `--remote-debugging-port`) — clicked a channel REMOVE button, confirmed the themed dialog renders with correct danger styling/message/buttons, clicked CANCEL, verified channels.json on disk was untouched (no autosave side effect from opening/canceling the dialog). See [[retro_cable_box_cdp_autosave_gotcha]] for why that check mattered.
