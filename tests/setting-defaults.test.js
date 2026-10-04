'use strict';
// Defaults for the 2026-10 settings (renderer/js/core/setting-defaults.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', 'core', 'setting-defaults.js')).href);

test('fills only what is missing and leaves set values alone', async () => {
  const { fillNewSettingDefaults } = await load();
  const config = { controls: { volumeStepPct: 15 }, display: { clock24: true } };
  const added = fillNewSettingDefaults(config);
  assert.ok(added > 10);
  assert.equal(config.controls.volumeStepPct, 15, 'a chosen value stays');
  assert.equal(config.controls.volumeMaxPct, 100);
  assert.equal(config.display.clock24, true);
  assert.equal(config.display.logoBugFollowPicture, true);
  assert.equal(fillNewSettingDefaults(config), 0, 'second pass adds nothing');
});

test('the old single no-repeat switch seeds the three new ones', async () => {
  const { fillNewSettingDefaults } = await load();
  const config = { commercials: { noRepeatInBreak: true } };
  fillNewSettingDefaults(config);
  assert.equal(config.commercials.noRepeatCommercials, true);
  assert.equal(config.commercials.noRepeatBumpers, true);
  assert.equal(config.commercials.noRepeatInterstitials, true);
});

test('defaultForPath returns a copy, and undefined for settings with no default', async () => {
  const { defaultForPath } = await load();
  const steps = defaultForPath(['controls', 'sleepSteps']);
  steps.push(999);
  assert.deepEqual(defaultForPath(['controls', 'sleepSteps']), [30, 60, 90, 120]);
  assert.equal(defaultForPath(['display', 'clock24']), undefined);
});
