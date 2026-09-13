// main/config-host.js — host-applied commands, revisions, and replaying host
// edits onto a renderer save that predates them (docs/design/05, step 3).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createConfigHost, RING_SIZE } = require('../main/config-host');

globalThis.window = globalThis.window || { matchMedia: () => ({ matches: false }) };
globalThis.document = globalThis.document || { getElementById: () => null };

const commandsUrl = pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', 'commands.js')).href;
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
  return { theme: 'digital-2000s', display: { clock24: false }, plugins: { disabled: ['weather'] }, channels: [{ number: 5, name: 'Boomerang', files: [] }] };
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
  const state = await load('state.js');
  globalThis.window.api = {
    saveConfig: (config, baseRevision) => host.reconcileSave(JSON.parse(JSON.stringify(config)), baseRevision),
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
