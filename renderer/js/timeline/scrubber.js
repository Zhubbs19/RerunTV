// The time machine's scrubber and "Go to…" targets, the DOM-free half
// (docs/design/11 §3). Everything here is a pure function of timestamps and
// schedule entries; timemachine.js draws the strip and moves S.timeOffsetMs.
// Callers pass "now" in — viewNow() for anything schedule-relative, per the
// invariant in CLAUDE.md.

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ---------- Window ----------
// ±3 h around the viewed time. The window stays put while the viewed time is
// comfortably inside it (so the strip doesn't slide under the marker on every
// step), and re-centres once the marker gets within 30 minutes of an edge.
export const SCRUB_HALF_WINDOW_MS = 3 * HOUR;
export const SCRUB_RECENTER_MARGIN_MS = 30 * MIN;

/**
 * Picks the scrubber's visible window for the viewed time, keeping the current one while the time is well inside it.
 * @param {number} viewedMs The viewed time (ms).
 * @param {?object} [current=null] The current window, `{ from, to }`.
 * @param {number} [halfMs=SCRUB_HALF_WINDOW_MS] Half the window's span (GUIDE & TIME MACHINE's strip span).
 * @returns {object} The window, `{ from, to }`.
 */
export function scrubWindow(viewedMs, current = null, halfMs = SCRUB_HALF_WINDOW_MS) {
  if (current && viewedMs >= current.from + SCRUB_RECENTER_MARGIN_MS && viewedMs <= current.to - SCRUB_RECENTER_MARGIN_MS) {
    return current;
  }
  return { from: viewedMs - halfMs, to: viewedMs + halfMs };
}

/**
 * A jump that leaves the window lands paused on a banner instead of playing.
 * @param {number} fromMs Where the jump starts (ms).
 * @param {number} toMs Where it lands (ms).
 * @param {number} [halfMs=SCRUB_HALF_WINDOW_MS] Half the window's span.
 * @returns {boolean} True when the jump is longer than half the window.
 */
export function isFarJump(fromMs, toMs, halfMs = SCRUB_HALF_WINDOW_MS) {
  return Math.abs(toMs - fromMs) > halfMs;
}

// ---------- ◀▶ hold acceleration ----------
// 10 s steps for a tap or a short hold, then 30 s, then 2 min, then whole
// programs. heldMs is how long the key has been down (UI gesture timing).
export const SCRUB_STEPS = [
  { untilMs: 1500, stepMs: 10000 },
  { untilMs: 3500, stepMs: 30000 },
  { untilMs: 6000, stepMs: 2 * MIN },
];

/**
 * Picks the scrub step for how long ◀▶ has been held.
 * @param {number} heldMs How long the key has been down.
 * @param {number} [firstStepMs=SCRUB_STEPS[0].stepMs] GUIDE & TIME MACHINE › "First scrub step";
 *   the later steps never get smaller.
 * @returns {number|string} A step in ms, or `'boundary'` to jump a whole program.
 */
export function scrubStepMs(heldMs, firstStepMs = SCRUB_STEPS[0].stepMs) {
  const held = Math.max(0, Number.isFinite(heldMs) ? heldMs : 0);
  const i = SCRUB_STEPS.findIndex((s) => held < s.untilMs);
  if (i < 0) return 'boundary';
  return i === 0 ? firstStepMs : Math.max(firstStepMs, SCRUB_STEPS[i].stepMs);
}

// ---------- ▲▼ program boundaries ----------
// A press at (or within a couple of seconds after) a program's start goes to
// the previous one, the way "previous chapter" does in a player.
export const BOUNDARY_TOLERANCE_MS = 2000;

/**
 * Lists the distinct program start times.
 * @param {?Array<object>} programs Schedule entries with `start`.
 * @returns {number[]} Start times, ascending.
 */
function starts(programs) {
  return [...new Set((programs || []).map((p) => p.start))].sort((a, b) => a - b);
}

