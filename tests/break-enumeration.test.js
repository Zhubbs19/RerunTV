// breakEntriesInWindow (interstitials.js) against synthetic channels —
// docs/design/02-programming-timeline.md §7: the ON AIR week and the editable
// timeline draw their break markers from it, and a phantom-break bug was
// already found there once. Each case is checked against a brute-force scan of
// resolveBreakAt, the resolver live playback itself polls:
//   - nothing missed: every second a jumpable break is on screen lies inside a
//     listed entry;
//   - nothing invented: every listed entry has a jumpable break inside it;
//   - entries are ordered, non-overlapping and clamped to the window.
// "Jumpable" is the enumerator's own notion: a text-only station-ID bar is an
// overlay on the program, not a break.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

globalThis.window = globalThis.window || { matchMedia: () => ({ matches: false }), api: {} };

const load = (name) => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', name)).href);

const MIN = 60000;
const HOUR = 60 * MIN;
const SAMPLE_MS = 1000;

async function modules() {
  const state = await load('state.js');
  const interstitials = await load('interstitials.js');
  return { state, interstitials };
}

function localMidnight(y, m, d) {
  return new Date(y, m, d, 0, 0, 0, 0).getTime();
}

function isJumpable(brk) {
  return !(brk.type === 'channelId' && !(brk.entry && brk.entry.file));
}

function entry(id, type, duration, extra = {}) {
  return { id, type, channelAffinity: 'any', file: { path: `${id}.mp4`, duration }, ...extra };
}

function setConfig(state, config) {
  state.S.config = {
    commercials: { timing: 'interval', intervalMinutes: 10 },
    interstitials: { pool: [], presets: [], flows: [] },
    ...config,
  };
  state.bumpConfigGeneration();
}

function checkAgainstScan(interstitials, ch, from, to, label) {
  const entries = interstitials.breakEntriesInWindow(ch, from, to);
  entries.forEach((e, i) => {
    assert.ok(e.start >= from && e.end <= to && e.start < e.end, `${label}: entry ${i} is inside the window`);
    if (i > 0) assert.ok(e.start >= entries[i - 1].end, `${label}: entry ${i} starts after entry ${i - 1} ends`);
  });
  const inside = (t) => entries.some((e) => t >= e.start && t < e.end);
  const hits = entries.map(() => false);
  for (let t = from; t < to; t += SAMPLE_MS) {
    const brk = interstitials.resolveBreakAt(ch, t);
    if (!brk || !isJumpable(brk)) continue;
    assert.ok(inside(t), `${label}: a ${brk.type} on screen at ${new Date(t).toISOString()} isn't listed`);
    entries.forEach((e, i) => { if (t >= e.start && t < e.end) hits[i] = true; });
  }
  entries.forEach((e, i) => {
    if (hits[i]) return;
    // Shorter than the scan step: probe its own start before calling it phantom.
    const brk = interstitials.resolveBreakAt(ch, e.start);
    assert.ok(brk && isJumpable(brk), `${label}: entry ${i} (${e.breakType} at ${new Date(e.start).toISOString()}) has no break in it`);
  });
  return entries;
}

function channel(anchor, extra = {}) {
  return {
    number: 7,
    name: 'TEST',
    anchor,
    adsEnabled: true,
    blocks: [],
    files: [
      { path: 'a.mp4', duration: 1500 },
      { path: 'b.mp4', duration: 1320 },
      { path: 'c.mp4', duration: 2700 },
    ],
    ...extra,
  };
}

test('interval pods with bump-in and bump-out are listed once each, whole', async () => {
  const { state, interstitials } = await modules();
  setConfig(state, {
    interstitials: {
      pool: [entry('in', 'adBreakIn', 4), entry('ad1', 'commercial', 30), entry('ad2', 'commercial', 15), entry('out', 'adBreakOut', 3)],
      presets: [],
      flows: [],
    },
  });
  const d0 = localMidnight(2026, 8, 14);
  const ch = channel(d0 - 17 * MIN);
  const from = d0 + 9 * HOUR;
  const entries = checkAgainstScan(interstitials, ch, from, from + 2 * HOUR, 'interval pods');
  assert.equal(entries.length, 12, 'one pod every 10 minutes');
  entries.forEach((e) => assert.equal(e.breakType, 'adBreakIn', 'an entry starts at its pod\'s bump-in'));
});

