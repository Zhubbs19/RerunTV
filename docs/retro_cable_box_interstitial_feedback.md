---
name: retro-cable-box-interstitial-feedback
description: "Channel switching on this project must stay an instant cut, like a real tuner — no loading/status card on the normal tune-in path, not even a debounced one"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 19eb178f-51d7-416b-9f4d-694d9ba0d571
  modified: 2026-08-04T15:14:29.990Z
---

On 2026-08-04 a "PLEASE STAND BY" card was added to show on every channel tune-in
(part of the Tier-2 backlog batch, see [[retro-cable-box-overview]]). The user reported
it made channel switching feel less immediate. First fix attempt: debounce it behind a
`setTimeout(..., 250)` so it only appeared if the load was genuinely slow. The user
reported it **still** kicked in when not needed — debouncing wasn't enough. Final fix:
removed the card from the tune-in path entirely (`playChannelLive` no longer takes a
`showStandby` opt at all, and `tuneToChannel` just calls `playChannelLive(ch)` plain,
matching every other internal retune/resume). Verified by rapid-surfing 8 channels in
one real Electron boot test — the card never appeared once. The `.no-signal-main.is-standby`
CSS variant was deleted along with it since nothing uses it anymore.

**Why:** this app's whole feel is built around channel changes reading as a real tuner
flip, not a loading UI — see the single-`<video>`-element and always-live-position rules
in [[retro-cable-box-architecture-constraints]]. Any visible "loading" state on the
tune-in path undermines that, even a rare/debounced one; two rounds of feedback both
pointed the same direction, so this wasn't a threshold-tuning problem, it was a
"don't put this here at all" problem. The distinct "OFF THE AIR" permanent-failure card
(shown only after 3 consecutive real playback failures on a channel, not on ordinary
tuning) was kept — that's a different, legitimate case the feedback never touched.

**How to apply:** Don't reach for a debounced loading card on the tune-in/channel-change
path again — the user has now rejected that twice. If a future feature needs to
communicate "this is taking a moment," prefer something that doesn't touch the no-signal
overlay during normal channel surfing (e.g. scoped to setup-screen actions, or to a
state that's already abnormal like a confirmed playback failure).
