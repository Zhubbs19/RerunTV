// First-run comfort choice (renderer/js/setup/onboarding.js): the pure helper that turns
// the photosensitivity-related page's answer into config changes.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', 'setup', 'onboarding.js')).href);

const defaults = () => ({
  crtEnabled: true,
  crtIntensity: { scanlines: 100, vignette: 100, grain: 100, flicker: 50, curvature: 0 },
  staticEffect: { enabled: true, intensity: 100, durationMs: 150 },
  updates: { strategy: 'startup-auto' },
});

test('full (and unknown values) leave the retro look untouched', async () => {
  const { applyComfortLevel } = await load();
  for (const level of ['full', undefined, 'bogus']) {
    const config = defaults();
    applyComfortLevel(config, level);
    assert.deepEqual(config, defaults(), `level ${String(level)}`);
  }
});

test('gentle turns off flicker and the channel static but keeps the CRT look', async () => {
  const { applyComfortLevel } = await load();
  const config = applyComfortLevel(defaults(), 'gentle');
  assert.equal(config.crtIntensity.flicker, 0);
  assert.equal(config.staticEffect.enabled, false);
  assert.equal(config.crtEnabled, true);
  assert.equal(config.crtIntensity.scanlines, 100, 'other CRT settings are kept');
  assert.equal(config.staticEffect.durationMs, 150, 'other static settings are kept');
});

test('minimal also switches the CRT effect off', async () => {
  const { applyComfortLevel } = await load();
  const config = applyComfortLevel(defaults(), 'minimal');
  assert.equal(config.crtEnabled, false);
  assert.equal(config.crtIntensity.flicker, 0);
  assert.equal(config.staticEffect.enabled, false);
});

test('a config missing those sections still gets safe values', async () => {
  const { applyComfortLevel } = await load();
  const config = applyComfortLevel({}, 'gentle');
  assert.equal(config.staticEffect.enabled, false);
  assert.equal(config.crtIntensity.flicker, 0);
  assert.equal(applyComfortLevel(null, 'gentle'), null);
});
