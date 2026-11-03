const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { migrateRenamedPlugins, currentThemeId, RETIRED_THEME_IDS } = require('../main/config/renamed-plugins');

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

test('a removed theme pack moves to its kept replacement and its plugin config is dropped', () => {
  const cfg = {
    theme: 'widescreen-grid-13',
    plugins: {
      disabled: ['theme-neo-brutalist', 'ticker'],
      approvedCapabilities: { 'theme-dark-grid-12': 'x', ticker: 'y' },
    },
    pluginSettings: { 'theme-frutiger-aero': {} },
    eras: { snapshot: { theme: 'cyberpunk-synth' } },
  };
  assert.equal(migrateRenamedPlugins(cfg), true);
  assert.equal(cfg.theme, 'cable-guide-hd-15');
  assert.equal(cfg.eras.snapshot.theme, 'outrun-synthwave');
  assert.deepEqual(cfg.plugins.disabled, ['ticker']);
  assert.deepEqual(cfg.plugins.approvedCapabilities, { ticker: 'y' });
  assert.deepEqual(cfg.pluginSettings, {});
  assert.equal(migrateRenamedPlugins(cfg), false);
});

test('every removed theme maps to a pack that still ships', () => {
  for (const [from, to] of Object.entries(RETIRED_THEME_IDS)) {
    assert.ok(!fs.existsSync(path.join(__dirname, '..', 'plugins', `theme-${from}`)), `${from} should be gone`);
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'plugins', `theme-${to}`, 'manifest.json')), `${from} -> ${to} must exist`);
  }
  assert.equal(currentThemeId('dual-tuner-dvr-05'), 'cable-guide-classic-05');
  assert.equal(currentThemeId('wood-console-70s'), 'wood-console-70s');
});
