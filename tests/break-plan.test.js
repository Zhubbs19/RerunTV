// Shows pause for ad breaks (core/interstitials.js applyBreakPlan, the default):
// a program's own breaks are planned into its air time, so the schedule itself
// holds the program still through them instead of running it on underneath.
// Before this, a time-machine jump or a fresh tune-in after a break found the
// program minutes further on, as if it had played during the ads.
process.env.TZ = 'America/New_York'; // before any Date use
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

globalThis.window = globalThis.window || { matchMedia: () => ({ matches: false }), api: {} };
const load = (name) => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', name)).href);

const MIN = 60000;
const HOUR = 60 * MIN;
const D0 = new Date(2026, 11, 1, 0, 0, 0, 0).getTime();

function ad(id, duration, type = 'commercial') {
  return { id, type, channelAffinity: 'any', weight: 1, file: { path: `${id}.mp4`, duration } };
}

async function setup(commercials = {}, pool = null, extra = {}) {
  const state = await load('core/state.js');
  const schedule = await load('core/schedule.js');
  const ib = await load('core/interstitials.js');
  const fit = await load('core/fit.js');
  state.S.config = {
    commercials: { timing: 'interval', intervalMinutes: 15, podMin: 3, podMax: 3, ...commercials },
    interstitials: {
      pool: pool || [ad('in', 4, 'adBreakIn'), ad('a', 30), ad('b', 30), ad('c', 30), ad('d', 30), ad('e', 15), ad('out', 4, 'adBreakOut')],
      presets: [], flows: [],
    },
    stationId: { enabled: false },
    ...extra,
  };
  state.bumpConfigGeneration();
  return { state, schedule, ib, fit };
}

function movieChannel(extra = {}) {
  return {
    number: 67, name: 'MOVIES', anchor: D0 + 7 * HOUR, adsEnabled: true, blocks: [],
    files: [{ path: 'm1.mp4', duration: 7201.5 }, { path: 'm2.mp4', duration: 5603 }, { path: 'm3.mp4', duration: 6000 }],
    ...extra,
  };
}

const posAt = (m, ch, t) => m.schedule.computeSourcePosition(m.schedule.resolveActiveSource(ch, t), t, { ignoreContentLost: true });

test('the program holds still through a planned break and resumes where it stopped', async () => {
  const m = await setup();
  const ch = movieChannel();
  // The first break inside a movie (not one between movies).
  let start = m.ib.nextBreakStart(ch, D0 + 7 * HOUR + MIN);
  let brk = m.ib.resolveBreakAt(ch, start);
  while (posAt(m, ch, start).file.path !== posAt(m, ch, brk.breakEnd + 10000).file.path) {
    start = m.ib.nextBreakStart(ch, brk.breakEnd);
    brk = m.ib.resolveBreakAt(ch, start);
  }
  assert.ok(brk && brk.planned, 'a planned break');
  const paused = m.fit.seekOffsetOf(posAt(m, ch, start));
  for (let t = start; t < brk.breakEnd; t += 5000) {
    assert.ok(Math.abs(m.fit.seekOffsetOf(posAt(m, ch, t)) - paused) < 1e-6, 'the video position does not move during the break');
  }
  const after = m.fit.seekOffsetOf(posAt(m, ch, brk.breakEnd + 10000));
  assert.ok(Math.abs(after - (paused + 10)) < 0.01, `10 s after the break the program is 10 s on (${after} vs ${paused})`);
});

test('over hours of air the video never skips ahead: 1 s per second, 0 during a planned break', async () => {
  const m = await setup();
  const ch = movieChannel();
  let prev = posAt(m, ch, D0 + 7 * HOUR);
  for (let t = D0 + 7 * HOUR + 1000; t < D0 + 13 * HOUR; t += 1000) {
    const pos = posAt(m, ch, t);
    if (pos.file.path !== prev.file.path) { prev = pos; continue; }
    const step = m.fit.seekOffsetOf(pos) - m.fit.seekOffsetOf(prev);
    const inBreak = !!m.ib.resolveBreakAt(ch, t - 1);
    assert.ok(step >= -1e-6 && step <= 1.000001, `at +${(t - D0 - 7 * HOUR) / 1000}s the video moved ${step}s`);
    if (inBreak) assert.ok(step < 1e-6 || step <= 1.000001, 'held (or leaving the break)');
    prev = pos;
  }
});

