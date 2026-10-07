// Pure date arithmetic for the time machine's calendar (playback/time-calendar.js).
// A "date" here is { year, month (0-11), day (1-31) } in the viewer's local time;
// nothing in this file reads the clock, so it can be tested directly.

export function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

export function clampDate({ year, month, day }) {
  return { year, month, day: Math.min(Math.max(1, day), daysInMonth(year, month)) };
}

export function dateFromMs(ms) {
  const d = new Date(ms);
  return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate() };
}

export function sameDate(a, b) {
  return !!a && !!b && a.year === b.year && a.month === b.month && a.day === b.day;
}

export function shiftDays(date, n) {
  const d = new Date(date.year, date.month, date.day + n);
  return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate() };
}

// Whole months, keeping the day of month where it exists (Jan 31 + 1 month = Feb 28/29).
export function shiftMonths(date, n) {
  const index = date.year * 12 + date.month + n;
  return clampDate({ year: Math.floor(index / 12), month: ((index % 12) + 12) % 12, day: date.day });
}

export function shiftYears(date, n) {
  return clampDate({ year: date.year + n, month: date.month, day: date.day });
}

// Six weeks of cells for one month, so the grid never changes height. Each cell is
// { year, month, day, inMonth }. weekStart: 0 = Sunday, 1 = Monday.
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

// The viewed date plus a time of day, as the instant to jump to.
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

export function hourLabel(hour, minute = 0) {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const mm = minute ? `:${String(minute).padStart(2, '0')}` : '';
  return `${h12}${mm} ${hour < 12 ? 'AM' : 'PM'}`;
}
