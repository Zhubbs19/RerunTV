// Declarative plugin settings fields (docs/design/04 §5): the contract a
// plugin's registerPluginSettings section can use instead of render(), and the
// dotted-path read/patch core writes through updatePluginSettings.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', 'plugin/settings-schema.js')).href);

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

test('ctx v7 exposes the kit as ctx.ui', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'js', 'plugin/host.js'), 'utf8');
  assert.match(src, /const CTX_VERSION = 7;/);
  const ui = src.match(/const ui = Object\.freeze\(\{([\s\S]*?)\}\);/);
  assert.ok(ui, 'ctx.ui is a frozen object');
  for (const name of ['Button', 'IconButton', 'Field', 'SettingRow', 'Toggle', 'Slider', 'Select', 'Segmented', 'NumberStepper', 'Tabs', 'ListDetail', 'Menu', 'MenuButton', 'Dialog', 'Toast', 'EmptyState', 'Badge', 'Chip', 'FocusScope', 'SpatialFocus']) {
    assert.match(ui[1], new RegExp(`\\b${name}\\b`), `ctx.ui.${name}`);
  }
  assert.match(src, /core, audio, channels, settings, util, search, input, ui, commands,/);
  const docs = fs.readFileSync(path.join(__dirname, '..', 'PLUGIN_DEVELOPMENT.md'), 'utf8');
  assert.match(docs, /ctx\.ui/, 'PLUGIN_DEVELOPMENT.md documents ctx.ui');
});

// docs/design/05 §3. The point of the namespace and the settings-only argument
// is that a plugin command cannot reach anything but its own settings, so
// these check the shape that makes that true rather than only that it exists.
test('ctx v7 gives a plugin its own namespaced, settings-scoped commands', async () => {
  const commands = await import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', 'core/commands.js')).href);
  const type = commands.registerPluginCommand('ctx-test', 'setThing', {
    apply(settings, cmd) {
      const before = settings.thing;
      settings.thing = cmd.value;
      return [{ name: 'setThing', value: before === undefined ? null : before }];
    },
    describe(settings, cmd) { return `Set thing to ${cmd.value}`; },
    touches() { return ['thing']; },
  });
  assert.equal(type, 'plugin:ctx-test.setThing');

  const config = { channels: [{ number: 5, name: 'Untouched' }], theme: 'digital-2000s' };
  const inverse = commands.applyCommand(config, { type, value: 'hello' });
  assert.deepEqual(config.pluginSettings, { 'ctx-test': { thing: 'hello' } });
  assert.equal(config.channels[0].name, 'Untouched', 'nothing outside its settings moved');
  assert.equal(config.theme, 'digital-2000s');

  assert.deepEqual(inverse, [{ type: 'plugin:ctx-test.setThing', value: null }],
    'the inverse comes back in the namespace, not in the plugin\'s own vocabulary');
  commands.applyCommand(config, inverse[0]);
  assert.deepEqual(config.pluginSettings['ctx-test'], { thing: null });

  assert.equal(commands.describeCommand(config, { type, value: 'x' }), 'Set thing to x');
  assert.deepEqual(commands.commandTouches({ type, value: 'x' }), ['plugins/ctx-test/settings/thing'],
    'touch tokens are confined to that plugin, whatever the plugin returns');

  // The host has no plugin renderers, so the command travels as the settings
  // it produced rather than as a type the host would not recognise.
  commands.applyCommand(config, { type, value: 'sent' });
  assert.deepEqual(commands.hostCommandsFor(config, { type, value: 'sent' }),
    [{ type: 'plugin.setSettings', id: 'ctx-test', settings: { thing: 'sent' } }]);

  commands.unregisterPluginCommands('ctx-test');
  assert.equal(commands.isRegisteredCommand(type), false);
});

test('a plugin command cannot be registered outside its own namespace', async () => {
  const commands = await import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', 'core/commands.js')).href);
  assert.throws(() => commands.registerPluginCommand('evil', '../../channel.remove', { apply: () => [] }), /letters, digits/);
  assert.throws(() => commands.registerPluginCommand('', 'x', { apply: () => [] }), /plugin id is required/);
  assert.throws(() => commands.registerPluginCommand('evil', 'x', {}), /apply\(settings, cmd\) is required/);
  // Even a well-formed registration can only ever produce plugin:<id>.<name>.
  const type = commands.registerPluginCommand('evil', 'tryIt', { apply: () => [] });
  assert.equal(type, 'plugin:evil.tryIt');
  assert.equal(commands.isRegisteredCommand('channel.remove'), true, 'core commands are untouched');
  commands.unregisterPluginCommands('evil');
});
