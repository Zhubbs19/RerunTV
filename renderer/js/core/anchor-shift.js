// Running a channel "behind" or "ahead": a channel's schedule is a pure
// function of its anchor, so moving the anchor later by N hours makes the
// channel air what it would have aired N hours earlier (a negative N, the
// reverse). Pure helpers, shared by DUPLICATE and the bulk SHIFT action.

export const HOUR_MS = 3600000;
export const MAX_SHIFT_HOURS = 24 * 365;

/**
 * The typed hours as a finite, bounded number, or null when it isn't usable.
 * @param {string|number} text The typed hours.
 * @returns {?number} The hours, or null for zero, a non-number or more than a year.
 */
export function parseShiftHours(text) {
  const n = typeof text === 'number' ? text : Number(String(text == null ? '' : text).trim());
  if (!Number.isFinite(n) || n === 0 || Math.abs(n) > MAX_SHIFT_HOURS) return null;
  return n;
}

/**
 * Moves a channel anchor by a number of hours.
 * `fallback` stands in for a channel with no anchor yet (it would be anchored
 * to the moment it is first scanned).
 * @param {number} anchor The channel's anchor, epoch milliseconds.
 * @param {number} hours Hours to shift; positive runs the channel behind.
 * @param {number} fallback The anchor to use when the channel has none.
 * @returns {number} The new anchor, epoch milliseconds.
 */
export function shiftedAnchor(anchor, hours, fallback) {
  const base = Number.isFinite(anchor) && anchor > 0 ? anchor : fallback;
  return Math.round(base + hours * HOUR_MS);
}

/**
 * Describes a shift in words, such as '3 hours behind'.
 * @param {number} hours The shift in hours; positive is behind.
 * @returns {string} The description.
 */
export function describeShift(hours) {
  const abs = Math.abs(hours);
  const unit = abs === 1 ? 'hour' : 'hours';
  return `${abs} ${unit} ${hours > 0 ? 'behind' : 'ahead'}`;
}
