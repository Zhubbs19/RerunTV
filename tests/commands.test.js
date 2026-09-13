// commands.js (pure) and the command-based undo history in state.js
// (docs/design/05-command-layer-and-sync.md, migration steps 1-2).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const saves = [];
globalThis.window = globalThis.window || { matchMedia: () => ({ matches: false }) };
globalThis.window.api = { saveConfig: async (config) => { saves.push(JSON.stringify(config)); } };
globalThis.document = globalThis.document || { getElementById: () => null };

const load = (name) => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', name)).href);

function sampleConfig() {
  return {
    theme: 'digital-2000s',
    crtEnabled: false,
    crtIntensity: { scanlines: 60, vignette: 30 },
    lastChannel: 5,
    channels: [
      { number: 5, name: 'Boomerang', rating: 'TV-G', favorite: false, files: [{ path: 'a.mp4', duration: 30 }, { path: 'b.mp4', duration: 40 }] },
      { number: 6, name: 'The Office', rating: 'TV-14', files: [{ path: 'c.mp4', duration: 50 }] },
      { number: 7, name: 'Nick', files: [] },
    ],
  };
}

// ---------- pure ----------

test('diffJson ops turn before into after and undo turns it back', async () => {
  const { diffJson, applyPatch, cloneJson } = await load('commands.js');
  const before = sampleConfig();
  const after = cloneJson(before);
  after.theme = 'analog-90s';
  delete after.crtEnabled;
  after.crtIntensity.grain = 65;
  after.channels.splice(1, 1);
  after.channels[0].files.push({ path: 'z.mp4', duration: 9 });
  after.channels[1].name = 'Nickelodeon';

  const { ops, undo } = diffJson(before, after);
  const forward = cloneJson(before);
  applyPatch(forward, ops);
  assert.deepEqual(forward, after);
  applyPatch(forward, undo);
  assert.deepEqual(forward, before);

  const channelSplices = ops.filter((op) => op.s && op.p.join('.') === 'channels');
  assert.equal(channelSplices.length, 1, 'removing one channel is one splice');
  assert.equal(channelSplices[0].s[1], 1, 'only CH 6 is spliced out; CH 5 and CH 7 are diffed in place');
  assert.equal(channelSplices[0].s[2].length, 0, 'the splice carries no copy of the untouched channels');
});

test('diffJson round-trips randomized edits', async () => {
  const { diffJson, applyPatch, cloneJson } = await load('commands.js');
  let seed = 11;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const randomValue = (depth) => {
    const r = rnd();
    if (depth > 2 || r < 0.4) return pick([1, 2.5, 'x', 'y', true, false, null]);
    if (r < 0.7) return Array.from({ length: Math.floor(rnd() * 4) }, () => randomValue(depth + 1));
    return Object.fromEntries(Array.from({ length: Math.floor(rnd() * 4) }, (_, i) => [`k${i}`, randomValue(depth + 1)]));
  };
  const mutate = (node, depth) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      const r = rnd();
      if (r < 0.25) node.splice(Math.floor(rnd() * (node.length + 1)), 0, randomValue(depth));
      else if (r < 0.5 && node.length) node.splice(Math.floor(rnd() * node.length), 1);
      else if (node.length) mutate(node[Math.floor(rnd() * node.length)], depth + 1);
      return;
    }
    const keys = Object.keys(node);
    const r = rnd();
    if (r < 0.3) node[`n${Math.floor(rnd() * 5)}`] = randomValue(depth);
    else if (r < 0.5 && keys.length) delete node[pick(keys)];
    else if (keys.length) {
      const key = pick(keys);
      if (node[key] !== null && typeof node[key] === 'object') mutate(node[key], depth + 1);
      else node[key] = randomValue(depth);
    }
  };
  for (let i = 0; i < 300; i++) {
    const before = { root: randomValue(0), list: [randomValue(1), randomValue(1)] };
    const after = cloneJson(before);
    for (let m = 0; m < 3; m++) mutate(after, 0);
    const { ops, undo } = diffJson(before, after);
    const work = cloneJson(before);
    applyPatch(work, ops);
    assert.deepEqual(work, after, `forward ${i}`);
    applyPatch(work, undo);
    assert.deepEqual(work, before, `back ${i}`);
  }
});

