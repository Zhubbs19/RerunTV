# 07 — Media library and auto-tagging

Status: **built** — every part of this doc has a first version in the app: identity and scanning
(§4), the store and re-anchoring (§3), auto-tagging with a grouped review queue (§5), saved queries
and smart channels with `channel.rematerialize` (§6), and the verified migration (§7), behind
setup › LIBRARY (CATALOGUE · REVIEW · SMART CHANNELS). §8 lists what was verified live and what is
still open. Depends on: C2 (02), C3 (05), 06 (remote folder browsing).
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
changes from X to Y".

**Correction (2026-09-16): an append is not schedule-safe.** This section used to say library sync
could auto-rematerialize "appends only", because files added at the end "don't move the current
anchor position". They don't move the anchor, but a channel airs

```
elapsed = ((now - anchor) / 1000) mod totalDuration
```

and appending changes `totalDuration`. The modulus changes, `elapsed` lands somewhere else, and a
channel mid-episode can cut to a different programme the moment a sync finishes — exactly what C6
forbids. `tests/library-reanchor.test.js` demonstrates it against the real `computeSourcePosition`.

**What is built instead: re-anchoring.** `renderer/js/library/reanchor.js`'s
`reanchorForPlaylistChange()` takes the old playlist, the new one, the anchor and the instant the
schedule is being evaluated at, and returns the anchor that leaves the currently-airing file at the
same offset in the new playlist. New content appears from the next loop onward; nothing jumps.
It preserves the loop count too, so a channel doesn't announce everything as a NEW EPISODE again
just because its playlist grew.

It refuses rather than guessing when it cannot keep its promise — the airing file was removed, a
playlist is empty, durations are zero. A refusal is not a failure: it means the change needs the
`diffSchedules` preview and a person. So unattended rematerialization is allowed when, and only
when, re-anchoring succeeds; that is a wider set than "appends" and a safer one.

Library sync uses it (`applyPlaylistPreservingAir`). Before this, a folder sync set
`channel.files` without moving the anchor, so a sync that added one episode could cut away from
what was on. It now keeps the airing file at its offset, and its results row says "what is on the
air changed" only when that was impossible (the airing file itself was removed).

Two details that matter:
- `atMs` must be the time the schedule is actually evaluated at, with break-drift compensation
  (`S.contentLostMs`) already subtracted. Passing the raw clock mid-break preserves the wrong frame.
- A file that appears more than once in the new playlist resolves to the occurrence nearest its old
  position, ties to the earlier index, so a rebuild that mostly preserves order barely moves the
  anchor and the result does not depend on iteration order.

