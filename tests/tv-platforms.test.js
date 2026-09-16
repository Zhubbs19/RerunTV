// Phase E platforms (docs/design/01 §5.2, §9): gamepad mapping, Tizen/webOS
// shims and the CEC helper's parser — all against fakes, since none of the
// hardware is available here.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { parseCecLine, startCecHelper } = require('../main/ui/cec.js');

const load = (name) => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', name)).href);

function pad(pressed = [], axes = [0, 0]) {
  const buttons = Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i), value: pressed.includes(i) ? 1 : 0 }));
  return { buttons, axes };
}

test('gamepad buttons map to remote keys, once per press', async () => {
  const { createGamepadMapper } = await load('tv/gamepad.js');
  const update = createGamepadMapper();
  assert.deepEqual(update(pad([0]), 0).map((e) => e.key), ['ok']);
  assert.deepEqual(update(pad([0]), 50), [], 'held A does not repeat');
  assert.deepEqual(update(pad([]), 100), []);
  assert.deepEqual(update(pad([1, 9]), 200).map((e) => e.key).sort(), ['back', 'menu']);
  assert.deepEqual(update(pad([]), 250), []);
  assert.deepEqual(update(pad([4]), 300).map((e) => e.key), ['chDown']);
});

test('the stick has a deadzone and directions repeat after a delay', async () => {
  const { createGamepadMapper } = await load('tv/gamepad.js');
  const update = createGamepadMapper({ deadzone: 0.5, repeatDelay: 400, repeatRate: 120 });
  assert.deepEqual(update(pad([], [0.3, 0]), 0), [], 'inside the deadzone');
  assert.deepEqual(update(pad([], [0.9, 0]), 10).map((e) => [e.key, e.repeat]), [['right', false]]);
  assert.deepEqual(update(pad([], [0.9, 0]), 300), [], 'not yet repeating');
  assert.deepEqual(update(pad([], [0.9, 0]), 420).map((e) => [e.key, e.repeat]), [['right', true]]);
  assert.deepEqual(update(pad([], [0.9, 0]), 480), [], 'repeat rate');
  assert.deepEqual(update(pad([], [0.9, 0]), 545).map((e) => e.key), ['right']);
  assert.deepEqual(update(pad([13], [0, 0]), 600).map((e) => e.key), ['down'], 'd-pad down');
});

test('Tizen registers only supported keys; webOS needs none; hidden means standby', async () => {
  const { detectTvPlatform, registerTizenKeys, installTvPlatform } = await load('tv/platform.js');
  const registered = [];
  const tizen = {
    tvinputdevice: {
      getSupportedKeys: () => [{ name: 'ColorF0Red' }, { name: 'ChannelUp' }, { name: 'SomethingElse' }],
      registerKey: (name) => registered.push(name),
    },
  };
  assert.equal(detectTvPlatform({ tizen }), 'tizen');
  assert.equal(detectTvPlatform({ webOS: {} }), 'webos');
  assert.equal(detectTvPlatform({}), null);
  assert.deepEqual(registerTizenKeys(tizen), ['ColorF0Red', 'ChannelUp']);
  assert.deepEqual(registered, ['ColorF0Red', 'ChannelUp']);

  const doc = new EventEmitter();
  doc.addEventListener = (type, fn) => doc.on(type, fn);
  const calls = [];
  assert.equal(installTvPlatform({ webOS: {} }, doc, { standby: () => calls.push('standby'), wake: () => calls.push('wake') }), 'webos');
  doc.visibilityState = 'hidden'; doc.emit('visibilitychange');
  doc.visibilityState = 'visible'; doc.emit('visibilitychange');
  assert.deepEqual(calls, ['standby', 'wake']);
  assert.equal(installTvPlatform({}, doc, { standby() {}, wake() {} }), null, 'a desktop browser is left alone');
});

test('cec-client output becomes remote keys; releases and noise are ignored', () => {
  assert.deepEqual(parseCecLine('TRAFFIC: [ 1234] >> 01:44:01 key pressed: up (1)'), { key: 'up', code: 1, name: 'up' });
  assert.equal(parseCecLine('DEBUG: key pressed: channel up (30)').key, 'chUp');
  assert.equal(parseCecLine('key pressed: select (0)').key, 'ok');
  assert.equal(parseCecLine('key pressed: F2 (red) (72)').key, 'red');
  assert.equal(parseCecLine('key pressed: 7 (27)').key, 'digit7');
  assert.equal(parseCecLine('key released: up (1)'), null);
  assert.equal(parseCecLine('waiting for input'), null);
  assert.equal(parseCecLine('key pressed: vendor thing (ff)'), null);
});

test('the CEC helper streams presses and survives a missing cec-client', () => {
  const stdout = new EventEmitter();
  const child = new EventEmitter();
  child.stdout = stdout;
  child.kill = () => { child.killed = true; };
  const keys = [];
  const stop = startCecHelper({ spawn: () => child, onKey: (p) => keys.push(p.key) });
  stdout.emit('data', Buffer.from('key pressed: up (1)\nkey pr'));
  stdout.emit('data', Buffer.from('essed: select (0)\nkey released: select (0)\n'));
  assert.deepEqual(keys, ['up', 'ok'], 'a line split across chunks still parses');
  stop();
  assert.equal(child.killed, true);

  const errors = [];
  const noop = startCecHelper({ spawn: () => { throw new Error('ENOENT'); }, onKey: () => {}, onError: (e) => errors.push(e.message) });
  noop();
  assert.deepEqual(errors, ['ENOENT']);
});
