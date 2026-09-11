---
name: retro-cable-box-plugin-dev-framework
description: "PLUGIN_DEVELOPMENT.md guide + plugin-dev-kit/starter-plugin template for third-party plugin authors, shipped in both repos"
metadata: 
  node_type: memory
  type: project
  originSessionId: cb18192e-9b5c-467c-b624-7ac340e7b0a4
  modified: 2026-08-18T01:41:05.790Z
---

2026-08-17 session: built the "framework for user-created plugins" the user asked for, on top of the plugin system that was already mature from prior sessions (see [[retro_cable_box_plugin_system]]) but had never been documented for anyone outside these sessions.

**`PLUGIN_DEVELOPMENT.md`** (repo root, both repos) — the complete guide: manifest.json field table, folder layout, both install methods (drop-in + zip), the full main.js `ctx` contract, the full renderer.js API (`registerChannelType`/`registerSettingsPanel` with complete parameter docs including the newer `onOk`/`onKey` hooks and the `data-modal-dismiss`/`data-modal-confirm` convention from [[retro_cable_box_virtual_channels_as_plugins]]), a table of every `window.<fn>` cross-origin exposure that exists as of this session, the config-namespacing convention, and the cross-plugin `window.RCBPlugins.<id>` escape-hatch pattern. Explicitly documents the trust model (main.js = full Node/Electron access, no sandbox) and the real limitation that a third-party plugin's own new IPC channel needs a matching `main/preload.js` (core file) entry to be callable from its own renderer — contextBridge has no dynamic registration.

**`plugin-dev-kit/starter-plugin/`** (both repos) — a copyable, heavily-commented reference plugin demonstrating a channel (with clock, onOk, stop cleanup), a settings panel (persisted greeting field), and a main.js IPC handler — including an honest demo of the preload.js limitation above (the in-UI "PING MAIN PROCESS" button reports "not wired up" until a dev manually adds the preload.js line, rather than pretending it works out of the box).

Deliberately placed **outside** `plugins/` (in a new top-level `plugin-dev-kit/` folder) so it's never seeded into `userData/plugins/` by `seedBundledPlugins()` and never packaged by electron-builder (whose `files` glob only covers `plugins/**/*`) — it's a template to copy, not a real installed plugin.

Verified via CDP by manually copying the starter template into `userData/plugins/starter-plugin`, confirming it discovers/loads with no errors, its channel (900) renders with a live clock and persists a settings-panel greeting across the expected round trip, then removed it and repaired two harmless test artifacts it left in the real channels.json (`lastChannel`, a stray `starterPlugin` config key) — the backup file had already been deleted before the diff came back non-empty, so repaired the two fields directly instead of restoring from backup.

README.md in both repos got a new "Plugins" feature bullet linking to the guide — worded differently per repo (original's mentions Spotify Connect as an example; FOSS's deliberately omits it, matching [[retro_cable_box_foss_repo]]'s "never mention Spotify/YouTube in FOSS" rule). This is the one file that's supposed to differ; everything else (the guide, the starter kit) is byte-identical between repos.

No commits made in either repo per [[retro_cable_box_workflow]].
