import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blockTitle, changedFields, clampDay, convertTrigger, dayKey, daysLabel, describeTrigger, isCalendarView, monthGrid,
  oneDayTrigger, shiftMonth, wrapStep, type CalendarBlock,
} from '../src/lib/calendar.ts';

function block(over: Partial<CalendarBlock> = {}): CalendarBlock {
  return {
    id: 'blk-1', name: '', priority: 10, mode: 'loop', folder: null, fileCount: 0, files: [], dayOverrides: {},
    trigger: { type: 'dateRange', startMonth: 12, startDay: 1, endMonth: 12, endDay: 25 },
    ...over,
  };
}

test('monthGrid lays a month out Sunday first in whole weeks', () => {
  // November 2026 starts on a Sunday and has 30 days.
  const nov = monthGrid(2026, 11);
  assert.equal(nov.length, 5);
  assert.deepEqual(nov[0], [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(nov[4], [29, 30, null, null, null, null, null]);
  // December 2026 starts on a Tuesday.
  assert.deepEqual(monthGrid(2026, 12)[0], [null, null, 1, 2, 3, 4, 5]);
  assert.ok(monthGrid(2026, 12).every((row) => row.length === 7));
});

test('shiftMonth crosses years both ways', () => {
  assert.deepEqual(shiftMonth(2026, 12, 1), { year: 2027, month: 1 });
  assert.deepEqual(shiftMonth(2026, 1, -1), { year: 2025, month: 12 });
  assert.deepEqual(shiftMonth(2026, 6, -18), { year: 2024, month: 12 });
});

test('describeTrigger matches how the box names an unnamed block', () => {
  assert.equal(describeTrigger({ type: 'dateRange', startMonth: 12, startDay: 1, endMonth: 12, endDay: 25 }), '12/1–12/25');
  assert.equal(describeTrigger({ type: 'dateRange', startMonth: 11, startDay: 22, endMonth: 12, endDay: 31, startRule: 'thanksgiving', startHour: 18, endHour: 22, days: [5] }), 'THANKSGIVING–12/31, 18:00–22:00, FR');
  assert.equal(describeTrigger({ type: 'dayOfWeek', startHour: 20, endHour: 6, days: [] }), '20:00–06:00, EVERY DAY');
  assert.equal(blockTitle(block({ name: ' Advent ' })), 'ADVENT');
  assert.equal(blockTitle(block()), '12/1–12/25');
  assert.equal(daysLabel([0, 1, 2, 3, 4, 5, 6]), 'EVERY DAY');
  assert.equal(daysLabel([3, 1]), 'MO WE');
});

test('converting a trigger keeps the hours and days that carry over', () => {
  const weekly = convertTrigger({ type: 'dateRange', startMonth: 1, startDay: 1, endMonth: 1, endDay: 2, startHour: 6, endHour: 9, days: [1] }, 'dayOfWeek', { month: 3, day: 4 });
  assert.deepEqual(weekly, { type: 'dayOfWeek', startHour: 6, endHour: 9, days: [1] });
  assert.deepEqual(convertTrigger(weekly, 'dateRange', { month: 3, day: 4 }), oneDayTrigger(3, 4));
  assert.equal(convertTrigger(weekly, 'dayOfWeek', { month: 1, day: 1 }), weekly);
});

test('small date helpers', () => {
  assert.equal(dayKey(3, 7), '03-07');
  assert.equal(clampDay(2, 31), 29);
  assert.equal(clampDay(4, 31), 30);
  assert.equal(wrapStep(23, 1, 0, 23), 0);
  assert.equal(wrapStep(1, -1, 1, 12), 12);
});

test('changedFields sends only what was edited', () => {
  const saved = block();
  assert.deepEqual(changedFields(saved, { ...saved }), {});
  const edited = { ...saved, name: 'Advent', mode: 'daily' as const, trigger: { ...saved.trigger!, endDay: 24 } as CalendarBlock['trigger'] };
  assert.deepEqual(changedFields(saved, edited), { name: 'Advent', mode: 'daily', trigger: { type: 'dateRange', startMonth: 12, startDay: 1, endMonth: 12, endDay: 24 } });
});

test('isCalendarView checks the reply shape', () => {
  assert.equal(isCalendarView({ channel: { number: 5, name: 'Rewind' }, revision: 3, blocks: [], month: null }), true);
  assert.equal(isCalendarView({ channel: { number: 5 }, blocks: [] }), false);
  assert.equal(isCalendarView([]), false);
});
