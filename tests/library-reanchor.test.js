// Re-anchoring across a playlist change (docs/design/07 §3, contract C6).
//
// Doc 07 claimed an append was schedule-safe because it does not move the
// anchor. The 2026-09-15 audit corrected that: appending changes the loop's
// total duration, so (now - anchor) mod duration lands somewhere else. The
// first test below demonstrates the bug the doc would have shipped; the rest
// check the fix against the REAL scheduling function, so the two cannot drift.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

globalThis.window = globalThis.window || { matchMedia: () => ({ matches: false }), api: {} };
globalThis.document = globalThis.document || { getElementById: () => null };

const { reanchorForPlaylistChange, totalDuration } = require('../main/library/reanchor');
const load = (name) => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', name)).href);

const file = (path_, duration) => ({ path: path_, duration });
const EPISODES = [file('a.mkv', 600), file('b.mkv', 600), file('c.mkv', 600)];

// The real thing, so this test fails if schedule.js's loop math ever changes.
async function airingAt(files, anchor, atMs) {
  const { computeSourcePosition } = await load('core/schedule.js');
  const position = computeSourcePosition({ files, anchor }, atMs, { ignoreContentLost: true });
  return position && { path: position.file.path, offset: Math.round(position.offset), index: position.fileIndex };
}

test('appending WITHOUT re-anchoring changes what is on — the bug doc 07 would have shipped', async () => {
  const anchor = 1_000_000_000_000;
  const atMs = anchor + 700_000; // 700 s in: 100 s into b.mkv
  const before = await airingAt(EPISODES, anchor, atMs);
  assert.deepEqual(before, { path: 'b.mkv', offset: 100, index: 1 });

  const appended = [...EPISODES, file('d.mkv', 600)];
  const after = await airingAt(appended, anchor, atMs);
  assert.deepEqual(after, before,
    'with a whole extra loop of headroom this particular instant happens to survive');

  // …but one loop later it does not, which is the point: the modulus changed.
  const laterMs = anchor + 700_000 + 1800_000; // one old loop later
  const beforeLater = await airingAt(EPISODES, anchor, laterMs);
  const afterLater = await airingAt(appended, anchor, laterMs);
  assert.notDeepEqual(afterLater, beforeLater,
    'appending moved what is airing, so an append is NOT inherently schedule-safe');
});

test('re-anchoring keeps the same file at the same offset across an append', async () => {
  const { computeSourcePosition } = await load('core/schedule.js');
  const anchor = 1_000_000_000_000;
  const appended = [...EPISODES, file('d.mkv', 600)];

  // Every instant across two full loops, not one convenient sample.
  for (let seconds = 0; seconds < 3600; seconds += 37) {
    const atMs = anchor + seconds * 1000;
    const before = computeSourcePosition({ files: EPISODES, anchor }, atMs, { ignoreContentLost: true });
    const result = reanchorForPlaylistChange({ files: EPISODES, nextFiles: appended, anchor, atMs });
    assert.equal(result.ok, true, `re-anchored at ${seconds}s`);

    const after = computeSourcePosition({ files: appended, anchor: result.anchor }, atMs, { ignoreContentLost: true });
    assert.equal(after.file.path, before.file.path, `same file at ${seconds}s`);
    assert.ok(Math.abs(after.offset - before.offset) < 0.01, `same offset at ${seconds}s`);
    assert.equal(after.loopCount, before.loopCount, `same loop count at ${seconds}s`);
  }
});

test('it holds when files are inserted in the middle and reordered, not just appended', async () => {
  const { computeSourcePosition } = await load('core/schedule.js');
  const anchor = 1_700_000_000_000;
  const rebuilt = [file('new1.mkv', 300), file('a.mkv', 600), file('new2.mkv', 120), file('c.mkv', 600), file('b.mkv', 600)];

  for (let seconds = 0; seconds < 1800; seconds += 23) {
    const atMs = anchor + seconds * 1000;
    const before = computeSourcePosition({ files: EPISODES, anchor }, atMs, { ignoreContentLost: true });
    const result = reanchorForPlaylistChange({ files: EPISODES, nextFiles: rebuilt, anchor, atMs });
    assert.equal(result.ok, true);
    const after = computeSourcePosition({ files: rebuilt, anchor: result.anchor }, atMs, { ignoreContentLost: true });
    assert.equal(after.file.path, before.file.path, `same file at ${seconds}s`);
    assert.ok(Math.abs(after.offset - before.offset) < 0.01, `same offset at ${seconds}s`);
  }
});

