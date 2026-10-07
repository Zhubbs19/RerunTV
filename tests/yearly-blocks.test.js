// Blocks that repeat every year: the Thanksgiving start rule and anchorToRange
// (core/schedule.js), plus the calendar date arithmetic (timeline/calendar-grid.js).
process.env.TZ = 'America/New_York'; // before any Date use
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

globalThis.window = globalThis.window || { matchMedia: () => ({ matches: false }), api: {} };
const load = (name) => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', name)).href);

const at = (y, m, d, h = 12, mi = 0) => new Date(y, m - 1, d, h, mi, 0, 0).getTime();
const files = (n, secs = 3600) => Array.from({ length: n }, (_, i) => ({ path: `f${i}.mp4`, duration: secs }));
const chan = (blocks) => ({ number: 67, name: 'X', anchor: at(2020, 1, 1), files: files(1), blocks });

test('thanksgivingDay is the 4th Thursday of November', async () => {
  const { thanksgivingDay } = await load('core/schedule.js');
  assert.deepEqual([2024, 2025, 2026, 2027, 2028, 2029, 2030].map(thanksgivingDay), [28, 27, 26, 25, 23, 22, 28]);
});

test('a Thanksgiving block starts on Thanksgiving whatever the year', async () => {
  const { resolveActiveSource } = await load('core/schedule.js');
  const hp = {
    id: 'hp', priority: 10, mode: 'loop', anchor: at(2026, 11, 26, 0), anchorToRange: true, files: files(3),
    trigger: { type: 'dateRange', startMonth: 11, startDay: 26, startRule: 'thanksgiving', endMonth: 12, endDay: 1 },
  };
  const ch = chan([hp]);
  const id = (ms) => resolveActiveSource(ch, ms).block?.id || 'default';
  assert.equal(id(at(2026, 11, 25)), 'default');
  assert.equal(id(at(2026, 11, 26)), 'hp');
  assert.equal(id(at(2026, 12, 1, 23)), 'hp');
  assert.equal(id(at(2026, 12, 2)), 'default');
  // 2027: Thanksgiving is the 25th, so the 25th is in and the 24th is not.
  assert.equal(id(at(2027, 11, 24)), 'default');
  assert.equal(id(at(2027, 11, 25, 0, 30)), 'hp');
  // 2028: the 23rd.
  assert.equal(id(at(2028, 11, 22)), 'default');
  assert.equal(id(at(2028, 11, 23)), 'hp');
});

test('anchorToRange restarts the block from its first file at the start of each year\'s range', async () => {
  const { resolveActiveSource, computeSourcePosition } = await load('core/schedule.js');
  const hp = {
    id: 'hp', priority: 10, mode: 'loop', anchor: at(2026, 11, 26, 0), anchorToRange: true, files: files(3),
    trigger: { type: 'dateRange', startMonth: 11, startDay: 26, startRule: 'thanksgiving', endMonth: 12, endDay: 1 },
  };
  const ch = chan([hp]);
  const where = (ms) => {
    const src = resolveActiveSource(ch, ms);
    const pos = computeSourcePosition(src, ms, { ignoreContentLost: true });
    return `${pos.file.path}+${Math.round(pos.offset / 60)}m`;
  };
  assert.equal(where(at(2026, 11, 26, 0, 30)), 'f0.mp4+30m');
  assert.equal(where(at(2026, 11, 26, 2, 15)), 'f2.mp4+15m', 'third file, 15 min in (3 files of 1h from midnight)');
  assert.equal(where(at(2027, 11, 25, 0, 30)), 'f0.mp4+30m');
  assert.equal(where(at(2027, 11, 25, 1, 10)), 'f1.mp4+10m');
});

