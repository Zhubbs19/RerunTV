// Audit fixes in core/schedule.js and friends: midnight-wrapping hour ranges keep their
// post-midnight tail on the day they started, walkSourceSchedule survives bad durations,
// truncation is reported, and pickDeterministic tolerates junk weights.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

globalThis.window = globalThis.window || { matchMedia: () => ({ matches: false }), api: {} };

const load = (name) => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', name)).href);

const HOUR = 3600000;
// 2026-10-23 is a Friday. Local time throughout, as the resolvers use local getters.
const at = (day, hour, min = 0) => new Date(2026, 9, day, hour, min, 0, 0).getTime();
const FRI = 5;
const SAT = 6;

function dayBlock(overrides = {}) {
  return {
    id: 'b1',
    files: [{ path: 'a.mp4', duration: 600 }],
    anchor: at(1, 0),
    trigger: { type: 'dayOfWeek', startHour: 22, endHour: 2, days: [FRI] },
    ...overrides,
  };
}

test('a wrapped Friday 22-2 slot airs through Saturday 01:59 and not Friday 00:00-01:59', async () => {
  const { matchesTrigger } = await load('core/schedule.js');
  const block = dayBlock();
  assert.equal(matchesTrigger(at(23, 22), block), true, 'Friday 22:00');
  assert.equal(matchesTrigger(at(23, 23, 59), block), true, 'Friday 23:59');
  assert.equal(matchesTrigger(at(24, 0, 30), block), true, 'Saturday 00:30 is Friday night\'s tail');
  assert.equal(matchesTrigger(at(24, 1, 59), block), true, 'Saturday 01:59');
  assert.equal(matchesTrigger(at(24, 2), block), false, 'Saturday 02:00 is past the end');
  assert.equal(matchesTrigger(at(23, 1), block), false, 'Friday 01:00 is Thursday night\'s tail, not Friday\'s');
  assert.equal(matchesTrigger(at(24, 22), block), false, 'Saturday 22:00 is not a Friday');
  assert.equal(matchesTrigger(at(25, 0, 30), block), false, 'Sunday 00:30 is Saturday night\'s tail');
});

test('a non-wrapping day filter is unchanged', async () => {
  const { matchesTrigger } = await load('core/schedule.js');
  const block = dayBlock({ trigger: { type: 'dayOfWeek', startHour: 20, endHour: 23, days: [FRI] } });
  assert.equal(matchesTrigger(at(23, 21), block), true);
  assert.equal(matchesTrigger(at(24, 21), block), false);
  assert.equal(matchesTrigger(at(23, 23, 30), block), false);
});

test('a wrapped slot with no day filter keeps matching every night', async () => {
  const { matchesTrigger } = await load('core/schedule.js');
  const block = dayBlock({ trigger: { type: 'dayOfWeek', startHour: 22, endHour: 2 } });
  assert.equal(matchesTrigger(at(24, 1), block), true);
  assert.equal(matchesTrigger(at(24, 12), block), false);
});

test('a dateRange narrowed to a wrapped window judges the date and day on the day it started', async () => {
  const { matchesTrigger } = await load('core/schedule.js');
  // Oct 23 - Oct 23 (one day), Friday only, 22-2.
  const block = dayBlock({
    trigger: { type: 'dateRange', startMonth: 10, startDay: 23, endMonth: 10, endDay: 23, startHour: 22, endHour: 2, days: [FRI] },
  });
  assert.equal(matchesTrigger(at(23, 23), block), true, 'evening of the range day');
  assert.equal(matchesTrigger(at(24, 1), block), true, 'tail falls on Oct 24 / a Saturday but belongs to Oct 23 / Friday');
  assert.equal(matchesTrigger(at(23, 1), block), false, 'Oct 23 01:00 belongs to Oct 22');
  assert.equal(matchesTrigger(at(24, 23), block), false);
});

test('ownerInstant leaves non-wrapping triggers alone', async () => {
  const { ownerInstant } = await load('core/schedule.js');
  const t = { startHour: 8, endHour: 12 };
  assert.equal(ownerInstant(at(24, 1), t), at(24, 1));
  const wrap = { startHour: 22, endHour: 2 };
  assert.equal(new Date(ownerInstant(at(24, 1), wrap)).getDate(), 23);
  assert.equal(ownerInstant(at(24, 23), wrap), at(24, 23));
});

