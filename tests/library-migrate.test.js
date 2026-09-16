// Building the library from an existing lineup (docs/design/07 §7).
//
// The per-channel diff-or-abort guard is what makes this migration safe, and a
// guard that always says "identical" looks exactly like one that works. So the
// most important test here deliberately breaks a planned channel and checks the
// real diffSchedules catches it and the channel is kept as it was.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

globalThis.window = globalThis.window || { matchMedia: () => ({ matches: false }), api: {} };
globalThis.document = globalThis.document || { getElementById: () => null };

const { planMigration, finalizeMigration, plannedItemId } = require('../main/library/migrate');
const load = (name) => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', name)).href);

const DAY = 24 * 3600 * 1000;

function lineup() {
  return {
    interstitials: { pool: [], presets: [], flows: [] },
    channels: [
      {
        number: 6, name: 'Office', anchor: 1_700_000_000_000, blocks: [],
        folders: [{ id: 'f6', source: 'local', ref: 'J:\\TV\\Office' }],
        files: [
          { path: 'J:\\TV\\Office\\s01e01.mkv', duration: 1320, folder: 'f6', source: 'local', title: 'Pilot', tags: ['office'] },
          { path: 'J:\\TV\\Office\\s01e02.mkv', duration: 1310, folder: 'f6', source: 'local' },
        ],
      },
      {
        number: 9, name: 'Mixed', anchor: 1_700_000_500_000, blocks: [],
        folders: [{ id: 'f9', source: 'local', ref: 'J:\\TV\\Mixed' }, { id: 'a9', source: 'archive', ref: 'some-archive-id' }],
        files: [
          { path: 'J:\\TV\\Mixed\\x.mkv', duration: 600, folder: 'f9', source: 'local' },
          { path: 'mediasource:archive:clip1', duration: 300, folder: 'a9', source: 'archive', title: 'Clip' },
        ],
      },
    ],
  };
}

async function verify(original, plan, days = 60) {
  const { S } = await load('core/state.js');
  const { diffSchedules } = await load('core/schedule-query.js');
  const from = 1_758_000_000_000;
  const verdicts = {};
  original.channels.forEach((before) => {
    const after = plan.config.channels.find((ch) => ch.number === before.number);
    S.config = original;
    verdicts[before.number] = diffSchedules(before, after, from, from + days * DAY, { breaks: true, afterConfig: plan.config });
  });
  return verdicts;
}

test('planning never modifies the config it was given', () => {
  const original = lineup();
  const snapshot = JSON.stringify(original);
  planMigration(original);
  assert.equal(JSON.stringify(original), snapshot);
});

test('each file gains an item id and nothing else about its playlist changes', () => {
  const original = lineup();
  const plan = planMigration(original);
  plan.config.channels.forEach((channel, c) => {
    const before = original.channels[c];
    assert.equal(channel.anchor, before.anchor, 'the anchor is untouched');
    assert.equal(channel.files.length, before.files.length);
    channel.files.forEach((file, f) => {
      const { item, ...rest } = file;
      assert.match(item, /^itm_[0-9a-f]{16}$/);
      assert.deepEqual(rest, before.files[f], 'path, duration, order and metadata all as they were');
    });
  });
});

test('the migrated lineup airs identically over 60 days', async () => {
  const original = lineup();
  const plan = planMigration(original);
  const verdicts = await verify(original, plan);
  Object.entries(verdicts).forEach(([number, diff]) => assert.equal(diff.identical, true, `CH ${number}`));
  const final = finalizeMigration(original, plan, verdicts);
  assert.deepEqual(final.accepted.sort(), [6, 9]);
  assert.deepEqual(final.rejected, []);
});

test('the guard catches a real schedule change and keeps that channel as it was', async () => {
  const original = lineup();
  const plan = planMigration(original);
  // Break one planned channel the way a buggy migration could: reorder its files.
  plan.config.channels[0].files.reverse();

  const verdicts = await verify(original, plan);
  assert.equal(verdicts[6].identical, false, 'the diff sees it — the guard is not vacuous');
  assert.equal(verdicts[9].identical, true);

  const final = finalizeMigration(original, plan, verdicts);
  assert.deepEqual(final.accepted, [9]);
  assert.equal(final.rejected[0].number, 6);
  assert.equal(final.rejected[0].reason, 'schedule-changed');
  assert.deepEqual(final.config.channels[0], original.channels[0], 'CH 6 is exactly as it was');
  assert.ok(Object.values(final.index.items).every((item) => !item.ref.includes('Office')),
    'and nothing in the library refers to it');
});

test('a changed duration is caught too, not just a reorder', async () => {
  const original = lineup();
  const plan = planMigration(original);
  plan.config.channels[1].files[0].duration += 1;
  const verdicts = await verify(original, plan);
  assert.equal(verdicts[9].identical, false);
});

