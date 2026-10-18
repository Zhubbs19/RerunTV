const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

globalThis.window = globalThis.window || { matchMedia: () => ({ matches: false }), api: {} };
globalThis.document = globalThis.document || { getElementById: () => null };

const load = (name) => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', name)).href);
let builder;
test.before(async () => { builder = await load('library/channel-builder.js'); });

function item(id, genre, era = '1990s', kind = 'episode') {
  return { id, ref: `C:\\Media\\${id}.mkv`, title: id, duration: 1800, kind, facets: { genre: [genre], era }, tags: [genre], series: { name: genre, season: 1, episode: id.charCodeAt(0) } };
}

test('offline description parser produces editable plan slots and blocks', () => {
  const plan = builder.describeChannel('90s cartoons Saturdays 7 am to 11 am, sitcoms weeknights 8 pm to 10 pm');
  assert.equal(Object.keys(plan.slots).length, 2);
  assert.deepEqual(plan.programming[0].block.days, [6]);
  assert.deepEqual(plan.programming[0].block.hours, [7, 11]);
  assert.deepEqual(plan.programming[1].block.days, [1, 2, 3, 4, 5]);
  assert.deepEqual(plan.programming[1].block.hours, [20, 22]);
  assert.equal(plan.slots.slot1.match['facets.era'], '1990s');
});

test('resolve reports missing required slots and ignores detached items', () => {
  const template = builder.BUILTIN_TEMPLATES.find((entry) => entry.id === 'saturday-morning');
  const empty = builder.resolveTemplate(template, { items: {} });
  assert.equal(empty.ready, false);
  assert.deepEqual(empty.missing, ['cartoons']);
  const items = Object.fromEntries(['a', 'b', 'c', 'd'].map((id) => [id, item(id, 'cartoon')]));
  items.d = { ...items.d, detached: true };
  assert.equal(builder.resolveTemplate(template, { items }).ready, false);
  items.d.detached = false;
  assert.equal(builder.resolveTemplate(template, { items }).ready, true);
});

test('compile makes a materialized channel with schedule blocks', () => {
  const plan = builder.describeChannel('cartoons Saturdays 7 am to 11 am, sitcoms weeknights 8 pm to 10 pm');
  const source = [item('a', 'cartoon'), item('b', 'sitcom'), item('c', 'cartoon'), item('d', 'sitcom')];
  const resolved = builder.resolveTemplate(plan, { items: Object.fromEntries(source.map((entry) => [entry.id, entry])) });
  const channel = builder.compileTemplate(resolved, { number: 42, atMs: 1000 });
  assert.equal(channel.number, 42);
  assert.equal(channel.files.length, 4);
  assert.equal(channel.blocks.length, 2);
  assert.equal(channel.blocks[0].files.length, 2);
  assert.deepEqual(channel.blocks[1].trigger, { type: 'dayOfWeek', days: [1, 2, 3, 4, 5], startHour: 20, endHour: 22 });
});

test('channel export removes paths and preserves block structure', () => {
  const template = builder.templateFromChannel({ name: 'Kids', rating: 'TV-Y7', blocks: [{ name: 'Cartoons', files: [{ path: 'secret.mkv', tags: ['cartoon'] }], trigger: { type: 'dayOfWeek', days: [6], startHour: 7, endHour: 11 } }] });
  assert.equal(JSON.stringify(template).includes('secret.mkv'), false);
  assert.deepEqual(template.programming[0].block.days, [6]);
  assert.deepEqual(template.slots.slot1.match, { tags: ['cartoon'] });
});

test('invalid templates fail before touching config', () => {
  assert.throws(() => builder.validateTemplate({ templateVersion: 2 }), /not supported/);
  assert.throws(() => builder.validateTemplate({ templateVersion: 1, id: 'x', name: 'x', slots: {}, channel: {}, programming: [{ block: { play: { slot: 'missing' } } }] }), /unknown slot/);
});