test('no phantom break from a text-only station ID at the window start', async () => {
  const { state, interstitials } = await modules();
  setConfig(state, { stationId: { enabled: true, intervalMinutes: 15 } });
  const d0 = localMidnight(2026, 8, 15);
  const ch = channel(d0 - 3 * HOUR);
  // The pool is empty, so the only thing on screen is the ID bar, and a window
  // starting on the hour lands exactly on one.
  const brk = interstitials.resolveBreakAt(ch, d0 + 9 * HOUR);
  assert.equal(brk && brk.type, 'channelId', 'fixture: an ID bar is up at the window start');
  assert.deepEqual(interstitials.breakEntriesInWindow(ch, d0 + 9 * HOUR, d0 + 12 * HOUR), []);
  assert.deepEqual(interstitials.breakEntriesInWindow(ch, d0, d0 + 24 * HOUR), []);
});

test('a station ID with a real video counts as a break', async () => {
  const { state, interstitials } = await modules();
  setConfig(state, {
    stationId: { enabled: true, intervalMinutes: 30 },
    interstitials: { pool: [entry('id', 'channelId', 6)], presets: [], flows: [] },
  });
  const d0 = localMidnight(2026, 8, 16);
  const ch = channel(d0 - 3 * HOUR, { adsEnabled: false });
  const entries = checkAgainstScan(interstitials, ch, d0 + 6 * HOUR, d0 + 8 * HOUR, 'video station ID');
  assert.equal(entries.length, 4);
  entries.forEach((e) => assert.equal(e.breakType, 'channelId'));
});

test('a window that starts inside a pod lists that pod clamped to the window', async () => {
  const { state, interstitials } = await modules();
  setConfig(state, {
    interstitials: { pool: [entry('ad1', 'commercial', 60), entry('ad2', 'commercial', 60)], presets: [], flows: [] },
    commercials: { timing: 'interval', intervalMinutes: 10, podMin: 2, podMax: 2 },
  });
  const d0 = localMidnight(2026, 8, 17);
  const anchor = d0 + 9 * HOUR - 20 * MIN;
  const ch = channel(anchor);
  const from = d0 + 9 * HOUR + 30000; // 30 s into the pod that starts at 9:00
  const entries = checkAgainstScan(interstitials, ch, from, from + HOUR, 'mid-pod start');
  assert.equal(entries[0].start, from);
  assert.equal(entries[0].end, d0 + 9 * HOUR + 120000);
});

test('no ads on the channel means no breaks, even with an ad pool', async () => {
  const { state, interstitials } = await modules();
  setConfig(state, { interstitials: { pool: [entry('ad1', 'commercial', 30)], presets: [], flows: [] } });
  const d0 = localMidnight(2026, 8, 18);
  const ch = channel(d0, { adsEnabled: false });
  assert.deepEqual(interstitials.breakEntriesInWindow(ch, d0, d0 + 24 * HOUR), []);
});

test('sign-off and sign-on bumpers bracket broadcast hours', async () => {
  const { state, interstitials } = await modules();
  setConfig(state, {});
  const d0 = localMidnight(2026, 8, 19);
  const ch = channel(d0 - 5 * HOUR, { adsEnabled: false, broadcastHours: { enabled: true, startHour: 6, endHour: 2 } });
  const entries = checkAgainstScan(interstitials, ch, d0 + HOUR, d0 + 7 * HOUR, 'broadcast hours');
  assert.deepEqual(entries.map((e) => e.breakType), ['signOff', 'signOn']);
  assert.equal(entries[0].end, d0 + 2 * HOUR);
  assert.equal(entries[1].start, d0 + 6 * HOUR);
});

test('a block\'s own ad policy and a tag-scoped preset are both enumerated', async () => {
  const { state, interstitials } = await modules();
  const d0 = localMidnight(2026, 8, 20);
  setConfig(state, {
    interstitials: {
      pool: [entry('ad1', 'commercial', 20), entry('ad2', 'commercial', 25)],
      presets: [{ id: 'movie', enabled: true, contentTags: ['movie'], timing: 'breakpoints', breakpoints: [25, 50, 75], podMin: 1, podMax: 1 }],
      flows: [],
    },
  });
  const ch = channel(d0 - 40 * MIN, {
    files: [{ path: 'a.mp4', duration: 1500 }, { path: 'film.mp4', duration: 5400, tags: ['movie'] }, { path: 'c.mp4', duration: 1320 }],
    blocks: [{
      id: 'blk', name: 'Mornings', priority: 0, mode: 'loop', anchor: d0 + 6 * HOUR,
      trigger: { type: 'dayOfWeek', startHour: 6, endHour: 9, days: [] },
      files: [{ path: 'm1.mp4', duration: 1380 }, { path: 'm2.mp4', duration: 1440 }],
      commercials: { enabled: true, timing: 'post', podMin: 1, podMax: 2 },
    }],
  });
  checkAgainstScan(interstitials, ch, d0 + 5 * HOUR, d0 + 13 * HOUR, 'block and preset');
});

