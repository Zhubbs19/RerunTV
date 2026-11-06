// The settings added with "shows pause for ad breaks" (docs/design/14 §6, tier 1):
// per-channel and per-block pause, a channel's own ad interval, how far breaks
// keep from a show's ends, ad variety, the 15-minute fit grid and credits sound.
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
    commercials: { timing: 'interval', intervalMinutes: 15, podMin: 2, podMax: 2, ...commercials },
    interstitials: { pool: pool || [ad('a', 30), ad('b', 30), ad('c', 30), ad('d', 28), ad('e', 15)], presets: [], flows: [] },
    stationId: { enabled: false },
    ...extra,
  };
  state.bumpConfigGeneration();
  return { state, schedule, ib, fit };
}

function channel(extra = {}) {
  return {
    number: 5, name: 'OPT', anchor: D0, adsEnabled: true, blocks: [],
    files: [{ path: 'm1.mp4', duration: 5400 }, { path: 'm2.mp4', duration: 4800 }],
    ...extra,
  };
}

const planOf = (m, ch, t = D0 + HOUR) => m.schedule.resolveActiveSource(ch, t);
const breaksOf = (src, i = 0) => src.files[i].fit.segments.filter((s) => s.kind === 'break');

test('a channel can turn pausing off (or on) for itself', async () => {
  let m = await setup();
  const off = channel({ pauseForBreaks: 'off' });
  assert.ok(!planOf(m, off).breakPlan, 'off: breaks laid over the show');
  assert.ok(planOf(m, channel()).breakPlan, 'unset follows the box (on)');
  m = await setup({ pauseForBreaks: false });
  assert.ok(planOf(m, channel({ pauseForBreaks: 'on' })).breakPlan, 'on beats a box that is off');
});

test('a schedule block can set pausing for its own hours', async () => {
  const m = await setup();
  const ch = channel({
    blocks: [{
      id: 'night', priority: 5, mode: 'loop', anchor: D0, pauseForBreaks: 'off',
      trigger: { type: 'dayOfWeek', startHour: 22, endHour: 2, days: [] },
      files: [{ path: 'n1.mp4', duration: 3000 }],
    }],
  });
  assert.ok(planOf(m, ch, D0 + 12 * HOUR).breakPlan, 'outside the block: the channel (box) setting');
  assert.ok(!planOf(m, ch, D0 + 23 * HOUR).breakPlan, 'inside the block: its own setting');
});

test('a channel can set its own ad interval; a preset still wins', async () => {
  const m = await setup();
  const ch = channel({ adIntervalMinutes: 30 });
  assert.equal(m.schedule.resolveActiveCommercials(ch, D0, []).commercials.intervalMinutes, 30);
  assert.equal(breaksOf(planOf(m, ch)).length, 3, '90 min movie, every 30 min: at 0, 30, 60');
  m.state.S.config.interstitials.presets = [{ id: 'p', enabled: true, channels: [5], contentTags: [], timing: 'interval', intervalMinutes: 10, podMin: 1, podMax: 1 }];
  m.state.bumpConfigGeneration();
  assert.equal(m.schedule.resolveActiveCommercials(ch, D0, []).commercials.intervalMinutes, 10);
});

test('"keep breaks from a show’s ends" sets the snap distance; 0 turns it off', async () => {
  const files = [{ path: 'x.mp4', duration: 1800 + 90 }, { path: 'y.mp4', duration: 1800 }];
  let m = await setup({ intervalMinutes: 30 });
  assert.equal(breaksOf(planOf(m, channel({ files })))[1].contentAt, 1800, 'default 60 s: a break 90 s from the end stays');
  m = await setup({ intervalMinutes: 30, breakEdgeSeconds: 120 });
  assert.equal(breaksOf(planOf(m, channel({ files })))[1].contentAt, 1890, '120 s: it moves onto the end');
  m = await setup({ intervalMinutes: 30, breakEdgeSeconds: 0 });
  const tiny = [{ path: 'z.mp4', duration: 1800 + 10 }, { path: 'y.mp4', duration: 1800 }];
  assert.equal(breaksOf(planOf(m, channel({ files: tiny })))[1].contentAt, 1800, '0: even 10 s from the end stays put');
});

test('ad variety: same length, also shorter (never longer), or off', async () => {
  const lineupsAt = async (commercials) => {
    const m = await setup({ podMin: 1, podMax: 1, ...commercials }, [ad('a', 30), ad('b', 30), ad('c', 28), ad('d', 25), ad('long', 31)]);
    const ch = channel({ files: [{ path: 's.mp4', duration: 1200 }] });
    const loopMs = planOf(m, ch).files[0].duration * 1000;
    const first = m.ib.nextBreakStart(ch, D0 + 1000);
    const ids = new Set();
    for (let pass = 0; pass < 40; pass++) {
      const brk = m.ib.resolveBreakAt(ch, first + pass * loopMs + 1);
      ids.add(brk.entry.id);
      assert.ok(brk.windowEnd - brk.windowStart <= 30000 + 1, 'the slot keeps its planned length');
    }
    return ids;
  };
  const same = await lineupsAt({});
  assert.ok(!same.has('c') && !same.has('d') && !same.has('long'), `same length only: ${[...same]}`);
  const shorter = await lineupsAt({ adVariety: 'shorter', adVarietySeconds: 3 });
  assert.ok(shorter.has('c') && !shorter.has('d') && !shorter.has('long'), `up to 3 s shorter, never longer: ${[...shorter]}`);
  const off = await lineupsAt({ adVariety: 'off' });
  assert.equal(off.size, 1, 'off: the planned ad every time');
});

test('fit to time slots can use a 15-minute grid', async () => {
  const m = await setup({}, null, { programFit: { enabled: true, gridMinutes: 15 } });
  assert.equal(m.fit.normalizeFitConfig({ gridMinutes: 15 }).gridMinutes, 15);
  assert.equal(m.fit.normalizeFitConfig({ gridMinutes: 20 }).gridMinutes, 30, 'anything else falls back to 30');
  const ch = channel({ anchor: D0 + 7 * MIN, files: [{ path: 'k.mp4', duration: 11 * 60 }, { path: 'k2.mp4', duration: 22 * 60 }] });
  const src = m.schedule.resolveActiveSource(ch, D0 + HOUR);
  assert.ok(src.fit, 'fitted');
  src.files.forEach((f) => assert.equal(f.duration % 900, 0, `${f.path} fills whole quarter hours (${f.duration} s)`));
  assert.equal(new Date(src.anchor).getMinutes() % 15, 0, 'the loop starts on a quarter hour');
});

test('credits sound follows the channel’s END CREDITS, else the fit settings, else mute', async () => {
  const m = await setup({}, null, { programFit: { enabled: false, creditsAudio: 'keep' } });
  assert.equal(m.fit.creditsAudioFor(channel()), 'mute', 'not fitted, no END CREDITS: muted');
  assert.equal(m.fit.creditsAudioFor(channel({ creditsSpeedup: { enabled: true, audio: 'lower' } })), 'lower');
  assert.equal(m.fit.creditsAudioFor(channel({ programFit: { mode: 'on' } })), 'keep', 'fitted: the fit setting');
  assert.equal(m.fit.normalizeFitConfig({ creditsAudio: 'loud' }).creditsAudio, 'mute', 'unknown values fall back to mute');
});
