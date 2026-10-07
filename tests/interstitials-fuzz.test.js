// Property tests for the break resolver (core/interstitials.js) over randomly generated channels, ad pools and
// cadences. resolveBreakAt is what live playback, the time machine, the guide and the timeline all read, and
// nextBreakBoundary is what arms the timer that starts and ends every break, so the two have to agree:
//   - resolveBreakAt is deterministic and its windows contain the time asked about;
//   - nextBreakBoundary always moves forward, and there is a boundary at every instant resolveBreakAt changes
//     (a change with no boundary means a break that starts late or never ends);
//   - between two boundaries the answer does not change;
//   - a pod never holds more commercials than podMax, and with "no repeats" never repeats an ad;
//   - an entry on air is one the pool says may air on this channel and block.
// The seeds are fixed so a failure names a reproducible configuration.
process.env.TZ = 'America/New_York'; // before any Date use
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

globalThis.window = globalThis.window || { matchMedia: () => ({ matches: false }), api: {} };
const load = (name) => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', name)).href);

const MIN = 60000;
const HOUR = 60 * MIN;

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const pick = (r, list) => list[Math.floor(r() * list.length)];

function makeCase(seed) {
  const r = rng(seed);
  const timing = pick(r, ['interval', 'interval', 'everyNMinutes', 'breakpoints', 'post', 'pre', 'both']);
  const podMax = 1 + Math.floor(r() * 5);
  const podMin = 1 + Math.floor(r() * podMax);
  const noRepeat = r() < 0.7;
  const entries = [];
  const dur = () => pick(r, [null, 0, 1, 4, 8, 15, 30, 30, 45, 60, 120]);
  const nCommercial = pick(r, [0, 1, 2, 3, 6, 12]);
  for (let i = 0; i < nCommercial; i += 1) {
    entries.push({ id: `ad${i}`, type: 'commercial', channelAffinity: pick(r, ['any', 'any', 7, 8]), blockAffinity: pick(r, [null, null, null, 'blk']), weight: 1, file: { path: `ad${i}.mp4`, duration: dur() } });
  }
  for (const type of ['adBreakIn', 'adBreakOut', 'upNext']) {
    const n = pick(r, [0, 0, 1, 2]);
    for (let i = 0; i < n; i += 1) entries.push({ id: `${type}${i}`, type, channelAffinity: pick(r, ['any', 7]), blockAffinity: null, weight: 1, file: { path: `${type}${i}.mp4`, duration: dur() } });
  }
  if (r() < 0.4) entries.push({ id: 'dyn', type: 'adBreakIn', channelAffinity: 7, blockAffinity: null, weight: 1, dynamic: true, durationS: pick(r, [3, 4, 6, 15]), bgFile: { path: 'bg.mp4' }, text: 'DAY {dayNumber:12/1}' });
  if (r() < 0.4) entries.push({ id: 'sid', type: 'channelId', channelAffinity: 'any', blockAffinity: null, weight: 1, text: 'TEXT ID' });
  const files = [];
  const nFiles = 1 + Math.floor(r() * 5);
  for (let i = 0; i < nFiles; i += 1) files.push({ path: `f${i}.mp4`, duration: pick(r, [700, 900, 1320, 1500, 2700, 5400, 7200]) }); // content must be longer than its own break; see the short-content test below
  const d0 = new Date(2026, 11, 7, 0, 0, 0).getTime();
  const ch = {
    number: 7, name: 'FUZZ', anchor: d0 - Math.floor(r() * 40) * HOUR - Math.floor(r() * HOUR), adsEnabled: true, files,
    blocks: r() < 0.5 ? [{
      id: 'blk', priority: 5, mode: 'loop', anchor: d0 + 2 * HOUR, trigger: { type: 'dayOfWeek', startHour: 2, endHour: 5, days: [] },
      files: [{ path: 'b0.mp4', duration: 900 }, { path: 'b1.mp4', duration: 1500 }],
    }] : [],
  };
  const commercials = {
    enabled: true, timing, intervalMinutes: pick(r, [1, 2, 5, 10, 12, 15, 30]), podMin, podMax, breakpoints: [25, 50, 75],
    noRepeatCommercials: noRepeat, noRepeatBumpers: r() < 0.5, noRepeatInterstitials: true,
  };
  return { seed, ch, commercials, pool: entries, timing, podMax, noRepeat, d0, stationId: r() < 0.5 };
}

