# 07 — Media library and auto-tagging

Status: proposed (P4). Depends on: C2 (02), C3 (05), 06 (remote folder browsing).
Owns contract **C6**. Consumed by: 08, 09.

## 1. Problem

- Media lives **inside channels**: each channel has folders and a `files` array holding
  title, tags, facets, description, breakpoints and TMDB matches. The same show on two
  channels means two copies of its metadata; moving a folder means relinking per channel
  (`renderer/js/library/relink.js`).
- Tags drive presets, flows, the pool, auto-curate and genre colours, but most real files have
  none. The installed lineup mostly has only channel-level tags, and the Tag Taxonomy page shows
  tags like `spongebob` on 272 files.
- Provider-backed media (`mediasource:` refs: Google Drive, Jellyfin, WebDAV, archive.org)
  already work per channel but have no shared catalogue.
- "Smart channels" (all 90s sitcom episodes, every Christmas special) are impossible without
  hand-building folders.

## 2. Goals

- A **library**: every media item catalogued once, with stable IDs, metadata and tags shared
  by every channel that uses it.
- Channels reference **folders, items, or saved queries** from the library.
- **Auto-tagging** that proposes series/season/episode, genre, era, rating and kind from
  local signals (filenames, folder structure, embedded tags, durations), optionally enriched
  by opt-in metadata plugins.
- **Never change what airs by surprise** (C6).

Non-goals: a Plex/Jellyfin replacement UI for browsing and playing on demand (the product is
linear TV); server-side transcoding catalogues.

## 3. Data model

Stored in `userData/library/` (its own `schemaVersion`), not in `channels.json`:

```jsonc
// library/index.json (sharded by root if large)
{
  "roots": [{ "id": "root-media", "ref": "J:\\Media Center", "kind": "local" },
            { "id": "root-jf", "ref": "mediasource:jellyfin:…", "kind": "provider" }],
  "items": {
    "itm_9f2c…": {
      "ref": "J:\\Media Center\\TV Shows\\The Office (2005)\\S02E01.mkv",
      "root": "root-media",
      "fingerprint": { "size": 734003200, "mtime": 1715000000, "head": "sha1:…" },
      "duration": 1260.4,
      "kind": "episode",                     // episode | movie | short | bumper | commercial | music | other
      "series": { "id": "ser_office", "season": 2, "episode": 1 },
      "title": "The Dundies",
      "facets": { "genre": ["sitcom"], "era": ["2000s"], "mood": [] },
      "rating": "TV-14",
      "tags": ["office"],
      "provenance": { "title": "filename", "genre": "user", "rating": "tmdb" }
    }
  },
  "series": { "ser_office": { "name": "The Office", "facets": { "genre": ["sitcom"] } } },
  "queries": { "q_90s_sitcoms": { "name": "90s sitcoms", "where": { "facets.genre": "sitcom", "facets.era": "1990s", "kind": "episode" } } }
}
```

Channel side (in `channels.json`, via a config schema migration — see 00 §5):

```jsonc
{
  "number": 6,
  "sources": [{ "type": "folder", "root": "root-media", "path": "TV Shows\\The Office (2005)" },
              { "type": "query", "query": "q_90s_sitcoms" }],
  "files": [ /* MATERIALIZED ordered playlist: { item: "itm_9f2c…", path, duration } */ ],
  "materializedAt": 1757700000000
}
```

**C6 rule:** schedule math reads only `ch.files` (materialized, ordered, with durations), exactly
as today. The library changes *candidates*; `channel.rematerialize` (a command) rebuilds
`files`, and its confirmation shows `diffSchedules` (02) — "adds 12 episodes; what's on now
changes from X to Y". Library sync can auto-rematerialize **appends only** (new files added at the
end of an ordered playlist don't move the current anchor position) when the user opts in, as
library sync does today.

Per-file metadata moves from `ch.files[i]` to `library.items[id]`. Channel-specific overrides
that genuinely differ per channel (a custom breakpoint for one channel's edit) live in
`ch.fileOverrides[itemId]`.

## 4. Scanning and identity

- **Fingerprint** = size + mtime + a hash of the first 1 MB. It survives renames and moves
  within roots, so relinking becomes automatic ("moved: 137 items"), replacing most of
  `renderer/js/library/relink.js`'s manual flow.
- Scans run host-side (headless-capable, 06), incrementally per root, with ffprobe durations
  cached by fingerprint (the existing duration probe stays the fallback).
- Provider roots use the media-source plugin contract's listing calls; fingerprint = provider
  id + etag/modified.

## 5. Auto-tagging pipeline

Local-first (offline invariant), each step producing **suggestions with provenance**:

1. **Path parsing** — series/season/episode from `S02E01`, `2x01`, folder names; movie year
   from `(1946)`; release-tag stripping (reuse `renderer/js/core/util.js` `stripReleaseTags`, `guessCleanTitle`,
   `suggestFacetsFromPath`).
2. **Embedded metadata** — container tags (title, genre, year, show) via ffprobe; audio tags
   (music-choice's ID3/FLAC/MP4 parser).
3. **Structure heuristics** — duration bands (≤ 60 s → commercial/bumper candidates; 20–24 min
   → half-hour episode; 80–150 min → movie), sibling consistency (a folder whose siblings are
   all `sitcom` suggests `sitcom`).
4. **Taxonomy mapping** — normalize to canonical genres/eras/moods (existing Tag Taxonomy).
5. **Opt-in enrichment** — metadata plugins (tmdb-metadata today) fill ratings, descriptions,
   posters, genres. Clearly a network exception, per-plugin, off by default.

Review UX (Library › Tags, desktop + web panel): a queue grouped by series/folder — "Apply
*sitcom, 2000s, TV-14* to 137 items in The Office?" — one action per group, individual
exceptions editable. Accepted suggestions become `provenance: 'user-accepted'`; user edits
always win over later automatic passes.

## 6. Smart channels

A channel source of `type: 'query'` materializes all matching items with the channel's order
policy (natural series order, seeded shuffle, weekly rotation). Queries are also usable in
blocks (02) and templates (08): "Saturday 7–11 AM: `kind=episode AND genre=cartoon AND
era<=1999`".

## 7. Migration (config schema migration + library v1)

1. Build the library index from existing channels: every `ch.files[i]` becomes an item
   (fingerprinted lazily), with metadata copied (conflicts between channels resolved by most
   recently edited, others kept as `fileOverrides`).
2. Channels keep `files` exactly (order, durations, anchors) and gain `item` ids + `sources`
   derived from `folders`.
3. `diffSchedules` over 60 days must be empty for every channel — otherwise abort that
   channel's migration and keep it legacy.
4. Old per-file metadata fields remain readable for one release (dual-read), then removed.

## 8. Acceptance criteria

- Moving `J:\Media Center` to another drive and updating the root relinks every channel with
  no schedule change.
- Tagging 1,000 new episodes by series takes < 10 review actions.
- A query channel "all Christmas specials" builds in < 5 s for a 5,000-item library.
- Migration of the real installed lineup produces an empty 60-day schedule diff.

## 9. Risks

- Migration is the riskiest change in the set: guarded by per-channel diff-or-abort and the
  existing backups (`backupUserDataForUpdate`).
- Library size in memory for very large collections — shard by root; load items lazily in
  clients, which only need materialized playlists to play.
- Fingerprint collisions on identical files across roots: treated as the same item by design
  (dedupe), with an "Unlink" escape hatch.