test('a channel with no verdict is rejected, not assumed fine', () => {
  const original = lineup();
  const plan = planMigration(original);
  const final = finalizeMigration(original, plan, { 6: { identical: true } });
  assert.deepEqual(final.accepted, [6]);
  assert.equal(final.rejected[0].number, 9);
  assert.equal(final.rejected[0].reason, 'not-verified');
});

test('folders become roots one to one, provider folders as provider roots', () => {
  const plan = planMigration(lineup());
  assert.equal(plan.index.roots.length, 3);
  const archive = plan.index.roots.find((root) => root.source === 'archive');
  assert.equal(archive.kind, 'provider');
  const clip = Object.values(plan.index.items).find((item) => item.ref === 'mediasource:archive:clip1');
  assert.equal(clip.root, archive.id, 'a file lands in the root it was scanned from');
});

test('metadata moves to the item, and the same file on two channels becomes one item', () => {
  const original = lineup();
  // The same episode on a second channel, titled differently there.
  original.channels[1].files.push({ path: 'J:\\TV\\Office\\s01e01.mkv', duration: 1320, folder: 'f9', source: 'local', title: 'Pilot (Mixed edit)' });
  const plan = planMigration(original);

  const id = plannedItemId('J:\\TV\\Office\\s01e01.mkv');
  const channelFiles = plan.config.channels.flatMap((ch) => ch.files).filter((f) => f.path === 'J:\\TV\\Office\\s01e01.mkv');
  assert.equal(channelFiles.length, 2);
  assert.ok(channelFiles.every((f) => f.item === id), 'one item, referenced twice');

  // Equal provenance and no timestamps: the lower channel number wins, whatever
  // order the channels are in.
  assert.equal(plan.index.items[id].title, 'Pilot');
  assert.equal(plan.conflicts.length, 1);
  assert.deepEqual(plan.config.channels[1].fileOverrides[id], { title: 'Pilot (Mixed edit)' },
    "the losing channel's value is kept, so nothing is lost when dual-read ends");
});

test('a re-run on an already-migrated lineup changes nothing', () => {
  const once = planMigration(lineup()).config;
  const twice = planMigration(once);
  assert.deepEqual(twice.config.channels.map((ch) => ch.files), once.channels.map((ch) => ch.files),
    'ids are reused, not re-keyed');
});

test('the renderer check walks the window in chunks and agrees with a single diff', async () => {
  const { S } = await load('core/state.js');
  const { verifyMigrationPlan } = await load('library/migration.js');
  const original = lineup();
  const plan = planMigration(original);
  plan.config.channels[1].files[0].duration += 1;
  S.config = original;
  const progress = [];
  const { verdicts, rows } = await verifyMigrationPlan(plan, {
    fromMs: 1_758_000_000_000, days: 20, chunkDays: 7, pause: async () => {}, onProgress: (p) => progress.push(p),
  });
  assert.deepEqual(verdicts, { 6: { identical: true }, 9: { identical: false } });
  assert.equal(rows[1].identical, false);
  assert.ok(rows[1].firstChange >= 1_758_000_000_000);
  assert.deepEqual(progress.filter((p) => p.channel === 6).map((p) => p.day), [0, 7, 14], 'the last chunk is short, not skipped');

  let stale = false;
  await assert.rejects(verifyMigrationPlan(plan, {
    fromMs: 1_758_000_000_000, days: 20, chunkDays: 7, pause: async () => { stale = true; }, isStale: () => stale,
  }), /changed while they were being checked/);
});

test('item ids are attached to the live config in place, and only for accepted channels', async () => {
  const { applyMigrationIds } = await load('library/migration.js');
  const original = lineup();
  original.channels[0].files.push({ path: 'J:\\TV\\Mixed\\x.mkv', duration: 600, title: 'Shared, titled differently' });
  const plan = planMigration(original);
  const final = finalizeMigration(original, plan, { 6: { identical: true } });
  const live = JSON.parse(JSON.stringify(original));
  const liveFile = live.channels[0].files[0];
  applyMigrationIds(live, final.config, final.accepted);
  assert.equal(live.channels[0].files[0], liveFile, 'the same objects, mutated');
  assert.ok(live.channels[0].files.every((f) => /^itm_/.test(f.item)));
  assert.ok(live.channels[1].files.every((f) => f.item === undefined), 'a rejected channel is untouched');
  const { item, ...rest } = live.channels[0].files[0];
  assert.deepEqual(rest, original.channels[0].files[0], 'nothing but the id is written');

  const drifted = JSON.parse(JSON.stringify(original));
  drifted.channels[0].files[1].path = 'J:\\TV\\Office\\renamed.mkv';
  const snapshot = JSON.stringify(drifted);
  assert.throws(() => applyMigrationIds(drifted, final.config, final.accepted), /changed after it was checked/);
  assert.equal(JSON.stringify(drifted), snapshot, 'all or nothing');
});
