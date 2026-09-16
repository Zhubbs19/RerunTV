// Incremental library scanning (docs/design/07 §4).
//
// The scanner's contract is narrow on purpose: report what it found, apply only
// what identity.js says is safe, and never touch what airs. These check all
// three, plus the incremental skip that makes a scan runnable on a timer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createLibraryStore } = require('../main/library/store');
const { scanRoot, applyScan, describeScan } = require('../main/library/scan');

function tempStore() {
  return createLibraryStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'reruntv-scan-')) });
}

// A fake disk: refs mapped to { size, mtimeMs, head }. The scanner never reads
// a real file, which is the point of injecting the fingerprinter.
function fakeDisk(files) {
  const disk = new Map(Object.entries(files));
  let hashCalls = 0;
  return {
    disk,
    hashCalls: () => hashCalls,
    list: async () => [...disk.entries()].map(([ref, f]) => ({ ref, size: f.size, mtimeMs: f.mtimeMs })),
    fingerprint: async (ref) => {
      hashCalls += 1;
      const f = disk.get(ref);
      if (!f) throw new Error('ENOENT');
      return { size: f.size, mtime: Math.round(f.mtimeMs), head: f.head };
    },
    probeDuration: async (ref) => (disk.get(ref) || {}).duration ?? 600,
  };
}

const ROOT = { id: 'root-media', ref: 'J:\\Media' };

test('a first scan catalogues everything as new, with durations', async () => {
  const store = tempStore();
  store.addRoot({ id: ROOT.id, ref: ROOT.ref });
  const world = fakeDisk({
    'J:\\Media\\a.mkv': { size: 100, mtimeMs: 1, head: 'sha1:a', duration: 1200 },
    'J:\\Media\\b.mkv': { size: 200, mtimeMs: 2, head: 'sha1:b' },
  });

  const report = await scanRoot({ store, root: ROOT, ...world });
  assert.equal(report.added.length, 2);
  assert.equal(report.same.length, 0);
  assert.equal(report.probed, 2);

  const applied = applyScan(store, report);
  assert.equal(applied.added, 2);
  assert.equal(store.stats().items, 2);
  assert.equal(store.findByRef('J:\\Media\\a.mkv').duration, 1200);
  assert.deepEqual(store.findByRef('J:\\Media\\a.mkv').provenance, {},
    'a scan catalogues; it does not invent metadata that would look user-supplied');
});

test('a second scan reads nothing it does not have to', async () => {
  const store = tempStore();
  store.addRoot({ id: ROOT.id, ref: ROOT.ref });
  const world = fakeDisk({
    'J:\\Media\\a.mkv': { size: 100, mtimeMs: 1, head: 'sha1:a' },
    'J:\\Media\\b.mkv': { size: 200, mtimeMs: 2, head: 'sha1:b' },
  });
  applyScan(store, await scanRoot({ store, root: ROOT, ...world }));
  const afterFirst = world.hashCalls();

  const second = await scanRoot({ store, root: ROOT, ...world });
  assert.equal(world.hashCalls(), afterFirst, 'not one file was re-read');
  assert.equal(second.skipped, 2);
  assert.equal(second.hashed, 0);
  assert.equal(second.same.length, 2);
  assert.equal(second.added.length, 0);
  assert.match(describeScan(second), /nothing changed/);
});

test('a touched file is re-read but stays the same item', async () => {
  const store = tempStore();
  store.addRoot({ id: ROOT.id, ref: ROOT.ref });
  const world = fakeDisk({ 'J:\\Media\\a.mkv': { size: 100, mtimeMs: 1, head: 'sha1:a' } });
  applyScan(store, await scanRoot({ store, root: ROOT, ...world }));
  const itemId = store.findByRef('J:\\Media\\a.mkv').id;

  // A copy, a restore, a sync client: mtime moves, bytes do not.
  world.disk.get('J:\\Media\\a.mkv').mtimeMs = 999;
  const report = await scanRoot({ store, root: ROOT, ...world });
  assert.equal(report.hashed, 1, 'the stat moved, so it looked');
  assert.equal(report.same.length, 1);
  assert.equal(report.added.length, 0);

  applyScan(store, report);
  assert.equal(store.findByRef('J:\\Media\\a.mkv').id, itemId, 'same item');
  assert.equal(store.getItem(itemId).fingerprint.mtime, 999, 'and the new stat is stored');

  const third = await scanRoot({ store, root: ROOT, ...world });
  assert.equal(third.hashed, 0, 'so the next scan skips it again');
});