test('the rules engine agrees with the layered resolvers on wrapped day-filtered blocks', async () => {
  const rules = await load('core/programming-rules.js');
  const { matchesTrigger } = await load('core/schedule.js');
  const block = dayBlock();
  const when = { hours: [22, 2], days: [FRI] };
  for (let h = 0; h < 48; h++) {
    const t = at(23, 0) + h * HOUR + 1000;
    assert.equal(rules.matchesWhen(when, t), matchesTrigger(t, block), `hour offset ${h}`);
  }
});

test('walkSourceSchedule skips zero, negative and NaN durations instead of looping or poisoning the total', async () => {
  const { walkSourceSchedule } = await load('core/schedule.js');
  const a = { path: 'a', duration: 600 };
  const source = {
    files: [{ path: 'nan', duration: NaN }, a, { path: 'neg', duration: -30 }, { path: 'zero', duration: 0 }, { path: 'undef' }, { path: 'str', duration: 'abc' }],
    anchor: at(1, 0),
    block: null,
  };
  const entries = walkSourceSchedule(source, at(2, 0), at(2, 0) + 3 * 600000);
  assert.ok(entries.length > 0);
  assert.ok(entries.every((e) => e.file === a), 'only the real file airs');
  assert.ok(entries.every((e) => e.end > e.start && Number.isFinite(e.start) && Number.isFinite(e.end)));
  assert.equal(entries.truncated, undefined);
});

test('walkSourceSchedule returns nothing when no file has a usable duration', async () => {
  const { walkSourceSchedule } = await load('core/schedule.js');
  const source = { files: [{ path: 'x', duration: NaN }, { path: 'y', duration: 0 }], anchor: 1, block: null };
  assert.deepEqual(walkSourceSchedule(source, 1000, 100000), []);
});

test('walkSourceSchedule flags a walk cut short by the per-segment safety cap', async () => {
  const { walkSourceSchedule } = await load('core/schedule.js');
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    // 0.01s files across a 30 minute window needs 180000 entries: well past the cap of 1000.
    const source = { files: [{ path: 's', duration: 0.01 }], anchor: at(1, 0), block: null };
    const entries = walkSourceSchedule(source, at(2, 0), at(2, 0) + 30 * 60000);
    assert.equal(entries.length, 1000);
    assert.equal(entries.truncated, true);
    walkSourceSchedule(source, at(2, 0), at(2, 0) + 30 * 60000);
    assert.equal(warnings.length, 1, 'warned once, not per call');
  } finally {
    console.warn = warn;
  }
});

test('getChannelSchedule and queryDay propagate truncated additively', async () => {
  const state = await load('core/state.js');
  const schedule = await load('core/schedule.js');
  const query = await load('core/schedule-query.js');
  state.S.config = { commercials: { timing: 'interval', intervalMinutes: 10 }, interstitials: { pool: [], presets: [], flows: [] } };
  const quiet = console.warn;
  console.warn = () => {};
  try {
    const tiny = { number: 7, files: [{ path: 's', duration: 0.01 }], anchor: at(1, 0), blocks: [] };
    const entries = schedule.getChannelSchedule(tiny, at(2, 0), at(2, 0) + HOUR);
    assert.equal(entries.truncated, true);
    const day = query.queryDay(tiny, at(2, 0), { breaks: false });
    assert.equal(day.truncated, true);
    assert.equal(query.querySchedule(tiny, at(2, 0), at(2, 12), { breaks: false }).truncated, true);

    const fine = { number: 8, files: [{ path: 'f', duration: 1800 }], anchor: at(1, 0), blocks: [] };
    const ok = schedule.getChannelSchedule(fine, at(2, 0), at(2, 0) + 3 * HOUR);
    assert.equal(ok.truncated, undefined);
    assert.equal('truncated' in query.queryDay(fine, at(2, 0), { breaks: false }), false);
  } finally {
    console.warn = quiet;
  }
});

test('pickDeterministic treats junk weights as 1 and never returns undefined for a non-empty pool', async () => {
  const { pickDeterministic } = await load('core/interstitials.js');
  const pool = [{ id: 'a', weight: 'abc' }, { id: 'b', weight: NaN }, { id: 'c' }, { id: 'd', weight: 3 }];
  const seen = new Set();
  for (let i = 0; i < 60; i++) {
    const pick = pickDeterministic(pool, 'seed', i);
    assert.ok(pick, `slot ${i}`);
    seen.add(pick.id);
  }
  assert.deepEqual([...seen].sort(), ['a', 'b', 'c', 'd']);
  const allJunk = [{ id: 'x', weight: 'q' }];
  assert.equal(pickDeterministic(allJunk, 's', 4).id, 'x');
});
