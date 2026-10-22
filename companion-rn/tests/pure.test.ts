import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterChannels, formatChannelNumber, formatCountdown, minutesLeft, modeLabel, normalizeCode, parseTarget,
} from '../src/lib/pure.ts';

test('parseTarget fills in http and the default port', () => {
  assert.deepEqual(parseTarget('192.168.1.20'), { baseUrl: 'http://192.168.1.20:8725', code: null });
  assert.deepEqual(parseTarget(' 10.0.0.5:9000 '), { baseUrl: 'http://10.0.0.5:9000', code: null });
});

test('parseTarget reads a pairing URL and strips the path', () => {
  const parsed = parseTarget('http://192.168.1.20:8725/some/page?pair=1234-5678');
  assert.deepEqual(parsed, { baseUrl: 'http://192.168.1.20:8725', code: '12345678' });
});

test('parseTarget refuses unusable input', () => {
  assert.equal(parseTarget(''), null);
  assert.equal(parseTarget('   '), null);
  assert.equal(parseTarget('ftp://host'), null);
  assert.equal(parseTarget('http://'), null);
});

test('normalizeCode keeps letters and digits only', () => {
  assert.equal(normalizeCode('1234 5678'), '12345678');
  assert.equal(normalizeCode('12-34-56-78'), '12345678');
});

test('minutesLeft rounds, never shows zero, and ignores the past', () => {
  assert.equal(minutesLeft(1_000_000 + 10 * 60000, 1_000_000), 10);
  assert.equal(minutesLeft(1_000_000 + 5000, 1_000_000), 1);
  assert.equal(minutesLeft(999, 1_000_000), null);
  assert.equal(minutesLeft(null, 1), null);
});

test('formatCountdown and formatChannelNumber', () => {
  assert.equal(formatCountdown(299_000), '4:59');
  assert.equal(formatCountdown(-5), '0:00');
  assert.equal(formatChannelNumber(7), '07');
  assert.equal(formatChannelNumber(7.1), '07.1');
  assert.equal(formatChannelNumber(null), '--');
});

test('modeLabel maps known values and shouts unknown ones', () => {
  assert.equal(modeLabel('pictureMode', 'vivid'), 'VIVID');
  assert.equal(modeLabel('aspectMode', 'contain'), 'STANDARD');
  assert.equal(modeLabel('audioMode', 'quad'), 'QUAD');
  assert.equal(modeLabel('audioMode', null), '');
});

test('filterChannels matches number prefix or name', () => {
  const rows = [{ number: 2, name: 'Cartoons' }, { number: 12, name: 'Movies' }, { number: 7.1, name: 'News' }];
  assert.deepEqual(filterChannels(rows, '1').map((r) => r.number), [12]);
  assert.deepEqual(filterChannels(rows, 'mov').map((r) => r.number), [12]);
  assert.deepEqual(filterChannels(rows, '7').map((r) => r.number), [7.1]);
  assert.equal(filterChannels(rows, '').length, 3);
});
