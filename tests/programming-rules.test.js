// programming-rules.js (docs/design/02 §5, step 3a): the rule stack must
// resolve exactly what today's layers resolve, at every instant a schedule can
// change, before any migration is allowed to write config (§5.3).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

globalThis.window = globalThis.window || { matchMedia: () => ({ matches: false }), api: {} };

const load = (name) => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', name)).href);

const DAY = 86400000;
const START = new Date(2026, 10, 20, 0, 0, 0, 0).getTime(); // spans Thanksgiving week into December

function rng(seed) {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
}

async function modules() {
  return { state: await load('core/state.js'), rules: await load('core/programming-rules.js'), schedule: await load('core/schedule.js') };
}

test('matchesWhen agrees with matchesTrigger for random triggers at random instants', async () => {
  const { rules, schedule } = await modules();
  const rnd = rng(3);
  const int = (n) => Math.floor(rnd() * n);
  for (let i = 0; i < 400; i++) {
    const days = rnd() < 0.4 ? [] : [...new Set(Array.from({ length: 1 + int(3) }, () => int(7)))];
    const trigger = rnd() < 0.5
      ? { type: 'dayOfWeek', startHour: int(24), endHour: int(24), days }
      : {
        type: 'dateRange', startMonth: 1 + int(12), startDay: 1 + int(29), endMonth: 1 + int(12), endDay: 1 + int(29),
        ...(rnd() < 0.5 ? { startHour: int(24), endHour: int(24) } : {}), ...(rnd() < 0.4 ? { days } : {}),
      };
    const when = rules.rulesFromLayers({ number: 1, blocks: [{ id: 'b', trigger, files: [] }] }, {}).rules[0].when;
    for (let k = 0; k < 40; k++) {
      const t = new Date(2027, 0, 1).getTime() + int(366) * DAY + int(24) * 3600000 + int(60) * 60000;
      assert.equal(rules.matchesWhen(when, t), schedule.matchesTrigger(t, { trigger }), `${JSON.stringify(trigger)} at ${new Date(t)}`);
    }
  }
});

test('translation order: ads off, flows, presets, blocks by priority, then the default', async () => {
  const { rules } = await modules();
  const config = {
    interstitials: {
      flows: [{ id: 'f-other', channels: [9] }, { id: 'f1', channels: [], contentTags: ['cartoon'] }, { id: 'f-off', enabled: false }],
      presets: [{ id: 'p-unscoped' }, { id: 'p1', channels: [4] }, { id: 'p2', contentTags: ['movie'] }],
    },
  };
  const ch = {
    number: 4, adsEnabled: false, broadcastHours: { enabled: true, startHour: 6, endHour: 2 },
    blocks: [
      { id: 'low', priority: 0, trigger: { type: 'dayOfWeek', startHour: 1, endHour: 2 } },
      { id: 'high', priority: 5, trigger: { type: 'dayOfWeek', startHour: 1, endHour: 2 }, commercials: { timing: 'post' } },
      { id: 'tie', priority: 0, trigger: { type: 'dayOfWeek', startHour: 1, endHour: 2 } },
    ],
  };
  const programming = rules.rulesFromLayers(ch, config);
  assert.deepEqual(programming.rules.map((r) => r.id), ['ads-off', 'flow:f1', 'preset:p1', 'preset:p2', 'block:high', 'block:low', 'block:tie', 'default']);
  assert.deepEqual(programming.signOff, { hours: [2, 6] });
  assert.deepEqual(programming.rules[4].breaks, { block: 'high' });
  assert.equal(programming.rules[5].breaks, undefined, 'a block without its own ads only plays');
  assert.equal(rules.rulesFromLayers({ number: 4, broadcastHours: { enabled: true, startHour: 3, endHour: 3 } }, {}).signOff, null);
});

