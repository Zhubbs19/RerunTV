// The library's host-side API (main/library/service.js): the one object both
// the Electron window and a LAN control panel call. Runs against temp
// directories with a few small fake media files — never a real library.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createLibraryService, registerLibraryIpc, REMOTE_METHODS } = require('../main/library/service');
const { planMigration } = require('../main/library/migrate');

const EXT = new Set(['.mkv']);

function tempDirs() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reruntv-libsvc-'));
  const media = path.join(base, 'media');
  fs.mkdirSync(path.join(media, 'Show'), { recursive: true });
  return { base, media, dir: path.join(base, 'library') };
}

function writeMedia(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(bytes));
}

function lineup(media) {
  return {
    interstitials: { pool: [], presets: [], flows: [] },
    channels: [{
      number: 5, name: 'Show', anchor: 1_700_000_000_000, blocks: [],
      folders: [{ id: 'f5', source: 'local', ref: path.join(media, 'Show') }],
      files: [
        { path: path.join(media, 'Show', 'a.mkv'), duration: 600, folder: 'f5', source: 'local', title: 'A' },
        { path: path.join(media, 'Show', 'b.mkv'), duration: 700, folder: 'f5', source: 'local' },
      ],
    }],
  };
}

async function builtService() {
  const dirs = tempDirs();
  writeMedia(path.join(dirs.media, 'Show', 'a.mkv'), 'aaaa');
  writeMedia(path.join(dirs.media, 'Show', 'b.mkv'), 'bbbbbb');
  const service = createLibraryService({ dir: dirs.dir, videoExtensions: EXT });
  const original = lineup(dirs.media);
  const plan = await service.call('planMigration', { config: original });
  const final = await service.call('finalizeMigration', { original, plan, verdicts: { 5: { identical: true } } });
  await service.call('commitMigration', { index: final.index });
  return { service, dirs, final, original };
}

test('status before and after building, and a second build is refused', async () => {
  const dirs = tempDirs();
  const service = createLibraryService({ dir: dirs.dir, videoExtensions: EXT });
  assert.equal((await service.call('status')).built, false);
  const { service: built, final } = await builtService();
  const status = await built.call('status');
  assert.equal(status.built, true);
  assert.equal(status.stats.items, 2);
  assert.equal(status.stats.roots, 1);
  assert.deepEqual(final.accepted, [5]);
  await assert.rejects(built.call('commitMigration', { index: final.index }), /already built/);
  await assert.doesNotReject(built.call('commitMigration', { index: final.index, replace: true }));
});

test('finalizeMigration rejects what was not verified and needs a plan', async () => {
  const dirs = tempDirs();
  const service = createLibraryService({ dir: dirs.dir, videoExtensions: EXT });
  const original = lineup(dirs.media);
  const plan = planMigration(original);
  const final = await service.call('finalizeMigration', { original, plan, verdicts: {} });
  assert.equal(final.rejected[0].reason, 'not-verified');
  assert.equal(Object.keys(final.index.items).length, 0);
  await assert.rejects(service.call('finalizeMigration', { original }), /plan is required/);
});

test('the first scan of a migrated root adopts every file instead of flagging it', async () => {
  const { service, final } = await builtService();
  const rootId = final.index.roots[0].id;
  const summary = await service.call('scanRoot', { rootId });
  assert.equal(summary.review.replaced.length, 0);
  assert.equal(summary.review.ambiguous.length, 0);
  assert.equal(summary.applied.added, 0);
  assert.equal(summary.missing.length, 0);
  assert.deepEqual(await service.call('lastScan', { rootId }), summary, 'the report is kept for review');
  const index = await service.call('getIndex');
  assert.ok(Object.values(index.items).every((item) => item.fingerprint && item.fingerprint.head), 'fingerprints adopted');
});

test('a new file is catalogued with its duration left to the renderer', async () => {
  const { service, final, dirs } = await builtService();
  const rootId = final.index.roots[0].id;
  await service.call('scanRoot', { rootId });
  writeMedia(path.join(dirs.media, 'Show', 'c.mkv'), 'cccccccc');
  const summary = await service.call('scanRoot', { rootId });
  assert.equal(summary.applied.added, 1);
  assert.equal(summary.needsDuration.length, 1);
  const { changed } = await service.call('applyItemUpdates', {
    updates: [{ id: summary.needsDuration[0], fields: { duration: 321, ref: 'X:\\hijack', id: 'nope', fingerprint: null } }],
  });
  assert.equal(changed, 1);
  const item = (await service.call('getIndex')).items[summary.needsDuration[0]];
  assert.equal(item.duration, 321);
  assert.equal(item.ref, path.join(dirs.media, 'Show', 'c.mkv'), 'identity fields cannot be written this way');
  assert.ok(item.fingerprint, 'nor fingerprints');
});