test('flow breaks at boundaries and mid-show cadence are enumerated', async () => {
  const { state, interstitials } = await modules();
  const d0 = localMidnight(2026, 8, 21);
  setConfig(state, {
    interstitials: {
      pool: [entry('in', 'adBreakIn', 3), entry('ad1', 'commercial', 30), entry('ad2', 'commercial', 30), entry('out', 'adBreakOut', 3), entry('nx', 'upNext', 5)],
      presets: [],
      flows: [{
        id: 'f1', enabled: true, channels: [7],
        steps: [{ type: 'contentSegment' }, { type: 'adPod', podMin: 1, podMax: 2 }, { type: 'contentSegment' }, { type: 'upNext' }],
        cadence: { enabled: true, timing: 'everyNMinutes', intervalMinutes: 8, podMin: 1, podMax: 1 },
      }],
    },
  });
  checkAgainstScan(interstitials, channel(d0 - 11 * MIN), d0 + 10 * HOUR, d0 + 13 * HOUR, 'flow');
});

// A station ID bar that happens to be on screen when a pod begins used to take
// the pod with it: skipping the bar skipped its whole contiguous run.
test('a pod that begins under a text-only station ID bar is still listed', async () => {
  const { state, interstitials } = await modules();
  setConfig(state, {
    stationId: { enabled: true, intervalMinutes: 15 },
    interstitials: { pool: [entry('ad1', 'commercial', 30)], presets: [], flows: [] },
  });
  const d0 = localMidnight(2026, 8, 22);
  // Interval pods every 10 minutes from the anchor; put one 2 s after 10:00.
  const ch = channel(d0 + 10 * HOUR + 2000 - 60 * MIN);
  const entries = checkAgainstScan(interstitials, ch, d0 + 9 * HOUR + 55 * MIN, d0 + 10 * HOUR + 5 * MIN, 'pod under ID bar');
  assert.ok(entries.some((e) => e.breakType === 'commercial' && Math.abs(e.start - (d0 + 10 * HOUR + 2000)) <= 2000));
});

test('seeded random channels agree with a brute-force scan', async () => {
  const { state, interstitials } = await modules();
  let seed = 11;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const d0 = localMidnight(2026, 8, 23);
  for (let trial = 0; trial < 14; trial++) {
    const pool = [];
    if (rnd() < 0.6) pool.push(entry(`in${trial}`, 'adBreakIn', 2 + rnd() * 4));
    for (let i = 0; i < 1 + Math.floor(rnd() * 3); i++) pool.push(entry(`ad${trial}-${i}`, 'commercial', 10 + rnd() * 50));
    if (rnd() < 0.5) pool.push(entry(`out${trial}`, 'adBreakOut', 2 + rnd() * 4));
    if (rnd() < 0.3) pool.push(entry(`nx${trial}`, 'upNext', 4 + rnd() * 4));
    const timing = pick(['interval', 'everyNMinutes', 'breakpoints', 'pre', 'post', 'both']);
    setConfig(state, {
      commercials: { timing, intervalMinutes: pick([7, 10, 12]), breakpoints: [30, 60], podMin: 1, podMax: 1 + Math.floor(rnd() * 3) },
      stationId: rnd() < 0.5 ? { enabled: true, intervalMinutes: pick([15, 30]) } : { enabled: false },
      interstitials: { pool, presets: [], flows: [] },
    });
    const ch = channel(d0 - rnd() * 30 * 86400000, {
      files: Array.from({ length: 5 + Math.floor(rnd() * 6) }, (_, i) => ({ path: `f${trial}-${i}.mp4`, duration: 300 + rnd() * 1500 })),
      broadcastHours: rnd() < 0.3 ? { enabled: true, startHour: 6, endHour: 1 } : undefined,
    });
    const from = d0 + Math.floor(rnd() * 20) * HOUR + Math.floor(rnd() * 3600) * 1000;
    checkAgainstScan(interstitials, ch, from, from + 90 * MIN, `trial ${trial} (${timing})`);
  }
});