test('applyPatch copies inserted values, so history can never alias live config', async () => {
  const { diffJson, applyPatch, cloneJson } = await load('commands.js');
  const before = sampleConfig();
  const after = cloneJson(before);
  after.channels.push({ number: 9, name: 'New', files: [] });
  const { ops } = diffJson(before, after);
  const live = cloneJson(before);
  applyPatch(live, ops);
  live.channels[3].name = 'Mutated later';
  const again = cloneJson(before);
  applyPatch(again, ops);
  assert.equal(again.channels[3].name, 'New');
});

test('each named command undoes exactly', async () => {
  const { applyCommand, cloneJson } = await load('commands.js');
  const cases = [
    { type: 'channel.set', channel: 5, field: 'favorite', value: true },
    { type: 'channel.set', channel: 7, field: 'rating', value: 'TV-Y7' },
    { type: 'channel.set', channel: 6, field: 'rating', value: null },
    { type: 'channel.rename', channel: 6, name: 'Dunder Mifflin' },
    { type: 'channel.remove', channel: 6 },
    { type: 'channel.insert', index: 1, channel: { number: 12, name: 'Twelve', files: [] } },
    { type: 'settings.set', path: ['crtEnabled'], value: true },
    { type: 'settings.set', path: ['crtIntensity', 'grain'], value: 70 },
    { type: 'settings.set', path: ['display', 'clock24'], value: true },
  ];
  for (const cmd of cases) {
    const config = sampleConfig();
    const original = cloneJson(config);
    const inverse = applyCommand(config, cmd);
    assert.notDeepEqual(config, original, `${cmd.type} changed something`);
    inverse.slice().reverse().forEach((inv) => applyCommand(config, inv));
    if (cmd.path && cmd.path[0] === 'display') delete config.display; // settings.set creates the section it writes into
    assert.deepEqual(config, original, `${cmd.type} undone`);
  }
});