async function withConfig(c, fn) {
  const state = await load('core/state.js');
  const interstitials = await load('core/interstitials.js');
  state.S.config = {
    commercials: { ...c.commercials },
    interstitials: { pool: c.pool, presets: [], flows: [] },
    stationId: c.stationId ? { enabled: true, intervalMinutes: 15 } : { enabled: false },
  };
  state.bumpConfigGeneration();
  return fn(interstitials, state);
}

const identity = (b) => (b ? `${b.type}|${b.entry ? (b.entry.id || 'x') : 'none'}|${b.windowStart}|${b.windowEnd}` : 'none');

const SEEDS = Array.from({ length: 60 }, (_, i) => 9000 + i * 37);

test('resolveBreakAt is deterministic and its window contains the time asked about', async () => {
  for (const seed of SEEDS) {
    const c = makeCase(seed);
    await withConfig(c, (ib) => {
      const r = rng(seed ^ 0xabc);
      for (let i = 0; i < 150; i += 1) {
        const t = c.d0 + Math.floor(r() * 10 * HOUR);
        const a = ib.resolveBreakAt(c.ch, t);
        const b = ib.resolveBreakAt(c.ch, t);
        assert.equal(identity(a), identity(b), `seed ${seed}: same answer twice at ${t}`);
        if (a) {
          assert.ok(Number.isFinite(a.windowStart) && Number.isFinite(a.windowEnd), `seed ${seed}: finite window`);
          assert.ok(a.windowStart <= t && t < a.windowEnd, `seed ${seed}: window [${a.windowStart}, ${a.windowEnd}) contains ${t} (${a.type}, ${c.timing})`);
        }
      }
    });
  }
});

test('nextBreakBoundary moves forward, stays finite-ish, and the answer is steady between boundaries', async () => {
  const sc = await load('core/schedule.js');
  for (const seed of SEEDS) {
    const c = makeCase(seed);
    await withConfig(c, (ib) => {
      let t = c.d0 + 6 * HOUR;
      const end = t + 3 * HOUR;
      let steps = 0;
      while (t < end && steps < 4000) {
        const next = ib.nextBreakBoundary(c.ch, t);
        if (!Number.isFinite(next)) break;
        assert.ok(next > t, `seed ${seed} (${c.timing}): boundary ${next} must be after ${t}`);
        const posAt = (ms) => sc.computeSourcePosition(sc.resolveActiveSource(c.ch, ms), ms, { ignoreContentLost: true });
        // A pod that starts just before its file ends is dropped by the schedule model at the file boundary (see
        // the next test), so an interval that contains a file boundary (or a one-file wrap) is not steady by design.
        const sameFile = posAt(t + 1).fileIndex === posAt(next - 1).fileIndex && posAt(t + 1).offset < posAt(next - 1).offset;
        if (next < end && sameFile) {
          const span = next - t;
          const ids = [0.02, 0.5, 0.98].map((f) => identity(ib.resolveBreakAt(c.ch, t + Math.floor(span * f))));
          // The start of the interval is itself the previous boundary, so compare interior samples only.
          assert.equal(new Set(ids).size, 1, `seed ${seed} (${c.timing}, interval ${c.commercials.intervalMinutes}): the break changes inside (${t}, ${next}): ${ids.join(' ~ ')}`);
        }
        t = next;
        steps += 1;
      }
      assert.ok(steps < 4000, `seed ${seed}: boundaries run away (${steps} in 3 hours)`);
    });
  }
});

