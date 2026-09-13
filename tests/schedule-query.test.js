// schedule-query.js (docs/design/02-programming-timeline.md §3) against a
// synthetic channel. The renderer modules are ES modules that only touch
// `window` for one media query at load, so a two-line stub is enough to
// exercise the real resolvers under node:test.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

globalThis.window = globalThis.window || { matchMedia: () => ({ matches: false }), api: {} };

const load = (name) => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', name)).href);

const HOUR = 3600000;

async function setup() {
  const state = await load('state.js');
  const schedule = await load('schedule.js');
  const interstitials = await load('interstitials.js');
  const query = await load('schedule-query.js');
  state.S.config = {
    commercials: { timing: 'interval', intervalMinutes: 10 },
    interstitials: {
      pool: [{ id: 'ad-1', type: 'commercial', channelAffinity: 'any', file: { path: 'ad-1.mp4', duration: 30 } }],
      presets: [],
      flows: [],
    },
  };
  return { state, schedule, interstitials, query };
}

function makeChannel(anchor) {
  return {
    number: 5,
    name: 'TEST',
    anchor,
    adsEnabled: true,
    blocks: [],
    folders: [],
    files: [
      { path: 'a.mp4', duration: 1500 },
      { path: 'b.mp4', duration: 1320 },
      { path: 'c.mp4', duration: 2700 },
    ],
  };
}

function localMidnight(y, m, d) {
  return new Date(y, m, d, 0, 0, 0, 0).getTime();
}

test('querySchedule stitches a program that crosses midnight back into one airing', async () => {
  const { schedule, query } = await setup();
  const d0 = localMidnight(2026, 8, 14);
  const ch = makeChannel(d0 - 7 * HOUR);
  const from = d0 + 22 * HOUR;
  const to = query.addDays(d0, 1) + 3 * HOUR;
  const result = query.querySchedule(ch, from, to, { breaks: false });
  const reference = schedule.getChannelSchedule(ch, from, to);

  assert.deepEqual(result.programs.map((e) => `${e.start}|${e.file.path}`), reference.map((e) => `${e.start}|${e.file.path}`));
  const midnight = query.addDays(d0, 1);
  const crossing = result.programs.find((e) => e.start < midnight && e.end > midnight);
  assert.ok(crossing, 'fixture should put a program across midnight');
  assert.equal(crossing.end, crossing.start + crossing.file.duration * 1000);
  result.programs.slice(0, -1).forEach((e, i) => assert.equal(e.end, result.programs[i + 1].start));
});

// Round-number durations hide it: with a real library's fractional durations
// and a long playlist, each day's float arithmetic puts the same airing's
// start a fraction of a millisecond apart, and exact-match stitching kept both
// halves (found on 7 of 14 channels of a real lineup). Seeded, so it's stable.
test('querySchedule stitching survives float noise from a realistic playlist', async () => {
  const { schedule, query } = await setup();
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const d0 = localMidnight(2026, 8, 12);
  for (let trial = 0; trial < 40; trial++) {
    const ch = {
      number: 100 + trial,
      anchor: d0 - rnd() * 400 * 86400000,
      blocks: [],
      files: Array.from({ length: 137 }, (_, i) => ({ path: `f${i}.mp4`, duration: 1200 + rnd() * 600 })),
    };
    const from = d0 + (20 + rnd() * 3) * HOUR;
    const to = from + 30 * HOUR;
    const got = query.querySchedule(ch, from, to, { breaks: false }).programs;
    const reference = schedule.getChannelSchedule(ch, from, to);
    assert.equal(got.length, reference.length, `trial ${trial}`);
    got.forEach((e, i) => {
      assert.equal(e.file.path, reference[i].file.path, `trial ${trial} entry ${i}`);
      assert.ok(Math.abs(e.start - reference[i].start) < 1, `trial ${trial} entry ${i} start`);
    });
  }
});

test('querySchedule breaks match breakEntriesInWindow for the same window', async () => {
  const { interstitials, query } = await setup();
  const d0 = localMidnight(2026, 8, 15);
  const ch = makeChannel(d0 - 3 * HOUR);
  const from = d0 + 9 * HOUR;
  const to = d0 + 13 * HOUR;
  const result = query.querySchedule(ch, from, to);
  const reference = interstitials.breakEntriesInWindow(ch, from, to);
  assert.ok(reference.length > 0, 'fixture should produce breaks');
  // querySchedule keeps each pod's real bounds; the reference clamps pods cut
  // by the window edges, so compare after clamping.
  const clamp = (e) => `${Math.max(e.start, from)}|${Math.min(e.end, to)}|${e.breakType}`;
  assert.deepEqual(result.breaks.map(clamp), reference.map(clamp));
});

