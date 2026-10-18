// Saved queries and smart channels (docs/design/07 §6, C6): evaluating a
// `where`, ordering, materializing a playlist, and planning a rebuild that
// keeps what is on the air. Plus the channel.rematerialize command that
// records a rebuild as one exactly-reversible step.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

globalThis.window = globalThis.window || { matchMedia: () => ({ matches: false }), api: {} };
globalThis.document = globalThis.document || { getElementById: () => null };

const load = (name) => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', name)).href);
let q;
test.before(async () => { q = await load('library/query.js'); });

const ep = (id, series, season, episode, extra = {}) => ({
  id, ref: `J:\\TV\\${series}\\S${season}E${episode}.mkv`, duration: 1320, kind: 'episode',
  series: { name: series, season, episode }, facets: { genre: ['sitcom'], era: '1990s' }, tags: [], addedAt: 1, ...extra,
});

test('where: equality, arrays, operators, text, any and not', () => {
  const item = ep('a', 'City Sitcom', 4, 11, { title: 'The Wager', tags: ['classic'], facets: { genre: ['sitcom', 'comedy'], era: '1990s' } });
  assert.equal(q.matchesWhere(item, { kind: 'EPISODE' }), true, 'case-insensitive');
  assert.equal(q.matchesWhere(item, { 'facets.genre': 'comedy' }), true, 'an array field contains');
  assert.equal(q.matchesWhere(item, { 'facets.genre': ['drama', 'sitcom'] }), true, 'any of');
  assert.equal(q.matchesWhere(item, { 'series.season': { gte: 4, lt: 5 } }), true);
  assert.equal(q.matchesWhere(item, { 'facets.era': { lte: '1980s' } }), false, 'decades compare as text');
  assert.equal(q.matchesWhere(item, { text: 'wager' }), true);
  assert.equal(q.matchesWhere(item, { any: [{ kind: 'movie' }, { tags: 'classic' }] }), true);
  assert.equal(q.matchesWhere(item, { not: { 'series.name': 'city sitcom' } }), false);
  assert.equal(q.matchesWhere(item, { rating: { exists: false } }), true);
  assert.throws(() => q.validateWhere({ kind: { like: 'x' } }), /Unknown query operator/);
  assert.throws(() => q.validateWhere([]), /at least one condition/);
});

test('the setup form round-trips to a where, and flags what it cannot show', () => {
  const where = q.buildWhere({ kind: 'episode', genre: ' sitcom ', era: '1990s', series: '', text: 'christmas' });
  assert.deepEqual(where, { kind: 'episode', 'facets.genre': 'sitcom', 'facets.era': '1990s', text: 'christmas' });
  const form = q.formFromWhere(where);
  assert.equal(form.genre, 'sitcom');
  assert.equal(form.advanced, false);
  assert.equal(q.formFromWhere({ 'series.season': { gte: 2 } }).advanced, true);
  assert.equal(q.describeWhere(where), 'episode · genre sitcom · era 1990s · contains “christmas”');
});

test('orders: series order, a shuffle that is stable for its seed, newest first', () => {
  const items = [ep('c', 'B', 1, 2), ep('a', 'A', 2, 1), ep('b', 'A', 1, 10), ep('d', 'A', 1, 2)];
  assert.deepEqual(q.ORDER_POLICIES.series(items).map((i) => i.id), ['d', 'b', 'a', 'c']);
  const one = q.ORDER_POLICIES.shuffle(items, 'seed').map((i) => i.id);
  const two = q.ORDER_POLICIES.shuffle(items.slice().reverse(), 'seed').map((i) => i.id);
  assert.deepEqual(one, two, 'input order does not matter, the seed does');
  const recent = q.ORDER_POLICIES.recent([{ ...items[0], addedAt: 5 }, { ...items[1], addedAt: 9 }]).map((i) => i.id);
  assert.deepEqual(recent, ['a', 'c']);
});

test('materializing skips items with no duration instead of guessing one', () => {
  const { files, skipped } = q.materializeItems([ep('a', 'A', 1, 1, { title: 'Pilot' }), ep('b', 'A', 1, 2, { duration: null })]);
  assert.equal(files.length, 1);
  assert.deepEqual(Object.keys(files[0]).sort(), ['duration', 'facets', 'item', 'kind', 'path', 'source', 'tags', 'title'].sort());
  assert.equal(files[0].item, 'a');
  assert.equal(skipped[0].item, 'b');
});

function library(items, queries) {
  return { items: Object.fromEntries(items.map((i) => [i.id, i])), queries };
}