test('removing the file that is on the air refuses instead of guessing', () => {
  const anchor = 1_000_000_000_000;
  const atMs = anchor + 700_000; // inside b.mkv
  const withoutB = EPISODES.filter((entry) => entry.path !== 'b.mkv');
  const result = reanchorForPlaylistChange({ files: EPISODES, nextFiles: withoutB, anchor, atMs });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'airing-file-removed');
  assert.equal(result.airing.key, 'b.mkv',
    'the caller can say WHICH programme would have been interrupted');
});

test('a duplicated file picks the copy nearest its old position, deterministically', () => {
  const anchor = 1_000_000_000_000;
  const atMs = anchor + 1_300_000; // 1300 s: 100 s into c.mkv (starts at 1200)
  // c.mkv twice: once early, once near where it used to be.
  const rebuilt = [file('c.mkv', 600), file('a.mkv', 600), file('b.mkv', 600), file('c.mkv', 600)];
  const result = reanchorForPlaylistChange({ files: EPISODES, nextFiles: rebuilt, anchor, atMs });
  assert.equal(result.ok, true);
  assert.equal(result.preserved.toIndex, 3, 'the copy at 1800 s, not the one at 0 s');
  assert.equal(Math.round(result.preserved.offset), 100);
});

test('a shorter replacement clamps the offset instead of spilling into the next file', async () => {
  const { computeSourcePosition } = await load('core/schedule.js');
  const anchor = 1_000_000_000_000;
  const atMs = anchor + 1_100_000; // 500 s into b.mkv
  // b.mkv comes back as a 120 s cut.
  const rebuilt = [file('a.mkv', 600), file('b.mkv', 120), file('c.mkv', 600)];
  const result = reanchorForPlaylistChange({ files: EPISODES, nextFiles: rebuilt, anchor, atMs });
  assert.equal(result.ok, true);
  const after = computeSourcePosition({ files: rebuilt, anchor: result.anchor }, atMs, { ignoreContentLost: true });
  assert.equal(after.file.path, 'b.mkv', 'still the same programme, not the one after it');
  assert.ok(after.offset < 120);
});

test('it uses library item ids when they are there, so a moved file still matches', async () => {
  const { computeSourcePosition } = await load('core/schedule.js');
  const anchor = 1_000_000_000_000;
  const atMs = anchor + 700_000;
  const withIds = [
    { item: 'itm_a', path: 'J:\\old\\a.mkv', duration: 600 },
    { item: 'itm_b', path: 'J:\\old\\b.mkv', duration: 600 },
  ];
  // The same items after the root moved to another drive, plus a new one.
  const moved = [
    { item: 'itm_a', path: 'K:\\media\\a.mkv', duration: 600 },
    { item: 'itm_b', path: 'K:\\media\\b.mkv', duration: 600 },
    { item: 'itm_c', path: 'K:\\media\\c.mkv', duration: 600 },
  ];
  const result = reanchorForPlaylistChange({ files: withIds, nextFiles: moved, anchor, atMs });
  assert.equal(result.ok, true);
  assert.equal(result.preserved.key, 'itm_b', 'matched by item id, not by a path that changed');
  const after = computeSourcePosition({ files: moved, anchor: result.anchor }, atMs, { ignoreContentLost: true });
  assert.equal(after.file.item, 'itm_b');
});

test('nonsense in gives a refusal out, never a broken anchor', () => {
  const base = { files: EPISODES, nextFiles: EPISODES, anchor: 1, atMs: 2 };
  assert.equal(reanchorForPlaylistChange({ ...base, files: [] }).reason, 'empty-before');
  assert.equal(reanchorForPlaylistChange({ ...base, nextFiles: [] }).reason, 'empty-after');
  assert.equal(reanchorForPlaylistChange({ ...base, anchor: null }).reason, 'no-anchor');
  assert.equal(reanchorForPlaylistChange({ ...base, files: [file('x', 0)] }).reason, 'zero-duration-before');
  assert.equal(reanchorForPlaylistChange({ ...base, nextFiles: [file('x', 0)] }).reason, 'zero-duration-after');
  assert.equal(totalDuration(EPISODES), 1800);
});

test('an unchanged playlist leaves the anchor where it was', () => {
  const anchor = 1_000_000_000_000;
  const result = reanchorForPlaylistChange({ files: EPISODES, nextFiles: EPISODES, anchor, atMs: anchor + 700_000 });
  assert.equal(result.ok, true);
  assert.equal(result.anchor, anchor, 'no change means no shift');
  assert.equal(result.preserved.anchorShiftMs, 0);
});
