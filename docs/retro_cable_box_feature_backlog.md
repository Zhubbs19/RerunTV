---
name: retro-cable-box-feature-backlog
description: "Prioritized list of not-yet-built features for RerunTV, verified against the actual code on 2026-09-11 — supersedes the 2026-08-04 tier list, which had gone badly stale"
metadata: 
  node_type: memory
  type: project
  originSessionId: 0c831b26-ee28-43d9-b436-f794fa6cc000
  modified: 2026-09-11T00:00:00.000Z
---

## Read this first

Rewritten 2026-09-11 after a fresh feature-and-functionality pass. The previous version was
a snapshot from 2026-08-04 and had drifted a long way from reality — it still listed closed
captions, SAP, program reminders, pay-per-view, breaking news, weather-driven signal
degradation and the marathon takeover as open, all of which had shipped. Two of them were
re-proposed in the 2026-09-11 pass purely because this file said they were open.

**Every status below was checked against the code on 2026-09-11**, not carried forward on
trust. Do the same before building anything from it: this is a snapshot, not living state.
See [[project_feature_pass_2026_09_11]], [[project_tier2_features]] and
[[project_tier3_subchannels_mosaic]] for what the 2026-09-11 pass actually shipped, and
[[retro-cable-box-quality-of-life]] for the separate setup-screen/workflow track.

## Open — worth building, roughly in priority order

1. **Printable / exportable TV Guide grid.** A week of the guide as a printable page. Cheap
   now: `window.api.openPrintableManual` already takes generated HTML and opens a real
   printable window (see `buildPrintableManualHtml`, setup-settings.js) — the guide page
   would reuse that exact plumbing with `getChannelSchedule` output instead of the manual.
2. **Procedurally generated title-card bumpers.** Canvas-drawn "NOW PRESENTING" / "COMING
   UP" slates so the interstitial pool doesn't need video assets for these. Partly covered
   already: text-based interstitials with a `{channel}/{time}/{nextTitle}` template
   vocabulary exist (`renderDynamicText`). What's missing is era-styled *artwork* rather
   than plain text, so this is an aesthetic upgrade, not a new capability.
3. **A live "fire this break now" trigger.** The setup screen's PREVIEW POOL button
   (setup-interstitials.js) plays pool entries in sequence for checking, and the flow
   builder's FORCE options control schedule-time placement. Neither fires a chosen
   interstitial into the *live* broadcast on demand, which is what QA-ing a break actually
   wants. Small.
4. **Second "companion box" window** — a real second `BrowserWindow` on a second display,
   independently tuned. **Explicitly excluded by the user on 2026-09-11**; keep it here for
   completeness, but don't start it without asking again.

## Rejected, with the reason — don't re-propose without new information

- **Voice remote via `SpeechRecognition`.** Chromium's implementation ships audio to Google.
  That breaks the offline-first rule for a gimmick. (The `speechSynthesis` side, used by the
  EAS voiceover, is local and fine — the two are not comparable.)
- **True picture-in-picture while surfing.** Needs two simultaneous decodes, against the
  one-`<video>`-element rule (see [[retro-cable-box-architecture-constraints]]). Superseded
  in practice by the CH 100 mosaic, which gets the same "see what else is on" result out of
  paused stills and is more period-accurate anyway.
- **AI-generated episode blurbs.** Would need an external model call for something currently
  free, instant and offline.

## Shipped — listed so nobody re-proposes them

