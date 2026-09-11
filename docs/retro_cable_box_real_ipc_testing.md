---
name: feedback-real-ipc-testing
description: "Verification of IPC-dependent Electron features must exercise the real preload/ipcMain bridge, not the LAN-viewer's browser-api-shim"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 197079ed-3170-4dd9-aff2-1ac59526b030
  modified: 2026-08-19T04:33:04.965Z
---

When verifying a feature that depends on Electron's real IPC bridge (preload.js exposed functions, `ipcMain`/`ipcRenderer`, a plugin's `main.js` `activate(ctx)` wiring), always go through the real IPC path — don't rely on testing via the LAN viewer (`electron . --headless`, [[retro_cable_box_lan_viewer]]) as if it exercises the same thing.

**Why:** The LAN viewer serves the renderer bundle to a plain browser tab via `browser-api-shim.js`, which stubs most `window.api.*` functions as no-ops (see e.g. `onPartyPost: () => {}`) rather than routing through real `ipcRenderer`/`ipcMain`. It's genuinely useful for catching renderer-side JS errors (bad imports, syntax errors, DOM wiring) since it runs the actual `renderer/js/*.js` and `plugins/*/renderer.js` files — but it proves nothing about whether an IPC round trip (e.g. a party-page guest action → main process → `mainWindow.webContents.send()` → renderer handler) actually fires. A clean console with zero errors in the LAN viewer is not evidence an IPC-dependent feature works. Caught live 2026-08-19: after migrating party-channel's ~8 `window.api.onPartyX` handlers into the plugin during a PARTY_CH full-plugin migration, the LAN viewer showed a clean boot, but the user pointed out this doesn't actually run the app's real IPC — the only thing available at that point was a static cross-check of channel name strings across `preload.js`/`main.js`/the plugin (which did turn up clean, but is not the same as a live test).

**How to apply:** For any change touching `ipcMain.handle`/`ipcMain.on`/`mainWindow.webContents.send`/`ipcRenderer.invoke`/`preload.js`, verify via a real windowed (or real headless-but-real-IPC) Electron instance with CDP attached — not the LAN-viewer shim. If no such real-IPC verification path is set up in the session, say so explicitly rather than reporting the LAN-viewer's clean console as if it validated the IPC-dependent behavior — a static channel-name cross-reference is a reasonable fallback to mention, but label it as what it is (a code-level check, not a live test), and ask the user to smoke-test the real flow if a proper CDP rig isn't available. See [[retro_cable_box_cdp_autosave_gotcha]] and [[retro_cable_box_architecture_constraints]] for related CDP-testing discipline notes.
