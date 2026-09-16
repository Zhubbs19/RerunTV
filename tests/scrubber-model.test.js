// scrubber-model.js — the time machine's scrub window, hold acceleration,
// program boundaries and "Go to…" targets (docs/design/11 §3).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', 'timeline/scrubber.js')).href);

const MIN = 60000;
const HOUR = 60 * MIN;
// Monday 2026-09-14 19:42 local.
const MONDAY_EVENING = new Date(2026, 8, 14, 19, 42, 0, 0).getTime();

test('the window is ±3 h and only re-centres near an edge', async () => {
  const { scrubWindow } = await load();
  const w = scrubWindow(MONDAY_EVENING);
  assert.equal(w.to - w.from, 6 * HOUR);
  assert.equal(w.from, MONDAY_EVENING - 3 * HOUR);
  assert.equal(scrubWindow(MONDAY_EVENING + 2 * HOUR, w), w, 'still inside: unchanged');
  const moved = scrubWindow(MONDAY_EVENING + 2 * HOUR + 40 * MIN, w);
  assert.notEqual(moved, w);
  assert.equal(moved.from, MONDAY_EVENING + 2 * HOUR + 40 * MIN - 3 * HOUR);
});

test('far jumps are the ones that leave the window', async () => {
  const { isFarJump } = await load();
  assert.equal(isFarJump(0, 2 * HOUR), false);
  assert.equal(isFarJump(0, -24 * HOUR), true);
});

test('holding ◀▶ accelerates 10 s → 30 s → 2 min → program boundary', async () => {
  const { scrubStepMs } = await load();
  assert.equal(scrubStepMs(0), 10000);
  assert.equal(scrubStepMs(1499), 10000);
  assert.equal(scrubStepMs(1500), 30000);
  assert.equal(scrubStepMs(3400), 30000);
  assert.equal(scrubStepMs(4000), 2 * MIN);
  assert.equal(scrubStepMs(6000), 'boundary');
  assert.equal(scrubStepMs(NaN), 10000);
});

test('▲▼ go to program starts, and a press at a start goes to the previous one', async () => {
  const { boundaryAfter, boundaryBefore, programAt } = await load();
  const programs = [
    { start: 0, end: 30 * MIN }, { start: 30 * MIN, end: 52 * MIN }, { start: 52 * MIN, end: 90 * MIN },
  ];
  assert.equal(boundaryAfter(programs, 10 * MIN), 30 * MIN);
  assert.equal(boundaryAfter(programs, 30 * MIN), 52 * MIN, 'at a start, next goes forward');
  assert.equal(boundaryAfter(programs, 60 * MIN), null);
  assert.equal(boundaryBefore(programs, 40 * MIN), 30 * MIN);
  assert.equal(boundaryBefore(programs, 30 * MIN + 1000), 0, 'just after a start counts as at it');
  assert.equal(boundaryBefore(programs, 0), null);
  assert.equal(programAt(programs, 31 * MIN).start, 30 * MIN);
  assert.equal(programAt(programs, 91 * MIN), null);
});

test('Go to… targets resolve in local time', async () => {
  const { goToTargets, thisMorning, lastSaturdayMorning, yesterdaySameTime } = await load();
  const d = (ms) => { const x = new Date(ms); return [x.getFullYear(), x.getMonth() + 1, x.getDate(), x.getHours(), x.getMinutes(), x.getDay()]; };
  assert.deepEqual(d(yesterdaySameTime(MONDAY_EVENING)), [2026, 9, 13, 19, 42, 0]);
  assert.deepEqual(d(thisMorning(MONDAY_EVENING)), [2026, 9, 14, 6, 0, 1]);
  const earlyMonday = new Date(2026, 8, 14, 3, 0).getTime();
  assert.deepEqual(d(thisMorning(earlyMonday)), [2026, 9, 13, 6, 0, 0], 'before 6 AM means yesterday morning');
  assert.deepEqual(d(lastSaturdayMorning(MONDAY_EVENING)), [2026, 9, 12, 8, 0, 6]);
  const saturdayNoon = new Date(2026, 8, 12, 12, 0).getTime();
  const saturdayDawn = new Date(2026, 8, 12, 7, 0).getTime();
  assert.deepEqual(d(lastSaturdayMorning(saturdayNoon)), [2026, 9, 12, 8, 0, 6], 'today, once it has passed');
  assert.deepEqual(d(lastSaturdayMorning(saturdayDawn)), [2026, 9, 5, 8, 0, 6], 'otherwise the week before');
  const targets = goToTargets(MONDAY_EVENING, MONDAY_EVENING - 12 * MIN);
  assert.deepEqual(targets.map((t) => t.id), ['yesterday', 'showStart', 'morning', 'saturday']);
  assert.deepEqual(goToTargets(MONDAY_EVENING, null).map((t) => t.id), ['yesterday', 'morning', 'saturday']);
});

test('the day/hour picker clamps to ±7 days and wraps hours', async () => {
  const { pickerTime, clampPicker } = await load();
  assert.deepEqual(clampPicker({ dayOffset: -9, hour: 25 }), { dayOffset: -7, hour: 1 });
  assert.deepEqual(clampPicker({ dayOffset: 3, hour: -1 }), { dayOffset: 3, hour: 23 });
  const at = new Date(pickerTime(MONDAY_EVENING, { dayOffset: -2, hour: 20 }));
  assert.deepEqual([at.getDate(), at.getHours(), at.getMinutes()], [12, 20, 0]);
});
