'use strict';
// Settings-only bundles (renderer/js/library/settings-bundle.js): what leaves
// the box, what an imported file may write, and what stays on this machine.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', 'library', 'settings-bundle.js')).href);

test('a bundle holds settings only, never channels or the ad pool', async () => {
  const { buildSettingsBundle } = await load();
  const bundle = buildSettingsBundle({
    channels: [{ number: 1 }], interstitials: { pool: [1] }, reminders: [1],
    theme: 'analog-90s', controls: { volumeStepPct: 15 }, display: { clock24: true, logoBugAuthoredHeight: 2160 },
  });
  assert.equal(bundle.kind, 'reruntv-settings');
  assert.deepEqual(Object.keys(bundle.settings).sort(), ['controls', 'display', 'theme']);
  assert.equal(bundle.settings.display.logoBugAuthoredHeight, undefined, 'a per-machine value stays behind');
  assert.equal(bundle.settings.display.clock24, true);
});

test('importing writes only the named groups and keeps this machine\'s own fields', async () => {
  const { buildSettingsBundle, readSettingsBundle, applySettingsBundle } = await load();
  const file = JSON.parse(JSON.stringify(buildSettingsBundle({ theme: 'x', display: { clock24: true } })));
  file.settings.channels = [{ number: 99 }]; // not in the list: must be ignored
  const settings = readSettingsBundle(file);
  assert.deepEqual(Object.keys(settings).sort(), ['display', 'theme']);
  const config = { channels: [{ number: 1 }], theme: 'old', display: { clock24: false, logoBugAuthoredHeight: 1080 } };
  const written = applySettingsBundle(config, settings);
  assert.deepEqual(written.sort(), ['display', 'theme']);
  assert.equal(config.theme, 'x');
  assert.equal(config.display.clock24, true);
  assert.equal(config.display.logoBugAuthoredHeight, 1080);
  assert.deepEqual(config.channels, [{ number: 1 }]);
});

test('files that are not settings bundles are refused', async () => {
  const { readSettingsBundle } = await load();
  assert.equal(readSettingsBundle(null), null);
  assert.equal(readSettingsBundle({ channels: [] }), null);
  assert.equal(readSettingsBundle({ kind: 'reruntv-settings', settings: {} }), null);
});