test('every change in resolveBreakAt has a boundary at it', async () => {
  const sc = await load('core/schedule.js');
  for (const seed of SEEDS) {
    const c = makeCase(seed);
    await withConfig(c, (ib) => {
      const from = c.d0 + 7 * HOUR;
      let prev = identity(ib.resolveBreakAt(c.ch, from));
      for (let t = from + 1000; t < from + 2 * HOUR; t += 1000) {
        const cur = identity(ib.resolveBreakAt(c.ch, t));
        // A mid-show pod that starts just before its file ends is dropped by the schedule model at the file
        // boundary (the new file has its own cadence), so a change to "none" exactly there is not a missing boundary.
        const here = sc.computeSourcePosition(sc.resolveActiveSource(c.ch, t), t, { ignoreContentLost: true });
        const before = sc.computeSourcePosition(sc.resolveActiveSource(c.ch, t - 1000), t - 1000, { ignoreContentLost: true });
        const fileEdge = here.fileIndex !== before.fileIndex || here.offset < before.offset; // a one-file channel wraps with the same index
        if (cur !== prev && !(cur === 'none' && fileEdge)) {
          const next = ib.nextBreakBoundary(c.ch, t - 1000);
          // A file-end boundary carries a few ms of epsilon (BOUNDARY_EPSILON_MS) so the timer fires just after the cut.
          assert.ok(next <= t + 60, `seed ${seed} (${c.timing}): the answer changed in (${t - 1000}, ${t}] ("${prev}" -> "${cur}") but the next boundary is ${next - t} ms later`);
        }
        prev = cur;
      }
    });
  }
});

test('pods respect podMax, never repeat an ad when asked, and only use entries meant for this channel and block', async () => {
  for (const seed of SEEDS) {
    const c = makeCase(seed);
    await withConfig(c, (ib) => {
      const from = c.d0 + 8 * HOUR;
      const intervalMs = c.commercials.intervalMinutes * MIN;
      const pods = new Map(); // slot -> commercial entries seen, for interval timing only
      for (let t = from; t < from + 90 * MIN; t += 500) {
        const b = ib.resolveBreakAt(c.ch, t);
        if (!b || !b.entry) continue;
        const e = b.entry;
        assert.ok(e.channelAffinity === 'any' || e.channelAffinity === c.ch.number, `seed ${seed}: ${e.id} is not for this channel`);
        assert.ok(e.blockAffinity == null || e.blockAffinity === 'blk', `seed ${seed}: ${e.id} is for another block`);
        if (c.timing === 'interval' && b.type === 'commercial') {
          const slot = Math.floor((b.windowStart - c.ch.anchor) / intervalMs);
          if (!pods.has(slot)) pods.set(slot, new Map());
          pods.get(slot).set(b.windowStart, e.id);
        }
      }
      pods.forEach((ads, slot) => {
        assert.ok(ads.size <= Math.max(1, c.podMax), `seed ${seed}: slot ${slot} has ${ads.size} commercials, podMax ${c.podMax}`);
        if (c.noRepeat) assert.equal(new Set(ads.values()).size, ads.size, `seed ${seed}: slot ${slot} repeats an ad`);
      });
    });
  }
});

test('degenerate pools never hang or throw', async () => {
  const cases = [
    { pool: [], label: 'empty pool' },
    { pool: [{ id: 'z', type: 'commercial', channelAffinity: 'any', weight: 1, file: { path: 'z.mp4', duration: 0 } }], label: 'zero-length ad' },
    { pool: [{ id: 'n', type: 'commercial', channelAffinity: 'any', weight: 1, file: { path: 'n.mp4' } }], label: 'ad with no duration' },
    { pool: [{ id: 'x', type: 'commercial', channelAffinity: 'any', weight: 1 }], label: 'ad with no file' },
    { pool: [{ id: 'big', type: 'commercial', channelAffinity: 'any', weight: 1, file: { path: 'big.mp4', duration: 99999 } }], label: 'ad longer than the interval' },
    { pool: [{ id: 'd', type: 'adBreakIn', channelAffinity: 'any', weight: 1, dynamic: true, bgFile: null, text: 'T' }], label: 'dynamic bumper with no background' },
  ];
  for (const k of cases) {
    for (const timing of ['interval', 'everyNMinutes', 'breakpoints', 'both']) {
      const c = makeCase(777);
      c.pool = k.pool;
      c.commercials = { ...c.commercials, timing, podMin: 2, podMax: 4, intervalMinutes: 5 };
      await withConfig(c, (ib) => {
        let t = c.d0 + 9 * HOUR;
        for (let i = 0; i < 400; i += 1) {
          ib.resolveBreakAt(c.ch, t);
          const next = ib.nextBreakBoundary(c.ch, t);
          assert.ok(!Number.isFinite(next) || next > t, `${k.label} / ${timing}: boundary must move forward`);
          t = Number.isFinite(next) ? next : t + 60000;
        }
      });
    }
  }
});