Per-file metadata moves from `ch.files[i]` to `library.items[id]`. Channel-specific overrides
that genuinely differ per channel (a custom breakpoint for one channel's edit) live in
`ch.fileOverrides[itemId]`.

## 4. Scanning and identity

- **Fingerprint** = size + a hash of the first 1 MB, with mtime alongside as a cheap pre-filter
  for deciding what to re-read. **Built**: `main/library/identity.js`.

**Correction (2026-09-16): a fingerprint is matching EVIDENCE, not an identity.** This section
used to say relinking "becomes automatic". Two different files can share a size and a first
megabyte — an encoder's identical leader, two rips of the same disc, a truncated copy — and one
file's mtime changes for reasons unrelated to its bytes: a copy, a backup restore, a sync client
touching it. So `classify()` returns a verdict with a confidence and the caller decides:

| Verdict | Meaning | Automatic? |
|---|---|---|
| `same` | still at the ref it was catalogued at | yes |
| `moved` | exactly one catalogued item has this content | yes — this is the "moved: 137 items" case |
| `ambiguous` | more than one item has this content | **no** — review queue, nothing moves |
| `replaced` | an item is catalogued at this ref but the content there is different | **no** — the item is not repointed and its metadata is not transferred, or a re-encode silently inherits the wrong title |
| `new` | nothing known matches | n/a |

`isAutoApplicable()` is the single definition of what may relink unattended, so the answer lives
in one place rather than at each call site.

- **Changed mtime, same size and head** → the same item. mtime alone never makes something a
  different file.
- **Same size and mtime, different head** → different content.
- A provider root's fingerprint is its id plus etag/modified, with no head hash; `sameContent()`
  treats a missing head as no evidence, so a provider item is never matched on size alone.
- Scans run host-side (headless-capable, 06), incrementally per root, with ffprobe durations
  cached by fingerprint (the existing duration probe stays the fallback).
- Provider roots use the media-source plugin contract's listing calls; fingerprint = provider
  id + etag/modified.
- `renderer/js/library/relink.js`'s manual flow is replaced only for the `moved` case. The
  `ambiguous` and `replaced` cases are what that flow is *for*, and they still need it.

**Built (2026-09-16).** `main/library/scan.js` and `main/library/service.js`. Rules added once
the scan met real data:

- **Migrated items adopt.** An item with no content evidence at all (every item straight out of
  migration, which fingerprints lazily) at the ref being scanned is `same` with `adopt: true`, not
  `replaced`. Otherwise the first scan of the real lineup would put 2,173 files in review.
- **Review decisions stick.** Resolving a `replaced` entry as "something else" marks the old item
  `detached`: it keeps its metadata, and scans never match it or report it missing again. Either
  decision returns the items whose duration must be probed again.
- A scan refuses a root with more than 5,000 media files rather than scanning part of it, and a
  root that is not reachable. Durations are probed by the renderer and sent back. An unreadable
  file gets **no** duration (not the playlist's 180 s fallback), and smart channels skip it.

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

**Built (2026-09-16): steps 1 and 3. Open: 2, 4 and 5.** `renderer/js/library/tagging.js` reads
the ref and duration only: series from the folder under a library container or the filename
prefix before an episode code; season/episode codes (`S02E01`, `2x01`, and the library's
`S1953E05` season-as-year convention); year and era; duration bands; and sports (a keyword *and*
at least 30 minutes, so "Baseball Bugs" is not a game). Genre folders (Cartoons, Commercials,
Sports…) are collections, not series. The episode-code patterns are bounded by "not a letter or
digit" rather than `\b`: an underscore is a word character, so with `\b`,
`Looney_Tunes_-_S1953E05` and every other underscore-named file lost its episode number.

`suggestGroups` makes one group per series (or folder), with only the fields that every item still
needing them agrees on, and the reason for each. REVIEW shows each group as one card: APPLY, or
CHOOSE ITEMS to untick exceptions. `acceptGroup` writes `user-accepted` provenance, and a `user` or
`user-accepted` field is never suggested again. Accepting changes the catalogue only.

Open: embedded container tags (step 2), mapping to the Tag Taxonomy vocabulary (step 4), the
opt-in metadata plugins (step 5), and editing one item's fields by hand.

## 6. Smart channels

A channel source of `type: 'query'` materializes all matching items with the channel's order
policy (natural series order, seeded shuffle, weekly rotation). Queries are also usable in
blocks (02) and templates (08): "Saturday 7–11 AM: `kind=episode AND genre=cartoon AND
era<=1999`".

**Built (2026-09-16).** `renderer/js/library/query.js`: a `where` is plain JSON (equality, any-of,
`gte`/`lte`/…, `text`, `any`, `not`), validated when saved. Order policies: series order, by
title, a shuffle that is stable for its seed (so a rebuild with nothing new moves nothing), and
newest first. `planChannelFiles` keeps folder files first, de-duplicates, and returns the anchor
from `reanchorForPlaylistChange`.

SMART CHANNELS in setup:

- Saved queries with a live match count. The form covers kind, genre, era, series and text; a
  query it can't represent keeps its conditions, and only its name and order can be edited.
- BUILD CHANNEL makes a new channel anchored now.
- REBUILD, for any channel with query sources, previews added and removed programmes, what is on
  now ("stays on" or "changes from X to Y") and the next 7 days of `diffSchedules`. It then
  dispatches **`channel.rematerialize`**: files, anchor, sources and `materializedAt` as one undo
  step that restores all of them exactly.
- "Rebuild smart channels after a scan" (`librarySync.rebuildSmartChannels`, off by default)
  rebuilds unattended **only** when re-anchoring succeeds. Anything else is named in the scan's
  notice and waits for a person.

**Verified live** (`tests/ui/verify-library-ui.mjs`): a saved query built CH 12; an unchanged
rebuild did nothing; broadening the query previewed "what's on now stays on", rebuilt with the same
episode still airing at the same point, and undo restored the channel exactly; with the setting on,
a scan rebuilt it unattended.

Open: query sources in blocks (02) and templates (08); a weekly-rotation order policy.

## 7. Migration (config schema migration + library v1)

1. Build the library index from existing channels: every `ch.files[i]` becomes an item
   (fingerprinted lazily), with metadata copied. **Conflict policy (built,
   `identity.resolveConflict`)**: provenance first — `user` > `user-accepted` > `plugin` >
   `embedded` > `path` — then recency, then the owning channel number as a stable tiebreak.
   "Most recently edited wins" alone is not deterministic, because timestamps are often absent
   or equal and the winner then depends on the order the walk happened to take; running the same
   migration twice has to produce the same library. Losing values are kept as `fileOverrides`.
2. Channels keep `files` exactly (order, durations, anchors) and gain `item` ids + `sources`
   derived from `folders`.
3. `diffSchedules` over 60 days must be empty for every channel — otherwise abort that
   channel's migration and keep it legacy.
4. Old per-file metadata fields remain readable for one release (dual-read), then removed.

**Built (2026-09-16).** `main/library/migrate.js` splits this into
steps that can each be checked before anything is written:

- `planMigration(config)` is pure. Each file gains an `item` id; path, duration, order, anchor
  and the file's own metadata are untouched (dual-read). Folders become roots one to one —
  consolidating sibling show folders under a common parent would be a guess about somebody's
  disks. Item ids are derived from the path at creation, so the same migration twice gives the
  same library; after that they never change (the store). Conflicts resolve by
  `identity.resolveConflict`, and the losing channel's value goes to `fileOverrides`.
- Verification is the real renderer `diffSchedules`, per channel, breaks included.
- `finalizeMigration` keeps only channels with an empty diff. A channel with **no** verdict is
  rejected as `not-verified`, not assumed fine. A rejected channel is restored exactly and
  nothing in the library refers to it.

**Dry run against the installed lineup** (`scripts/library-migration-dryrun.js`, reads a
channels.json and writes only a report elsewhere): **14/14 channels identical over 60 days**,
0 conflicts, 2,173 items in 26 roots, 0.6–4.6 s per channel (Boomerang's 1,329 files is the
slow one). The source file's SHA-1 was identical before and after.

**In the app** (CATALOGUE › CHECK MY CHANNELS):

1. The host plans from a copy of config.
2. The renderer checks each channel with `diffSchedules` over 60 days, breaks included, in 5-day
   chunks with a yield between them so the progress line keeps painting
   (`renderer/js/library/migration.js`). A table shows each channel's verdict.
3. BUILD LIBRARY finalizes on the host and **saves the library first**. Only then are `item` ids
   and `fileOverrides` attached to the live config in place, all or nothing with every path
   re-checked, as one `Build media library` patch.

The check stops if config changes underneath it, and "changes" means content. The generation
counter alone is not enough: library sync's bookkeeping (and the last channel tuned) bump it on a
timer without changing anything a schedule reads, and would otherwise abort minutes of checking.

Undoing `Build media library` removes the ids from config but not the saved library. CATALOGUE then
says no channel is linked, and offers to check and build again, replacing the library.

The guard is proven to bite, not just to agree: `tests/library-migrate.test.js` reorders a
planned channel and nudges a duration by one second, and both are caught; on the real lineup,
swapping two Office episodes changed 52 programmes over the window and CH 6 was rejected and
restored byte-for-byte.

## 8. Acceptance criteria

- Moving `J:\Media Center` to another drive and updating the root relinks every channel with
  no schedule change. **Built:** UPDATE LOCATION rewrites path text at a folder boundary in config
  and library together (`root-move.js`). It previews every touched channel over 14 days, keyed by
  library item rather than path, and refuses if anything would air differently. **Verified live** with YT Archive moved to a synthetic `Z:` path and back: CH 420 and a smart channel repointed, every other channel byte-identical, library root and items updated, the unreachable-path warning shown, nothing on disk touched, and all paths as at the start afterwards. A whole-drive move has not been done for real.
- Tagging 1,000 new episodes by series takes < 10 review actions. **Met in tests:** 1,000 episodes
  across five series make 5 groups, and accepting each once covers all 1,000. **Live:** the real library produces 29 groups (Looney Tunes 1,002, SpongeBob 267, Tom and Jerry 161, Blue's Clues 144, The Office 137, …); accepting one with an item unticked tagged only the ticked item and left config unchanged.
- A query channel "all Christmas specials" builds in < 5 s for a 5,000-item library. **Met in
  tests**, well under a second in Node.
- Migration of the real installed lineup produces an empty 60-day schedule diff. **Met** in the
  dry run (14/14). **Verified live** through CATALOGUE on a copy of the installed profile: 14/14 identical in 40 s with the progress line updating throughout, 2,173/2,173 files given ids, paths, durations and anchors unchanged, one `Build media library` undo step. The first scan of YT Archive adopted both files with nothing sent to review.

**2026-09-17:** a single-item editor and root/item removal are now built. `main/library/service.js`
gained `removeRoot`/`removeItem` (host-only, not in `REMOTE_METHODS` — same "whole-library
rewrites stay on the host window" rule as everything else that touches more than one item) over
the store's own `removeRoot`/`removeItem`, which already existed but were never wired to
anything. `renderer/js/setup/library.js`'s CATALOGUE tab gained a "find an item" search (title or
filename, top 25 matches) with EDIT…/REMOVE per row, a FORGET… button per location (items are
left behind on purpose — a root is often removed because a drive is unplugged, and dropping
every item would lose tags and review decisions; `orphanedItems()` already reports them), and an
EDIT… link on every item in REVIEW's per-group "CHOOSE ITEMS…" list. The editor covers title,
kind, series name/season/episode, genre/era facets, rating and tags, and marks every field it
touches `provenance: 'user'` so no later automatic pass overwrites a hand edit (§5's own rule).
Neither removal path touches a channel's materialized `files` (C6) — a channel that already
played an item keeps playing it exactly as it does now; only a later, previewed rematerialize
would stop offering it as a candidate.

Still open across the doc:

- §5 steps 2, 4 and 5 (embedded container tags, taxonomy mapping, opt-in metadata plugins).
- Queries in blocks and templates.
- Provider roots have no etags, so a provider item keeps its identity by ref alone.
- Old per-file metadata is still dual-read (§7 step 4).

## 9. Risks

- Migration is the riskiest change in the set: guarded by per-channel diff-or-abort and the
  existing backups (`backupUserDataForUpdate`).
- Library size in memory for very large collections — shard by root; load items lazily in
  clients, which only need materialized playlists to play.
- Fingerprint collisions on identical files across roots: treated as the same item by design
  (dedupe), with an "Unlink" escape hatch.
