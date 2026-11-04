// The library index on disk (docs/design/07 §3).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createLibraryStore, normalize, migrate, SCHEMA_VERSION } = require('../main/library/store');

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reruntv-lib-'));
  return { dir, store: createLibraryStore({ dir }) };
}

test('a missing index starts empty rather than failing', () => {
  const { store } = tempStore();
  assert.deepEqual(store.stats(), { roots: 0, items: 0, series: 0, queries: 0, presets: 0 });
  assert.equal(store.lastLoadError(), null);
  assert.equal(store.load().schemaVersion, SCHEMA_VERSION);
});

test('it round-trips through rerun.db', () => {
  const { dir, store } = tempStore();
  const root = store.addRoot({ ref: 'J:\\Media', kind: 'local' });
  store.addItem({ id: 'itm_a', ref: 'J:\\Media\\a.mkv', root: root.id, duration: 600, title: 'A' });
  store.save();

  assert.equal(store.backend(), 'sqlite');
  assert.ok(fs.existsSync(path.join(dir, 'rerun.db')));
  assert.ok(!fs.existsSync(path.join(dir, 'index.json')), 'no JSON index is written any more');

  const reopened = createLibraryStore({ dir });
  assert.equal(reopened.stats().items, 1);
  assert.equal(reopened.getItem('itm_a').title, 'A');
  assert.equal(reopened.getRoot(root.id).ref, 'J:\\Media');
});

function libraryRows(dir) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'rerun.db'), { readOnly: true });
  const rows = db.prepare("SELECT kind, id FROM library WHERE kind != 'meta' ORDER BY kind, id").all().map((r) => `${r.kind}/${r.id}`);
  db.close();
  return rows;
}

test('save writes in-place edits and removals, row by row', () => {
  const { dir, store } = tempStore();
  const root = store.addRoot({ ref: 'D:\\Library' });
  store.addItem({ id: 'itm_a', ref: 'D:\\Library\\a.mkv', root: root.id, title: 'A' });
  store.addItem({ id: 'itm_b', ref: 'D:\\Library\\b.mkv', root: root.id, title: 'B' });
  store.upsertQuery('q_1', { name: 'Q' });
  store.save();
  assert.deepEqual(libraryRows(dir), ['items/itm_a', 'items/itm_b', 'queries/q_1']);

  // Callers mutate items in place without going through updateItem.
  store.getItem('itm_a').tags = ['comedy'];
  store.removeItem('itm_b');
  store.removeQuery('q_1');
  store.removeRoot(root.id);
  store.save();
  assert.deepEqual(libraryRows(dir), ['items/itm_a']);

  const reopened = createLibraryStore({ dir });
  assert.deepEqual(reopened.getItem('itm_a').tags, ['comedy']);
  assert.equal(reopened.getItem('itm_b'), null);
  assert.equal(reopened.stats().roots, 0);
});

test('an id of __proto__ survives the database like any other', () => {
  const { dir, store } = tempStore();
  store.addItem({ id: '__proto__', ref: 'x.mkv', root: 'r', title: 'Odd' });
  store.save();
  const reopened = createLibraryStore({ dir });
  assert.equal(reopened.getItem('__proto__').title, 'Odd');
  assert.equal(reopened.stats().items, 1);
});

test('an existing index.json is imported once and kept beside the database', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reruntv-lib-'));
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    roots: [{ id: 'root_1', ref: 'D:\\Library' }],
    items: { itm_a: { id: 'itm_a', ref: 'D:\\Library\\a.mkv', root: 'root_1', title: 'A' } },
    presets: { mine: { id: 'mine', name: 'Mine' } },
  }));
  const store = createLibraryStore({ dir });
  assert.deepEqual(store.stats(), { roots: 1, items: 1, series: 0, queries: 0, presets: 1 });
  assert.ok(!fs.existsSync(path.join(dir, 'index.json')));
  assert.ok(fs.existsSync(path.join(dir, 'index.json.pre-sqlite')), 'the old file is kept as a safety copy');
  assert.deepEqual(libraryRows(dir), ['items/itm_a', 'presets/mine']);
  assert.equal(createLibraryStore({ dir }).getRoot('root_1').ref, 'D:\\Library');
});

