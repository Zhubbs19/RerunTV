// dayCounter (core/schedule.js): the {dayNumber} / {daysLeft} dynamic-bumper counters.
process.env.TZ = 'America/New_York'; // before any Date use
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

globalThis.window = globalThis.window || { matchMedia: () => ({ matches: false }), api: {} };
const load = (name) => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', name)).href);

const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h, 0, 0, 0).getTime();
const file = { path: 'f.mp4', duration: 1200 };
const chan = (blocks = []) => ({ number: 67, name: 'X', anchor: at(2026, 1, 1), files: [file], blocks });
const dayBlock = (id, m, d, extra = {}) => ({
  id, priority: 20, mode: 'loop', anchor: at(2026, m, d, 0), files: [file],
  trigger: { type: 'dateRange', startMonth: m, startDay: d, endMonth: m, endDay: d }, ...extra,
});

test('dayNumber with a date: 1 on the day, counts up, blank before it', async () => {
  const { dayCounter } = await load('core/schedule.js');
  const ch = chan();
  assert.equal(dayCounter('dayNumber', ch, at(2026, 11, 30), 12, 1), null);
  assert.equal(dayCounter('dayNumber', ch, at(2026, 12, 1, 0), 12, 1), 1);
  assert.equal(dayCounter('dayNumber', ch, at(2026, 12, 1, 23), 12, 1), 1);
  assert.equal(dayCounter('dayNumber', ch, at(2026, 12, 7), 12, 1), 7);
  assert.equal(dayCounter('dayNumber', ch, at(2026, 12, 25), 12, 1), 25);
});

test('daysLeft with a date: counts down to 0 on the day, blank after it', async () => {
  const { dayCounter } = await load('core/schedule.js');
  const ch = chan();
  assert.equal(dayCounter('daysLeft', ch, at(2026, 12, 1), 12, 25), 24);
  assert.equal(dayCounter('daysLeft', ch, at(2026, 12, 24), 12, 25), 1);
  assert.equal(dayCounter('daysLeft', ch, at(2026, 12, 25), 12, 25), 0);
  assert.equal(dayCounter('daysLeft', ch, at(2026, 12, 26), 12, 25), null);
});

test('day counts survive a DST change inside the range', async () => {
  const { dayCounter } = await load('core/schedule.js');
  // US DST ended Nov 1, 2026 (a 25-hour day).
  assert.equal(dayCounter('dayNumber', chan(), at(2026, 11, 3), 10, 30), 5);
  assert.equal(dayCounter('daysLeft', chan(), at(2026, 10, 30), 11, 3), 4);
});

test('no date: uses the active dateRange block, including one that wraps New Year', async () => {
  const { dayCounter } = await load('core/schedule.js');
  const advent = {
    id: 'a', priority: 10, mode: 'loop', anchor: at(2026, 12, 1), files: [file],
    trigger: { type: 'dateRange', startMonth: 12, startDay: 1, endMonth: 12, endDay: 25 },
  };
  assert.equal(dayCounter('dayNumber', chan([advent]), at(2026, 12, 7)), 7);
  assert.equal(dayCounter('daysLeft', chan([advent]), at(2026, 12, 7)), 18);
  const wrap = { ...advent, trigger: { type: 'dateRange', startMonth: 12, startDay: 20, endMonth: 1, endDay: 5 } };
  assert.equal(dayCounter('dayNumber', chan([wrap]), at(2027, 1, 2)), 14);
  assert.equal(dayCounter('daysLeft', chan([wrap]), at(2027, 1, 2)), 3);
  // Outside any block, or with a non-dateRange block, there is nothing to count.
  assert.equal(dayCounter('dayNumber', chan([advent]), at(2026, 12, 28)), null);
  assert.equal(dayCounter('dayNumber', chan(), at(2026, 12, 7)), null);
});

test('a run of one-day blocks needs the explicit date (each block is only day 1)', async () => {
  const { dayCounter } = await load('core/schedule.js');
  const ch = chan([dayBlock('d12', 12, 12), dayBlock('d13', 12, 13)]);
  assert.equal(dayCounter('dayNumber', ch, at(2026, 12, 13)), 1);
  assert.equal(dayCounter('dayNumber', ch, at(2026, 12, 13), 12, 1), 13);
});

test('fillDayCounters fills the tokens and blanks them outside the range', async () => {
  const { fillDayCounters } = await load('core/schedule.js');
  const ch = chan();
  assert.equal(fillDayCounters('DAY {dayNumber:12/1} OF 25 · {daysLeft:12/25} TO GO', ch, at(2026, 12, 14)), 'DAY 14 OF 25 · 11 TO GO');
  assert.equal(fillDayCounters('DAY {dayNumber:12/1} OF 25', ch, at(2026, 11, 20)), 'DAY  OF 25');
  assert.equal(fillDayCounters('{daysLeft:12/25} DAYS', ch, at(2026, 12, 26)), ' DAYS');
  assert.equal(fillDayCounters('NO TOKENS {channel}', ch, at(2026, 12, 14)), 'NO TOKENS {channel}');
  const advent = {
    id: 'a', priority: 10, mode: 'loop', anchor: at(2026, 12, 1), files: [file],
    trigger: { type: 'dateRange', startMonth: 12, startDay: 1, endMonth: 12, endDay: 25 },
  };
  assert.equal(fillDayCounters('DAY {dayNumber}, {daysLeft} LEFT', chan([advent]), at(2026, 12, 10)), 'DAY 10, 15 LEFT');
});