test('registerTemplate (docs/design/08 §3.2) adds a plugin template to listTemplates, validated the same as import', () => {
  const before = builder.listTemplates().length;
  builder.registerTemplate({
    templateVersion: 1, id: 'plugin-test-template', name: 'Plugin Test Template',
    slots: { slot1: { label: 'Slot 1', match: { kind: 'episode' } } },
    channel: { name: 'Plugin Test' },
  });
  const after = builder.listTemplates();
  assert.equal(after.length, before + 1);
  assert.ok(after.some((t) => t.id === 'plugin-test-template'));
  assert.throws(() => builder.registerTemplate({ templateVersion: 1, id: 'bad' }), /missing required fields/);
});

// ---------- Channel presets (docs/design/08: 24/7 loops, breaks, the track card) ----------

function media(id, kind, extra = {}) {
  return { id, ref: `C:/Media/${id}.mp4`, title: id, duration: kind === 'commercial' || kind === 'bumper' ? 30 : 240, kind, facets: {}, tags: [], ...extra };
}

test('a preset with no programming loops its content slots 24/7 and leaves the breaks slot out of the loop', () => {
  const template = builder.BUILTIN_TEMPLATES.find((entry) => entry.id === 'music-television');
  const items = {};
  for (let i = 0; i < 12; i += 1) items[`v${i}`] = media(`v${i}`, 'music', { artist: 'Band', ref: `C:/Media/Music Videos/Band - Song ${i}.mp4` });
  items.ad1 = media('ad1', 'commercial', { tags: ['music'] });
  items.ad2 = media('ad2', 'bumper', { facets: { genre: ['music'] } });
  const resolved = builder.resolveTemplate(template, { items });
  assert.equal(resolved.ready, true);
  const { channel, poolEntries, contentTag } = builder.compilePreset(resolved, { number: 7, atMs: 5000 });
  assert.equal(channel.blocks.length, 0, 'no blocks: a 24/7 loop');
  assert.equal(channel.files.length, 12, 'only the videos loop; the ads are not programs');
  assert.ok(channel.files.every((file) => file.kind === 'music'));
  assert.equal(channel.files[0].artist, 'Band', 'library metadata rides onto the playlist for the track card');
  assert.deepEqual(channel.trackCard, { enabled: true, atStart: true, atEnd: true, seconds: 8 });
  assert.equal(channel.shuffle, true);
  assert.equal(contentTag, 'music-television');
  assert.deepEqual(channel.contentTags, ['music-television']);
  assert.equal(channel.adsEnabled, true);
  assert.equal(poolEntries.length, 2);
  assert.deepEqual(poolEntries.map((entry) => entry.type).sort(), ['bumper', 'commercial']);
  assert.ok(poolEntries.every((entry) => entry.contentTags[0] === 'music-television' && entry.channelAffinity === 'any'));
  assert.equal(poolEntries[0].file.path, 'C:/Media/ad1.mp4');
});

test('re-applying a preset does not duplicate ads already in the pool under its tag', () => {
  const template = builder.BUILTIN_TEMPLATES.find((entry) => entry.id === 'christmas-tv');
  const items = {
    a: media('a', 'movie', { ref: 'C:/Media/Movies/A Christmas Story (1983).mkv', duration: 5600 }),
    b: media('b', 'episode', { tags: ['christmas'], duration: 1300 }),
    c: media('c', 'short', { title: 'Xmas Short', duration: 400 }),
    d: media('d', 'episode', { tags: ['christmas'], duration: 1300 }),
    ad: media('ad', 'commercial', { tags: ['christmas'] }),
    other: media('other', 'commercial'),
  };
  const resolved = builder.resolveTemplate(template, { items });
  assert.equal(resolved.ready, true);
  assert.equal(resolved.slots.programs.files.length, 4);
  const first = builder.compilePreset(resolved, { number: 8, atMs: 1 });
  assert.equal(first.poolEntries.length, 1, 'only the Christmas ad, not the untagged one');
  const second = builder.compilePreset(resolved, { number: 9, atMs: 1, existingPool: first.poolEntries });
  assert.equal(second.poolEntries.length, 0);
  assert.deepEqual(second.channel.contentTags, ['christmas'], 'the second channel still carries the tag, so the shared ads play there too');
});

