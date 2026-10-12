// main/config-host.js — host-applied commands, revisions, and replaying host
// edits onto a renderer save that predates them (docs/design/05, step 3).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createConfigHost, RING_SIZE } = require('../main/config/host');

globalThis.window = globalThis.window || { matchMedia: () => ({ matches: false }) };
globalThis.document = globalThis.document || { getElementById: () => null };

const commandsUrl = pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', 'core/commands.js')).href;
const load = (name) => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', name)).href);

function makeDisk(initial) {
  const disk = { raw: JSON.stringify(initial), writes: 0 };
  return {
    disk,
    load: () => JSON.parse(disk.raw),
    save: (config) => { disk.raw = JSON.stringify(config); disk.writes += 1; },
    read: () => JSON.parse(disk.raw),
  };
}

function baseConfig() {
  return { theme: 'digital-2000s', display: { clock24: false }, plugins: { disabled: ['weather'] }, channels: [{ number: 5, name: 'Rewind', files: [] }] };
}

function makeHost(store, broadcasts = []) {
  return createConfigHost({
    load: store.load,
    save: store.save,
    broadcast: (update) => broadcasts.push(update),
    loadCommands: () => import(commandsUrl),
  });
}

test('host commands save, bump the revision, and broadcast what they applied', async () => {
  const store = makeDisk(baseConfig());
  const broadcasts = [];
  const host = makeHost(store, broadcasts);
  const update = await host.applyCommands({ type: 'plugin.setApproval', id: 'party', signature: 'sig-1' }, { source: 'plugins' });
  assert.equal(update.revision, 1);
  assert.equal(host.getRevision(), 1);
  assert.equal(store.read().plugins.approvedCapabilities.party, 'sig-1');
  assert.deepEqual(broadcasts, [update]);
  assert.equal(update.source, 'plugins');
});

test('an invalid batch writes nothing and keeps the revision', async () => {
  const store = makeDisk(baseConfig());
  const host = makeHost(store);
  await assert.rejects(host.applyCommands([
    { type: 'plugin.setEnabled', id: 'weather', enabled: true },
    { type: 'plugin.setEnabled', enabled: true },
  ]));
  assert.equal(store.disk.writes, 0);
  assert.equal(host.getRevision(), 0);
});

test('a renderer save that predates a host edit gets that edit replayed onto it', async () => {
  const store = makeDisk(baseConfig());
  const host = makeHost(store);
  const rendererCopy = store.load(); // renderer loaded at revision 0
  await host.applyCommands({ type: 'plugin.setApproval', id: 'party', signature: 'sig-1' });
  rendererCopy.theme = 'analog-90s'; // an unrelated renderer edit
  const result = await host.reconcileSave(rendererCopy, 0);
  assert.equal(result.replayed, 1);
  const onDisk = store.read();
  assert.equal(onDisk.theme, 'analog-90s', 'the renderer edit is kept');
  assert.equal(onDisk.plugins.approvedCapabilities.party, 'sig-1', 'the host edit is not reverted');
});

test('a save that already includes the host edit replays nothing; an unknown base replays nothing', async () => {
  const store = makeDisk(baseConfig());
  const host = makeHost(store);
  await host.applyCommands({ type: 'plugin.setEnabled', id: 'weather', enabled: true });
  assert.equal((await host.reconcileSave(store.load(), 1)).replayed, 0);
  assert.equal((await host.reconcileSave(store.load(), undefined)).replayed, 0);
});

test('host edits from before a backup restore are never replayed across it', async () => {
  const store = makeDisk(baseConfig());
  const host = makeHost(store);
  await host.applyCommands({ type: 'plugin.setApproval', id: 'old', signature: 'from-before-restore' });
  const restored = baseConfig();
  store.save(restored);
  host.noteReset();
  await host.applyCommands({ type: 'plugin.setApproval', id: 'new', signature: 'after-restore' });
  const rendererSave = baseConfig(); // the renderer adopted the restored config, knew revision 0
  await host.reconcileSave(rendererSave, 0);
  const onDisk = store.read();
  assert.equal(onDisk.plugins.approvedCapabilities.new, 'after-restore');
  assert.equal(onDisk.plugins.approvedCapabilities.old, undefined);
});

