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
