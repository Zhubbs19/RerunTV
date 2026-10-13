// Regression tests for hardening found by code scanning: the plugin settings path helper,
// the Cast LAN-only guard, and the bounded Range header parser.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const schema = () => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', 'plugin', 'settings-schema.js')).href);

test('settingPathPatch sets a nested value and keeps the rest of the branch', async () => {
  const { settingPathPatch } = await schema();
  const patch = settingPathPatch({ audio: { volume: 3, mute: false } }, 'audio.volume', 9);
  assert.deepEqual(patch, { audio: { volume: 9, mute: false } });
});

test('settingPathPatch refuses prototype-chain paths and pollutes nothing', async () => {
  const { settingPathPatch } = await schema();
  for (const bad of ['__proto__.polluted', 'a.__proto__.polluted', 'constructor.prototype.polluted', 'a.constructor.polluted', 'prototype.x']) {
    assert.deepEqual(settingPathPatch({}, bad, 'yes'), {}, bad);
  }
  assert.equal({}.polluted, undefined, 'Object.prototype was not touched');
});

test('Cast connections are limited to LAN addresses', () => {
  const { isLanAddress } = require('../plugins/cast-to-tv/castv2-lite.js');
  for (const ok of ['192.168.1.20', '10.0.0.5', '172.16.4.1', '172.31.255.255', '169.254.10.1', '127.0.0.1', '::1', 'fd12:3456::1', 'fe80::1', '[fe80::2]', 'living-room.local']) {
    assert.equal(isLanAddress(ok), true, ok);
  }
  for (const bad of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '192.169.1.1', '2001:4860:4860::8888', 'example.com', 'evil.local.example.com', '', null, undefined]) {
    assert.equal(isLanAddress(bad), false, String(bad));
  }
});

test('Range headers: valid forms parse, malformed bytes ranges are flagged, others ignored', () => {
  const { parseRangeHeader } = require('../main/media/protocol.js');
  assert.deepEqual(parseRangeHeader('bytes=0-99').match.slice(1, 3), ['0', '99']);
  assert.deepEqual(parseRangeHeader('bytes=100-').match.slice(1, 3), ['100', '']);
  assert.deepEqual(parseRangeHeader('bytes=-500').match.slice(1, 3), ['', '500']);
  assert.deepEqual(parseRangeHeader(' bytes = 5 - 9').match.slice(1, 3), ['5', '9']);
  assert.equal(parseRangeHeader('bytes=abc').malformed, true, 'a bytes range that cannot be parsed is a 416');
  assert.equal(parseRangeHeader('items=0-9').malformed, false, 'a different unit is ignored');
  assert.deepEqual(parseRangeHeader(undefined), { match: null, malformed: false });
});

test('a hostile Range header is rejected quickly instead of backtracking', () => {
  const { parseRangeHeader } = require('../main/media/protocol.js');
  const hostile = 'bytes=' + ' '.repeat(16000) + 'x';
  const started = process.hrtime.bigint();
  const result = parseRangeHeader(hostile);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(result.malformed, true);
  assert.ok(ms < 50, `took ${ms.toFixed(1)} ms`);
});