/**
 * Finds the next program start after an instant, past the tolerance.
 * @param {?Array<object>} programs Schedule entries with `start`.
 * @param {number} atMs The instant (ms).
 * @returns {?number} The start time, or null.
 */
export function boundaryAfter(programs, atMs) {
  return starts(programs).find((s) => s > atMs + BOUNDARY_TOLERANCE_MS) ?? null;
}

/**
 * Finds the previous program start before an instant; a press just after a start goes to the one before it.
 * @param {?Array<object>} programs Schedule entries with `start`.
 * @param {number} atMs The instant (ms).
 * @returns {?number} The start time, or null.
 */
export function boundaryBefore(programs, atMs) {
  const list = starts(programs).filter((s) => s < atMs - BOUNDARY_TOLERANCE_MS);
  return list.length ? list[list.length - 1] : null;
}

/**
 * The program airing at an instant, or null.
 * @param {?Array<object>} programs Schedule entries with `start` and `end`.
 * @param {number} atMs The instant (ms).
 * @returns {?object} The entry, or null.
 */
export function programAt(programs, atMs) {
  return (programs || []).find((p) => atMs >= p.start && atMs < p.end) || null;
}

// ---------- Go to… ----------
// Local-time anchors: "this morning" is 6 AM today (yesterday's, before 6 AM);
// "last Saturday 8 AM" is the most recent Saturday 8 AM that has already
// happened, which is today's when it's Saturday after 8.
export const MORNING_HOUR = 6;
export const SATURDAY_HOUR = 8;

/**
 * Sets an instant to a whole local hour on the same day.
 * @param {number} dayMs Any time on the day (ms).
 * @param {number} hour The hour, 0-23.
 * @returns {number} The instant (ms).
 */
