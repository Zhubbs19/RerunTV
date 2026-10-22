// Running a channel "behind" or "ahead": a channel's schedule is a pure
// function of its anchor, so moving the anchor later by N hours makes the
// channel air what it would have aired N hours earlier (a negative N, the
// reverse). Pure helpers, shared by DUPLICATE and the bulk SHIFT action.

export const HOUR_MS = 3600000;
export const MAX_SHIFT_HOURS = 24 * 365;

// The typed hours as a finite, bounded number, or null when it isn't usable.
export function parseShiftHours(text) {
  const n = typeof text === 'number' ? text : Number(String(text == null ? '' : text).trim());
  if (!Number.isFinite(n) || n === 0 || Math.abs(n) > MAX_SHIFT_HOURS) return null;
  return n;
}

// `fallback` stands in for a channel with no anchor yet (it would be anchored
// to the moment it is first scanned).
export function shiftedAnchor(anchor, hours, fallback) {
  const base = Number.isFinite(anchor) && anchor > 0 ? anchor : fallback;
  return Math.round(base + hours * HOUR_MS);
}

export function describeShift(hours) {
  const abs = Math.abs(hours);
  const unit = abs === 1 ? 'hour' : 'hours';
  return `${abs} ${unit} ${hours > 0 ? 'behind' : 'ahead'}`;
}