test('an index.json written beside an existing database library does not overwrite it', () => {
  const { dir, store } = tempStore();
  store.addItem({ id: 'itm_new', ref: 'n.mkv', root: 'r' });
  store.save();
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ schemaVersion: SCHEMA_VERSION, items: { itm_old: { id: 'itm_old' } } }));
  const reopened = createLibraryStore({ dir, now: () => 777 });
  assert.ok(reopened.getItem('itm_new'));
  assert.equal(reopened.getItem('itm_old'), null);
  assert.ok(fs.existsSync(path.join(dir, 'index.json.ignored-777')));
});

test('a corrupt index is preserved, not silently discarded', () => {
  const { dir } = tempStore();
  fs.writeFileSync(path.join(dir, 'index.json'), '{ this is not json');
  const store = createLibraryStore({ dir, now: () => 12345 });

  assert.equal(store.stats().items, 0, 'it starts fresh so the app still runs');
  assert.ok(store.lastLoadError(), 'and says so, rather than looking like an empty library');
  assert.ok(fs.existsSync(path.join(dir, 'index.json.corrupt-12345')),
    "somebody's tags and review decisions are not thrown away");
});

test('an index from a newer build is refused rather than downgraded', () => {
  const { dir } = tempStore();
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1, items: {} }));
  const store = createLibraryStore({ dir });
  assert.throws(() => store.load(), /schema v/,
    'saving would drop fields this version does not understand');
});

test('a half-written or hand-edited index normalizes instead of crashing', () => {
  // deepEqual is prototype-sensitive under assert/strict, and these maps are
  // deliberately prototype-less (see idMap) — so compare their contents.
  assert.deepEqual(Object.keys(normalize(null).items), []);
  assert.deepEqual(Object.keys(normalize({ items: [] }).items), [], 'an array where an object belongs');
  assert.equal(Object.getPrototypeOf(normalize(null).items), null,
    'the id maps have no prototype, so "__proto__" is an ordinary key');
  assert.deepEqual(normalize({ roots: [{ ref: 'no id' }, { id: 'r1', ref: 'J:\\' }] }).roots.map((r) => r.id), ['r1']);
  assert.equal(normalize({}).schemaVersion, SCHEMA_VERSION);
  assert.equal(migrate({ schemaVersion: 1 }).schemaVersion, SCHEMA_VERSION);
});

test('adding the same root twice is idempotent', () => {
  const { store } = tempStore();
  const first = store.addRoot({ ref: 'J:\\Media' });
  const again = store.addRoot({ ref: 'J:\\Media', label: 'ignored' });
  assert.equal(first.id, again.id);
  assert.equal(store.stats().roots, 1);
});

test('removing a root keeps its items, and reports them as orphaned', () => {
  const { store } = tempStore();
  const root = store.addRoot({ ref: 'J:\\Media' });
  store.addItem({ id: 'itm_a', ref: 'J:\\Media\\a.mkv', root: root.id, tags: ['kept'] });

  assert.equal(store.removeRoot(root.id), true);
  assert.equal(store.stats().items, 1, 'an unplugged drive must not delete tags and review decisions');
  assert.deepEqual(store.orphanedItems().map((item) => item.id), ['itm_a']);
  assert.deepEqual(store.getItem('itm_a').tags, ['kept']);
  assert.equal(store.removeRoot(root.id), false, 'removing it again changes nothing');
});

test('ids are random, so a file that moves or is re-encoded keeps its identity', () => {
  const { store } = tempStore();
  const a = store.addItem({ ref: 'J:\\a.mkv', root: 'r1' });
  const b = store.addItem({ ref: 'J:\\a.mkv', root: 'r1' });
  assert.notEqual(a.id, b.id, 'the id is not derived from the ref');
  assert.match(a.id, /^itm_[0-9a-f]{16}$/);

  // The point of that: repointing an item does not change what refers to it.
  store.updateItem(a.id, { ref: 'K:\\moved\\a.mkv' });
  assert.equal(store.getItem(a.id).ref, 'K:\\moved\\a.mkv');
  assert.equal(store.getItem(a.id).id, a.id);
});