test('a moved file is repointed, and its metadata comes with it', async () => {
  const store = tempStore();
  store.addRoot({ id: ROOT.id, ref: ROOT.ref });
  const world = fakeDisk({ 'J:\\Media\\a.mkv': { size: 100, mtimeMs: 1, head: 'sha1:a' } });
  applyScan(store, await scanRoot({ store, root: ROOT, ...world }));
  const itemId = store.findByRef('J:\\Media\\a.mkv').id;
  store.updateItem(itemId, { title: 'The Dundies', tags: ['office'] });

  world.disk.delete('J:\\Media\\a.mkv');
  world.disk.set('J:\\Media\\Season 2\\a.mkv', { size: 100, mtimeMs: 1, head: 'sha1:a' });

  const report = await scanRoot({ store, root: ROOT, ...world });
  assert.equal(report.moved.length, 1);
  assert.equal(report.added.length, 0);
  assert.equal(report.missing.length, 0, 'it is not missing, it moved');
  assert.equal(report.moved[0].from, 'J:\\Media\\a.mkv');

  applyScan(store, report);
  assert.equal(store.getItem(itemId).ref, 'J:\\Media\\Season 2\\a.mkv');
  assert.equal(store.getItem(itemId).title, 'The Dundies', 'the tags went with it');
  assert.equal(store.stats().items, 1, 'not one gone and one new');
});

test('two identical files are never relinked on their own', async () => {
  const store = tempStore();
  store.addRoot({ id: ROOT.id, ref: ROOT.ref });
  const twin = { size: 100, mtimeMs: 1, head: 'sha1:same' };
  const world = fakeDisk({ 'J:\\Media\\a.mkv': { ...twin }, 'J:\\Media\\copy.mkv': { ...twin } });

  // Catalogue both, then move one of them somewhere new.
  applyScan(store, await scanRoot({ store, root: ROOT, ...world }));
  assert.equal(store.stats().items, 2, 'two refs, catalogued separately');

  world.disk.delete('J:\\Media\\copy.mkv');
  world.disk.set('J:\\Media\\elsewhere\\copy.mkv', { ...twin });
  const report = await scanRoot({ store, root: ROOT, ...world });

  assert.equal(report.ambiguous.length, 1);
  assert.equal(report.moved.length, 0, 'it could be either item — a human decides');
  assert.match(report.ambiguous[0].reason, /same size and first megabyte/);

  const applied = applyScan(store, report);
  assert.equal(applied.moved, 0);
  assert.equal(applied.needsReview, 1);
  assert.match(describeScan(report), /1 need a decision/);
});

test('different content at a known path does not inherit the old title', async () => {
  const store = tempStore();
  store.addRoot({ id: ROOT.id, ref: ROOT.ref });
  const world = fakeDisk({ 'J:\\Media\\a.mkv': { size: 100, mtimeMs: 1, head: 'sha1:a' } });
  applyScan(store, await scanRoot({ store, root: ROOT, ...world }));
  const itemId = store.findByRef('J:\\Media\\a.mkv').id;
  store.updateItem(itemId, { title: 'The Dundies' });

  // Re-encoded, or the filename recycled for something else entirely.
  Object.assign(world.disk.get('J:\\Media\\a.mkv'), { size: 50, mtimeMs: 2, head: 'sha1:different' });

  const report = await scanRoot({ store, root: ROOT, ...world });
  assert.equal(report.replaced.length, 1);
  assert.equal(report.added.length, 0);

  applyScan(store, report);
  assert.equal(store.getItem(itemId).title, 'The Dundies');
  assert.equal(store.getItem(itemId).fingerprint.head, 'sha1:a',
    'the item was NOT repointed at content nobody has identified');
  assert.equal(applyScan(store, report).needsReview, 1);
});