test('queryDay is cached until the config generation changes', async () => {
  const { state, query } = await setup();
  const d0 = localMidnight(2026, 8, 16);
  const ch = makeChannel(d0);
  const first = query.queryDay(ch, d0);
  assert.equal(query.queryDay(ch, d0), first);

  ch.files[0].duration = 900;
  assert.equal(query.queryDay(ch, d0), first, 'an unannounced mutation is not seen (the documented contract)');
  state.bumpConfigGeneration();
  const second = query.queryDay(ch, d0);
  assert.notEqual(second, first);
  assert.notEqual(second.programs[1].start, first.programs[1].start);
});

test('a proposed copy of a channel never shares cached days with the live channel', async () => {
  const { query } = await setup();
  const d0 = localMidnight(2026, 8, 17);
  const live = makeChannel(d0);
  const liveBefore = query.querySchedule(live, d0, d0 + 6 * HOUR, { breaks: false }).programs.map((e) => e.start);

  const proposed = structuredClone(live);
  proposed.files.reverse();
  const proposedStarts = query.querySchedule(proposed, d0, d0 + 6 * HOUR, { breaks: false }).programs.map((e) => e.file.path);
  assert.equal(proposedStarts[0], 'c.mp4');

  const liveAfter = query.querySchedule(live, d0, d0 + 6 * HOUR, { breaks: false }).programs.map((e) => e.start);
  assert.deepEqual(liveAfter, liveBefore);
});

test('diffSchedules reports nothing for an identical copy and the changed span for an edit', async () => {
  const { query } = await setup();
  const d0 = localMidnight(2026, 8, 18);
  const from = d0 + 8 * HOUR;
  const to = d0 + 20 * HOUR;
  const live = makeChannel(d0);

  const same = query.diffSchedules(live, structuredClone(live), from, to);
  assert.equal(same.identical, true);
  assert.deepEqual(same.changed, []);

  const edited = structuredClone(live);
  edited.files[1].duration = 600;
  const diff = query.diffSchedules(live, edited, from, to);
  assert.equal(diff.identical, false);
  assert.ok(diff.added.length > 0 && diff.removed.length > 0);
  diff.changed.forEach((r) => {
    assert.ok(r.start >= from && r.end <= to && r.start < r.end);
  });
});

test('offAirRanges follows broadcast hours, including a range that wraps midnight', async () => {
  const { query } = await setup();
  const d0 = localMidnight(2026, 8, 19);
  const ch = makeChannel(d0);
  ch.broadcastHours = { enabled: true, startHour: 6, endHour: 2 };
  const at = (h) => new Date(new Date(d0).setHours(h, 0, 0, 0)).getTime();
  assert.deepEqual(query.offAirRanges(ch, d0, query.addDays(d0, 1)), [{ start: at(2), end: at(6) }]);
  assert.deepEqual(query.offAirRanges(makeChannel(d0), d0, query.addDays(d0, 1)), []);

  const day = query.queryDay(ch, d0, { breaks: false });
  assert.deepEqual(day.offAir, [{ start: at(2), end: at(6) }]);
});

test('explainAt agrees with the program querySchedule says is airing', async () => {
  const { schedule, query } = await setup();
  const d0 = localMidnight(2026, 8, 20);
  const ch = makeChannel(d0 - 90 * 60000);
  const t = d0 + 14 * HOUR + 123456;
  const info = query.explainAt(ch, t);
  const airing = query.querySchedule(ch, t, t + 1, { breaks: false }).programs[0];
  assert.equal(info.source.key, schedule.resolveActiveSource(ch, t).key);
  assert.equal(info.position.file.path, airing.file.path);
  assert.equal(info.onAir, true);
  assert.ok(info.commercials && info.commercials.commercials);
});

// ---------- editing support (docs/design/02 §4) ----------

function blockChannel(anchor) {
  const ch = makeChannel(anchor);
  ch.blocks = [{
    id: 'sat', name: 'Saturday Cartoons', priority: 0, mode: 'loop', anchor,
    trigger: { type: 'dayOfWeek', startHour: 8, endHour: 12, days: [6] },
    files: [{ path: 'toon1.mp4', duration: 660 }, { path: 'toon2.mp4', duration: 720 }],
    commercials: { enabled: true, timing: 'post', podMin: 1, podMax: 1 },
  }];
  return ch;
}

test('proposeEdit leaves live config alone, and undoing the edit diffs empty', async () => {
  const { state, query } = await setup();
  const commands = await load('commands.js');
  const saturday = localMidnight(2026, 8, 19); // a Saturday
  const live = blockChannel(saturday - 30 * 86400000);
  state.S.config.channels = [live];
  const snapshot = commands.cloneJson(state.S.config);

  const edit = { type: 'block.setHours', channel: 5, id: 'sat', startHour: 7, endHour: 11 };
  const { config, channel } = query.proposeEdit(state.S.config, 5, edit);
  assert.deepEqual(state.S.config, snapshot, 'live config untouched');
  assert.notEqual(channel, live);
  assert.equal(config.interstitials, state.S.config.interstitials, 'a channel edit shares box-wide programming');

  const diff = query.diffSchedules(live, channel, saturday, query.addDays(saturday, 1), { afterConfig: config });
  assert.equal(diff.identical, false);
  // Around the moved edges only: a program already airing at 7 is cut short, and one running past 11 ends early.
  assert.ok(diff.changed.every((r) => r.start >= saturday + 6 * HOUR && r.end <= saturday + 13 * HOUR), 'only the morning can change');

  const undone = query.proposeEdit(config, 5, { type: 'block.setHours', channel: 5, id: 'sat', startHour: 8, endHour: 12 });
  assert.equal(query.diffSchedules(live, undone.channel, saturday, query.addDays(saturday, 7), { afterConfig: undone.config }).identical, true);
});