test('anchorToRange on a one-day block with an hour window starts at the window hour', async () => {
  const { resolveActiveSource, computeSourcePosition } = await load('core/schedule.js');
  const day = {
    id: 'd7', priority: 20, mode: 'loop', anchor: at(2026, 12, 7, 7), anchorToRange: true, files: files(4),
    trigger: { type: 'dateRange', startMonth: 12, startDay: 7, endMonth: 12, endDay: 7, startHour: 7, endHour: 23 },
  };
  const ch = chan([day]);
  const pos = (ms) => computeSourcePosition(resolveActiveSource(ch, ms), ms, { ignoreContentLost: true });
  for (const year of [2026, 2027, 2031]) {
    const p = pos(at(year, 12, 7, 7, 0));
    assert.equal(p.file.path, 'f0.mp4', `year ${year} starts with the first file`);
    assert.equal(Math.round(p.offset), 0);
    assert.equal(pos(at(year, 12, 7, 8, 30)).file.path, 'f1.mp4');
  }
});

test('a block without anchorToRange keeps its fixed anchor', async () => {
  const { resolveActiveSource } = await load('core/schedule.js');
  const day = {
    id: 'd', priority: 20, mode: 'loop', anchor: at(2026, 12, 7, 7), files: files(4),
    trigger: { type: 'dateRange', startMonth: 12, startDay: 7, endMonth: 12, endDay: 7 },
  };
  assert.equal(resolveActiveSource(chan([day]), at(2027, 12, 7)).anchor, at(2026, 12, 7, 7));
});

test('nextBlockStartMs follows a Thanksgiving start into next year', async () => {
  const { nextBlockStartMs } = await load('core/schedule.js');
  const hp = { id: 'hp', trigger: { type: 'dateRange', startMonth: 11, startDay: 26, startRule: 'thanksgiving', endMonth: 12, endDay: 1 } };
  assert.equal(nextBlockStartMs(hp, at(2026, 10, 7)), at(2026, 11, 26, 0));
  assert.equal(nextBlockStartMs(hp, at(2026, 11, 27)), at(2027, 11, 25, 0));
});

test('dayCounter and dateBlocksOn see the Thanksgiving start', async () => {
  const { dayCounter, dateBlocksOn } = await load('core/schedule.js');
  const hp = {
    id: 'hp', priority: 10, mode: 'loop', anchor: at(2026, 11, 26), files: files(2),
    trigger: { type: 'dateRange', startMonth: 11, startDay: 26, startRule: 'thanksgiving', endMonth: 12, endDay: 1 },
  };
  const ch = chan([hp]);
  assert.equal(dayCounter('dayNumber', ch, at(2027, 11, 27)), 3); // Thanksgiving 2027 is the 25th
  assert.equal(dateBlocksOn(ch, at(2027, 11, 24)).length, 0);
  assert.equal(dateBlocksOn(ch, at(2027, 11, 25)).length, 1);
  assert.equal(dateBlocksOn(ch, at(2027, 12, 1)).length, 1);
});

test('calendar grid: six full weeks, correct first cell, day clamping', async () => {
  const g = await load('timeline/calendar-grid.js');
  const grid = g.monthGrid(2026, 11); // December 2026 starts on a Tuesday
  assert.equal(grid.length, 6);
  assert.ok(grid.every((w) => w.length === 7));
  assert.deepEqual(grid[0].map((c) => `${c.month + 1}/${c.day}`), ['11/29', '11/30', '12/1', '12/2', '12/3', '12/4', '12/5']);
  assert.equal(grid.flat().filter((c) => c.inMonth).length, 31);
  assert.deepEqual(g.shiftMonths({ year: 2026, month: 0, day: 31 }, 1), { year: 2026, month: 1, day: 28 });
  assert.deepEqual(g.shiftMonths({ year: 2026, month: 0, day: 15 }, -1), { year: 2025, month: 11, day: 15 });
  assert.deepEqual(g.shiftMonths({ year: 2026, month: 11, day: 25 }, 2), { year: 2027, month: 1, day: 25 });
  assert.deepEqual(g.shiftYears({ year: 2028, month: 1, day: 29 }, 1), { year: 2029, month: 1, day: 28 });
  assert.deepEqual(g.shiftDays({ year: 2026, month: 11, day: 31 }, 1), { year: 2027, month: 0, day: 1 });
  assert.equal(g.dateTimeToMs({ year: 2026, month: 11, day: 7 }, 20, 30), at(2026, 12, 7, 20, 30));
  assert.equal(g.hourLabel(0), '12 AM');
  assert.equal(g.hourLabel(13, 30), '1:30 PM');
});
