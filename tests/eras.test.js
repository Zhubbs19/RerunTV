// Eras as a presentation layer (docs/design/10, contract C7) — pure
// apply/clear/override logic in renderer/js/display/eras.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = (name) => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', name)).href);

function sampleConfig() {
  return {
    theme: 'digital-2000s',
    crtEnabled: false,
    crtIntensity: { scanlines: 10, vignette: 20, grain: 5, flicker: 0, curvature: 0 },
    displayMode: { resolution: 'native', aspect: '16:9', windowMode: 'letterbox', uiExtent: 'confined' },
    display: { clock24: true },
  };
}

test('applying then clearing an era restores every touched value exactly (doc 10 §8)', async () => {
  const { applyEra, clearEra } = await load('display/eras.js');
  const config = sampleConfig();
  const before = JSON.stringify(config);
  applyEra(config, '1994');
  assert.notEqual(JSON.stringify(config), before, 'applying an era should change something');
  assert.equal(config.theme, 'prevue-guide-94');
  assert.equal(config.crtEnabled, true);
  clearEra(config);
  assert.equal(JSON.stringify(config), before);
  assert.equal(config.era, undefined);
});

test('an unknown era id throws rather than silently no-op', async () => {
  const { applyEra } = await load('display/eras.js');
  assert.throws(() => applyEra(sampleConfig(), 'nope'));
});

test('a hand-changed era field becomes a box-level exception clearing leaves alone', async () => {
  const { applyEra, clearEra, noteEraOverride, eraFieldSource } = await load('display/eras.js');
  const config = sampleConfig();
  const originalTheme = config.theme;
  applyEra(config, '1994');
  // simulate the person picking a different theme by hand while the era is active
  config.theme = 'vhs-retro-80s';
  noteEraOverride(config, ['theme']);
  assert.equal(eraFieldSource(config, 'theme'), 'override');
  assert.equal(eraFieldSource(config, 'crtEnabled'), 'era');
  clearEra(config);
  assert.equal(config.theme, 'vhs-retro-80s', 'the override survives clearing the era');
  assert.equal(config.crtEnabled, false, 'every other touched field still restores to its pre-era value');
  assert.notEqual(config.theme, originalTheme);
});

test('setting an overridden field back to the era value un-overrides it', async () => {
  const { applyEra, noteEraOverride, eraFieldSource } = await load('display/eras.js');
  const config = sampleConfig();
  applyEra(config, '1994');
  config.crtEnabled = false;
  noteEraOverride(config, ['crtEnabled']);
  assert.equal(eraFieldSource(config, 'crtEnabled'), 'override');
  config.crtEnabled = true; // the era's own value for 1994
  noteEraOverride(config, ['crtEnabled']);
  assert.equal(eraFieldSource(config, 'crtEnabled'), 'era');
});

test('resetEraField restores one field and clears its override without touching others', async () => {
  const { applyEra, noteEraOverride, resetEraField, eraFieldSource } = await load('display/eras.js');
  const config = sampleConfig();
  applyEra(config, '1994');
  config.theme = 'vhs-retro-80s';
  noteEraOverride(config, ['theme']);
  config.crtIntensity.scanlines = 5;
  noteEraOverride(config, ['crtIntensity', 'scanlines']);
  assert.equal(eraFieldSource(config, 'theme'), 'override');
  assert.equal(eraFieldSource(config, 'crtScanlines'), 'override');
  resetEraField(config, 'theme');
  assert.equal(config.theme, 'prevue-guide-94');
  assert.equal(eraFieldSource(config, 'theme'), 'era');
  assert.equal(eraFieldSource(config, 'crtScanlines'), 'override', 'the other override is untouched');
  assert.equal(config.crtIntensity.scanlines, 5, 'and its value is untouched too');
});

test('a field an era does not set is never touched or reported as a source', async () => {
  const { applyEra, eraFieldSource } = await load('display/eras.js');
  const config = sampleConfig();
  config.crtIntensity.vignette = 42;
  applyEra(config, '1994');
  assert.equal(config.crtIntensity.vignette, 42);
  assert.equal(eraFieldSource(config, 'vignette'), null);
});

test('switching eras re-snapshots from the currently active era, not the original box settings', async () => {
  const { applyEra, clearEra } = await load('display/eras.js');
  const config = sampleConfig();
  const before = JSON.stringify(config);
  applyEra(config, '1994');
  applyEra(config, '2016');
  assert.equal(config.theme, 'cloud-guide-16');
  clearEra(config);
  // clearing after switching restores to what was there right before the
  // *second* apply (i.e. 1994's values), since that's what applyEra snapshot
  // as "previous" the second time around - not all the way back to box settings.
  assert.equal(config.theme, 'prevue-guide-94');
  assert.notEqual(JSON.stringify(config), before);
});

test('listEras exposes the five built-ins and getEra resolves by id', async () => {
  const { listEras, getEra } = await load('display/eras.js');
  const eras = listEras();
  assert.equal(eras.length, 5);
  assert.ok(getEra('1994'));
  assert.equal(getEra('nope'), null);
});