test('a rebuild keeps folder files first, de-duplicates, and keeps what is airing', async () => {
  const { computeSourcePosition } = await load('core/schedule.js');
  const items = [ep('a', 'A', 1, 1), ep('b', 'A', 1, 2), ep('c', 'A', 1, 3)];
  const lib = library(items, { q1: { id: 'q1', name: 'A', where: { 'series.name': 'A' }, order: 'series' } });
  const channel = {
    number: 40,
    anchor: 1_000_000_000_000,
    sources: [{ type: 'query', query: 'q1' }],
    files: [
      { path: 'J:\\Folder\\intro.mkv', duration: 600, folder: 'f1', source: 'local' },
      { path: items[0].ref, duration: 1320, item: 'a' },
      { path: items[1].ref, duration: 1320, item: 'b' },
    ],
  };
  const atMs = channel.anchor + (600 + 1320 + 100) * 1000; // 100 s into b
  const plan = q.planChannelFiles(channel, lib, { atMs });
  assert.deepEqual(plan.files.map((f) => f.item || f.path), ['J:\\Folder\\intro.mkv', 'a', 'b', 'c']);
  assert.equal(plan.summary.added, 1);
  assert.equal(plan.summary.removed, 0);
  assert.equal(plan.reanchor.ok, true);
  const before = computeSourcePosition({ files: channel.files, anchor: channel.anchor }, atMs, { ignoreContentLost: true });
  const after = computeSourcePosition({ files: plan.files, anchor: plan.anchor }, atMs, { ignoreContentLost: true });
  assert.equal(after.file.path, before.file.path);
  assert.equal(Math.round(after.offset), Math.round(before.offset));
});

test('a rebuild that removes the airing file says so instead of moving the anchor', () => {
  const items = [ep('a', 'A', 1, 1), ep('b', 'B', 1, 1)];
  const lib = library(items, { q1: { id: 'q1', name: 'B', where: { 'series.name': 'B' } } });
  const channel = { number: 41, anchor: 1_000, sources: [{ type: 'query', query: 'q1' }], files: [{ path: items[0].ref, duration: 1320, item: 'a' }] };
  const plan = q.planChannelFiles(channel, lib, { atMs: 60_000 });
  assert.equal(plan.reanchor.ok, false);
  assert.equal(plan.reanchor.reason, 'airing-file-removed');
  assert.equal(plan.anchor, 1_000, 'the anchor is left for the person to decide on');
});

test('a missing saved query is reported per source', () => {
  const plan = q.planChannelFiles({ number: 42, sources: [{ type: 'query', query: 'gone' }], files: [] }, library([], {}), { atMs: 5 });
  assert.equal(plan.summary.sources[0].error, 'saved query not found');
  assert.equal(plan.files.length, 0);
});

test('§8: a query channel over a 5,000-item library builds in under 5 s', () => {
  const items = [];
  for (let i = 0; i < 5000; i += 1) {
    const christmas = i % 50 === 0;
    items.push(ep(`itm_${i}`, `Show ${i % 120}`, (i % 9) + 1, (i % 24) + 1, {
      title: christmas ? `A Very Special Christmas ${i}` : `Episode ${i}`,
      tags: christmas ? ['christmas'] : [],
      duration: 600 + (i % 1200),
    }));
  }
  const lib = library(items, { xmas: { id: 'xmas', name: 'All Christmas specials', where: { text: 'christmas' }, order: 'series' } });
  const started = Date.now();
  const plan = q.planChannelFiles({ number: 50, sources: [{ type: 'query', query: 'xmas' }], files: [] }, lib, { atMs: Date.now() });
  const ms = Date.now() - started;
  assert.equal(plan.files.length, 100);
  assert.ok(ms < 5000, `${ms} ms`);
});

test('channel.rematerialize is one step that restores files, anchor and sources exactly', async () => {
  const { applyCommand, cloneJson } = await load('core/commands.js');
  const config = {
    channels: [{ number: 7, name: 'Smart', anchor: 123, files: [{ path: 'a.mkv', duration: 10 }] }],
  };
  const before = cloneJson(config);
  const inverse = applyCommand(config, {
    type: 'channel.rematerialize', channel: 7,
    files: [{ path: 'b.mkv', duration: 20, item: 'itm_b' }], anchor: 456,
    sources: [{ type: 'query', query: 'q1' }], materializedAt: 999,
  });
  assert.equal(config.channels[0].anchor, 456);
  assert.deepEqual(config.channels[0].sources, [{ type: 'query', query: 'q1' }]);
  assert.equal(config.channels[0].materializedAt, 999);
  inverse.forEach((cmd) => applyCommand(config, cmd));
  assert.deepEqual(config, before, 'no leftover sources or materializedAt keys');
  assert.throws(() => applyCommand(config, { type: 'channel.rematerialize', channel: 7, files: [{ path: 'x' }] }), /positive duration/);
});
