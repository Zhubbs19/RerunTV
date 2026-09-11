---
name: retro-cable-box-transcode-swap-bug
description: "Fixed 2026-08-16 — bad-codec-file auto-transcode swap could silently fail on Windows, orphaning multi-hundred-MB *.transcoded.mp4 files without ever fixing the channel entry; found and cleaned 23 of them (3.0GB) in the user's real library"
metadata: 
  node_type: memory
  type: project
  originSessionId: ae09312f-5985-435a-a33c-42a4f9ed4958
  modified: 2026-08-16T20:19:40.295Z
---

The user reported (2026-08-16) that "sometimes when testing videos get transcoded when they shouldn't be, creating file issues." Root cause found in `main.js`'s `media:transcode` IPC handler and `renderer/js/playback.js`'s `handleUnplayable()` (the auto-fix-bad-codec-file feature, [[retro-cable-box-architecture-constraints]]).

**Root cause:** `handleUnplayable()` called `window.api.transcode(file.path)` while `player.src` was *still pointing at that exact file*. On Windows (unlike POSIX), a file with an open handle can't be renamed — and Chromium's media pipeline keeps a handle open on a file even after failing to produce a decodable frame (it did successfully open the container to read metadata). So `fs.renameSync(srcPath, backupPath)` in the swap (main.js) would intermittently throw, landing in a catch block that reported the error back but **never cleaned up the already-finished `*.transcoded.mp4` output** — leaving a full-size wasted duplicate on disk while the original (still genuinely broken) file was never actually fixed, so the same channel entry would fail and re-attempt the whole multi-minute transcode again on every future tune-in.

**Evidence found:** scanned the user's real library (paths from `channels.json`'s `files[].folder`, all under `J:\Media Center\...`) for `_originals_backup` folders and stray `*.transcoded.mp4` files. Found 23 orphaned `.transcoded.mp4` files (3.0GB total) across Christmas Movies, Disney Movies, Harry Potter, Rocky, Looney Tunes, Spongebob, The Office, Tom and Jerry, What's New Scooby-Doo, and the WVU Football Archive — every one confirmed to still have its real original intact at the live path (so the channel entries were never actually broken, just wasting the transcode over and over). Deleted all 23 with the user's confirmation after verifying originals were present; several near-empty `_originals_backup` folders (from swaps that never got that far) were left in place — harmless, `scanFolderForVideos` (`main-media.js`) already skips that folder name.

**Fix (both landed 2026-08-16):**
1. `playback.js`'s `handleUnplayable()` now calls `player.removeAttribute('src'); player.load();` before invoking `window.api.transcode()`, releasing Chromium's handle on the file first — the actual root-cause fix.
2. `main.js`'s `media:transcode` handler, as defense-in-depth against *any* other transient Windows lock (AV scan, indexer, network-share latency on the user's `J:` drive): renames now go through `renameWithRetry()` (5 attempts, 300ms×attempt backoff) instead of a bare `fs.renameSync`; if the second rename (transcoded → live path) fails after the first succeeded, the original is best-effort restored from the backup rather than leaving the channel entry pointing at a missing file; and the catch branch now always `unlinkSync`s the pending `*.transcoded.mp4` on any swap failure, so a future transient failure can no longer orphan the multi-hundred-MB file the way these 23 did.

**How to apply:** any future code path that hands a file to an external process (ffmpeg, a rename, a move) while that same file might still be open in `player`/`youtubeOverlayAudioEl` must release the element's hold on it first (`removeAttribute('src')` + `.load()`) — Windows file-locking semantics make this a real, reproducible failure mode on this app, not a theoretical one. Any main-process file-swap/rename logic should default to a short retry-with-backoff plus guaranteed cleanup-on-failure of any large intermediate artifact, following the `renameWithRetry` pattern now in `main.js`, rather than a bare single-attempt `fs.renameSync`.