test('replaying a host command the renderer already had changes nothing', async () => {
  const { applyCommand, cloneJson } = await import(commandsUrl);
  const config = baseConfig();
  const cmds = [
    { type: 'plugin.setEnabled', id: 'weather', enabled: false },
    { type: 'plugin.setEnabled', id: 'party', enabled: false },
    { type: 'plugin.setApproval', id: 'party', signature: 'x' },
    { type: 'plugin.forget', id: 'weather' },
  ];
  cmds.forEach((cmd) => applyCommand(config, cmd));
  const once = cloneJson(config);
  cmds.forEach((cmd) => applyCommand(config, cmd));
  assert.deepEqual(config, once);
  assert.deepEqual(config.plugins.disabled, ['party']);
});

test('the replay window is bounded', async () => {
  const store = makeDisk(baseConfig());
  const host = makeHost(store);
  for (let i = 0; i < RING_SIZE + 5; i++) {
    // eslint-disable-next-line no-await-in-loop
    await host.applyCommands({ type: 'plugin.setApproval', id: `p${i}`, signature: 's' });
  }
  const warn = console.warn;
  const warnings = [];
  console.warn = (msg) => warnings.push(msg);
  try {
    await host.reconcileSave(baseConfig(), 0);
  } finally {
    console.warn = warn;
  }
  assert.ok(warnings.some((w) => /replay window/.test(w)));
  assert.equal(store.read().plugins.approvedCapabilities[`p${RING_SIZE + 4}`], 's');
});

// The historical bug, end to end: a setup-screen edit is pending when a plugin
// approval lands on the host; the renderer's autosave must not revert it.
test('the capability-approval revert race is gone (renderer state.js + host)', async () => {
  const store = makeDisk(baseConfig());
  const broadcasts = [];
  const host = makeHost(store, broadcasts);
  const state = await load('core/state.js');
  const copy = (value) => JSON.parse(JSON.stringify(value));
  globalThis.window.api = {
    saveConfig: (config, baseRevision, client) => host.reconcileSave(copy(config), baseRevision, { client }),
    applyConfigCommands: (batch, meta) => host.applyCommands(copy(batch), { ...meta, origin: 'client' }),
    getConfigSnapshot: async () => ({ config: store.load(), revision: host.getRevision() }),
    loadConfig: async () => store.load(),
  };
  state.S.config = store.load();
  state.resetUndoBaseline();

  state.S.config.theme = 'analog-90s';
  state.saveConfigDebounced(5); // edit pending on the renderer

  const update = await host.applyCommands({ type: 'plugin.setApproval', id: 'party', signature: 'sig-1' });
  // Even if the broadcast hasn't reached the renderer yet, the save must not
  // lose it; wait for the debounced save.
  await new Promise((resolve) => { setTimeout(resolve, 40); });
  let onDisk = store.read();
  assert.equal(onDisk.theme, 'analog-90s');
  assert.equal(onDisk.plugins.approvedCapabilities.party, 'sig-1', 'replayed onto the stale save');

  // Once the renderer applies the update, it counts as seen and its own copy matches.
  assert.equal(state.applyHostUpdate(update), true);
  assert.equal(state.applyHostUpdate(update), false, 'the same update is applied once');
  assert.equal(state.getHostRevision(), 1);
  assert.equal(state.S.config.plugins.approvedCapabilities.party, 'sig-1');
  assert.equal(state.canUndo(), true, 'the pending theme edit is still undoable');
  state.performUndo();
  assert.equal(state.S.config.theme, 'digital-2000s');
  assert.equal(state.S.config.plugins.approvedCapabilities.party, 'sig-1', 'undoing a setup edit never undoes a host edit');
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  onDisk = store.read();
  assert.equal(onDisk.plugins.approvedCapabilities.party, 'sig-1');
});

// ---------- step 4: announcing viewer-relevant writes ----------

const crypto = require('node:crypto');
const { createChangeAnnouncer } = require('../main/config/host');
const { createViewerRemoteBridge } = require('../main/lan/viewer-server');

const sha1 = (text) => crypto.createHash('sha1').update(text).digest('hex');