test('content shorter than its own break still resolves to something finite (pods may overlap, but nothing hangs or throws)', async () => {
  for (const seed of SEEDS.slice(0, 20)) {
    const c = makeCase(seed);
    c.ch.files = [{ path: 's0.mp4', duration: 5 }, { path: 's1.mp4', duration: 30 }, { path: 's2.mp4', duration: 90 }];
    await withConfig(c, (ib) => {
      const r = rng(seed);
      for (let i = 0; i < 300; i += 1) {
        const t = c.d0 + Math.floor(r() * 6 * HOUR);
        const b = ib.resolveBreakAt(c.ch, t);
        if (b) assert.ok(Number.isFinite(b.windowStart) && b.windowEnd > b.windowStart, `seed ${seed}: sane window`);
        const n = ib.nextBreakBoundary(c.ch, t);
        assert.ok(n === Infinity || n > t, `seed ${seed}: boundary moves forward`);
      }
    });
  }
});

test('extreme times do not break the resolver', async () => {
  const c = makeCase(4242);
  await withConfig(c, (ib) => {
    for (const t of [0, -1, -86400000, 1, new Date(1969, 0, 1).getTime(), new Date(2100, 5, 1).getTime(), 8.64e15 - 1]) {
      const b = ib.resolveBreakAt(c.ch, t);
      if (b) assert.ok(Number.isFinite(b.windowStart) && Number.isFinite(b.windowEnd), `finite window at ${t}`);
      const n = ib.nextBreakBoundary(c.ch, t);
      assert.ok(n === Infinity || n > t, `boundary after ${t}`);
    }
  });
});

// ---- richer configurations: flows, tag presets, broadcast hours, preemption, trivia, forced pre/post ----
function makeRichCase(seed) {
  const c = makeCase(seed);
  const r = rng(seed ^ 0x5eed);
  c.ch.files = c.ch.files.map((f, i) => ({ ...f, tags: i % 2 ? ['movie'] : ['show'] }));
  const stepTypes = ['contentSegment', 'adPod', 'upNext', 'stationId', 'ident', 'bumpIn', 'localAvail'];
  const flows = [];
  if (r() < 0.6) {
    const steps = [];
    const n = 2 + Math.floor(r() * 4);
    for (let i = 0; i < n; i += 1) {
      const type = pick(r, stepTypes);
      steps.push(type === 'adPod' ? { id: `s${i}`, type, podMin: 1, podMax: 1 + Math.floor(r() * 3) } : { id: `s${i}`, type });
    }
    if (!steps.some((s) => s.type === 'contentSegment')) steps.splice(1, 0, { id: 'cs', type: 'contentSegment' });
    flows.push({
      id: 'flow1', enabled: true, channels: [7], steps,
      cadence: r() < 0.5 ? { enabled: true, timing: pick(r, ['everyNMinutes', 'breakpoints']), intervalMinutes: pick(r, [5, 8, 10]), breakpoints: [30, 60], podMin: 1, podMax: 2 } : { enabled: false },
    });
  }
  const presets = r() < 0.6 ? [{ id: 'moviePreset', name: 'Movie', enabled: true, contentTags: ['movie'], timing: pick(r, ['breakpoints', 'interval', 'post']), breakpoints: [25, 50, 75], intervalMinutes: pick(r, [15, 20]), podMin: 1, podMax: 3 }] : [];
  if (r() < 0.3) c.pool.push({ id: 'forced', type: 'commercial', channelAffinity: 'any', weight: 1, contentTiming: pick(r, ['pre', 'post', 'both']), contentTags: ['movie'], file: { path: 'forced.mp4', duration: 20 } });
  if (r() < 0.4) c.pool.push({ id: 'avail', type: 'localAvail', channelAffinity: 'any', weight: 1, text: 'LOCAL' });
  if (r() < 0.4) c.pool.push({ id: 'trv', type: 'trivia', channelAffinity: 'any', weight: 1, text: 'FACT' });
  if (r() < 0.3) c.pool.push({ id: 'promoE', type: 'promo', channelAffinity: 7, blockAffinity: 'blk', weight: 1, leadDays: 30, dynamic: true, bgFile: { path: 'bg.mp4' }, durationS: 6, text: '{daysUntil}' });
  if (r() < 0.3) c.ch.broadcastHours = { enabled: true, startHour: 6, endHour: 2 };
  c.trivia = r() < 0.4;
  c.preemption = r() < 0.3 ? [{ id: 'pw', kind: 'absolute', startMs: c.d0 + 10 * HOUR, endMs: c.d0 + 10 * HOUR + 5 * MIN, label: 'SPECIAL REPORT' }] : [];
  if (c.preemption.length) c.pool.push({ id: 'pre1', type: 'preemption', channelAffinity: 'any', weight: 1, file: { path: 'news.mp4', duration: 300 } });
  c.flows = flows; c.presets = presets;
  return c;
}

