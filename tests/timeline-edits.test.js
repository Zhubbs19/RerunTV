// timeline-edits.js — the commands SCHEDULE > ON AIR's gestures turn into
// (docs/design/02 §4), checked through the same proposeEdit/diffSchedules
// preview and dispatch/undo path the view uses.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

globalThis.window = globalThis.window || { matchMedia: () => ({ matches: false }) };
globalThis.window.api = globalThis.window.api || {};
globalThis.window.api.saveConfig = async () => {};
globalThis.document = globalThis.document || { getElementById: () => null };

const load = (name) => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', name)).href);

const HOUR = 3600000;
const SATURDAY = new Date(2026, 8, 19, 0, 0, 0, 0).getTime();

async function setup() {
  const state = await load('state.js');
  const edits = await load('timeline-edits.js');
  const query = await load('schedule-query.js');
  const commands = await load('commands.js');
  const ch = {
    number: 5,
    name: 'Toons',
    anchor: SATURDAY - 20 * 86400000,
    adsEnabled: true,
    blocks: [],
    folders: [{ id: 'f1', source: 'local', ref: 'D:\\TV\\Library', label: null }],
    files: [
      { path: 'D:\\TV\\Library\\News\\n1.mp4', duration: 1800, folder: 'f1' },
      { path: 'D:\\TV\\Library\\News\\n2.mp4', duration: 1800, folder: 'f1' },
      { path: 'D:\\TV\\Library\\Cartoons\\c1.mp4', duration: 660, folder: 'f1', tags: ['cartoon'] },
      { path: 'D:\\TV\\Library\\Cartoons\\c2.mp4', duration: 690, folder: 'f1', tags: ['cartoon'] },
    ],
  };
  state.S.config = {
    commercials: { timing: 'interval', intervalMinutes: 10, podMin: 1, podMax: 2 },
    interstitials: { pool: [{ id: 'ad', type: 'commercial', channelAffinity: 'any', file: { path: 'ad.mp4', duration: 30 } }], presets: [], flows: [] },
    channels: [ch],
  };
  state.resetUndoBaseline();
  return { state, edits, query, commands, ch: state.S.config.channels[0] };
}

function preview(query, state, commands) {
  const { config, channel } = query.proposeEdit(state.S.config, 5, commands);
  const live = state.S.config.channels[0];
  return query.diffSchedules(live, channel, SATURDAY, query.addDays(SATURDAY, 7), { afterConfig: config });
}

test('make Saturday 7–11 AM cartoons: previewed, applied as one step, and undone to an identical week', async () => {
  const { state, edits, query, commands, ch } = await setup();
  const cartoons = edits.librarySources(state.S.config).folders.find((s) => s.label === 'Cartoons');
  assert.ok(cartoons && cartoons.files.length === 2, 'the Cartoons show folder is a source without scanning');

  const cmd = edits.createBlockCommand(ch, { dayStart: SATURDAY, startHour: 7, endHour: 11, name: 'Saturday Cartoons', files: cartoons.files, folder: cartoons.folder, anchorMs: SATURDAY - 86400000 });
  const before = query.querySchedule(ch, SATURDAY, query.addDays(SATURDAY, 7));
  const diff = preview(query, state, [cmd]);
  assert.equal(diff.identical, false);
  assert.ok(diff.changed.every((r) => r.start >= SATURDAY + 6 * HOUR && r.end <= SATURDAY + 12 * HOUR), 'only Saturday morning changes this week');
  assert.ok(edits.diffCounts(diff).programs > 0);
  assert.equal(edits.guardrailsFor(state.S.config, 5, [cmd]).confirm, false, 'a new weekly block needs no confirm');

  state.dispatch([cmd], { label: 'Make Saturday 7 AM–11 AM Saturday Cartoons' });
  const at8 = query.querySchedule(ch, SATURDAY + 8 * HOUR, SATURDAY + 8 * HOUR + 1, { breaks: false }).programs[0];
  assert.match(at8.file.path, /Cartoons/);
  assert.equal(state.undoLabel(), 'Make Saturday 7 AM–11 AM Saturday Cartoons');

  state.performUndo();
  const after = query.querySchedule(ch, SATURDAY, query.addDays(SATURDAY, 7));
  const key = (e) => `${Math.round(e.start)}|${Math.round(e.end)}|${e.file ? e.file.path : e.breakType}`;
  assert.deepEqual(after.programs.map(key), before.programs.map(key));
  assert.deepEqual(after.breaks.map(key), before.breaks.map(key));
});

