// Declarative plugin settings fields (docs/design/04 §5): the contract a
// plugin's registerPluginSettings section can use instead of render(), and the
// dotted-path read/patch core writes through updatePluginSettings.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', 'plugin-settings-schema.js')).href);

test('fields normalize and reject what core could not draw', async () => {
  const { normalizeSettingsFields } = await load();
  const fields = normalizeSettingsFields('crawl', 'behavior', [
    { key: 'enabled', type: 'toggle', label: 'Show the crawl' },
    { key: 'crawl.speed', type: 'slider', label: 'Crawl speed', min: 1, max: 10, unit: 'x', dependsOn: 'enabled' },
    { key: 'crawl.style', type: 'select', label: 'Style', options: ['ticker', { value: 'marquee', label: 'Marquee' }] },
    { key: 'lines', type: 'number', label: 'Lines', min: 1, step: 1 },
  ]);
  assert.equal(fields[1].step, 1);
  assert.equal(fields[1].unit, 'x');
  assert.deepEqual(fields[2].options, [{ value: 'ticker', label: 'ticker' }, { value: 'marquee', label: 'Marquee' }]);
  assert.equal(fields[3].max, Infinity);

  const bad = (list, pattern) => assert.throws(() => normalizeSettingsFields('crawl', 'behavior', list), pattern);
  bad([], /non-empty/);
  bad([{ key: 'a b', type: 'toggle', label: 'x' }], /dotted key/);
  bad([{ key: 'a', type: 'toggle', label: 'x' }, { key: 'a', type: 'text', label: 'y' }], /duplicate/);
  bad([{ key: 'a', type: 'dial', label: 'x' }], /type must be/);
  bad([{ key: 'a', type: 'toggle' }], /needs a label/);
  bad([{ key: 'a', type: 'slider', label: 'x', min: 5, max: 5 }], /min < max/);
  bad([{ key: 'a', type: 'select', label: 'x', options: [] }], /needs options/);
});

test('dotted paths read and patch without disturbing siblings', async () => {
  const { readSettingPath, settingPathPatch } = await load();
  const settings = { enabled: true, crawl: { speed: 3, style: 'ticker', deep: { a: 1 } } };
  assert.equal(readSettingPath(settings, 'crawl.speed'), 3);
  assert.equal(readSettingPath(settings, 'crawl.missing.x'), undefined);
  assert.deepEqual(settingPathPatch(settings, 'enabled', false), { enabled: false });
  const patch = settingPathPatch(settings, 'crawl.deep.b', 2);
  assert.deepEqual(patch, { crawl: { speed: 3, style: 'ticker', deep: { a: 1, b: 2 } } });
  assert.equal(settings.crawl.deep.b, undefined, 'the saved settings object is not mutated');
  assert.deepEqual(settingPathPatch({}, 'x.y', 1), { x: { y: 1 } });
});

test('values are coerced to what the control can show', async () => {
  const { coerceFieldValue } = await load();
  assert.equal(coerceFieldValue({ type: 'toggle' }, 'yes'), true);
  assert.equal(coerceFieldValue({ type: 'slider', min: 1, max: 10 }, 99), 10);
  assert.equal(coerceFieldValue({ type: 'number', min: 1, max: Infinity }, 'abc'), 1);
  const select = { type: 'select', options: [{ value: 2, label: 'two' }, { value: 3, label: 'three' }] };
  assert.equal(coerceFieldValue(select, '3'), 3, 'the option value, not the string from the <select>');
  assert.equal(coerceFieldValue(select, 'nope'), 2);
  assert.equal(coerceFieldValue({ type: 'text' }, undefined), '');
});

test('ctx v6 exposes the kit as ctx.ui', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'js', 'plugins.js'), 'utf8');
  assert.match(src, /const CTX_VERSION = 6;/);
  const ui = src.match(/const ui = Object\.freeze\(\{([\s\S]*?)\}\);/);
  assert.ok(ui, 'ctx.ui is a frozen object');
  for (const name of ['Button', 'IconButton', 'Field', 'SettingRow', 'Toggle', 'Slider', 'Select', 'Segmented', 'NumberStepper', 'Tabs', 'ListDetail', 'Menu', 'MenuButton', 'Dialog', 'Toast', 'EmptyState', 'Badge', 'Chip', 'FocusScope', 'SpatialFocus']) {
    assert.match(ui[1], new RegExp(`\\b${name}\\b`), `ctx.ui.${name}`);
  }
  assert.match(src, /core, audio, channels, settings, util, search, input, ui,/);
  const docs = fs.readFileSync(path.join(__dirname, '..', 'PLUGIN_DEVELOPMENT.md'), 'utf8');
  assert.match(docs, /ctx\.ui/, 'PLUGIN_DEVELOPMENT.md documents ctx.ui');
});
