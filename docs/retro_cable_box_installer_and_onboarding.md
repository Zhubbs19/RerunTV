---
name: retro-cable-box-installer-and-onboarding
description: "Zip plugin installer synced to FOSS, NSIS .exe installer verified for both repos, first-run onboarding screen shipped"
metadata: 
  node_type: memory
  type: project
  originSessionId: cb18192e-9b5c-467c-b624-7ac340e7b0a4
  modified: 2026-08-17T20:50:17.129Z
---

2026-08-17 session: finished the task list from [[retro_cable_box_plugin_system]] — zip-based plugin installer, app-wide installer, and onboarding.

**Zip plugin installer synced to FOSS.** `installPluginFromZip` (main-plugins.js), the `plugins:installFromZip` IPC handler (main.js), preload bridge, INSTALL FROM ZIP… button (index.html/dom.js/setup-plugins.js), and `adm-zip` dependency were all copied/installed into retro-cable-box-foss — core files are byte-identical again per [[retro_cable_box_foss_parity]]. Verified via CDP boot test with the button present and clickable.

**App-wide installer = NSIS .exe (not MSI).** Both repos already had `electron-builder`'s `nsis` win target configured; added an explicit `nsis` block (`oneClick: false`, `allowToChangeInstallationDirectory: true`, `createDesktopShortcut`/`createStartMenuShortcut: true`) so it behaves like a real installer (directory picker, shortcuts, uninstaller) instead of a silent one-click drop. Built and verified both: `Retro Cable Box Setup 1.0.0.exe` (~119MB) and `Retro Cable Box FOSS Setup 1.0.0.exe`. `npm run dist` in either repo produces it under `dist/` (gitignored, deleted after verification — not committed).

**Found + fixed a real bug while polishing the installer**: FOSS's `package.json` `build.appId`/`build.productName` were still identical to the original app's ("com.retrocablebox.app" / "Retro Cable Box") even though [[retro_cable_box_foss_repo]] records the *dev-mode* userData-collision bug as fixed via the top-level `name` field. The **packaged installer identity** was never actually updated — two installed copies would have collided on install path/registry key/Start Menu entry. Fixed: FOSS's build.appId → `com.retrocablebox.foss`, build.productName → `"Retro Cable Box FOSS"`. Worth remembering as a *second, separate* place app identity needs to diverge, distinct from the earlier userData fix.

**Onboarding (first-run welcome screen), new file `renderer/js/onboarding.js`.** Design:
- main-config.js's `loadConfig()` returns `_isFirstRun: true` only when `channels.json` doesn't exist on disk at all — not just `channels.length === 0`, which a returning user can also hit after deleting every channel (shouldn't be re-welcomed).
- app.js's `init()` reads and strips `_isFirstRun`, awaits `showOnboarding()` before `showSetupScreen()` only when both `isFirstRun` and `channels.length === 0` are true.
- `showOnboarding()` is a single-screen modal (not a multi-step wizard — kept intentionally minimal), reusing setup-dialogs.js's `.confirm-dialog`/`.confirm-dialog-box` CSS for visual consistency but implemented as its own module since content/behavior differ (a bullet list, no cancel/backdrop-dismiss — informational only, Escape/Enter/click all just confirm-and-close).
- Verified via CDP: shows exactly once on a truly fresh install (no channels.json), does NOT reappear on a second boot even with an empty-but-existing channels.json (0 channels, file present) — confirming the file-existence gate rather than channel-count gate is the right signal.

Synced to FOSS identically (all four touched files — main-config.js, app.js, onboarding.js, setup.css — diffed clean before copying, confirmed byte-identical after).

No commits made in either repo per [[retro_cable_box_workflow]] — user controls commit timing.
