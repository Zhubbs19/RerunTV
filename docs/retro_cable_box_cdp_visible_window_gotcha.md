---
name: retro-cable-box-cdp-visible-window-gotcha
description: "A boot-test electron launch that fails to actually attach --remote-debugging-port becomes a real, visible, interactive window against production data — verify the CDP port bound before treating a launch as disposable"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ae09312f-5985-435a-a33c-42a4f9ed4958
  modified: 2026-08-16T20:35:31.547Z
---

2026-08-16: during a setup-UI CDP audit, one `electron . --remote-debugging-port=9333 --remote-allow-origins=*` launch (via a backgrounded Bash call) silently didn't pick up the flags — `Get-CimInstance Win32_Process` showed its actual command line as just `electron.exe "<project dir>"`, no debug port at all. `curl localhost:9333/json/list` failed to connect, confirming no CDP attach. Because this project's CDP testing pattern always points `userData` at the real production config dir ([[retro-cable-box-architecture-constraints]]), this wasn't a harmless dead process — it was a completely normal, visible, interactive Electron window sitting on the user's real screen, pointed at their real config. The user saw it, assumed it was "the app," and used it normally (changed the theme setting) before it got killed a minute or so later once the failed CDP connection was noticed.

**Why this matters:** every other launch in this session correctly attached CDP and was driven invisibly via WebSocket `Runtime.evaluate` — the user never saw or touched those. This one didn't, and the difference is invisible from the launcher's side (the process starts fine either way, `curl`/CDP failing is the only signal). A `cp backup -> live` restore performed shortly after (to undo an unrelated in-session mistake) nearly clobbered the user's real, intentional theme change made through that window — caught only because a permission-classifier block on a follow-up file write happened to stop it, and the user then explicitly said "I changed the theme" when asked.

**How to apply:** before treating any launched instance as safe to drive/kill/ignore, confirm `curl http://127.0.0.1:<port>/json/list` (or equivalent) actually returns a target — don't just check the process exists in `tasklist`/`Get-Process`. If the debug port never bound, treat that window as a real, user-facing instance: don't blind-kill it without checking whether the user is interacting with it, and don't assume any config diff it produced is test noise — it may be a real, intentional edit. Also: a blanket `cp backup -> live` config restore is riskier than it looks, exactly because of this — it doesn't distinguish "field I know my test mutated" from "field that changed for a legitimate reason I don't know about" (a real edit through an accidentally-visible window, in this case). Prefer patching only the specific fields a test is known to have touched over a full-file restore, especially once a session has run for a while and the "clean baseline" backup itself might be stale.