test('a scan refuses an unreachable root and one that is too big', async () => {
  const { service, final, dirs } = await builtService();
  const rootId = final.index.roots[0].id;
  const small = createLibraryService({ dir: dirs.dir, videoExtensions: EXT, maxScanFiles: 1 });
  await assert.rejects(small.call('scanRoot', { rootId }), /more than 1 media files/);
  fs.renameSync(path.join(dirs.media, 'Show'), path.join(dirs.media, 'Unplugged'));
  await assert.rejects(service.call('scanRoot', { rootId }), /not reachable/);
  await assert.rejects(service.call('scanRoot', { rootId: 'nope' }), /not in the library/);
});

test('a changed file waits for review; both decisions are applied and re-probed', async () => {
  const { service, final, dirs } = await builtService();
  const rootId = final.index.roots[0].id;
  await service.call('scanRoot', { rootId });
  const index = await service.call('getIndex');
  const a = Object.values(index.items).find((item) => item.ref.endsWith('a.mkv'));
  const b = Object.values(index.items).find((item) => item.ref.endsWith('b.mkv'));
  writeMedia(a.ref, 'a different file entirely');
  writeMedia(b.ref, 'b was re-encoded, longer');

  const summary = await service.call('scanRoot', { rootId });
  assert.equal(summary.review.replaced.length, 2);

  const kept = await service.call('resolveReview', { rootId, kind: 'replaced', itemId: b.id, keep: true });
  assert.deepEqual(kept, { remaining: 1, needsDuration: [b.id] });
  const fresh = await service.call('resolveReview', { rootId, kind: 'replaced', itemId: a.id, keep: false });
  assert.equal(fresh.remaining, 0);
  assert.equal(fresh.needsDuration.length, 1);

  const after = await service.call('getIndex');
  assert.equal(after.items[a.id].detached, true);
  assert.equal(after.items[a.id].title, 'A', 'the detached item keeps its metadata');
  assert.equal(after.items[fresh.needsDuration[0]].title, undefined, 'the new content inherits nothing');
  const rescan = await service.call('scanRoot', { rootId });
  assert.equal(rescan.review.replaced.length, 0, 'decisions stick');
  assert.equal(rescan.missing.length, 0, 'a detached item is not reported missing');
  await assert.rejects(service.call('resolveReview', { rootId, kind: 'replaced', itemId: a.id }), /not waiting/);
});

test('saved queries: a name and a condition are required', async () => {
  const { service } = await builtService();
  await assert.rejects(service.call('saveQuery', { name: ' ', where: { kind: 'episode' } }), /needs a name/);
  await assert.rejects(service.call('saveQuery', { name: 'x', where: {} }), /at least one condition/);
  const saved = await service.call('saveQuery', { name: ' Sitcoms ', where: { kind: 'episode' }, order: 'shuffle' });
  assert.equal(saved.name, 'Sitcoms');
  const again = await service.call('saveQuery', { id: saved.id, name: 'Sitcoms 2', where: { kind: 'episode' } });
  assert.equal(again.id, saved.id);
  assert.equal((await service.call('status')).stats.queries, 1);
  assert.deepEqual(await service.call('removeQuery', { id: saved.id }), { removed: true });
});

test('moveRoot rewrites roots and item refs from a planned index', async () => {
  const { service, final } = await builtService();
  const index = await service.call('getIndex');
  const planned = JSON.parse(JSON.stringify(index));
  planned.roots[0].ref = 'K:\\Moved\\Show';
  Object.values(planned.items).forEach((item) => { item.ref = `K:\\Moved\\Show\\${path.basename(item.ref)}`; });
  planned.items.itm_unknown = { id: 'itm_unknown', ref: 'K:\\x.mkv' };
  await service.call('moveRoot', { index: planned });
  const after = await service.call('getIndex');
  assert.equal(after.roots[0].ref, 'K:\\Moved\\Show');
  assert.ok(Object.values(after.items).every((item) => item.ref.startsWith('K:\\Moved\\Show\\')));
  assert.equal(after.items.itm_unknown, undefined, 'a move never adds items');
  assert.equal(Object.keys(after.items).length, Object.keys(final.index.items).length);
});

test('a LAN control session cannot rewrite the whole library', async () => {
  const { service } = await builtService();
  for (const method of ['planMigration', 'finalizeMigration', 'commitMigration', 'moveRoot']) {
    assert.equal(REMOTE_METHODS.has(method), false, method);
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(service.call(method, {}, { remote: true }), /only be done on the host/);
  }
  assert.ok((await service.call('status', {}, { remote: true })).built);
  await assert.rejects(service.call('toString'), /Unknown library method/);
});

test('IPC answers { ok, result } or { ok: false, error }', async () => {
  const handlers = {};
  const { service } = await builtService();
  registerLibraryIpc({ handle: (name, fn) => { handlers[name] = fn; } }, { getService: () => service });
  const ok = await handlers['library:call']({}, 'status', {});
  assert.equal(ok.ok, true);
  const bad = await handlers['library:call']({}, 'nope', {});
  assert.deepEqual(bad, { ok: false, error: 'Unknown library method "nope".' });
});