test('the guide gives each program its air time, breaks included', async () => {
  const m = await setup();
  const ch = movieChannel();
  const rows = m.schedule.getChannelSchedule(ch, D0 + 7 * HOUR, D0 + 13 * HOUR);
  const first = rows[0];
  const plan = first.file.fit;
  assert.equal(plan.mode, 'breaks');
  assert.ok(Math.abs((first.end - first.start) / 1000 - (7201.5 + plan.breakS)) < 0.01, 'row length = video + its breaks');
  assert.ok(plan.breakS > 0);
});

test('a break is the same length every pass through the loop, but its spots vary', async () => {
  const m = await setup({ intervalMinutes: 10, podMin: 2, podMax: 2 }, [ad('a', 30), ad('b', 30), ad('c', 30), ad('d', 30), ad('e', 30)]);
  const ch = { number: 9, name: 'SHORT', anchor: D0, adsEnabled: true, blocks: [], files: [{ path: 's1.mp4', duration: 1320 }, { path: 's2.mp4', duration: 1320 }] };
  const loopMs = m.schedule.resolveActiveSource(ch, D0).files.reduce((s, f) => s + f.duration, 0) * 1000;
  const first = m.ib.nextBreakStart(ch, D0 + 60000);
  const lengths = new Set();
  const lineups = new Set();
  for (let pass = 0; pass < 12; pass++) {
    const brk = m.ib.resolveBreakAt(ch, first + pass * loopMs + 1);
    assert.ok(brk && brk.planned, `pass ${pass} has the break`);
    lengths.add(Math.round(brk.breakEnd - brk.breakStart));
    lineups.add(brk.segments.map((s) => s.entry.id).join(','));
    assert.equal(new Set(brk.segments.map((s) => s.entry.id)).size, brk.segments.length, 'no spot twice in one break');
  }
  assert.equal(lengths.size, 1, 'one length for every pass');
  assert.ok(lineups.size > 1, `the ads change between airings (${[...lineups].join(' | ')})`);
});

test('every lookup inside one break returns the same windows', async () => {
  const m = await setup();
  const ch = movieChannel({ anchor: D0 - 37 * 86400000 + 12345 }); // an old, odd anchor
  const start = m.ib.nextBreakStart(ch, D0 + 10 * HOUR);
  const a = m.ib.resolveBreakAt(ch, start);
  for (let t = start; t < a.breakEnd; t += 777) {
    const b = m.ib.resolveBreakAt(ch, t);
    assert.equal(b.breakStart, a.breakStart);
    assert.equal(b.breakEnd, a.breakEnd);
    const seg = a.segments.find((s) => t >= s.windowStart && t < s.windowEnd);
    assert.equal(b.windowStart, seg.windowStart, 'the segment window is exact, so playback keys it the same each tick');
  }
  assert.equal(m.ib.resolveBreakAt(ch, a.breakEnd), null, 'the program is back at the end');
  assert.equal(m.ib.nextBreakBoundary(ch, start + 1000) <= a.segments[1].windowStart, true, 'the timer finds the next spot');
});

test('a cadence slot within a minute of the end moves to the end of the program', async () => {
  const m = await setup({ intervalMinutes: 30 });
  const ch = { number: 4, name: 'EDGE', anchor: D0, adsEnabled: true, blocks: [], files: [{ path: 'x.mp4', duration: 1800 + 30 }, { path: 'y.mp4', duration: 1800 }] };
  const plan = m.schedule.resolveActiveSource(ch, D0).files[0].fit;
  const breaks = plan.segments.filter((s) => s.kind === 'break');
  // Slots at program time 0 and 30:00; 30:00 is 30 s from x's end, so it airs after x instead.
  assert.equal(breaks.length, 2);
  assert.equal(breaks[0].contentAt, 0);
  assert.equal(breaks[1].contentAt, 1830, 'moved onto the end');
});

