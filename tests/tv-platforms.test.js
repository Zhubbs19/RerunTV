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

// Presses and repeats only; releases are checked where they matter.
const presses = (events) => events.filter((e) => !e.release);

test('gamepad buttons map to remote keys, once per press, and report their release', async () => {
  const { createGamepadMapper } = await load('tv/gamepad.js');
  const update = createGamepadMapper();
  assert.deepEqual(update(pad([0]), 0), [{ key: 'ok', button: '0', repeat: false }]);
  assert.deepEqual(update(pad([0]), 50), [], 'held A does not repeat');
  assert.deepEqual(update(pad([0]), 900), [], 'however long it is held');
  assert.deepEqual(update(pad([]), 950), [{ key: 'ok', button: '0', repeat: false, release: true }]);
  assert.deepEqual(presses(update(pad([1, 9]), 1000)).map((e) => e.key).sort(), ['back', 'menu']);
  assert.deepEqual(presses(update(pad([]), 1050)), []);
  assert.deepEqual(presses(update(pad([4]), 1100)).map((e) => e.key), ['chDown']);
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
  assert.deepEqual(presses(update(pad([13], [0, 0]), 600)).map((e) => e.key), ['down'], 'd-pad down');
});

test('the right stick is the volume, stick clicks mute and recall, and unassigned controls still report', async () => {
  const { createGamepadMapper } = await load('tv/gamepad.js');
  const update = createGamepadMapper({ repeatDelay: 400, repeatRate: 120 });
  assert.deepEqual(update(pad([], [0, 0, 0, -0.9]), 0).map((e) => [e.key, e.button]), [['volUp', 'axis3-']]);
  assert.deepEqual(update(pad([], [0, 0, 0, -0.9]), 450).map((e) => [e.key, e.repeat]), [['volUp', true]], 'volume repeats while held');
  assert.deepEqual(presses(update(pad([], [0, 0, 0, 0.9]), 500)).map((e) => e.key), ['volDown']);
  assert.deepEqual(presses(update(pad([10, 11]), 600)).map((e) => e.key).sort(), ['last', 'mute']);
  // The home button and the right stick's sideways travel do nothing until assigned,
  // but the press is still reported so the settings screen can find the row.
  assert.deepEqual(presses(update(pad([16], [0, 0, 0.9, 0]), 700)), [
    { key: null, button: '16', repeat: false },
    { key: null, button: 'axis2+', repeat: false },
  ]);
});

test('controller buttons can be reassigned, to a remote button, a shortcut or nothing', async () => {
  const { createGamepadMapper, gamepadTarget, GAMEPAD_CONTROLS, GAMEPAD_TARGETS } = await load('tv/gamepad.js');
  const { REMOTE_KEYS } = await load('remote/input.js');
  const { KEY_ACTIONS } = await load('core/keymap.js');
  const bindings = { 3: 'action:fullscreen', 8: 'last', 1: 'none', 2: 'not-a-target', 4: 'volDown' };
  assert.equal(gamepadTarget(bindings, '3'), 'action:fullscreen');
  assert.equal(gamepadTarget(bindings, 8), 'last');
  assert.equal(gamepadTarget(bindings, '1'), null, 'switched off');
  assert.equal(gamepadTarget(bindings, '2'), 'info', 'an unknown target falls back to the default');
  assert.equal(gamepadTarget(null, '0'), 'ok');
  assert.equal(gamepadTarget({}, '99'), null, 'a button the table has no row for');

  const update = createGamepadMapper({ bindings, repeatDelay: 400, repeatRate: 120 });
  assert.deepEqual(update(pad([3, 4]), 0).map((e) => e.key), ['action:fullscreen', 'volDown']);
  assert.deepEqual(update(pad([3, 4]), 450).map((e) => [e.key, e.repeat]), [['volDown', true]], 'repeating follows the assignment, not the button');
  // A settings change applies on the next frame, without rebuilding the mapper.
  assert.deepEqual(presses(update(pad([0]), 500, { bindings: { 0: 'guide' } })).map((e) => e.key), ['guide']);

  // Every default and every choice is something the input layer understands.
  const known = (id) => id === 'none' || REMOTE_KEYS.includes(id) || KEY_ACTIONS.some((a) => `action:${a.id}` === id);
  GAMEPAD_CONTROLS.forEach((control) => assert.ok(GAMEPAD_TARGETS.some((t) => t.id === control.target), `${control.label} defaults to a listed target`));
  GAMEPAD_TARGETS.forEach((target) => assert.ok(known(target.id), `${target.id} is a remote key or a shortcut`));
  assert.equal(new Set(GAMEPAD_CONTROLS.map((c) => c.id)).size, GAMEPAD_CONTROLS.length, 'control ids are unique');
});

test('controller settings fall back to defaults and clamp the dead zone', async () => {
  const { gamepadSettings, gamepadName, createGamepadMapper } = await load('tv/gamepad.js');
  assert.deepEqual(gamepadSettings({}), { enabled: true, deadzone: 0.5, background: false, buttons: {} });
  assert.deepEqual(gamepadSettings(null), { enabled: true, deadzone: 0.5, background: false, buttons: {} });
  const set = gamepadSettings({ gamepad: { enabled: false, deadzone: 5, background: true, buttons: { 0: 'back' } } });
  assert.deepEqual(set, { enabled: false, deadzone: 0.9, background: true, buttons: { 0: 'back' } });
  assert.equal(gamepadSettings({ gamepad: { deadzone: 0 } }).deadzone, 0.2);
  assert.equal(gamepadSettings({ gamepad: { deadzone: 'wide', buttons: 'x' } }).deadzone, 0.5);

  const update = createGamepadMapper();
  assert.deepEqual(update(pad([], [0.4, 0]), 0, { deadzone: 0.3 }).map((e) => e.key), ['right'], 'a smaller dead zone takes less travel');

  assert.equal(gamepadName('Wired Controller (STANDARD GAMEPAD)'), 'Wired Controller');
  assert.equal(gamepadName('Wireless Controller (STANDARD GAMEPAD Vendor: 0000 Product: 0000)'), 'Wireless Controller');
  assert.equal(gamepadName(''), 'Game controller');
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