test('invalid commands throw before changing anything', async () => {
  const { applyCommand, cloneJson } = await load('commands.js');
  const config = sampleConfig();
  const original = cloneJson(config);
  assert.throws(() => applyCommand(config, { type: 'channel.set', channel: 5, field: 'files', value: [] }), /editable/);
  assert.throws(() => applyCommand(config, { type: 'channel.set', channel: 99, field: 'favorite', value: true }), /doesn't exist/);
  assert.throws(() => applyCommand(config, { type: 'settings.set', path: ['channels'], value: [] }), /settings section/);
  assert.throws(() => applyCommand(config, { type: 'nope' }), /Unknown command/);
  assert.deepEqual(config, original);
});

// ---------- history (state.js) ----------

async function freshState() {
  const state = await load('state.js');
  state.S.config = sampleConfig();
  state.resetUndoBaseline();
  return state;
}

test('an in-place edit through saveConfigDebounced is one undoable step, restored in place', async () => {
  const state = await freshState();
  const { S } = state;
  const channel = S.config.channels[0];
  channel.rating = 'TV-PG';
  channel.name = 'Boomerang HD';
  state.saveConfigDebounced();
  assert.equal(state.canUndo(), true, 'undo is available before the save fires');
  assert.equal(state.undoLabel(), 'Recent edit', 'a pending burst is not settled just to label it');
  state.performUndo(); state.performRedo();
  assert.equal(state.undoLabel(), 'Edit CH 5');
  state.performUndo(); state.performRedo();

  const gen = S.configGeneration;
  assert.equal(state.performUndo(), true);
  assert.equal(S.configGeneration > gen, true);
  assert.equal(S.config.channels[0], channel, 'undo keeps object identity');
  assert.equal(channel.rating, 'TV-G');
  assert.equal(channel.name, 'Boomerang');
  assert.equal(state.canUndo(), false);

  assert.equal(state.performRedo(), true);
  assert.equal(channel.rating, 'TV-PG');
  assert.equal(channel.name, 'Boomerang HD');
});

test('skipUndo-only writes make no step and survive undoing a later edit', async () => {
  const state = await freshState();
  const { S } = state;
  S.config.lastChannel = 6;
  state.saveConfigDebounced(0, { skipUndo: true });
  assert.equal(state.canUndo(), false);
  // Let that write actually save; one still pending would join the next
  // edit's step (see the next test), exactly as the snapshot history did.
  await new Promise((resolve) => { setTimeout(resolve, 20); });

  S.config.theme = 'analog-90s';
  state.saveConfigDebounced();
  state.performUndo();
  assert.equal(S.config.theme, 'digital-2000s');
  assert.equal(S.config.lastChannel, 6, 'the earlier skipUndo write stays');
  assert.equal(state.canUndo(), false);
});

test('removing an item while editing another in the same burst splices only the removed one', async () => {
  const { diffJson, applyPatch, cloneJson } = await load('commands.js');
  const before = sampleConfig();
  before.channels.push({ number: 8, name: 'Noggin', files: [] });
  const after = cloneJson(before);
  after.channels.splice(1, 1);                    // remove CH 6
  after.channels[0].files.push({ path: 'z.mp4' }); // edit CH 5 (prefix side)
  after.channels[2].name = 'Noggin HD';            // edit CH 8 (suffix side)
  const { ops, undo } = diffJson(before, after);
  const splice = ops.find((op) => op.s && op.p.join('.') === 'channels');
  assert.deepEqual([splice.s[0], splice.s[1], splice.s[2].length], [1, 1, 0]);
  const work = cloneJson(before);
  applyPatch(work, ops);
  assert.deepEqual(work, after);
  applyPatch(work, undo);
  assert.deepEqual(work, before);
});

test('a skipUndo write inside a real edit burst belongs to that step (unchanged behaviour)', async () => {
  const state = await freshState();
  const { S } = state;
  S.config.theme = 'analog-90s';
  state.saveConfigDebounced();
  S.config.lastChannel = 7;
  state.saveConfigDebounced(600, { skipUndo: true });
  state.performUndo();
  assert.equal(S.config.theme, 'digital-2000s');
  assert.equal(S.config.lastChannel, 5);
});

test('dispatch records named steps, coalesces typing, and settles plain edits first', async () => {
  const state = await freshState();
  const { S } = state;
  S.config.crtEnabled = true;
  state.saveConfigDebounced();
  ['B', 'Bo', 'Boo'].forEach((name) => state.dispatch({ type: 'channel.rename', channel: 7, name }, { coalesce: 'rename:7' }));
  assert.equal(S.config.channels[2].name, 'Boo');
  assert.equal(state.undoLabel(), 'Rename CH 7');

  state.performUndo();
  assert.equal(S.config.channels[2].name, 'Nick', 'the whole typing burst is one step');
  assert.equal(S.config.crtEnabled, true, 'the earlier plain edit is its own step');
  assert.equal(state.undoLabel(), 'Change CRT effect');
  state.performUndo();
  assert.equal(S.config.crtEnabled, false);
});

test('a batch with one invalid command changes nothing', async () => {
  const state = await freshState();
  const { S } = state;
  const { cloneJson } = await load('commands.js');
  const before = cloneJson(S.config);
  assert.throws(() => state.dispatch([
    { type: 'channel.set', channel: 5, field: 'favorite', value: true },
    { type: 'channel.set', channel: 404, field: 'favorite', value: true },
  ]));
  assert.deepEqual(S.config, before);
  assert.equal(state.canUndo(), false);
});

test('removing a channel by command is undoable and restores its position', async () => {
  const state = await freshState();
  const { S } = state;
  state.dispatch({ type: 'channel.remove', channel: 6 });
  assert.deepEqual(S.config.channels.map((c) => c.number), [5, 7]);
  state.performUndo();
  assert.deepEqual(S.config.channels.map((c) => c.number), [5, 6, 7]);
  assert.equal(S.config.channels[1].name, 'The Office');
});

test('pushUndoSnapshot makes a wholesale restore one undoable step', async () => {
  const state = await freshState();
  const { S } = state;
  S.config = { theme: 'restored', channels: [{ number: 1, name: 'Only', files: [] }] };
  state.pushUndoSnapshot();
  assert.equal(state.undoLabel(), 'Restore backup');
  state.performUndo();
  assert.equal(S.config.theme, 'digital-2000s');
  assert.equal(S.config.channels.length, 3);
  state.performRedo();
  assert.equal(S.config.theme, 'restored');
});

test('new edits after an undo clear redo', async () => {
  const state = await freshState();
  const { S } = state;
  state.dispatch({ type: 'channel.set', channel: 5, field: 'favorite', value: true });
  state.performUndo();
  assert.equal(state.canRedo(), true);
  S.config.theme = 'x';
  state.saveConfigDebounced();
  assert.equal(state.canRedo(), false);
  assert.equal(state.performRedo(), false);
});

test('the history listener hears edits, commands and undo', async () => {
  const state = await freshState();
  let calls = 0;
  state.onHistoryChange(() => { calls++; });
  state.S.config.theme = 'y';
  state.saveConfigDebounced();
  state.dispatch({ type: 'channel.set', channel: 5, field: 'favorite', value: true });
  state.performUndo();
  state.onHistoryChange(null);
  assert.ok(calls >= 3, `listener called ${calls} times`);
});
