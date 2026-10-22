'use strict';
// Remappable shortcuts (renderer/js/core/keymap.js): the translation in front
// of handleKey, the checks on what a key may be given, and the hint text.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', 'core', 'keymap.js')).href);

test('with nothing remapped keys pass straight through', async () => {
  const { buildKeyTranslator } = await load();
  const t = buildKeyTranslator({});
  assert.equal(t.active, false);
  assert.equal(t.translate('g'), 'g');
});

test('a remapped action answers to its new key and the old one goes quiet', async () => {
  const { buildKeyTranslator } = await load();
  const t = buildKeyTranslator({ guide: 'y' });
  assert.equal(t.translate('y'), 'g', 'Y now opens the guide');
  assert.equal(t.translate('Y'), 'G', 'case is kept');
  assert.equal(t.translate('g'), '', 'G does nothing now');
  assert.equal(t.translate('m'), 'm', 'other keys are untouched');
  assert.equal(t.translate('ArrowUp'), 'ArrowUp');
});

test('two actions can swap keys', async () => {
  const { buildKeyTranslator } = await load();
  const t = buildKeyTranslator({ guide: 's', setup: 'g' });
  assert.equal(t.translate('s'), 'g');
  assert.equal(t.translate('g'), 's');
});

test('keys that are taken, reserved or not a single key are refused', async () => {
  const { keyProblem } = await load();
  assert.equal(keyProblem({}, 'guide', 'y'), null);
  assert.match(keyProblem({}, 'guide', 'm'), /already does/);
  assert.match(keyProblem({}, 'guide', '5'), /Digits/);
  assert.match(keyProblem({}, 'guide', 'k'), /used by something else/);
  assert.match(keyProblem({}, 'guide', 'Enter'), /single/);
  assert.equal(keyProblem({ guide: 'y' }, 'setup', 'g'), null, 'a default letter its owner moved away from is free');
});

test('every default key is unique and none is reserved', async () => {
  const { KEY_ACTIONS, RESERVED_KEYS } = await load();
  const keys = KEY_ACTIONS.map((a) => a.key);
  assert.equal(new Set(keys).size, keys.length, 'no two actions share a default key');
  keys.forEach((k) => assert.ok(!RESERVED_KEYS.has(k), `${k} is not reserved`));
  assert.ok(KEY_ACTIONS.some((a) => a.id === 'skipbreak' && a.key === 'q'));
});

test('the hint bar text swaps only the leading key', async () => {
  const { hintWithKey } = await load();
  assert.equal(hintWithKey('G GUIDE', 'g', 'y'), 'Y GUIDE');
  assert.equal(hintWithKey('SHIFT+↑↓ FAVORITES', 'g', 'y'), 'SHIFT+↑↓ FAVORITES');
});
