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
    { type: 'file.set', channel: 5, file: 'b.mp4', fields: { title: 'Episode 2', tags: ['cartoon'] } },
    { type: 'file.set', channel: 5, file: 'a.mp4', fields: { advisory: 'EDITED FOR TIME', rating: null } },
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
  assert.throws(() => applyCommand(config, { type: 'file.set', channel: 5, file: 'a.mp4', fields: { path: 'x.mp4' } }), /editable file field/);
  assert.throws(() => applyCommand(config, { type: 'file.set', channel: 5, file: 'nope.mp4', fields: { title: 'x' } }), /no file/);
  assert.throws(() => applyCommand(config, { type: 'file.set', channel: 5, block: 'blk-gone', file: 'a.mp4', fields: { title: 'x' } }), /doesn't exist/);
  assert.deepEqual(config, original);
});

test('file.set reaches a file in a schedule block by block id, and a settings label reads as words', async () => {
  const { applyCommand, describeCommand, cloneJson } = await load('commands.js');
  const config = sampleConfig();
  config.channels[0].blocks = [{ id: 'blk-1', files: [{ path: 'a.mp4', duration: 30 }] }];
  const original = cloneJson(config);
  const cmd = { type: 'file.set', channel: 5, block: 'blk-1', file: 'a.mp4', fields: { title: 'Block copy' } };
  const inverse = applyCommand(config, cmd);
  assert.equal(config.channels[0].blocks[0].files[0].title, 'Block copy');
  assert.equal(config.channels[0].files[0].title, undefined, 'the channel pool file with the same path is untouched');
  inverse.forEach((inv) => applyCommand(config, inv));
  assert.deepEqual(config, original);
  assert.equal(describeCommand(config, cmd), 'Change CH 5 file title');
  assert.equal(describeCommand(config, { type: 'settings.set', path: ['display', 'hintBarShowDuration'], value: 1 }), 'Change display hint bar show duration');
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

// ---------- id-addressed lists (step 5, round 2) ----------

function listConfig() {
  const config = sampleConfig();
  config.interstitials = {
    pool: [{ id: 'p1', type: 'commercial', weight: 1 }, { id: 'p2', type: 'bumper', weight: 2 }, { id: 'p3', type: 'commercial', weight: 1 }],
    presets: [],
    flows: [{ id: 'f1', name: 'Flow', steps: [{ id: 's1', name: 'Intro' }], cadence: { enabled: false, podMin: 1 } }],
  };
  return config;
}

test('item.set / item.insert / item.remove undo exactly, and removals in a batch restore their order', async () => {
  const { applyCommand, cloneJson } = await load('commands.js');
  const cases = [
    [{ type: 'item.set', collection: 'pool', id: 'p2', fields: { weight: 5, contentTags: ['x'], type: undefined } }],
    [{ type: 'item.insert', collection: 'presets', item: { id: 'pr1', name: 'New' } }],
    [{ type: 'item.remove', collection: 'pool', id: 'p1' }, { type: 'item.remove', collection: 'pool', id: 'p3' }],
    [{ type: 'item.set', collection: 'flows', id: 'f1', fields: { steps: [{ id: 's1', name: 'Intro' }, { id: 's2', name: 'Pod' }] } }],
  ];
  for (const batch of cases) {
    const config = listConfig();
    const original = cloneJson(config);
    const inverses = [];
    batch.forEach((cmd) => inverses.push(...applyCommand(config, cmd)));
    assert.notDeepEqual(config, original);
    inverses.slice().reverse().forEach((inv) => applyCommand(config, inv));
    assert.deepEqual(config, original, JSON.stringify(batch));
  }
  const config = listConfig();
  assert.throws(() => applyCommand(config, { type: 'item.set', collection: 'pool', id: 'nope', fields: { weight: 1 } }), /No ad pool entry/);
  assert.throws(() => applyCommand(config, { type: 'item.set', collection: 'pool', id: 'p1', fields: { id: 'x' } }), /id/);
  assert.throws(() => applyCommand(config, { type: 'item.set', collection: 'channels', id: 'p1', fields: { weight: 1 } }), /isn't a list/);
  assert.throws(() => applyCommand(config, { type: 'item.insert', collection: 'pool', item: { id: 'p1' } }), /already exists/);
});

test('commitItemEdit records an in-place item edit as one step without replacing the live objects', async () => {
  const state = await load('state.js');
  const { cloneJson } = await load('commands.js');
  state.S.config = listConfig();
  state.resetUndoBaseline();
  const original = JSON.stringify(state.S.config);

  const flow = state.S.config.interstitials.flows[0];
  const cadence = flow.cadence;
  const steps = flow.steps;
  const prior = cloneJson(flow);
  cadence.enabled = true;
  steps.push({ id: 's2', name: 'Pod' });
  assert.equal(state.commitItemEdit('flows', [flow, prior]), true);
  assert.equal(flow.cadence, cadence, 'the nested object the UI holds is still the one in config');
  assert.equal(flow.steps, steps);
  assert.equal(state.undoLabel(), 'Change flow settings');
  assert.equal(state.commitItemEdit('flows', [flow, cloneJson(flow)]), false, 'nothing changed, nothing recorded');

  // A burst of typing on one entry coalesces into one step.
  const entry = state.S.config.interstitials.pool[1];
  for (const text of ['a', 'ab', 'abc']) {
    const before = cloneJson(entry);
    entry.text = text;
    state.commitItemEdit('pool', [entry, before], { coalesce: 'pool:p2:text' });
  }
  assert.equal(state.undoLabel(), 'Change ad pool entry text');
  state.performUndo();
  assert.equal(entry.text, undefined);
  state.performUndo();
  assert.equal(JSON.stringify(state.S.config), original);
  state.performRedo();
  assert.equal(state.S.config.interstitials.flows[0].cadence.enabled, true);
});

test('blocks are a channel-scoped list: inverses keep the channel, and commitInPlace drops a no-op', async () => {
  const { applyCommand, cloneJson } = await load('commands.js');
  const config = sampleConfig();
  config.channels[1].blocks = [{ id: 'b1', name: 'Prime', trigger: { type: 'dayOfWeek', startHour: 20, days: [] } }];
  const original = cloneJson(config);
  const inverses = [];
  inverses.push(...applyCommand(config, { type: 'item.set', collection: 'blocks', channel: 6, id: 'b1', fields: { name: 'Late', trigger: { type: 'dayOfWeek', startHour: 23, days: [5] } } }));
  inverses.push(...applyCommand(config, { type: 'item.insert', collection: 'blocks', channel: 7, item: { id: 'b2', name: 'New' } }));
  inverses.push(...applyCommand(config, { type: 'item.remove', collection: 'blocks', channel: 6, id: 'b1' }));
  assert.ok(inverses.every((inv) => inv.channel === 6 || inv.channel === 7));
  inverses.slice().reverse().forEach((inv) => applyCommand(config, inv));
  delete config.channels[2].blocks; // item.insert creates the list it inserts into
  assert.deepEqual(config, original);
  assert.throws(() => applyCommand(config, { type: 'item.set', collection: 'blocks', channel: 7, id: 'b1', fields: { name: 'x' } }), /No block/);
  assert.throws(() => applyCommand(config, { type: 'item.insert', collection: 'blocks', channel: 99, item: { id: 'b9' } }), /doesn't exist/);

  const state = await load('state.js');
  state.S.config = cloneJson(original);
  state.resetUndoBaseline();
  const block = state.S.config.channels[1].blocks[0];
  const trigger = block.trigger;
  trigger.days.push(6);
  assert.equal(state.commitInPlace({ type: 'item.set', collection: 'blocks', channel: 6, id: 'b1', fields: { trigger } }), true);
  assert.equal(block.trigger, trigger, 'the trigger the days row holds is still the live one');
  assert.equal(state.commitInPlace({ type: 'item.set', collection: 'blocks', channel: 6, id: 'b1', fields: { trigger } }), false, 'unchanged');
  state.performUndo();
  assert.deepEqual(state.S.config.channels[1].blocks[0].trigger.days, []);
});

// ---------- schedule block commands (docs/design/02 §4.1) ----------

function blockConfig() {
  const config = sampleConfig();
  config.channels[0].broadcastHours = { enabled: false, startHour: 6, endHour: 0 };
  config.channels[0].blocks = [
    { id: 'sat', name: 'Saturday Cartoons', priority: 0, trigger: { type: 'dayOfWeek', startHour: 8, endHour: 12, days: [6] }, files: [{ path: 'x.mp4', duration: 60 }], dayOverrides: {} },
    { id: 'xmas', name: '', priority: 10, trigger: { type: 'dateRange', startMonth: 12, startDay: 1, endMonth: 12, endDay: 25 }, mode: 'daily', files: [], dayOverrides: { '12-03': { file: null, skip: true } } },
  ];
  return config;
}

test('block commands undo exactly, and each is safe to apply twice', async () => {
  const { applyCommand, cloneJson } = await load('commands.js');
  const cases = [
    { type: 'block.create', channel: 5, block: { id: 'new', name: 'Mornings', trigger: { type: 'dayOfWeek', startHour: 7, endHour: 11, days: [6] }, files: [] } },
    { type: 'block.create', channel: 7, index: 0, block: { id: 'first', trigger: { type: 'dayOfWeek', startHour: 1, endHour: 2, days: [] } } },
    { type: 'block.remove', channel: 5, id: 'sat' },
    { type: 'block.setHours', channel: 5, id: 'sat', startHour: 7, endHour: 11 },
    { type: 'block.setHours', channel: 5, id: 'xmas', startHour: 18, endHour: 22 },
    { type: 'block.setDays', channel: 5, id: 'sat', days: [6, 0] },
    { type: 'block.setPriority', channel: 5, id: 'sat', priority: 11 },
    { type: 'block.overrideDay', channel: 5, id: 'xmas', key: '12-10', override: { file: 'x.mp4', title: 'Special', skip: false } },
    { type: 'block.overrideDay', channel: 5, id: 'xmas', key: '12-03', override: null },
    { type: 'channel.setBroadcastHours', channel: 5, broadcastHours: { enabled: true, startHour: 6, endHour: 2 } },
  ];
  for (const cmd of cases) {
    const config = blockConfig();
    const original = cloneJson(config);
    const inverse = applyCommand(config, cmd);
    assert.notDeepEqual(config, original, `${cmd.type} changed something`);
    const once = cloneJson(config);
    if (!/create|remove/.test(cmd.type)) {
      applyCommand(config, cmd);
      assert.deepEqual(config, once, `${cmd.type} applied twice is the same as once`);
    }
    inverse.slice().reverse().forEach((inv) => applyCommand(config, inv));
    if (cmd.channel === 7) delete config.channels[2].blocks; // block.create makes the list it inserts into
    assert.deepEqual(config, original, `${cmd.type} undone`);
  }
});

test('block commands describe themselves and refuse what does not fit', async () => {
  const { applyCommand, describeCommand, cloneJson } = await load('commands.js');
  const config = blockConfig();
  assert.equal(describeCommand(config, { type: 'block.setHours', channel: 5, id: 'sat', startHour: 7, endHour: 11 }), 'Set "Saturday Cartoons" to 7 AM–11 AM');
  assert.equal(describeCommand(config, { type: 'block.setDays', channel: 5, id: 'sat', days: [2, 6] }), 'Air "Saturday Cartoons" on Tue, Sat');
  assert.equal(describeCommand(config, { type: 'channel.setBroadcastHours', channel: 5, broadcastHours: { enabled: true, startHour: 6, endHour: 2 } }), 'Sign CH 5 off 2 AM–6 AM');
  assert.equal(describeCommand(config, { type: 'block.create', channel: 5, block: { id: 'z', name: 'Cartoons', trigger: {} } }), 'Add "Cartoons" to CH 5');

  const original = cloneJson(config);
  assert.throws(() => applyCommand(config, { type: 'block.setHours', channel: 5, id: 'sat', startHour: 7, endHour: 24 }), /whole hours/);
  assert.throws(() => applyCommand(config, { type: 'block.setHours', channel: 5, id: 'gone', startHour: 7, endHour: 9 }), /no block/);
  assert.throws(() => applyCommand(config, { type: 'block.setDays', channel: 5, id: 'sat', days: [7] }), /weekdays/);
  assert.throws(() => applyCommand(config, { type: 'block.create', channel: 5, block: { id: 'sat', trigger: {} } }), /already exists/);
  assert.throws(() => applyCommand(config, { type: 'block.overrideDay', channel: 5, id: 'xmas', key: '2026-12-10', override: null }), /MM-DD/);
  assert.throws(() => applyCommand(config, { type: 'channel.setBroadcastHours', channel: 5, broadcastHours: { enabled: 'yes', startHour: 6, endHour: 2 } }), /enabled/);
  assert.deepEqual(config, original);

  applyCommand(config, { type: 'block.setDays', channel: 5, id: 'sat', days: [0, 1, 2, 3, 4, 5, 6, 6] });
  assert.deepEqual(config.channels[0].blocks[0].trigger.days, [], 'all seven days is every day');
});

test('a dispatched block batch is one undo step that restores config exactly', async () => {
  const { cloneJson } = await load('commands.js');
  const state = await load('state.js');
  state.S.config = blockConfig();
  state.resetUndoBaseline();
  const before = cloneJson(state.S.config);
  const liveBlocks = state.S.config.channels[0].blocks;
  state.dispatch([
    { type: 'block.create', channel: 5, block: { id: 'am', name: 'Mornings', priority: 1, trigger: { type: 'dayOfWeek', startHour: 7, endHour: 11, days: [6] }, files: [{ path: 'x.mp4', duration: 60 }] } },
    { type: 'block.setPriority', channel: 5, id: 'sat', priority: 2 },
  ], { label: 'Make Saturday mornings' });
  assert.equal(state.undoLabel(), 'Make Saturday mornings');
  assert.equal(state.S.config.channels[0].blocks.length, 3);
  state.performUndo();
  assert.deepEqual(state.S.config, before);
  assert.equal(state.S.config.channels[0].blocks, liveBlocks, 'undo rewinds in place');
});
