// Isolated plugins that start on first use (isolation.js deferIsolatedPlugin,
// activation-order.js lazyStartEligible). Electron is replaced with a fake whose
// utilityProcess.fork() returns an in-memory "process" speaking the real RPC
// protocol (rpc-channel.js), so the host side runs exactly as it does in the app.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const { lazyStartEligible } = require('../main/plugins/activation-order');
const { createRpc } = require('../main/plugins/rpc-channel');

test('only plugins whose whole surface is in the manifest wait to start', () => {
  const base = { isolated: true, capabilities: { net: [] }, dependsOn: [] };
  const plugins = [
    { ...base, id: 'metadata' },
    { ...base, id: 'server', capabilities: { net: [{ port: 9000 }] } },
    { ...base, id: 'ffmpeg' },
    { ...base, id: 'captions', dependsOn: ['ffmpeg'] },
    { ...base, id: 'watcher', startAtBoot: true },
    // Adds pages to the server plugin's web server, so it must be running.
    { ...base, id: 'server-addon', dependsOn: ['server'] },
    { ...base, id: 'same-process', isolated: false },
  ];
  assert.deepEqual([...lazyStartEligible(plugins)].sort(), ['captions', 'metadata']);
});

// ---------- A fake Electron ----------
const handlers = new Map();
const listeners = new Map();
const forks = [];
let failActivation = false;

/**
 * A stand-in for one forked plugin process: registers a handle channel, an on
 * channel and a media-source service when told to activate.
 * @returns {object} An object shaped like Electron's UtilityProcess.
 */
function fakeChild() {
  const child = new EventEmitter();
  let toHost = null;
  const fromHost = [];
  const rpc = createRpc((msg) => setImmediate(() => child.emit('message', msg)), (cb) => { toHost = cb; fromHost.forEach(cb); });
  child.postMessage = (msg) => setImmediate(() => (toHost ? toHost(msg) : fromHost.push(msg)));
  child.kill = () => setImmediate(() => child.emit('exit', 1));
  child.received = [];
  rpc.on('init', ({ manifest: m }) => {
    if (failActivation) { rpc.emit('activate-result', { ok: false, error: 'boom' }); return; }
    rpc.emit('ipc:handle-register', { channel: 'meta:search' });
    rpc.emit('ipc:on-register', { channel: 'meta:ping' });
    rpc.emit('services:registerProvider', { key: `mediaSource:${m.capabilities.mediaSource[0].providerId}:list` });
    rpc.emit('activate-result', { ok: true });
  });
  rpc.handle('ipc:call', async ({ channel, args }) => ({ channel, args }));
  rpc.on('ipc:on-fire', (payload) => child.received.push(payload));
  rpc.handle('services:invoke', async ({ key, args }) => `${key}:${args.join(',')}`);
  setImmediate(() => rpc.emit('runtime-ready', {}));
  forks.push(child);
  return child;
}

const fakeElectron = {
  app: { getPath: () => os.tmpdir(), on: () => {}, isPackaged: false, getVersion: () => '0.0.0' },
  ipcMain: {
    handle: (channel, fn) => {
      if (handlers.has(channel)) throw new Error(`second handler for ${channel}`);
      handlers.set(channel, fn);
    },
    on: (channel, fn) => listeners.set(channel, fn),
  },
  shell: {},
  desktopCapturer: {},
  utilityProcess: { fork: () => fakeChild() },
};
const realLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === 'electron') return fakeElectron;
  return realLoad.call(this, request, ...rest);
};
const isolation = require('../main/plugins/isolation');
const bridge = require('../main/plugins/bridge');

const manifest = (id, providerId = 'fake') => ({
  id,
  capabilities: {
    ipc: [{ channel: 'meta:search' }, { channel: 'meta:ping' }], spawn: [], net: [], system: [],
    mediaSource: [{ providerId }],
  },
});
const baseCtx = { app: fakeElectron.app, loadConfig: () => ({}), ffmpegStaticPath: null };
const tick = () => new Promise((resolve) => { setTimeout(resolve, 20); });

test('an on-demand plugin starts on its first call, once, and answers through it', async () => {
  forks.length = 0;
  const errors = [];
  isolation.deferIsolatedPlugin(manifest('meta'), path.join(os.tmpdir(), 'meta'), baseCtx, {}, os.tmpdir(), (e) => errors.push(e));
  assert.equal(forks.length, 0, 'nothing forked at boot');
  assert.ok(handlers.has('meta:search') && listeners.has('meta:ping'));

  // Two calls at once share one start.
  const [a, b] = await Promise.all([
    handlers.get('meta:search')({}, 'x'),
    bridge.invoke({}, 'meta', 'meta:search', ['y']),
  ]);
  assert.equal(forks.length, 1);
  assert.deepEqual(a, { channel: 'meta:search', args: ['x'] });
  assert.deepEqual(b, { channel: 'meta:search', args: ['y'] });

  listeners.get('meta:ping')({}, 1, 2);
  await tick();
  assert.deepEqual(forks[0].received, [{ channel: 'meta:ping', args: [1, 2] }]);

  assert.equal(await isolation.callAnyService({}, 'mediaSource:fake:list', ['a']), 'mediaSource:fake:list:a');
  assert.deepEqual(errors, []);

  // A process that stops is started again by the next call.
  forks[0].emit('exit', 0);
  await tick();
  assert.deepEqual(await handlers.get('meta:search')({}, 'z'), { channel: 'meta:search', args: ['z'] });
  assert.equal(forks.length, 2);
});

test('a media-source call starts the provider that declared it', async () => {
  handlers.clear(); listeners.clear(); forks.length = 0;
  isolation.resetLazyForTests();
  isolation.deferIsolatedPlugin(manifest('media', 'other'), os.tmpdir(), baseCtx, {}, os.tmpdir());
  assert.equal(forks.length, 0);
  assert.equal(await isolation.callAnyService({}, 'mediaSource:other:list', ['b']), 'mediaSource:other:list:b');
  assert.equal(forks.length, 1);
});

test('a plugin that fails to start reports it once and stays down', async () => {
  handlers.clear(); listeners.clear(); forks.length = 0;
  isolation.resetLazyForTests();
  failActivation = true;
  const errors = [];
  isolation.deferIsolatedPlugin(manifest('broken', 'none'), os.tmpdir(), baseCtx, {}, os.tmpdir(), (e) => errors.push(e));
  await assert.rejects(handlers.get('meta:search')({}), /boom/);
  await assert.rejects(handlers.get('meta:search')({}), /boom/);
  assert.equal(forks.length, 1, 'no retry after a failed activation');
  assert.deepEqual(errors, ['boom']);
  failActivation = false;
});
