// main/system/shutdown.js: the PC-shutdown countdown, with the OS command and
// the clock injected so nothing here can ever reach a real `shutdown`.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_DELAY_SEC, MIN_DELAY_SEC, MAX_DELAY_SEC, clampDelay, shutdownCommand, cancelCommand,
  createShutdownController, registerShutdownIpc,
} = require('../main/system/shutdown.js');

function fakeEnv({ platform = 'win32', allowed = true, fail = false } = {}) {
  const calls = [];
  const timers = [];
  const changes = [];
  let clock = 1_000_000;
  const env = {
    calls, timers, changes,
    allowed,
    advance(ms) {
      clock += ms;
      timers.filter((t) => !t.cleared && !t.fired && t.due <= clock).forEach((t) => { t.fired = true; t.fn(); });
    },
    controller: createShutdownController({
      platform,
      execFile: (file, args, opts, cb) => { calls.push({ file, args }); cb(fail ? new Error('boom') : null); },
      now: () => clock,
      setTimer: (fn, ms) => { const t = { fn, due: clock + ms, cleared: false, fired: false }; timers.push(t); return t; },
      clearTimer: (t) => { if (t) t.cleared = true; },
      isAllowed: () => env.allowed,
      onChange: (status) => changes.push(status),
    }),
  };
  return env;
}

test('clampDelay keeps the countdown within bounds and defaults when nonsense', () => {
  assert.equal(clampDelay(undefined), DEFAULT_DELAY_SEC);
  assert.equal(clampDelay('abc'), DEFAULT_DELAY_SEC);
  assert.equal(clampDelay(1), MIN_DELAY_SEC);
  assert.equal(clampDelay(10_000), MAX_DELAY_SEC);
  assert.equal(clampDelay(30.4), 30);
});

test('each platform gets its own command, and only Windows an OS-side cancel', () => {
  assert.deepEqual(shutdownCommand('win32', 20), { file: 'shutdown', args: ['/s', '/t', '20'], osCountdown: true });
  assert.equal(shutdownCommand('darwin', 20).file, 'osascript');
  assert.equal(shutdownCommand('darwin', 20).osCountdown, false);
  assert.deepEqual(shutdownCommand('linux', 20), { file: 'systemctl', args: ['poweroff'], osCountdown: false });
  assert.deepEqual(cancelCommand('win32'), { file: 'shutdown', args: ['/a'] });
  assert.equal(cancelCommand('darwin'), null);
  assert.equal(cancelCommand('linux'), null);
});

test('refuses while the setting is off, and says so', () => {
  const env = fakeEnv({ allowed: false });
  const status = env.controller.schedule({ source: 'remote' });
  assert.equal(status.pending, false);
  assert.equal(status.allowed, false);
  assert.match(status.error, /switched off/i);
  assert.equal(env.calls.length, 0, 'no command may run while the feature is off');
  assert.equal(env.changes.length, 0);
});

test('Windows: schedule hands the countdown to the OS and cancel aborts it', () => {
  const env = fakeEnv({ platform: 'win32' });
  const status = env.controller.schedule({ delaySec: 20, source: 'menu' });
  assert.equal(status.pending, true);
  assert.equal(status.remainingSec, 20);
  assert.equal(status.source, 'menu');
  assert.deepEqual(env.calls, [{ file: 'shutdown', args: ['/s', '/t', '20'] }]);
  assert.equal(env.timers.length, 0, 'the OS owns the timer on Windows');
  assert.equal(env.changes.length, 1);

  env.advance(5000);
  assert.equal(env.controller.status().remainingSec, 15);

  // A second request while one is pending changes nothing.
  env.controller.schedule({ delaySec: 60 });
  assert.equal(env.calls.length, 1);
  assert.equal(env.controller.status().delaySec, 20);

  const cancelled = env.controller.cancel();
  assert.equal(cancelled.pending, false);
  assert.deepEqual(env.calls[1], { file: 'shutdown', args: ['/a'] });
  assert.equal(env.changes.length, 2);
  // Cancelling again is a no-op.
  env.controller.cancel();
  assert.equal(env.calls.length, 2);
});

test('macOS/Linux: the timer runs here and the command fires only at the deadline', () => {
  const env = fakeEnv({ platform: 'darwin' });
  env.controller.schedule({ delaySec: 10 });
  assert.equal(env.calls.length, 0);
  assert.equal(env.timers.length, 1);
  env.advance(9000);
  assert.equal(env.calls.length, 0);
  env.advance(1000);
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].file, 'osascript');
});

test('macOS/Linux: cancel clears the timer so nothing ever runs', () => {
  const env = fakeEnv({ platform: 'linux' });
  env.controller.schedule({ delaySec: 10 });
  env.controller.cancel();
  env.advance(60_000);
  assert.equal(env.calls.length, 0);
  assert.equal(env.controller.status().pending, false);
});

test('a failed command clears the countdown and reports the error', () => {
  const env = fakeEnv({ platform: 'win32', fail: true });
  env.controller.schedule({});
  const status = env.controller.status();
  assert.equal(status.pending, false);
  assert.match(status.error, /failed/i);
});

test('registerShutdownIpc wires the three channels to the controller', async () => {
  const env = fakeEnv({ platform: 'win32' });
  const handlers = {};
  registerShutdownIpc({ handle: (channel, fn) => { handlers[channel] = fn; } }, env.controller);
  assert.deepEqual(Object.keys(handlers).sort(), ['system:cancelPcShutdown', 'system:pcShutdownStatus', 'system:shutdownPc']);
  const started = await handlers['system:shutdownPc']({}, { delaySec: 20, source: 'menu' });
  assert.equal(started.pending, true);
  assert.equal((await handlers['system:pcShutdownStatus']({})).pending, true);
  assert.equal((await handlers['system:cancelPcShutdown']({})).pending, false);
  // A non-object payload is ignored rather than trusted.
  assert.equal((await handlers['system:shutdownPc']({}, 'nonsense')).pending, true);
});