function atLocalHour(dayMs, hour) {
  const d = new Date(dayMs);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

/**
 * Adds local calendar days, keeping the clock time across DST changes.
 * @param {number} ms The instant (ms).
 * @param {number} n Days to add; negative goes back.
 * @returns {number} The new instant (ms).
 */
function addLocalDays(ms, n) {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

/**
 * Gets the same clock time a day earlier.
 * @param {number} nowMs The viewed time (ms).
 * @returns {number} The target (ms).
 */
export function yesterdaySameTime(nowMs) {
  return addLocalDays(nowMs, -1);
}

/**
 * Gets the morning hour today (6 AM unless set), or yesterday's before that hour.
 * @param {number} nowMs The viewed time (ms).
 * @param {number} [hour=MORNING_HOUR] The morning hour, 0-23.
 * @returns {number} The target (ms).
 */
export function thisMorning(nowMs, hour = MORNING_HOUR) {
  const today = atLocalHour(nowMs, hour);
  return today <= nowMs ? today : addLocalDays(today, -1);
}

/**
 * Gets the most recent `weekday` (0 Sunday … 6 Saturday) at `hour` that has already happened
 * (Saturday 8 AM unless set).
 * @param {number} nowMs The viewed time (ms).
 * @param {number} [hour=SATURDAY_HOUR] The hour, 0-23.
 * @param {number} [weekday=6] The weekday, 0 Sunday … 6 Saturday.
 * @returns {number} The target (ms).
 */
export function lastSaturdayMorning(nowMs, hour = SATURDAY_HOUR, weekday = 6) {
  const d = new Date(nowMs);
  const back = (d.getDay() - weekday + 7) % 7; // days since that weekday
  let at = atLocalHour(addLocalDays(nowMs, -back), hour);
  if (at > nowMs) at = addLocalDays(at, -7);
  return at;
}

const DAY_NAMES = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
/**
 * A whole hour as "6 AM" / "12 PM", for the go-to labels.
 * @param {number} hour The hour, 0-23.
 * @returns {string} The label.
 */
function hourText(hour) {
  return `${hour % 12 === 0 ? 12 : hour % 12} ${hour < 12 ? 'AM' : 'PM'}`;
}

/**
 * GUIDE & TIME MACHINE › TIME MACHINE settings, with their defaults: the go-to
 * presets, the day picker's reach, the calendar's first weekday, the first
 * scrub step, the top shuttle speed and the strip's span. Pure.
 * @param {?object} config The app config.
 * @returns {object} The options (`morningHour`, `weekendDay`, `weekendHour`, `pickerDays`,
 *   `weekStart`, `firstStepMs`, `maxShuttle`, `halfWindowMs`), each clamped to its range.
 */
export function timeMachineOptions(config) {
  const tm = (config && config.timeMachine) || {};
  const num = (v, def, lo, hi) => { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
  return {
    morningHour: num(tm.morningHour, MORNING_HOUR, 0, 23),
    weekendDay: num(tm.weekendDay, 6, 0, 6),
    weekendHour: num(tm.weekendHour, SATURDAY_HOUR, 0, 23),
    pickerDays: num(tm.pickerDays, PICKER_DAY_RANGE, 1, 30),
    weekStart: tm.weekStart === 'mon' ? 1 : 0,
    firstStepMs: num(tm.scrubStepSeconds, 10, 1, 60) * 1000,
    maxShuttle: num(tm.maxShuttle, 7200, 60, 7200),
    halfWindowMs: num(tm.scrubberHours, 3, 1, 12) * HOUR,
  };
}

/**
 * The fixed targets, in menu order. programStart is the start of what's
 * airing at the viewed time (null on a channel with no schedule).
 * @param {number} nowMs The viewed time (ms).
 * @param {?number} [programStart=null] Start of the program airing then.
 * @param {object} [opts={}] From timeMachineOptions (the presets' hours and day): `morningHour`,
 *   `weekendDay`, `weekendHour`.
 * @returns {Array<object>} Targets as `{ id, label, at }`.
 */
export function goToTargets(nowMs, programStart = null, opts = {}) {
  const morning = opts.morningHour ?? MORNING_HOUR;
  const day = opts.weekendDay ?? 6;
  const hour = opts.weekendHour ?? SATURDAY_HOUR;
  const targets = [{ id: 'yesterday', label: 'YESTERDAY SAME TIME', at: yesterdaySameTime(nowMs) }];
  if (Number.isFinite(programStart)) targets.push({ id: 'showStart', label: 'START OF THIS SHOW', at: programStart });
  targets.push({ id: 'morning', label: `THIS MORNING (${hourText(morning)})`, at: thisMorning(nowMs, morning) });
  targets.push({ id: 'saturday', label: `LAST ${DAY_NAMES[day]} ${hourText(hour)}`, at: lastSaturdayMorning(nowMs, hour, day) });
  return targets;
}

// The day/hour picker: a day offset from the viewed day (±7 unless set) and an hour.
export const PICKER_DAY_RANGE = 7;

/**
 * Clamps the day/hour picker to ±`range` days and wraps the hour into 0-23.
 * @param {object} [picker] The picker state.
 * @param {number} [picker.dayOffset=0] Days from the viewed day.
 * @param {number} [picker.hour=0] The hour.
 * @param {number} [range=PICKER_DAY_RANGE] How many days either way the picker reaches.
 * @returns {object} The clamped `{ dayOffset, hour }`.
 */
export function clampPicker({ dayOffset = 0, hour = 0 } = {}, range = PICKER_DAY_RANGE) {
  return {
    dayOffset: Math.max(-range, Math.min(range, Math.round(dayOffset))),
    hour: ((Math.round(hour) % 24) + 24) % 24,
  };
}

/**
 * Turns the picker into an instant: the viewed day plus the offset, at the hour.
 * @param {number} nowMs The viewed time (ms).
 * @param {object} picker The picker state, `{ dayOffset, hour }`.
 * @param {number} [range=PICKER_DAY_RANGE] How many days either way the picker reaches.
 * @returns {number} The target (ms).
 */
export function pickerTime(nowMs, picker, range = PICKER_DAY_RANGE) {
  const { dayOffset, hour } = clampPicker(picker, range);
  return atLocalHour(addLocalDays(nowMs, dayOffset), hour);
}

export { DAY, HOUR, MIN };