test('a proposed preset edit is resolved against the proposal, without poisoning the live ad policy', async () => {
  const { state, query, schedule } = await setup();
  const d0 = localMidnight(2026, 8, 21);
  const live = makeChannel(d0 - 3 * HOUR);
  state.S.config.channels = [live];
  const t = d0 + 10 * HOUR;
  const liveKey = schedule.resolveActiveCommercials(live, t).key;

  const preset = { id: 'quiet', name: 'No breaks', enabled: true, channels: [5], contentTags: [], timing: 'breakpoints', breakpoints: [] };
  const { config, channel } = query.proposeEdit(state.S.config, 5, { type: 'item.insert', collection: 'presets', item: preset });
  assert.notEqual(config.interstitials, state.S.config.interstitials, 'box-wide lists are copied when edited');
  assert.equal(state.S.config.interstitials.presets.length, 0);

  const diff = query.diffSchedules(live, channel, d0 + 9 * HOUR, d0 + 13 * HOUR, { afterConfig: config });
  assert.ok(diff.breaksRemoved.length > 0, 'the preview sees the interval pods go');
  assert.equal(diff.breaksAdded.length, 0);
  assert.equal(schedule.resolveActiveCommercials(live, t).key, liveKey, 'the live channel\'s cached policy is unchanged');
  assert.equal(schedule.resolveActiveCommercials(channel, t).key, liveKey, 'outside the preview the copy reads live config again');
});

test('explainLayers names every layer that matched, and its winners agree with the resolvers', async () => {
  const { state, query, schedule } = await setup();
  const saturday = localMidnight(2026, 8, 19);
  const ch = blockChannel(saturday - 9 * 86400000);
  ch.broadcastHours = { enabled: true, startHour: 6, endHour: 2 };
  ch.blocks.push(
    { id: 'empty', name: 'No folder yet', priority: 5, trigger: { type: 'dayOfWeek', startHour: 9, endHour: 10, days: [] }, files: [] },
    { id: 'low', name: 'Weekend filler', priority: -1, anchor: ch.anchor, trigger: { type: 'dayOfWeek', startHour: 0, endHour: 0, days: [0, 6] }, files: [{ path: 'fill.mp4', duration: 900 }] },
  );
  state.S.config.channels = [ch];
  state.S.config.interstitials.presets = [{ id: 'film', enabled: true, channels: [5], contentTags: [], timing: 'interval', intervalMinutes: 20 }];
  state.bumpConfigGeneration();

  const at9 = query.explainLayers(ch, saturday + 9 * HOUR + 15 * 60000);
  const kinds = at9.layers.map((l) => `${l.group}:${l.kind}:${l.item ? l.item.id : '-'}:${l.role}`);
  assert.deepEqual(kinds, [
    'content:broadcastHours:-:passes',
    'content:block:sat:wins',
    'content:block:low:outranked',
    'content:block:empty:skipped',
    'content:default:-:outranked',
    'breaks:preset:film:wins',
    'breaks:blockAds:sat:outranked',
    'breaks:globalAds:-:outranked',
  ]);

  const at3 = query.explainLayers(ch, saturday + 3 * HOUR);
  assert.equal(at3.layers[0].role, 'wins', 'signed off at 3 AM');
  assert.ok(at3.layers.filter((l) => l.group === 'content').slice(1).every((l) => l.role !== 'wins'));

  // Agreement over a whole weekend, every 7 minutes.
  for (let t = saturday; t < saturday + 48 * HOUR; t += 7 * 60000) {
    const { layers, onAir } = query.explainLayers(ch, t);
    const source = schedule.resolveActiveSource(ch, t);
    const contentWinners = layers.filter((l) => l.group === 'content' && l.role === 'wins');
    assert.equal(contentWinners.length, 1, `one content winner at ${new Date(t).toISOString()}`);
    if (!onAir) assert.equal(contentWinners[0].kind, 'broadcastHours');
    else if (source.block) assert.equal(contentWinners[0].item, source.block);
    else assert.equal(contentWinners[0].kind, 'default');
    assert.equal(layers.filter((l) => l.group === 'breaks' && l.role === 'wins').length, 1, 'one ad-policy winner');
  }
});