test('only writes a viewer would see are announced', () => {
  let notices = 0;
  const announcer = createChangeAnnouncer({ hash: sha1, notify: () => { notices += 1; } });
  const config = { ...baseConfig(), lastChannel: 5, muted: false, volume: 1, pictureMode: 'standard', aspectMode: 'contain' };
  config.display.hintBar = true;
  announcer.prime(config);

  // The host's own watching state: surfing, volume, mute, picture/aspect, hint bar.
  const watched = { ...config, lastChannel: 7, volume: 0.4, muted: true, pictureMode: 'vivid', aspectMode: 'fill', display: { ...config.display, hintBar: false } };
  assert.equal(announcer.written(watched), false);
  assert.equal(notices, 0);

  // A real edit is announced once, and an identical rewrite is not.
  const edited = { ...watched, channels: [{ number: 5, name: 'Rewind HD', files: [] }] };
  assert.equal(announcer.written(edited), true);
  assert.equal(announcer.written({ ...edited, lastChannel: 9 }), false);
  assert.equal(notices, 1);

  // A setting inside display that viewers do render is announced.
  assert.equal(announcer.written({ ...edited, display: { ...edited.display, clock24: true } }), true);
  assert.equal(notices, 2);
});

test('the viewer event bus carries config:changed to a viewer polling with a cursor', () => {
  const bridge = createViewerRemoteBridge();
  const { cursor } = bridge.read(null);
  assert.equal(bridge.publish('config:changed', null), true);
  const { events } = bridge.read(cursor);
  assert.deepEqual(events.map((e) => e.channel), ['config:changed']);
  assert.equal(bridge.publish('config:not-a-channel', null), false, 'the allow-list still applies');
});

// The real host wires loadCommands with a path built from main/config/'s own
// __dirname. It is resolved lazily at the first host command, so a wrong path
// after a directory move surfaces only as a plugin approval that silently
// fails — never at boot, and never in the tests above, which inject their own
// loader. Check the path the application actually uses.
test('the host loads the real commands module from main/config/', async () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(path.join(__dirname, '..', 'main', 'config', 'config.js'), 'utf8');
  const match = source.match(/const COMMANDS_MODULE_PATH = path\.join\(__dirname, ([^)]+)\);/);
  assert.ok(match, 'config.js resolves the commands module through COMMANDS_MODULE_PATH');
  const segments = match[1].split(',').map((part) => part.trim().replace(/^'|'$/g, ''));
  const resolved = path.join(__dirname, '..', 'main', 'config', ...segments);
  assert.ok(fs.statSync(resolved).isFile(), `host commands must resolve to a real file, got ${resolved}`);
  const module = await import(pathToFileURL(resolved).href);
  assert.equal(typeof module.applyCommand, 'function');
});


// ---------- Client-origin batches (docs/design/05 §2.2-2.3, step 6) ----------
// The Electron renderer and the browser control panel both post batches here
// with a base revision and a batch id of their own. These cover the five
// outcomes the host has to tell apart.

const asClient = (client, id, baseRevision) => ({ origin: 'client', client, id, baseRevision, source: client });

test('two clients editing different channels both apply', async () => {
  const store = makeDisk({ ...baseConfig(), channels: [{ number: 5, name: 'Rewind', files: [] }, { number: 9, name: 'Kidz', files: [] }] });
  const host = makeHost(store);

  const laptop = await host.applyCommands([{ type: 'channel.rename', channel: 5, name: 'Toon Town' }], asClient('laptop', 'b1', 0));
  const phone = await host.applyCommands([{ type: 'channel.rename', channel: 9, name: 'Retrovision' }], asClient('phone', 'b2', 0));

  assert.equal(laptop.ok, true);
  assert.equal(phone.ok, true, 'a batch built against revision 0 still applies when it touches something else');
  assert.equal(phone.revision, 2);
  const saved = store.read();
  assert.equal(saved.channels.find((c) => c.number === 5).name, 'Toon Town');
  assert.equal(saved.channels.find((c) => c.number === 9).name, 'Retrovision');
});

test('a stale client editing what another client just changed is refused', async () => {
  const store = makeDisk(baseConfig());
  const host = makeHost(store);

  await host.applyCommands([{ type: 'channel.rename', channel: 5, name: 'Toon Town' }], asClient('laptop', 'b1', 0));
  const phone = await host.applyCommands([{ type: 'channel.rename', channel: 5, name: 'Toonami' }], asClient('phone', 'b2', 0));

  assert.equal(phone.ok, false);
  assert.equal(phone.reason, 'conflict');
  assert.equal(phone.revision, 1, 'the refusal tells the client where the host actually is');
  assert.deepEqual(phone.conflictsWith, [{ type: 'channel.rename', channel: 5, name: 'Toon Town' }]);
  assert.equal(store.read().channels[0].name, 'Toon Town', 'nothing was applied');
});