// A random channel exercising every layer: time blocks (wrapping, weekly
// rotations), date ranges (daily with day overrides and unlock times, finale,
// narrowed), blocks with no folder or only ads, presets and flows scoped by
// channel and tags, broadcast hours and the ads switch.
function randomSetup(seed) {
  const rnd = rng(seed);
  const int = (n) => Math.floor(rnd() * n);
  const pick = (list) => list[int(list.length)];
  const tagsPool = ['cartoon', 'movie', 'news', 'sitcom'];
  const file = (i, prefix) => ({ path: `${prefix}${i}.mp4`, duration: 300 + rnd() * 2400, ...(rnd() < 0.5 ? { tags: [pick(tagsPool)] } : {}) });
  const files = (n, prefix) => Array.from({ length: n }, (_, i) => file(i, prefix));
  const blocks = Array.from({ length: int(6) }, (_, i) => {
    const dateRange = rnd() < 0.4;
    const block = {
      id: `b${i}`, name: `Block ${i}`, priority: int(4) * (rnd() < 0.3 ? 5 : 1), mode: 'loop',
      anchor: START - int(60) * DAY, files: rnd() < 0.15 ? [] : files(1 + int(6), `b${i}-`), dayOverrides: {},
      commercials: rnd() < 0.3 ? { enabled: true, timing: pick(['post', 'interval']), intervalMinutes: 8 } : null,
    };
    if (dateRange) {
      const sm = pick([11, 12, 1]);
      block.trigger = { type: 'dateRange', startMonth: sm, startDay: 1 + int(28), endMonth: pick([11, 12, 1]), endDay: 1 + int(28) };
      if (rnd() < 0.4) Object.assign(block.trigger, { startHour: int(24), endHour: int(24) });
      if (rnd() < 0.3) block.trigger.days = [int(7)];
      block.mode = pick(['loop', 'daily', 'weekly', 'marathon']);
      if (block.mode === 'daily' && rnd() < 0.6) {
        block.dayOverrides['12-03'] = { file: null, skip: true };
        block.dayOverrides['11-28'] = { file: block.files[0] && block.files[0].path, unlockTime: `${pad(int(24))}:${pad(int(60))}` };
      }
      if (rnd() < 0.3) block.finale = { unlockAll: true, mode: 'marathon' };
    } else {
      block.trigger = { type: 'dayOfWeek', startHour: int(24), endHour: int(24), days: rnd() < 0.5 ? [] : [int(7)] };
      if (block.trigger.days.length === 1 && rnd() < 0.5) block.mode = 'weekly';
    }
    return block;
  });
  const ch = {
    number: 7, anchor: START - int(90) * DAY, adsEnabled: rnd() > 0.1, files: files(4 + int(8), 'ch-'), blocks,
    ...(rnd() < 0.3 ? { contentTags: [pick(tagsPool)] } : {}),
    ...(rnd() < 0.4 ? { broadcastHours: { enabled: true, startHour: int(24), endHour: int(24) } } : {}),
  };
  const config = {
    commercials: { timing: 'interval', intervalMinutes: 10 },
    interstitials: {
      pool: [],
      flows: Array.from({ length: int(3) }, (_, i) => ({
        id: `f${i}`, enabled: rnd() > 0.2, channels: rnd() < 0.5 ? [] : [pick([7, 8])], contentTags: rnd() < 0.5 ? [] : [pick(tagsPool)],
        steps: [{ type: 'contentSegment' }, { type: 'adPod', podMin: 1, podMax: 2 }],
      })),
      presets: Array.from({ length: int(4) }, (_, i) => ({
        id: `p${i}`, enabled: rnd() > 0.2, channels: rnd() < 0.5 ? [] : [pick([7, 8])], contentTags: rnd() < 0.5 ? [] : [pick(tagsPool)], timing: 'breakpoints', breakpoints: [50],
      })),
    },
    channels: [ch],
  };
  return { ch, config };
  function pad(n) { return String(n).padStart(2, '0'); }
}

test('random channels: the rule stack resolves what the layers resolve for 60 days', async () => {
  const { state, rules } = await modules();
  let checks = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const { ch, config } = randomSetup(seed * 7919);
    state.S.config = config;
    state.bumpConfigGeneration();
    const result = rules.compareRulesToLayers(ch, config, START, START + 60 * DAY, { limit: 3 });
    checks += result.checks;
    assert.deepEqual(result.mismatches, [], `seed ${seed}: ${JSON.stringify(result.mismatches.map((m) => ({ ...m, at: new Date(m.atMs).toString() })))}`);
  }
  assert.ok(checks > 100000, `exhaustive enough (${checks} checks)`);
});
