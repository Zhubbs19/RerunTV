// rerun.db (main/util/db.js): the SQLite cache table, the one-time import of
// the old JSON caches, the update-install snapshot, and the loudness/crop
// services reading through it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DB_FILE, cacheTable, closeAll, isSqliteAvailable, snapshotDb } = require('../main/util/db');
const { createLoudnessService } = require('../main/media/loudness');
const { createCropDetectService } = require('../main/media/cropdetect');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rerun-db-test-'));
  t.after(() => {
    closeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('node:sqlite is available to the app', () => {
  assert.equal(isSqliteAvailable(), true);
});

test('a cache table keeps values across a close and reopen', (t) => {
  const dir = tempDir(t);
  const table = cacheTable(dir, 'demo');
  table.set('a', { n: 1 }, 100);
  table.set('b', [1, 2, 3], 200);
  table.set('a', { n: 2 }, 300);
  assert.deepEqual(table.get('a'), { at: 300, value: { n: 2 } });
  assert.equal(table.get('missing'), null);
  assert.equal(table.count(), 2);
  assert.equal(cacheTable(dir, 'demo'), table, 'same table for the same dir and namespace');

  closeAll();
  assert.ok(!fs.existsSync(path.join(dir, `${DB_FILE}-wal`)), 'a clean close folds the WAL back in');
  const reopened = cacheTable(dir, 'demo');
  assert.deepEqual(reopened.get('b'), { at: 200, value: [1, 2, 3] });
  assert.equal(cacheTable(dir, 'other').count(), 0, 'namespaces are separate');
});

test('the cap drops the oldest entries first', (t) => {
  const table = cacheTable(tempDir(t), 'capped', { maxEntries: 3 });
  [5, 1, 4, 2, 3].forEach((at) => table.set(`k${at}`, at, at));
  assert.equal(table.prune(), 2);
  assert.equal(table.count(), 3);
  assert.equal(table.get('k1'), null);
  assert.equal(table.get('k2'), null);
  assert.ok(table.get('k3') && table.get('k5'));
});

test('merge never lets an older entry replace a newer one', (t) => {
  const table = cacheTable(tempDir(t), 'merge');
  table.set('x', 'new', 500);
  assert.equal(table.merge([['x', 'old', 100], ['y', 'fresh', 50]]), 2);
  assert.equal(table.get('x').value, 'new');
  assert.equal(table.get('y').value, 'fresh');
});

test('countWithField counts rows whose field is set', (t) => {
  const table = cacheTable(tempDir(t), 'fields');
  table.set('a', { crop: { x: 0, y: 0.1, w: 1, h: 0.8 } });
  table.set('b', { crop: null });
  table.set('c', { other: 1 });
  assert.equal(table.countWithField('crop'), 1);
  assert.throws(() => table.countWithField("crop') or 1=1 --"));
});

test('an old JSON cache is imported once and then removed', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'old-cache.json');
  fs.writeFileSync(file, JSON.stringify({ one: { at: 10, data: 'a' }, two: { at: 20, data: 'b' } }));
  const toEntries = (store) => Object.entries(store).map(([key, e]) => [key, e.data, e.at]);
  const table = cacheTable(dir, 'imported', { importFrom: { file, toEntries } });
  assert.equal(table.count(), 2);
  assert.deepEqual(table.get('two'), { at: 20, value: 'b' });
  assert.ok(!fs.existsSync(file));
});

test('an unreadable old JSON cache is removed without failing', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'broken.json');
  fs.writeFileSync(file, '{not json');
  const table = cacheTable(dir, 'broken', { importFrom: { file, toEntries: () => [] } });
  assert.equal(table.count(), 0);
  assert.ok(!fs.existsSync(file));
});

test('a database that will not open is set aside and replaced', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, DB_FILE), 'this is not a sqlite file '.repeat(200));
  const table = cacheTable(dir, 'fresh');
  table.set('k', 1);
  assert.equal(table.count(), 1);
  assert.ok(fs.readdirSync(dir).some((name) => name.startsWith(`${DB_FILE}.unreadable-`)));
});

test('snapshotDb writes a complete copy while the database is open', (t) => {
  const dir = tempDir(t);
  const table = cacheTable(dir, 'snap');
  table.merge(Array.from({ length: 2000 }, (_, i) => [`k${i}`, { i }, i]));
  assert.ok(fs.existsSync(path.join(dir, `${DB_FILE}-wal`)), 'writes are still in the WAL');
  const copyDir = path.join(dir, 'copy');
  fs.mkdirSync(copyDir);
  assert.equal(snapshotDb(dir, path.join(copyDir, DB_FILE)), true);
  assert.deepEqual(fs.readdirSync(copyDir), [DB_FILE], 'one self-contained file');
  assert.equal(cacheTable(copyDir, 'snap').count(), 2000);
  assert.deepEqual(cacheTable(copyDir, 'snap').get('k1999').value, { i: 1999 });
  assert.equal(snapshotDb(path.join(dir, 'nothing-here'), path.join(dir, 'x.db')), false);
});

// A real file whose size and mtime the old cache entry matches.
function mediaFile(dir) {
  const file = path.join(dir, 'episode.mkv');
  fs.writeFileSync(file, 'not really video');
  const st = fs.statSync(file);
  return { file, size: st.size, mtimeMs: st.mtimeMs };
}

test('the loudness service reads measurements imported from loudness-cache.json', async (t) => {
  const dir = tempDir(t);
  const media = mediaFile(dir);
  fs.writeFileSync(path.join(dir, 'loudness-cache.json'), JSON.stringify({
    version: 1,
    entries: {
      [media.file]: { size: media.size, mtimeMs: media.mtimeMs, lufs: -21.5, at: 1 },
      'C:\\gone.mkv': { size: 1, mtimeMs: 1, lufs: -30, at: 2 },
    },
  }));
  const service = createLoudnessService({ userDataDir: dir, getFfmpegPath: () => null });
  assert.equal(service.status().measured, 2);
  assert.equal(await service.get(media.file, 1200), -21.5);
  assert.ok(!fs.existsSync(path.join(dir, 'loudness-cache.json')));
});

test('a loudness-cache.json from another cache version is not imported', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'loudness-cache.json'), JSON.stringify({ version: 99, entries: { a: { at: 1 } } }));
  const service = createLoudnessService({ userDataDir: dir, getFfmpegPath: () => null });
  assert.equal(service.status().measured, 0);
});

test('the crop service reads measurements imported from crop-cache.json', async (t) => {
  const dir = tempDir(t);
  const media = mediaFile(dir);
  const box = { x: 0, y: 0.125, w: 1, h: 0.75 };
  fs.writeFileSync(path.join(dir, 'crop-cache.json'), JSON.stringify({
    version: 1,
    entries: {
      [media.file]: { size: media.size, mtimeMs: media.mtimeMs, crop: box, at: 1 },
      'C:\\no-bars.mkv': { size: 1, mtimeMs: 1, crop: null, at: 2 },
    },
  }));
  const service = createCropDetectService({ userDataDir: dir, getFfmpegPath: () => null });
  const status = service.status();
  assert.equal(status.checked, 2);
  assert.equal(status.withBars, 1);
  assert.deepEqual(await service.get(media.file, 1200), box);
});
