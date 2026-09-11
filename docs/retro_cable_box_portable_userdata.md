---
name: retro-cable-box-portable-userdata
description: "The app now runs with real user data in the portable <repo>/userData/ folder next to the app, not the OS-profile %APPDATA%/retro-cable-box path — switched 2026-08-17, discovered independently during CDP verification of the same day's plugin migration"
metadata: 
  node_type: memory
  type: project
  originSessionId: 86d9f1bd-c3a1-4f78-be0f-b3a872f80695
  modified: 2026-08-18T02:14:51.577Z
---

As of 2026-08-17, `retro-cable-box`'s live/real user data (channels.json, backups, plugins, window-state, party-uploads, spotify-cache) lives in the **portable local folder** `C:\Users\zhubb\VSCodeProjects\retro-cable-box\userData\`, not the OS-profile default `%APPDATA%\retro-cable-box\`. The OS-profile folder still exists on disk with older/stale data (last touched around 2026-08-17 12:28-12:42) but the running app no longer reads or writes it.

**Why:** the user made this switch earlier in the day on 2026-08-17, in a session/change not captured in any existing memory file — I only discovered the *effect* of it independently, the hard way, while CDP-verifying the ticker/screensaver/vintage-audio/smpte-test-pattern plugin migration (see [[retro_cable_box_core_subsystems_as_plugins]]): backed up the OS-profile `channels.json` before testing, ran the app, and found the OS-profile `plugins/` folder still empty afterward even though the plugins had clearly loaded — turned out the app had switched to the portable folder, and my backup/diff was against a file the app was no longer touching at all. `main.js` itself has long had a one-time migration (copies `OWN_DATA_ENTRIES` from the OS-profile path into `<repo>/userData/` the first time that local folder is missing and the OS-profile one exists) — it's plausible this migration is what the user triggered today, or the switch happened some other way; the mechanism is documented in code but *when*/*why* the user actually flipped to it today is not captured anywhere, including this note.

**How to apply:** Any future session doing a CDP boot test or otherwise needing to find/back up/diff this app's real config must check `C:\Users\zhubb\VSCodeProjects\retro-cable-box\userData\` first (does it exist? does it have a recent `channels.json`?) rather than assuming the OS-profile `%APPDATA%\retro-cable-box\` path is still authoritative. See [[retro_cable_box_cdp_autosave_gotcha]]'s fifth gotcha entry for the full mechanics and a repair recipe. If asked, tell the user this gap exists in memory rather than guessing why/when the switch happened — this note only captures the *current state*, not the history behind it.
