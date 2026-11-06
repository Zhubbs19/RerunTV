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

export function scrubWindow(viewedMs, current = null, halfMs = SCRUB_HALF_WINDOW_MS) {
  if (current && viewedMs >= current.from + SCRUB_RECENTER_MARGIN_MS && viewedMs <= current.to - SCRUB_RECENTER_MARGIN_MS) {
    return current;
  }
  return { from: viewedMs - halfMs, to: viewedMs + halfMs };
}

// A jump that leaves the window lands paused on a banner instead of playing.
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

// firstStepMs: GUIDE & TIME MACHINE › "First scrub step"; the later steps never get smaller.
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

function starts(programs) {
  return [...new Set((programs || []).map((p) => p.start))].sort((a, b) => a - b);
}

export function boundaryAfter(programs, atMs) {
  return starts(programs).find((s) => s > atMs + BOUNDARY_TOLERANCE_MS) ?? null;
}

export function boundaryBefore(programs, atMs) {
  const list = starts(programs).filter((s) => s < atMs - BOUNDARY_TOLERANCE_MS);
  return list.length ? list[list.length - 1] : null;
}

// The program airing at an instant, or null.
export function programAt(programs, atMs) {
  return (programs || []).find((p) => atMs >= p.start && atMs < p.end) || null;
}

// ---------- Go to… ----------
// Local-time anchors: "this morning" is 6 AM today (yesterday's, before 6 AM);
// "last Saturday 8 AM" is the most recent Saturday 8 AM that has already
// happened, which is today's when it's Saturday after 8.
export const MORNING_HOUR = 6;
export const SATURDAY_HOUR = 8;

function atLocalHour(dayMs, hour) {
  const d = new Date(dayMs);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

function addLocalDays(ms, n) {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

export function yesterdaySameTime(nowMs) {
  return addLocalDays(nowMs, -1);
}

export function thisMorning(nowMs, hour = MORNING_HOUR) {
  const today = atLocalHour(nowMs, hour);
  return today <= nowMs ? today : addLocalDays(today, -1);
}

// The most recent `weekday` (0 Sunday … 6 Saturday) at `hour` that has already happened.
export function lastSaturdayMorning(nowMs, hour = SATURDAY_HOUR, weekday = 6) {
  const d = new Date(nowMs);
  const back = (d.getDay() - weekday + 7) % 7; // days since that weekday
  let at = atLocalHour(addLocalDays(nowMs, -back), hour);
  if (at > nowMs) at = addLocalDays(at, -7);
  return at;
}

const DAY_NAMES = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
function hourText(hour) {
  return `${hour % 12 === 0 ? 12 : hour % 12} ${hour < 12 ? 'AM' : 'PM'}`;
}

// GUIDE & TIME MACHINE › TIME MACHINE settings, with their defaults: the go-to
// presets, the day picker's reach, the calendar's first weekday, the first
// scrub step, the top shuttle speed and the strip's span. Pure.
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

// The fixed targets, in menu order. programStart is the start of what's
// airing at the viewed time (null on a channel with no schedule). opts comes
// from timeMachineOptions (the presets' hours and day).
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

export function clampPicker({ dayOffset = 0, hour = 0 } = {}, range = PICKER_DAY_RANGE) {
  return {
    dayOffset: Math.max(-range, Math.min(range, Math.round(dayOffset))),
    hour: ((Math.round(hour) % 24) + 24) % 24,
  };
}

export function pickerTime(nowMs, picker, range = PICKER_DAY_RANGE) {
  const { dayOffset, hour } = clampPicker(picker, range);
  return atLocalHour(addLocalDays(nowMs, dayOffset), hour);
}

export { DAY, HOUR, MIN };
