---
name: retro-cable-box-youtube-music-and-discord
description: YouTube music feature (CH4/its own channel) scope decisions + a planned separate Discord bot for whole-box control
metadata: 
  node_type: memory
  type: project
  originSessionId: ca83d59a-147e-48c0-b828-2e6296352f47
  modified: 2026-08-12T00:38:47.001Z
---

YouTube search-and-play was added to CH4 (Spotify Connect channel) via yt-dlp + the bundled ffmpeg, mirroring the user's own Discord bot ZMusicBot's yt-dlp-based approach (`C:\Users\zhubb\DiscordBots\ZMusicBot\cogs\music.py`) for search/extraction and its exact ffmpeg filter strings for audio effects (bassboost, EQ presets, nightcore/vaporwave/chipmunk/demon speed-pitch combos, 8D/chorus/flanger/reverb/karaoke/distortion/underwater/telephone/tremolo/vibrato — see `_make_ffmpeg_options`/`_EQ_PRESETS` in that file for the canonical filter graph).

Scope grew across a session into a larger plan the user confirmed:
1. Queue + transport controls (skip/pause/resume/stop/shuffle/loop/remove) — a real queue, not just one-track-at-a-time.
2. Audio effects (ffmpeg filters, ported from ZMusicBot as above).
3. Novelty commands (rickroll/roast/rate/vibe/coinflip/blame) — ported from ZMusicBot's canned-random-response style; best fit is the PARTY page (guest-facing, multi-person context matches Discord's) rather than the solo CH4 UI.
4. YouTube split into its **own channel**, not just a tab on CH4/Spotify Connect.
5. Party web app (`party/`) gets a jukebox panel (search + queue + vote-to-skip) alongside the above.

**Why:** user explicitly asked for all of the above after initially scoping down, then expanding back out — see [[retro_cable_box_party_channel]] and [[retro_cable_box_spotify_connect]] for the features this integrates with.

**How to apply:** when picking up this work, check current state against the 5 items above — this was built incrementally across one long session and may span multiple follow-ups.

**Discord integration for the whole cable box** (channel control, not just music) is a separate, later idea — explicitly **a different bot from ZMusicBot**, not an extension of it. Still in the "start thinking about architecture" stage as of this note — nothing built yet. Treat bot-token/secret handling with the same care as any credential (never hardcode, never log) when this gets designed.
