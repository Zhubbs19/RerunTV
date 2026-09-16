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

export function scrubWindow(viewedMs, current = null) {
  if (current && viewedMs >= current.from + SCRUB_RECENTER_MARGIN_MS && viewedMs <= current.to - SCRUB_RECENTER_MARGIN_MS) {
    return current;
  }
  return { from: viewedMs - SCRUB_HALF_WINDOW_MS, to: viewedMs + SCRUB_HALF_WINDOW_MS };
}

// A jump that leaves the window lands paused on a banner instead of playing.
export function isFarJump(fromMs, toMs) {
  return Math.abs(toMs - fromMs) > SCRUB_HALF_WINDOW_MS;
}

// ---------- ◀▶ hold acceleration ----------
// 10 s steps for a tap or a short hold, then 30 s, then 2 min, then whole
// programs. heldMs is how long the key has been down (UI gesture timing).
export const SCRUB_STEPS = [
  { untilMs: 1500, stepMs: 10000 },
  { untilMs: 3500, stepMs: 30000 },
  { untilMs: 6000, stepMs: 2 * MIN },
];

export function scrubStepMs(heldMs) {
  const held = Math.max(0, Number.isFinite(heldMs) ? heldMs : 0);
  const step = SCRUB_STEPS.find((s) => held < s.untilMs);
  return step ? step.stepMs : 'boundary';
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

export function thisMorning(nowMs) {
  const today = atLocalHour(nowMs, MORNING_HOUR);
  return today <= nowMs ? today : addLocalDays(today, -1);
}

export function lastSaturdayMorning(nowMs) {
  const d = new Date(nowMs);
  const back = (d.getDay() - 6 + 7) % 7; // days since Saturday
  let at = atLocalHour(addLocalDays(nowMs, -back), SATURDAY_HOUR);
  if (at > nowMs) at = addLocalDays(at, -7);
  return at;
}

// The fixed targets, in menu order. programStart is the start of what's
// airing at the viewed time (null on a channel with no schedule).
export function goToTargets(nowMs, programStart = null) {
  const targets = [{ id: 'yesterday', label: 'YESTERDAY SAME TIME', at: yesterdaySameTime(nowMs) }];
  if (Number.isFinite(programStart)) targets.push({ id: 'showStart', label: 'START OF THIS SHOW', at: programStart });
  targets.push({ id: 'morning', label: 'THIS MORNING (6 AM)', at: thisMorning(nowMs) });
  targets.push({ id: 'saturday', label: 'LAST SATURDAY 8 AM', at: lastSaturdayMorning(nowMs) });
  return targets;
}

// The day/hour picker: a day offset from the viewed day (±7) and an hour.
export const PICKER_DAY_RANGE = 7;

export function clampPicker({ dayOffset = 0, hour = 0 } = {}) {
  return {
    dayOffset: Math.max(-PICKER_DAY_RANGE, Math.min(PICKER_DAY_RANGE, Math.round(dayOffset))),
    hour: ((Math.round(hour) % 24) + 24) % 24,
  };
}

export function pickerTime(nowMs, picker) {
  const { dayOffset, hour } = clampPicker(picker);
  return atLocalHour(addLocalDays(nowMs, dayOffset), hour);
}

export { DAY, HOUR, MIN };
