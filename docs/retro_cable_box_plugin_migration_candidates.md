---
name: retro-cable-box-plugin-migration-candidates
description: "All 6 originally-flagged external-dependency/LAN-server features are now plugins (2026-08-17/18) — this list is closed"
metadata: 
  node_type: memory
  type: project
  originSessionId: 52e76aac-40e2-49cc-b1c2-96da84ca1476
  modified: 2026-08-17T17:28:37.156Z
---

All features originally flagged for migration onto the [[retro_cable_box_plugin_system]] are now shipped as plugins. This closes the list — see [[retro_cable_box_plugin_system]] for the mechanics (dependsOn ordering, shared ctx.services, fallback IPC stubs).

- **TMDB metadata** → `plugins/tmdb-metadata/` (2026-08-17)
- **NOAA weather/EAS** → `plugins/noaa-weather/` (2026-08-17)
- **Spotify Connect** (librespot) → `plugins/spotify-connect/`, vendor binary moved to `plugins/spotify-connect/librespot/` (2026-08-17)
- **YouTube channel** (yt-dlp) → `plugins/youtube-music/` (2026-08-17)
- **Party web app** → `plugins/party-channel/`, static assets moved to `plugins/party-channel/party/` (2026-08-18)
- **Universal web-remote** → `plugins/universal-remote/`, static assets moved to `plugins/universal-remote/remote/` (2026-08-18)

**Also shipped along the way:** `plugins/ffmpeg-transcode/` — not on the original list, but Spotify/YouTube's ffmpeg pipelines forced the question of where ffmpeg's GPL-licensed binary belongs. Resolved as a "bundled core plugin" (own manifest, ships enabled by default, but a real disable-able plugin) — core video transcode and party thumbnail capture depend on it too, not just the two audio plugins.

If a new external-dependency or LAN-server feature gets built in this app going forward, build it as a plugin from the start (see [[retro_cable_box_plugin_system]]'s "How to apply") rather than wiring it into core — that's now the established default, not just an aspiration.