test('a file gone from the root is reported, never deleted', async () => {
  const store = tempStore();
  store.addRoot({ id: ROOT.id, ref: ROOT.ref });
  const world = fakeDisk({
    'J:\\Media\\a.mkv': { size: 100, mtimeMs: 1, head: 'sha1:a' },
    'J:\\Media\\b.mkv': { size: 200, mtimeMs: 2, head: 'sha1:b' },
  });
  applyScan(store, await scanRoot({ store, root: ROOT, ...world }));

  world.disk.delete('J:\\Media\\b.mkv');
  const report = await scanRoot({ store, root: ROOT, ...world });
  assert.equal(report.missing.length, 1);

  applyScan(store, report);
  assert.equal(store.stats().items, 2,
    'an unplugged drive and a deleted folder look identical from here, and the first is commoner');
});

test('an aborted scan reports nothing as missing', async () => {
  const store = tempStore();
  store.addRoot({ id: ROOT.id, ref: ROOT.ref });
  const world = fakeDisk({
    'J:\\Media\\a.mkv': { size: 100, mtimeMs: 1, head: 'sha1:a' },
    'J:\\Media\\b.mkv': { size: 200, mtimeMs: 2, head: 'sha1:b' },
  });
  applyScan(store, await scanRoot({ store, root: ROOT, ...world }));

  const signal = { aborted: false };
  const report = await scanRoot({
    store, root: ROOT, ...world, signal,
    onProgress: () => { signal.aborted = true; }, // stop after the first entry
  });
  assert.equal(report.aborted, true);
  assert.deepEqual(report.missing, [], 'half a root is not evidence that anything is gone');
});

test('a file that vanishes mid-scan is an error, not a deletion', async () => {
  const store = tempStore();
  store.addRoot({ id: ROOT.id, ref: ROOT.ref });
  const world = fakeDisk({ 'J:\\Media\\a.mkv': { size: 100, mtimeMs: 1, head: 'sha1:a' } });
  // Listed, then gone by the time it is read.
  const report = await scanRoot({
    store, root: ROOT, list: world.list, probeDuration: world.probeDuration,
    fingerprint: async () => { throw new Error('ENOENT'); },
  });
  assert.equal(report.errors.length, 1);
  assert.equal(report.added.length, 0);
  assert.equal(report.missing.length, 0, 'it was listed a moment ago; do not trigger a relink');
});

test('a file moved between two catalogued roots reads as moved, not gone-and-new', async () => {
  const store = tempStore();
  store.addRoot({ id: 'root-a', ref: 'J:\\A' });
  store.addRoot({ id: 'root-b', ref: 'K:\\B' });
  const a = fakeDisk({ 'J:\\A\\x.mkv': { size: 100, mtimeMs: 1, head: 'sha1:x' } });
  applyScan(store, await scanRoot({ store, root: { id: 'root-a', ref: 'J:\\A' }, ...a }));
  const itemId = store.findByRef('J:\\A\\x.mkv').id;

  const b = fakeDisk({ 'K:\\B\\x.mkv': { size: 100, mtimeMs: 1, head: 'sha1:x' } });
  const report = await scanRoot({ store, root: { id: 'root-b', ref: 'K:\\B' }, ...b });
  assert.equal(report.moved.length, 1, 'candidates come from the whole library, not one root');
  assert.equal(report.added.length, 0);
  applyScan(store, report);
  assert.equal(store.stats().items, 1);
  assert.equal(store.getItem(itemId).ref, 'K:\\B\\x.mkv');
});

test('a scan reports progress it can be driven by', async () => {
  const store = tempStore();
  store.addRoot({ id: ROOT.id, ref: ROOT.ref });
  const world = fakeDisk({
    'J:\\Media\\a.mkv': { size: 1, mtimeMs: 1, head: 'sha1:a' },
    'J:\\Media\\b.mkv': { size: 2, mtimeMs: 2, head: 'sha1:b' },
    'J:\\Media\\c.mkv': { size: 3, mtimeMs: 3, head: 'sha1:c' },
  });
  const seen = [];
  await scanRoot({ store, root: ROOT, ...world, onProgress: (p) => seen.push(p) });
  assert.equal(seen.length, 3);
  assert.deepEqual(seen.map((p) => p.done), [1, 2, 3]);
  assert.equal(seen[0].total, 3);
  assert.equal(seen[0].action, 'new');
});