test('block spans: owners per hour, edges only where the block really starts and ends', async () => {
  const { state, edits, ch } = await setup();
  const files = [{ path: 'x.mp4', duration: 1200 }];
  ch.blocks.push(
    { id: 'late', name: 'Late', priority: 0, anchor: ch.anchor, trigger: { type: 'dayOfWeek', startHour: 22, endHour: 2, days: [] }, files },
    { id: 'am', name: 'Mornings', priority: 0, anchor: ch.anchor, trigger: { type: 'dayOfWeek', startHour: 8, endHour: 12, days: [6] }, files },
    { id: 'news', name: 'Breaking', priority: 3, anchor: ch.anchor, trigger: { type: 'dayOfWeek', startHour: 7, endHour: 9, days: [6] }, files },
    { id: 'todo', name: 'No folder', priority: 0, trigger: { type: 'dayOfWeek', startHour: 14, endHour: 15, days: [] }, files: [] },
  );
  state.bumpConfigGeneration();
  const spans = edits.blockSpansForDay(ch, SATURDAY).map((s) => [s.block.id, new Date(s.start).getHours(), new Date(s.end).getHours(), s.startEdge, s.endEdge, s.empty]);
  assert.deepEqual(spans, [
    ['late', 0, 2, false, true, false],
    ['news', 7, 9, true, true, false],
    ['am', 9, 12, false, true, false], // covered 8–9 by news, so its start isn't draggable here
    ['todo', 14, 15, true, true, true],
    ['late', 22, 0, true, false, false],
  ]);
});

test('resizing, copying to a weekday and reordering build the smallest commands', async () => {
  const { edits, ch } = await setup();
  const block = { id: 'am', priority: 0, trigger: { type: 'dayOfWeek', startHour: 8, endHour: 12, days: [6] } };
  const low = { id: 'low', priority: 0, trigger: { type: 'dayOfWeek', startHour: 0, endHour: 0, days: [] } };
  const high = { id: 'high', priority: 5, trigger: { type: 'dayOfWeek', startHour: 9, endHour: 10, days: [] } };
  ch.blocks.push(block, low, high);

  assert.deepEqual(edits.resizeCommand(ch, block, 'start', 7), { type: 'block.setHours', channel: 5, id: 'am', startHour: 7, endHour: 12 });
  assert.deepEqual(edits.resizeCommand(ch, block, 'end', 24), { type: 'block.setHours', channel: 5, id: 'am', startHour: 8, endHour: 0 });
  assert.equal(edits.resizeCommand(ch, block, 'end', 8), null, 'an empty block is refused');
  assert.equal(edits.resizeCommand(ch, block, 'start', 8), null, 'no change, no command');

  assert.deepEqual(edits.copyToWeekdayCommand(ch, block, 0), { type: 'block.setDays', channel: 5, id: 'am', days: [6, 0] });
  assert.equal(edits.copyToWeekdayCommand(ch, block, 6), null);
  assert.equal(edits.copyToWeekdayCommand(ch, low, 2), null, 'an every-day block already airs there');
  assert.deepEqual(edits.removeWeekdayCommand(ch, low, 2).days, [0, 1, 3, 4, 5, 6]);

  // Drag "low" to the top of [high, block, low].
  assert.deepEqual(edits.reorderCommands(ch, [low, high, block]), [
    { type: 'block.setPriority', channel: 5, id: 'low', priority: 6 },
  ], 'only the moved block changes');
  assert.deepEqual(edits.reorderCommands(ch, [high, block]), [], 'already in order');

  assert.equal(edits.priorityToWin(ch, 6, 7, 11), 6, 'beats every time block overlapping Saturday 7–11');
  assert.equal(edits.priorityToWin({ ...ch, blocks: [block] }, 1, 7, 11), 0, 'Monday has nothing to beat');
});