async function withRichConfig(c, fn) {
  const state = await load('core/state.js');
  const interstitials = await load('core/interstitials.js');
  state.S.config = {
    commercials: { ...c.commercials },
    interstitials: { pool: c.pool, presets: c.presets, flows: c.flows },
    stationId: c.stationId ? { enabled: true, intervalMinutes: 15 } : { enabled: false },
    trivia: c.trivia ? { enabled: true, intervalMinutes: 20 } : { enabled: false },
    preemptionWindows: c.preemption,
  };
  state.bumpConfigGeneration();
  return fn(interstitials, state);
}

const RICH = Array.from({ length: 60 }, (_, i) => 31000 + i * 53);

test('rich configurations: deterministic, sane windows, forward boundaries, a boundary at every change', async () => {
  const sc = await load('core/schedule.js');
  for (const seed of RICH) {
    const c = makeRichCase(seed);
    await withRichConfig(c, (ib) => {
      const r = rng(seed);
      for (let i = 0; i < 120; i += 1) {
        const t = c.d0 + Math.floor(r() * 12 * HOUR);
        const a = ib.resolveBreakAt(c.ch, t);
        assert.equal(identity(a), identity(ib.resolveBreakAt(c.ch, t)), `rich seed ${seed}: deterministic`);
        if (a) assert.ok(a.windowStart <= t && t < a.windowEnd, `rich seed ${seed}: ${a.type} window contains the time`);
      }
      const from = c.d0 + 6 * HOUR;
      let prev = identity(ib.resolveBreakAt(c.ch, from));
      for (let t = from + 1000; t < from + 2 * HOUR; t += 1000) {
        const cur = identity(ib.resolveBreakAt(c.ch, t));
        const fileAt = (ms) => sc.computeSourcePosition(sc.resolveActiveSource(c.ch, ms), ms, { ignoreContentLost: true });
        const fileEdge = fileAt(t) && fileAt(t - 1000) && (fileAt(t).fileIndex !== fileAt(t - 1000).fileIndex || fileAt(t).offset < fileAt(t - 1000).offset); // a one-file channel wraps with the same index
        if (cur !== prev && !(cur === 'none' && fileEdge)) {
          const next = ib.nextBreakBoundary(c.ch, t - 1000);
          assert.ok(next > t - 1000 && next <= t + 60, `rich seed ${seed}: the answer changed in (${t - 1000}, ${t}] ("${prev}" -> "${cur}") but the next boundary is ${next - t} ms away`);
        }
        prev = cur;
      }
      let t = from; let steps = 0;
      while (t < from + 3 * HOUR && steps < 5000) {
        const next = ib.nextBreakBoundary(c.ch, t);
        if (!Number.isFinite(next)) break;
        assert.ok(next > t, `rich seed ${seed}: boundary must move forward`);
        t = next; steps += 1;
      }
      assert.ok(steps < 5000, `rich seed ${seed}: boundaries run away`);
    });
  }
});