- **Recording / "taping" (shipped 2026-09-11, `plugins/tape-deck`).** CH 101, the tape
  deck. The route the note below predicted is the one that was built: an ffmpeg
  cut-and-concat over the real source files, driven by core's own schedule engine. Two ctx
  additions made it possible without reimplementing anything — `resolveBreakAt` and
  `nextBreakBoundary` joined `getChannelSchedule` on `ctx.channels` (ctx v3), which together
  let a plugin reconstruct a channel's whole broadcast, shows and breaks alike, for any
  range. Decisions taken and not worth relitigating: cuts are **re-encoded**, not
  stream-copied, so a segment starts on the frame the schedule says (uniform MPEG-TS pieces,
  then a `-c copy` concat); a channel whose files are unresolvable provider refs is
  **refused by name** rather than taped with holes; a break core draws as a card over a
  paused picture becomes black of the same length, and a text-only station ID is **not** a
  segment at all, because core overlays that one without pausing anything. Because the
  segment list is computed up front, a tape finishes faster than the broadcast it records.
  Playback is the point of the channel: a shelf of cassettes you load into a VCR (slot,
  clunk, blue screen, tracking, auto-rewind) or of discs you load into a DVD player (tray,
  spin-up, title menu whose chapters are the recording's own show/break structure). Formats
  are real: VHS SP/LP/EP, DVD SD and Blu-Ray each fix their own resolution and refuse a range
  longer than they actually held, and UNLIMITED opts out of both. A tape's format is written
  into the tape, so one shelf holds cassettes and discs and each loads in its own machine.
  Recording over a cassette wears it — generation loss encoded into the file, compounding and
  permanent — while a disc re-burns clean, which is the honest asymmetry rather than an
  oversight. Every tape takes front and back cover art, a label on the physical cassette or
  disc inside the case, and a cassette colour. The deck's seven sounds and three animations
  all ship with synthesized/CSS defaults and can each be pointed at a user's own file — a
  custom sound is decoded and played through core's own `sfxGain` node so it obeys mute and
  volume, and a custom animation is an IMAGE (GIF/APNG/WebP) rather than a video, precisely
  so nothing competes with the one `<video>` element at the moment it is about to be handed
  a tape.

  Two core bugs surfaced building it, both fixed here: `seedBundledPlugins()` refreshed an
  app-owned plugin copy by copying OVER it, so a file the bundled source stopped shipping
  survived forever, changed the folder's hash, and made the plugin read as `modified` — which
  blocks activation until the user approves an integrity change they never made. And an
  isolated plugin's `--allow-fs-read` grants never included the ffmpeg binary core resolved
  for it, so on a build that finds ffmpeg on PATH (this one — it deliberately doesn't bundle
  GPL ffmpeg) `ffmpeg-transcode` concluded the binary wasn't there and refused to load,
  silently taking the codec fix, caption extraction, thumbnail capture and recording with it.

Everything the old tier list tracked is done. Compressed, with the surprising ones first
because those are the ones that keep getting re-suggested:

- **Weather-driven signal degradation** — `plugins/noaa-weather` (`signalDegradation`, real
  alert severity drives it). **Sign-on / sign-off ceremony** — `signOff`/`signOn`
  interstitial types plus the persistent off-air card. **Marathon / event takeover** — block
  modes (loop / marathon / daily-advent / finale) in the schedule editor. **Scrambled
  premium-channel gag** — `ch.notSubscribed`'s "please call your cable company" card.
  **Orphan-reference validation** — the channel health check reports orphaned presets,
  orphaned and dangling pool entries.
- Closed captions, SAP audio, breaking-news interrupts, pay-per-view, the teletext arcade,
  the ticker, the screensaver, the SMPTE pattern, vintage audio texture — all plugins now.
- Program reminders (with a managed list, auto-tune and desktop notification as of
  2026-09-11), seven-day program search, the time machine, the OSD skin engine grown to 23+
  theme packs, dayparting, weekly grids, calendar date overrides, CRT burn-in, VHS wear,
  auto-curation, the LAN viewer, the companion app, auto-update.
- From the 2026-09-11 pass: schedule-drift correction, the display wake lock, air checks,
  the viewing history log, channel SCAN, details-card poster frames, the OS media session,
  opt-in sub-channel numbering (7.1), and CH 100 the mosaic preview channel.

**Why:** this list took three separate brainstorming and prioritization passes to produce
originally, and a fourth to correct. Losing it means re-deriving it — and, as 2026-09-11
proved, re-proposing things that already exist.

**How to apply:** when the user asks "what's next," start at the top of **Open** above. Grep
the code to confirm an item is still open before quoting it as work to do, and update this
file in the same session as the work rather than leaving it to rot again.
