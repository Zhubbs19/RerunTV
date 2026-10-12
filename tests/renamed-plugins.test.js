const test = require('node:test');
const assert = require('node:assert/strict');
const { migrateRenamedPlugins } = require('../main/config/renamed-plugins');

test('old plugin ids are moved to the new ids in every place config keys on them', () => {
  const cfg = {
    theme: 'prevue-guide-94',
    plugins: {
      disabled: ['prevue', 'ticker'],
      approvedCapabilities: { 'music-choice-channel': '{"ipc":[]}', ticker: 'x' },
    },
    pluginSettings: { 'music-choice-channel': { stations: [1] }, prevue: { label: 'A' } },
    pluginSettingsMeta: { 'music-choice-channel': { v: 2 } },
    eras: { snapshot: { theme: 'prevue-guide-94' } },
  };
  assert.equal(migrateRenamedPlugins(cfg), true);
  assert.equal(cfg.theme, 'scrolling-guide-94');
  assert.deepEqual(cfg.plugins.disabled, ['guide-channel', 'ticker']);
  assert.deepEqual(Object.keys(cfg.plugins.approvedCapabilities).sort(), ['digital-music-channel', 'ticker']);
  assert.deepEqual(cfg.pluginSettings['digital-music-channel'], { stations: [1] });
  assert.deepEqual(cfg.pluginSettings['guide-channel'], { label: 'A' });
  assert.ok(!('prevue' in cfg.pluginSettings));
  assert.deepEqual(cfg.pluginSettingsMeta['digital-music-channel'], { v: 2 });
  assert.equal(cfg.eras.snapshot.theme, 'scrolling-guide-94');
});

test('migration is idempotent and leaves unrelated config alone', () => {
  const cfg = { channels: [{ number: 3, name: 'prevue' }], plugins: { disabled: [] }, pluginSettings: { ticker: {} } };
  assert.equal(migrateRenamedPlugins(cfg), false);
  assert.equal(cfg.channels[0].name, 'prevue', 'only theme ids are rewritten as values, never channel names');
  const again = { pluginSettings: { prevue: { a: 1 } } };
  assert.equal(migrateRenamedPlugins(again), true);
  assert.equal(migrateRenamedPlugins(again), false);
});

test('an existing new-id value wins over a stale old-id value', () => {
  const cfg = { pluginSettings: { prevue: { a: 1 }, 'guide-channel': { a: 2 } } };
  migrateRenamedPlugins(cfg);
  assert.deepEqual(cfg.pluginSettings, { 'guide-channel': { a: 2 } });
});
