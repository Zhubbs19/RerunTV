// Keeping what's on the air across a playlist change (docs/design/07 §3, C6).
//
// Doc 07 said library sync could auto-apply "appends only", because adding
// files at the end "doesn't move the current anchor position". That is wrong,
// and the 2026-09-15 audit caught it: a channel airs
//
//     elapsed = ((now - anchor) / 1000) mod totalDuration
//
// so appending changes `totalDuration`, the modulus changes, and `elapsed`
// lands somewhere else. A channel mid-episode can cut to a different show the
// moment a sync finishes. That breaks the one rule doc 07 calls C6: never
// change what airs by surprise.
//
// The fix is to move the anchor deliberately instead of pretending it doesn't
// matter. Given the file that is airing and how far into it we are, this finds
// the anchor that puts that same file at that same offset in the NEW playlist.
// Nothing jumps; the new content simply appears from the next loop onward.
//
// Pure: no clock, no state, no I/O. Durations are in seconds and anchors in
// milliseconds, matching renderer/js/core/schedule.js's computeSourcePosition —
// tests/library-reanchor.test.js cross-checks this against that real function
// so the two can never quietly drift apart.
//
// An ES module in the renderer because everything that re-anchors lives there:
// library sync, channel rematerialization and the schedule math it must agree
// with. The host process never needs it.

export function totalDuration(files) {
  return files.reduce((sum, file) => sum + (file.duration || 0), 0);
}

// Where `elapsed` seconds into a playlist lands. Mirrors computeSourcePosition's
// loop exactly, including its "past the end" fallback.
export function locate(files, elapsed) {
  let acc = 0;
  for (let i = 0; i < files.length; i += 1) {
    const d = files[i].duration || 0;
    if (elapsed < acc + d) return { index: i, offset: elapsed - acc, start: acc, file: files[i] };
    acc += d;
  }
  return { index: 0, offset: 0, start: 0, file: files[0] };
}

// Default identity: whatever the library calls this entry, falling back to its
// path so this works before items exist and for a plain folder channel.
export function defaultKeyOf(file) {
  return (file && (file.item || file.path)) || null;
}

/**
 * The anchor that keeps the currently-airing file at the same offset once the
 * playlist becomes `nextFiles`.
 *
 * `atMs` must be the timestamp the schedule is actually being evaluated at —
 * the caller's own effective time, with any break-drift compensation
 * (S.contentLostMs) already subtracted. Passing the raw clock when playback is
 * mid-break would preserve the wrong frame.
 *
 * Returns { ok: true, anchor, preserved } or { ok: false, reason }. A refusal
 * is not a failure: it means this change cannot be applied without moving what
 * is on, so the caller should show the diffSchedules preview and ask.
 */
export function reanchorForPlaylistChange({ files, nextFiles, anchor, atMs, keyOf = defaultKeyOf }) {
  if (!Array.isArray(files) || !files.length) return { ok: false, reason: 'empty-before' };
  if (!Array.isArray(nextFiles) || !nextFiles.length) return { ok: false, reason: 'empty-after' };
  if (!Number.isFinite(anchor)) return { ok: false, reason: 'no-anchor' };

  const oldTotal = totalDuration(files);
  const newTotal = totalDuration(nextFiles);
  if (oldTotal <= 0) return { ok: false, reason: 'zero-duration-before' };
  if (newTotal <= 0) return { ok: false, reason: 'zero-duration-after' };

  const elapsedRaw = (atMs - anchor) / 1000;
  const elapsed = ((elapsedRaw % oldTotal) + oldTotal) % oldTotal;
  const airing = locate(files, elapsed);
  const key = keyOf(airing.file);
  if (key == null) return { ok: false, reason: 'unidentifiable' };

  // Where that same file sits in the new playlist. A file can legitimately
  // appear more than once (a short aired twice a loop); pick the occurrence
  // whose start is nearest the old one, so a rebuild that mostly preserves
  // order barely moves the anchor at all. Deterministic: ties go to the
  // earlier index.
  let chosen = null;
  let acc = 0;
  for (let i = 0; i < nextFiles.length; i += 1) {
    const d = nextFiles[i].duration || 0;
    if (keyOf(nextFiles[i]) === key) {
      const distance = Math.abs(acc - airing.start);
      if (!chosen || distance < chosen.distance) chosen = { index: i, start: acc, duration: d, distance };
    }
    acc += d;
  }
  // The file that is on right now is not in the new playlist. There is no
  // anchor that keeps it airing, so this cannot be applied unattended.
  if (!chosen) return { ok: false, reason: 'airing-file-removed', airing: { key, offset: airing.offset } };

  // Clamp into the chosen copy: a re-encode can be shorter than the entry the
  // offset was measured against, and an offset past its end would silently
  // land in the NEXT file.
  const offset = Math.min(airing.offset, Math.max(0, chosen.duration - 0.001));
  const desired = chosen.start + offset;

  // Keep the loop count too, so a channel doesn't announce everything as a
  // NEW EPISODE again just because its playlist grew (schedule.js's loopCount
  // drives that bug and progressive tape wear).
  const loopCount = Math.max(0, Math.floor(elapsedRaw / oldTotal));
  const newAnchor = Math.round(atMs - (loopCount * newTotal + desired) * 1000);

  return {
    ok: true,
    anchor: newAnchor,
    preserved: {
      key,
      fromIndex: airing.index,
      toIndex: chosen.index,
      offset,
      loopCount,
      anchorShiftMs: newAnchor - anchor,
      oldTotal,
      newTotal,
    },
  };
}


/**
 * Replaces a channel's playlist in place, moving its anchor so what is on the
 * air stays on (library sync, docs/design/07 §3). `atMs` is the schedule's own
 * clock — viewNow(), minus S.contentLostMs for the tuned channel — supplied by
 * the caller so this stays pure.
 *
 * Returns { preserved: true } or { preserved: false, reason }. A refusal still
 * applies the playlist and leaves the anchor: the airing file was removed (with
 * "remove files that disappear" on it is gone from disk and could not play
 * anyway), or the channel had never aired.
 */
export function applyPlaylistPreservingAir(channel, nextFiles, atMs) {
  const before = channel.files || [];
  const result = before.length && channel.anchor
    ? reanchorForPlaylistChange({ files: before, nextFiles, anchor: channel.anchor, atMs })
    : { ok: false, reason: 'no-anchor' };
  channel.files = nextFiles;
  if (result.ok) {
    channel.anchor = result.anchor;
    return { preserved: true };
  }
  return { preserved: false, reason: result.reason };
}
