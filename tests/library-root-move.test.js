// Moving a library root (docs/design/07 §8): path text is rewritten at a folder
// boundary, in config and library together, and the same content airs at the
// same times afterwards. Synthetic paths only — nothing here touches a disk.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

globalThis.window = globalThis.window || { matchMedia: () => ({ matches: false }), api: {} };
globalThis.document = globalThis.document || { getElementById: () => null };

const load = (name) => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', name)).href);
let rm;
test.before(async () => { rm = await load('library/root-move.js'); });

function lineup() {
  return {
    interstitials: { pool: [], presets: [], flows: [] },
    channels: [
      {
        number: 6, name: 'Office', anchor: 1_700_000_000_000, blocks: [],
        folders: [{ id: 'f6', source: 'local', ref: 'J:\\Media\\Office' }],
        files: [
          { path: 'J:\\Media\\Office\\s01e01.mkv', duration: 1320, folder: 'f6', item: 'itm_1' },
          { path: 'J:\\Media\\Office\\s01e02.mkv', duration: 1310, folder: 'f6', item: 'itm_2' },
        ],
      },
      {
        number: 7, name: 'Other drive', anchor: 1_700_000_000_000, blocks: [],
        folders: [{ id: 'f7', source: 'local', ref: 'J:\\Media Center\\Cartoons' }],
        files: [{ path: 'J:\\Media Center\\Cartoons\\a.mkv', duration: 420, folder: 'f7' }],
      },
    ],
  };
}

const index = () => ({
  roots: [{ id: 'r1', ref: 'J:\\Media\\Office' }, { id: 'r2', ref: 'J:\\Media Center\\Cartoons' }],
  items: {
    itm_1: { id: 'itm_1', ref: 'J:\\Media\\Office\\s01e01.mkv', root: 'r1', fingerprint: { size: 1, mtime: 5, head: 'sha1:x' } },
    itm_2: { id: 'itm_2', ref: 'J:\\Media\\Office\\s01e02.mkv', root: 'r1', fingerprint: null },
  },
});

test('a prefix matches only at a folder boundary', () => {
  assert.equal(rm.underPrefix('J:\\Media\\a.mkv', 'J:\\Media'), true);
  assert.equal(rm.underPrefix('J:\\Media Center\\a.mkv', 'J:\\Media'), false);
  assert.equal(rm.underPrefix('J:\\Media', 'J:\\Media'), true);
  assert.equal(rm.underPrefix('J:\\Media\\a.mkv', 'J:\\Media\\'), true);
  assert.equal(rm.rewritePrefix('J:\\Media\\x\\a.mkv', 'J:\\Media', 'K:\\Archive'), 'K:\\Archive\\x\\a.mkv');
});

test('planning copies, rewrites config and library together, and counts', () => {
  const config = lineup();
  const lib = index();
  const snapshot = JSON.stringify([config, lib]);
  const plan = rm.planRootMove(config, lib, { from: 'J:\\Media', to: 'K:\\Media' });
  assert.equal(JSON.stringify([config, lib]), snapshot, 'inputs untouched');
  assert.deepEqual(plan.counts, { channels: 1, folders: 1, files: 2, roots: 1, items: 2 });
  assert.equal(plan.config.channels[1].files[0].path, 'J:\\Media Center\\Cartoons\\a.mkv', 'J:\\Media Center is not J:\\Media');
  assert.equal(plan.index.items.itm_1.fingerprint.head, 'sha1:x', 'content evidence survives');
  assert.equal(plan.index.items.itm_1.fingerprint.mtime, null, 'the old disk’s stat does not');
  assert.equal(plan.index.items.itm_2.fingerprint, null);
});

test('applying in place writes exactly what the plan previewed', () => {
  const config = lineup();
  const plan = rm.planRootMove(config, null, { from: 'J:\\Media', to: 'K:\\Media' });
  const counts = rm.applyRootMoveInPlace(config, { from: 'J:\\Media', to: 'K:\\Media' });
  assert.deepEqual(config, plan.config);
  assert.equal(counts.files, 2);
  assert.equal(plan.index, null, 'channels move even before the library is built');
});

test('refuses provider refs and no-op moves', () => {
  assert.throws(() => rm.planRootMove(lineup(), null, { from: 'J:\\Media', to: 'J:\\Media' }), /same/);
  assert.throws(() => rm.planRootMove(lineup(), null, { from: 'mediasource:jf:x', to: 'K:\\x' }), /Provider/);
  assert.throws(() => rm.applyRootMoveInPlace(lineup(), { from: '', to: 'K:\\x' }), /both/);
});

test('after a move the same content airs at the same times; a real change is caught', async () => {
  const config = lineup();
  const from = 1_758_000_000_000;
  const to = from + 3 * 24 * 3600 * 1000;
  const plan = rm.planRootMove(config, null, { from: 'J:\\Media', to: 'K:\\Media' });
  const moved = rm.airingDiffIgnoringPaths(config.channels[0], plan.config.channels[0], from, to);
  assert.equal(moved.identical, true);
  assert.ok(moved.programs > 100);

  const swapped = JSON.parse(JSON.stringify(plan.config.channels[0]));
  swapped.files.reverse();
  assert.equal(rm.airingDiffIgnoringPaths(config.channels[0], swapped, from, to).identical, false);
});