test('a preset can only set the channel fields it is allowed to', () => {
  const template = {
    templateVersion: 1, id: 'sneaky', name: 'Sneaky',
    slots: { s: { label: 'S', match: { kind: 'movie' } } },
    channel: { name: 'Sneaky', folders: [{ ref: 'C:/evil' }], files: [{ path: 'C:/evil/x.mp4' }], number: 1, rating: 'TV-MA', trackCard: { enabled: true, seconds: 999 } },
  };
  const resolved = builder.resolveTemplate(template, { items: { m: media('m', 'movie', { duration: 5000 }) } });
  const { channel } = builder.compilePreset(resolved, { number: 42, atMs: 1 });
  assert.equal(channel.number, 42);
  assert.deepEqual(channel.folders, []);
  assert.equal(channel.files.length, 1);
  assert.equal(channel.files[0].path, 'C:/Media/m.mp4');
  assert.equal(channel.rating, 'TV-MA');
  assert.equal(channel.trackCard.seconds, 60, 'the card time is clamped');
});

test('compileTemplate still returns the channel alone', () => {
  const template = builder.BUILTIN_TEMPLATES.find((entry) => entry.id === 'marathon');
  const items = Object.fromEntries(['a', 'b', 'c', 'd'].map((id) => [id, item(id, 'sitcom')]));
  const channel = builder.compileTemplate(builder.resolveTemplate(template, { items }), { number: 3, atMs: 1 });
  assert.equal(channel.number, 3);
  assert.equal(channel.files.length, 4);
});

test('a channel with no blocks exports as a 24/7 preset, and its ad tag becomes a breaks slot', () => {
  const template = builder.templateFromChannel({
    name: 'Music TV', shuffle: true, adsEnabled: true, contentTags: ['music-tv'], trackCard: { enabled: true, seconds: 6 },
    files: [{ path: 'secret1.mp4', kind: 'music' }, { path: 'secret2.mp4', kind: 'music' }],
  }, { id: 'music-tv', name: 'Music TV' });
  assert.equal(JSON.stringify(template).includes('secret'), false);
  assert.deepEqual(template.programming, []);
  assert.deepEqual(template.slots.loop.match, { kind: 'music' }, 'the kind every file shares');
  assert.equal(template.channel.shuffle, true);
  assert.equal(template.channel.trackCard.seconds, 6);
  assert.deepEqual(template.breaks, { pool: { slot: 'ads' }, contentTag: 'music-tv' });
  assert.equal(template.slots.ads.optional, true);
});

test('normalizeTrackCard: off is null, defaults fill in, seconds are clamped', () => {
  assert.equal(builder.normalizeTrackCard(null), null);
  assert.equal(builder.normalizeTrackCard({ enabled: false }), null);
  assert.deepEqual(builder.normalizeTrackCard({}), { enabled: true, atStart: true, atEnd: true, seconds: 8 });
  assert.deepEqual(builder.normalizeTrackCard({ atEnd: false, seconds: 1 }), { enabled: true, atStart: true, atEnd: false, seconds: 2 });
});

test('validation covers the new fields, and templateSource tells built-ins from saved presets', () => {
  const base = { templateVersion: 1, id: 'x', name: 'x', slots: { s: { label: 'S', match: { kind: 'movie' } } }, channel: { name: 'x' } };
  assert.throws(() => builder.validateTemplate({ ...base, breaks: { pool: { slot: 'nope' } } }), /unknown slot/);
  assert.throws(() => builder.validateTemplate({ ...base, programming: [{ block: { play: { slot: 's' } } }] }), /days and hours/);
  assert.throws(() => builder.validateTemplate({ ...base, channel: { trackCard: 'yes' } }), /trackCard/);
  assert.throws(() => builder.validateTemplate({ ...base, slots: {} }), /at least one slot/);
  assert.equal(builder.templateSource(builder.BUILTIN_TEMPLATES[0]), 'builtin');
  assert.equal(builder.templateSource({ id: 'plugin-test-template' }), 'plugin');
  assert.equal(builder.templateSource({ id: 'mine' }), 'saved');
  assert.equal(builder.slugify('My Christmas TV!'), 'my-christmas-tv');
  const blank = builder.blankTemplate({ name: 'Fresh' });
  assert.equal(blank.templateVersion, 1);
  assert.deepEqual(blank.programming, []);
});
