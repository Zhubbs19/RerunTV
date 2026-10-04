'use strict';
// settingNumber (renderer/js/core/util.js): blank settings must read as unset, not 0.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
globalThis.window = globalThis.window || { matchMedia: () => ({ matches: false }), api: {} };
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', 'core', 'util.js')).href);

test('settingNumber treats unset, blank and non-numeric values as null', async () => {
  const { settingNumber } = await load();
  for (const v of [undefined, null, '', '  ', 'abc', NaN, Infinity]) assert.equal(settingNumber(v), null);
});

test('settingNumber keeps real numbers, including 0 and numeric text', async () => {
  const { settingNumber } = await load();
  assert.equal(settingNumber(0), 0);
  assert.equal(settingNumber(25), 25);
  assert.equal(settingNumber('40'), 40);
});