test('END CREDITS speed-up is part of the plan, so the program ends on time', async () => {
  const m = await setup({ timing: 'post' });
  const ch = movieChannel({ creditsSpeedup: { enabled: true, leadSeconds: 90, rate: 3 } });
  const plan = m.schedule.resolveActiveSource(ch, D0 + 8 * HOUR).files[0].fit;
  const credits = plan.segments.find((s) => s.kind === 'credits');
  assert.ok(credits, 'a credits segment');
  assert.equal(credits.rate, 3);
  assert.ok(Math.abs((credits.airEnd - credits.airStart) - 30) < 1e-6, '90 s of credits air in 30 s');
  assert.ok(Math.abs(plan.slotS - (7201.5 - 60 + plan.breakS)) < 1e-6);
});

test('switched off, or with ads that change by the clock, the source is left as it was', async () => {
  const m = await setup({ pauseForBreaks: false });
  const ch = movieChannel();
  const off = m.schedule.resolveActiveSource(ch, D0 + 9 * HOUR);
  assert.ok(!off.breakPlan && off.files === ch.files, 'off: the original file list');

  const m2 = await setup();
  const timed = movieChannel({
    blocks: [{ id: 'quiet', priority: 1, files: [], commercials: { enabled: false }, trigger: { type: 'dayOfWeek', startHour: 1, endHour: 5, days: [] } }],
  });
  const src = m2.schedule.resolveActiveSource(timed, D0 + 9 * HOUR);
  assert.ok(!src.breakPlan && src.files === timed.files, 'an ad-only block makes breaks depend on the clock: overlay model');
});

test('clock-tied breaks still run over the program but are not credited back', async () => {
  const m = await setup({}, null, { stationId: { enabled: true, intervalMinutes: 15 } });
  const ch = movieChannel();
  const t = D0 + 9 * HOUR + 15 * MIN + 1000; // a :15 station ID bar
  const brk = m.ib.resolveBreakAt(ch, t);
  if (brk && !brk.planned) {
    assert.equal(brk.type, 'channelId');
    assert.equal(brk.fit, true, 'fit: true means breaks.js credits nothing back');
  }
});

test('re-anchoring a changed playlist keeps the same moment of the same file on the air', async () => {
  const m = await setup();
  const reanchor = await load('library/reanchor.js');
  const ch = movieChannel({ anchor: D0 - 3 * 86400000 + 4321 });
  const atMs = D0 + 10 * HOUR + 17 * MIN;
  const before = posAt(m, ch, atMs);
  const res = reanchor.applyPlaylistPreservingAir(ch, [...ch.files, { path: 'm4.mp4', duration: 3000 }], atMs);
  assert.ok(res.preserved);
  m.state.bumpConfigGeneration();
  const after = posAt(m, ch, atMs);
  assert.equal(after.file.path, before.file.path);
  assert.ok(Math.abs(after.offset - before.offset) < 0.01, `same air moment (${after.offset} vs ${before.offset})`);
});

test('timeline edits store plain file entries and place an added break by video position', async () => {
  const m = await setup();
  const edits = await load('timeline/edits.js');
  const query = await load('core/schedule-query.js');
  const ch = movieChannel();
  m.state.S.config.channels = [ch];
  m.state.bumpConfigGeneration();
  const program = query.querySchedule(ch, D0 + 8 * HOUR, D0 + 8 * HOUR + 1, { breaks: false }).programs[0];
  const only = edits.exceptionBlockCommand(ch, program, D0);
  only.block.files.forEach((f, i) => {
    assert.ok(!('fit' in f), 'no plan stored in channels.json');
    assert.equal(f.duration, ch.files[i].duration, 'the video length, not the air length');
  });
  // A click 40% into the airing's VIDEO, located through its plan.
  const plan = program.file.fit;
  const targetS = 0.4 * plan.contentS;
  const seg = plan.segments.find((s) => s.kind === 'content' && targetS >= s.contentStart && targetS < s.contentStart + (s.airEnd - s.airStart));
  const clickMs = program.start + (seg.airStart + (targetS - seg.contentStart)) * 1000;
  const add = edits.addBreakHereCommands(ch, program, clickMs, 'Movie');
  const preset = add.commands.find((c) => c.type === 'item.insert');
  assert.deepEqual(preset.item.breakpoints, [40]);
});
