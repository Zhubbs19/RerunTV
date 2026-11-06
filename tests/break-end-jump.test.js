// breakEndAt (core/interstitials.js), the time machine's "end of break" jump
// (\ key, TV menu › TIME MACHINE › END OF BREAK): it lands a few seconds
// before the show comes back from the whole pod, from inside the pod or from
// the show before it, and pressing it again near the end moves on. Checked
// with shows pausing for breaks (the default) and with breaks laid over them.
process.env.TZ = 'America/New_York'; // before any Date use
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

globalThis.window = globalThis.window || { matchMedia: () => ({ matches: false }), api: {} };
const load = (name) => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', name)).href);

const MIN = 60000;
const HOUR = 60 * MIN;
const MODES = [{ overlay: false, name: 'shows pause' }, { overlay: true, name: 'overlay' }];

function entry(id, type, duration) {
  return { id, type, channelAffinity: 'any', file: { path: `${id}.mp4`, duration } };
}

async function setup(overlay, extraConfig = {}) {
  const state = await load('core/state.js');
  const ib = await load('core/interstitials.js');
  state.S.config = {
    commercials: { timing: 'interval', intervalMinutes: 15, podMin: 2, podMax: 2, pauseForBreaks: !overlay },
    interstitials: {
      pool: [entry('in', 'adBreakIn', 4), entry('ad1', 'commercial', 30), entry('ad2', 'commercial', 45), entry('out', 'adBreakOut', 8)],
      presets: [],
      flows: [],
    },
    ...extraConfig,
  };
  state.bumpConfigGeneration();
  const d0 = new Date(2026, 11, 1, 0, 0, 0, 0).getTime();
  const ch = {
    number: 67, name: 'TEST', anchor: d0, adsEnabled: true, blocks: [],
    files: [{ path: 'movie.mp4', duration: 7200 }, { path: 'movie2.mp4', duration: 6000 }],
  };
  return { ib, ch, d0 };
}

// The instant the show is back: the first moment after `fromMs` with no
// interrupting break on, found by brute force.
function showBackAfter(ib, ch, fromMs) {
  for (let t = fromMs; t < fromMs + HOUR; t += 250) {
    if (!ib.resolveBreakAt(ch, t)) return t;
  }
  return null;
}

for (const mode of MODES) {
  test(`from inside a pod: lands just before the show comes back, past every segment (${mode.name})`, async () => {
    const { ib, ch, d0 } = await setup(mode.overlay);
    const podStart = ib.nextBreakStart(ch, d0 + 9 * HOUR);
    assert.equal(ib.resolveBreakAt(ch, podStart).type, 'adBreakIn', 'fixture: the pod opens with its bump-in');
    const found = ib.breakEndAt(ch, podStart + 2000);
    assert.ok(found, 'a break end is found');
    const back = showBackAfter(ib, ch, podStart);
    assert.ok(Math.abs(found.breakEnd - back) <= 250, `break end ${found.breakEnd - podStart} ms vs show back ${back - podStart} ms`);
    assert.equal(found.target, found.breakEnd - ib.BREAK_END_LEAD_MS);
    const atTarget = ib.resolveBreakAt(ch, found.target);
    assert.ok(atTarget, 'the landing point is still inside the break');
    assert.equal(atTarget.type, 'adBreakOut', 'it lands in the bump-out, the last segment');
  });

  test(`from the show: lands near the end of the next break (${mode.name})`, async () => {
    const { ib, ch, d0 } = await setup(mode.overlay);
    const first = ib.nextBreakStart(ch, d0 + 9 * HOUR);
    const from = showBackAfter(ib, ch, first) + 2 * MIN; // mid-show, after that pod
    assert.equal(ib.resolveBreakAt(ch, from), null, 'fixture: the show is on');
    const found = ib.breakEndAt(ch, from);
    const next = ib.nextBreakStart(ch, from);
    assert.ok(found.target > next && found.target < found.breakEnd, 'lands inside that pod, before its end');
    assert.equal(ib.resolveBreakAt(ch, found.breakEnd), null, 'the show is back at the break end');
  });

  test(`pressing again in the last seconds moves on to the next break (${mode.name})`, async () => {
    const { ib, ch, d0 } = await setup(mode.overlay);
    const podStart = ib.nextBreakStart(ch, d0 + 9 * HOUR);
    const first = ib.breakEndAt(ch, podStart + 1000);
    const second = ib.breakEndAt(ch, first.target);
    assert.ok(second.breakEnd > first.breakEnd + 10 * MIN, 'the second press goes to the following pod');
  });

  test(`a text-only station ID over the show is not treated as a break (${mode.name})`, async () => {
    const { ib, ch, d0 } = await setup(mode.overlay, { stationId: { enabled: true, intervalMinutes: 5 } });
    const podStart = ib.nextBreakStart(ch, d0 + 9 * HOUR);
    const found = ib.breakEndAt(ch, podStart + 1000);
    const after = ib.resolveBreakAt(ch, found.breakEnd);
    assert.ok(!after || (after.type === 'channelId' && !(after.entry && after.entry.file)), 'only an ID bar (or nothing) at the end');
  });

  test(`a channel with no breaks finds nothing (${mode.name})`, async () => {
    const { ib, ch, d0 } = await setup(mode.overlay);
    ch.adsEnabled = false;
    assert.equal(ib.breakEndAt(ch, d0 + 9 * HOUR), null);
  });
}