test('"Only this day" copies the airing exactly; "Replace with…" changes only that slot', async () => {
  const { state, edits, query } = await setup();
  const ch = state.S.config.channels[0];
  const monday = query.addDays(SATURDAY, 2);
  const program = query.querySchedule(ch, monday + 19 * HOUR + 1, monday + 19 * HOUR + 2, { breaks: false }).programs[0];

  const only = edits.exceptionBlockCommand(ch, program, monday);
  assert.equal(only.block.trigger.type, 'dateRange');
  assert.equal(only.block.trigger.startDay, 21);
  const onlyDiff = preview(query, state, [only]);
  assert.equal(onlyDiff.added.length + onlyDiff.removed.length, 0, 'the copy airs the same programs');

  const replace = edits.exceptionBlockCommand(ch, program, monday, { name: 'Cartoons', files: [{ path: 'toon.mp4', duration: 600 }] });
  const { startHour, endHour } = replace.block.trigger;
  const diff = preview(query, state, [replace]);
  assert.equal(diff.identical, false);
  assert.ok(diff.changed.every((r) => r.start >= monday + (startHour - 1) * HOUR && r.end <= monday + (endHour + 1) * HOUR), 'only around that slot on that Monday');
});

test('break edits target the layer that decides breaks, and say why when they cannot', async () => {
  const { state, edits, query } = await setup();
  const ch = state.S.config.channels[0];
  const t = SATURDAY + 15 * HOUR + 7 * 60000;
  const program = query.querySchedule(ch, t, t + 1, { breaks: false }).programs[0];

  const quiet = edits.noBreaksCommands(ch, program, t);
  assert.equal(quiet.label, 'No ad breaks in this show');
  const quietDiff = preview(query, state, quiet.commands);
  assert.ok(quietDiff.breaksRemoved.length > 0 && quietDiff.breaksAdded.length === 0);
  assert.equal(quietDiff.added.length + quietDiff.removed.length, 0, 'programs keep their times');

  const mid = program.start + (program.end - program.start) / 2;
  const add = edits.addBreakHereCommands(ch, program, mid, 'News');
  assert.equal(add.commands.length, 2, 'the show gets a tag and its own set-points preset');
  const addDiff = preview(query, state, add.commands);
  assert.ok(addDiff.breaksAdded.some((b) => Math.abs(b.start - mid) < 1000), 'a break appears where it was placed');

  state.S.config.interstitials.flows = [{ id: 'f', name: 'Cartoon flow', enabled: true, channels: [5], steps: [{ type: 'contentSegment' }] }];
  state.bumpConfigGeneration();
  assert.match(edits.noBreaksCommands(ch, program, t).disabled, /Cartoon flow/);
  assert.match(edits.addBreakHereCommands(ch, program, mid, 'News').disabled, /FLOWS/);

  state.S.config.interstitials.flows = [];
  state.S.config.interstitials.presets = [{ id: 'p', pluginId: 'weather', enabled: true, channels: [5], contentTags: [], timing: 'breakpoints', breakpoints: [50] }];
  state.bumpConfigGeneration();
  assert.match(edits.addBreakHereCommands(ch, program, mid, 'News').disabled, /weather plugin/);
});

test('guardrails: re-anchoring and long date ranges need a confirm', async () => {
  const { state, edits } = await setup();
  const ch = state.S.config.channels[0];
  ch.blocks.push(
    { id: 'xmas', trigger: { type: 'dateRange', startMonth: 12, startDay: 1, endMonth: 12, endDay: 25, startHour: 18, endHour: 22 }, files: [] },
    { id: 'wknd', trigger: { type: 'dateRange', startMonth: 7, startDay: 4, endMonth: 7, endDay: 5 }, files: [] },
  );
  assert.equal(edits.guardrailsFor(state.S.config, 5, [{ type: 'block.setHours', channel: 5, id: 'xmas', startHour: 17, endHour: 22 }]).beyondWeek, true);
  assert.equal(edits.guardrailsFor(state.S.config, 5, [{ type: 'block.setHours', channel: 5, id: 'wknd', startHour: 17, endHour: 22 }]).confirm, false);
  assert.equal(edits.guardrailsFor(state.S.config, 5, [{ type: 'item.set', collection: 'blocks', channel: 5, id: 'wknd', fields: { files: [], anchor: 1 } }]).reanchor, true);
});
