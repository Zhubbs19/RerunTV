// Pure date arithmetic for the time machine's calendar (playback/time-calendar.js).
// A "date" here is { year, month (0-11), day (1-31) } in the viewer's local time;
// nothing in this file reads the clock, so it can be tested directly.

/**
 * Counts the days in a month.
 * @param {number} year The full year.
 * @param {number} month The month, 0-11.
 * @returns {number} 28 to 31.
 */
export function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

/**
 * Pulls a day of month back inside its month.
 * @param {object} date The date.
 * @param {number} date.year The full year.
 * @param {number} date.month The month, 0-11.
 * @param {number} date.day The day of month; clamped to 1 and the month's last day.
 * @returns {object} The clamped `{ year, month, day }`.
 */
export function clampDate({ year, month, day }) {
  return { year, month, day: Math.min(Math.max(1, day), daysInMonth(year, month)) };
}

/**
 * Converts an instant to a local calendar date.
 * @param {number} ms Epoch milliseconds.
 * @returns {object} `{ year, month, day }` in local time.
 */
export function dateFromMs(ms) {
  const d = new Date(ms);
  return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate() };
}

/**
 * Tests whether two dates are the same day.
 * @param {?object} a A `{ year, month, day }` date.
 * @param {?object} b A `{ year, month, day }` date.
 * @returns {boolean} True when both are given and match.
 */
export function sameDate(a, b) {
  return !!a && !!b && a.year === b.year && a.month === b.month && a.day === b.day;
}

/**
 * Moves a date by whole days, across month and year ends.
 * @param {object} date A `{ year, month, day }` date.
 * @param {number} n Days to add; negative goes back.
 * @returns {object} The new `{ year, month, day }`.
 */
export function shiftDays(date, n) {
  const d = new Date(date.year, date.month, date.day + n);
  return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate() };
}

/**
 * Whole months, keeping the day of month where it exists (Jan 31 + 1 month = Feb 28/29).
 * @param {object} date A `{ year, month, day }` date.
 * @param {number} n Months to add; negative goes back.
 * @returns {object} The new `{ year, month, day }`.
 */
export function shiftMonths(date, n) {
  const index = date.year * 12 + date.month + n;
  return clampDate({ year: Math.floor(index / 12), month: ((index % 12) + 12) % 12, day: date.day });
}

/**
 * Moves a date by whole years, clamping Feb 29 in a non-leap year.
 * @param {object} date A `{ year, month, day }` date.
 * @param {number} n Years to add; negative goes back.
 * @returns {object} The new `{ year, month, day }`.
 */
export function shiftYears(date, n) {
  return clampDate({ year: date.year + n, month: date.month, day: date.day });
}

/**
 * Six weeks of cells for one month, so the grid never changes height. Each cell is
 * { year, month, day, inMonth }. weekStart: 0 = Sunday, 1 = Monday.
 * @param {number} year The full year.
 * @param {number} month The month, 0-11.
 * @param {number} [weekStart=0] The first weekday column.
 * @returns {Array<Array<object>>} Six rows of seven cells.
 */
export function monthGrid(year, month, weekStart = 0) {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() - weekStart + 7) % 7;
  const weeks = [];
  for (let w = 0; w < 6; w += 1) {
    const row = [];
    for (let i = 0; i < 7; i += 1) {
      const d = new Date(year, month, 1 - lead + w * 7 + i);
      row.push({ year: d.getFullYear(), month: d.getMonth(), day: d.getDate(), inMonth: d.getMonth() === month });
    }
    weeks.push(row);
  }
  return weeks;
}

/**
 * The viewed date plus a time of day, as the instant to jump to.
 * @param {object} date A `{ year, month, day }` date.
 * @param {number} [hour=0] The hour, 0-23.
 * @param {number} [minute=0] The minute.
 * @returns {number} Epoch milliseconds in local time.
 */
export function dateTimeToMs(date, hour = 0, minute = 0) {
  return new Date(date.year, date.month, date.day, hour, minute, 0, 0).getTime();
}

// Hour buttons under the calendar — prime time and the day's usual starting points.
export const TIME_PRESETS = [
  { label: '6 AM', hour: 6 },
  { label: '9 AM', hour: 9 },
  { label: 'NOON', hour: 12 },
  { label: '3 PM', hour: 15 },
  { label: '6 PM', hour: 18 },
  { label: '8 PM', hour: 20 },
  { label: '10 PM', hour: 22 },
];

/**
 * Formats an hour as a 12-hour clock label, e.g. `8 PM` or `8:30 PM`.
 * @param {number} hour The hour, 0-23.
 * @param {number} [minute=0] The minute; left out of the label when 0.
 * @returns {string} The label.
 */
export function hourLabel(hour, minute = 0) {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const mm = minute ? `:${String(minute).padStart(2, '0')}` : '';
  return `${h12}${mm} ${hour < 12 ? 'AM' : 'PM'}`;
}