test('updates mutate in place and bump the generation', () => {
  const { store } = tempStore();
  const item = store.addItem({ id: 'itm_a', ref: 'J:\\a.mkv', root: 'r1', title: 'Before' });
  const generation = store.generation();

  const updated = store.updateItem('itm_a', { title: 'After' });
  assert.equal(updated, item, 'object identity survives, as it does for config');
  assert.equal(item.title, 'After');
  assert.ok(store.generation() > generation, 'so a cache has something to key on');

  assert.equal(store.updateItem('itm_missing', { title: 'x' }), null);
  assert.equal(store.updateItem('itm_a', { id: 'itm_hijack' }).id, 'itm_a', 'an id cannot be reassigned');
});

test('an id from a filename cannot reach the prototype', () => {
  const { store } = tempStore();
  store.addItem({ id: '__proto__', ref: 'J:\\weird.mkv', root: 'r1', title: 'own property' });
  assert.equal(store.getItem('__proto__').title, 'own property');
  assert.equal({}.title, undefined, 'nothing leaked onto Object.prototype');
  assert.throws(() => store.addItem({ id: '__proto__', ref: 'J:\\again.mkv' }), /already exists/);
});

test('items can be found by ref and listed per root', () => {
  const { store } = tempStore();
  store.addItem({ id: 'itm_a', ref: 'J:\\a.mkv', root: 'r1' });
  store.addItem({ id: 'itm_b', ref: 'J:\\b.mkv', root: 'r1' });
  store.addItem({ id: 'itm_c', ref: 'K:\\c.mkv', root: 'r2' });

  assert.equal(store.findByRef('J:\\b.mkv').id, 'itm_b');
  assert.equal(store.findByRef('J:\\nope.mkv'), null);
  assert.deepEqual(store.itemsInRoot('r1').map((item) => item.id), ['itm_a', 'itm_b']);
  assert.equal(store.allItems().length, 3);

  assert.equal(store.removeItem('itm_a'), true);
  assert.equal(store.removeItem('itm_a'), false);
  assert.equal(store.stats().items, 2);
});

test('series and saved queries upsert', () => {
  const { store } = tempStore();
  const series = store.upsertSeries('ser_workplace', { name: 'Workplace Comedy' });
  store.upsertSeries('ser_workplace', { facets: { genre: ['sitcom'] } });
  assert.equal(store.load().series.ser_workplace.name, 'Workplace Comedy', 'an upsert merges, it does not replace');
  assert.deepEqual(store.load().series.ser_workplace.facets.genre, ['sitcom']);
  assert.equal(series.id, 'ser_workplace');

  store.upsertQuery('q_90s', { name: '90s sitcoms', where: { 'facets.era': '1990s' } });
  assert.equal(store.load().queries.q_90s.name, '90s sitcoms');
  assert.equal(store.removeQuery('q_90s'), true);
  assert.equal(store.removeQuery('q_90s'), false);

  const generated = store.upsertSeries(null, { name: 'Unnamed' });
  assert.match(generated.id, /^ser_[0-9a-f]{16}$/);
});

test('channel presets are stored whole, replaced whole, and survive a reload', () => {
  const { dir, store } = tempStore();
  const preset = { templateVersion: 1, id: 'christmas-mine', name: 'My Christmas', slots: { s: { label: 'S', match: { tags: 'christmas' } } }, channel: { name: 'Xmas' } };
  store.upsertPreset(preset);
  assert.equal(store.stats().presets, 1);
  store.upsertPreset({ ...preset, name: 'Renamed' });
  assert.equal(store.stats().presets, 1, 'same id replaces');
  store.save();
  const reopened = createLibraryStore({ dir });
  assert.equal(reopened.load().presets['christmas-mine'].name, 'Renamed');
  assert.equal(reopened.removePreset('christmas-mine'), true);
  assert.equal(reopened.removePreset('christmas-mine'), false);
  assert.equal(normalize({ presets: 'nope' }).presets.constructor, undefined, 'a bad presets section normalizes to an empty null-prototype map');
});