test("a client's own earlier edits never conflict with its later ones", async () => {
  const store = makeDisk(baseConfig());
  const host = makeHost(store);

  const first = await host.applyCommands([{ type: 'channel.rename', channel: 5, name: 'A' }], asClient('laptop', 'b1', 0));
  // Same base revision, because the reply has not arrived yet.
  const second = await host.applyCommands([{ type: 'channel.rename', channel: 5, name: 'B' }], asClient('laptop', 'b2', 0));

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(store.read().channels[0].name, 'B');
});

test('a redelivered batch is answered, not applied twice', async () => {
  const store = makeDisk({ ...baseConfig(), interstitials: { pool: [] } });
  const host = makeHost(store);
  const batch = [{ type: 'item.insert', collection: 'pool', item: { id: 'ad-1', path: 'x.mp4' } }];

  const first = await host.applyCommands(batch, asClient('laptop', 'once', 0));
  const again = await host.applyCommands(batch, asClient('laptop', 'once', 0));

  assert.equal(first.ok, true);
  assert.equal(again.ok, true);
  assert.equal(again.duplicate, true);
  assert.equal(again.revision, first.revision, 'the revision did not move');
  assert.equal(store.read().interstitials.pool.length, 1, 'an insert is not idempotent, so it must not run twice');
});

test('a batch from before a backup restore is refused rather than applied', async () => {
  const store = makeDisk(baseConfig());
  const host = makeHost(store);

  await host.applyCommands([{ type: 'channel.rename', channel: 5, name: 'A' }], asClient('laptop', 'b1', 0));
  host.noteReset();

  const late = await host.applyCommands([{ type: 'channel.rename', channel: 5, name: 'B' }], asClient('laptop', 'b2', 1));
  assert.equal(late.ok, false);
  assert.equal(late.reason, 'stale-reset');
  assert.equal(store.read().channels[0].name, 'A', 'the restored config was left alone');
});

test('a batch older than the replay window is refused rather than guessed at', async () => {
  const store = makeDisk(baseConfig());
  const host = makeHost(store);
  for (let i = 0; i < RING_SIZE + 5; i++) {
    await host.applyCommands({ type: 'plugin.setApproval', id: `p${i}`, signature: 's' }, { source: 'plugins' });
  }
  const ancient = await host.applyCommands([{ type: 'channel.rename', channel: 5, name: 'B' }], asClient('laptop', 'b1', 0));
  assert.equal(ancient.ok, false);
  assert.equal(ancient.reason, 'stale-window');
});

test('an invalid client batch comes back as a refusal, not an exception', async () => {
  const store = makeDisk(baseConfig());
  const host = makeHost(store);
  const result = await host.applyCommands([{ type: 'channel.rename', channel: 404, name: 'Nope' }], asClient('laptop', 'b1', 0));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid');
  assert.match(result.message, /404/);
  // A host-origin batch still throws, which is what the main-process callers expect.
  await assert.rejects(host.applyCommands([{ type: 'channel.rename', channel: 404, name: 'Nope' }]));
});

test('a host command still applies over a client batch and is replayed onto a whole-config save', async () => {
  const store = makeDisk(baseConfig());
  const host = makeHost(store);

  await host.applyCommands([{ type: 'channel.rename', channel: 5, name: 'Toon Town' }], asClient('laptop', 'b1', 0));
  await host.applyCommands({ type: 'plugin.setEnabled', id: 'weather', enabled: true }, { source: 'plugins' });

  // The laptop's own save, built before it saw the host's plugin command.
  const laptopCopy = store.read();
  laptopCopy.plugins.disabled = ['weather'];
  const saved = await host.reconcileSave(laptopCopy, 1, { client: 'laptop' });

  assert.equal(saved.ok, true);
  assert.equal(saved.replayed, 1);
  assert.deepEqual(store.read().plugins.disabled, [], 'the host edit survived the save that predated it');
});

test("a whole-config save that would bury another client's command is refused", async () => {
  const store = makeDisk(baseConfig());
  const host = makeHost(store);

  await host.applyCommands([{ type: 'channel.rename', channel: 5, name: 'From the phone' }], asClient('phone', 'b1', 0));

  const laptopCopy = baseConfig();
  const result = await host.reconcileSave(laptopCopy, 0, { client: 'laptop' });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'conflict');
  assert.equal(store.read().channels[0].name, 'From the phone', 'nothing was overwritten');
});
