import { S, viewNow } from './state.js';

const DAY_MS = 86400000;
const DAILY_SAFETY_CAP = 400;

// Exported for the setup screen's broadcast-hours UI/preview and for
// isWithinBroadcastHours below — same wrap-safe (s > e means "wraps
// midnight") hour-range check every trigger already uses internally.
export function hourInRange(hour, t) {
  const s = t.startHour, e = t.endHour;
  if (s === e) return true; // full-day block
  if (s < e) return hour >= s && hour < e;
  return hour >= s || hour < e; // wraps midnight
}

// A dayOfWeek trigger matches a moment if its hour range matches AND (when
// it carries a day-of-week filter) today is one of those days. `t.days`
// unset/empty means "every day" — the backward-compatible default so every
// block saved before the weekly grid existed keeps behaving exactly as it did.
function matchesDayOfWeek(atMs, t) {
  const d = new Date(atMs);
  if (t.days && t.days.length && !t.days.includes(d.getDay())) return false;
  return hourInRange(d.getHours(), t);
}

// Calendar-date range check (month/day only, year-independent), mirroring
// hourInRange's midnight-wrap trick but across the calendar year — so a
// range like Dec 20 -> Jan 5 works. 2001 is just a fixed non-leap reference
// year used purely for ordering month/day pairs.
function dateKey(month, day) {
  return new Date(2001, month - 1, day).getTime();
}
function inDateRange(atMs, t) {
  const d = new Date(atMs);
  const cur = dateKey(d.getMonth() + 1, d.getDate());
  const start = dateKey(t.startMonth, t.startDay);
  const end = dateKey(t.endMonth, t.endDay);
  return start <= end ? (cur >= start && cur <= end) : (cur >= start || cur <= end);
}

// A dateRange trigger can optionally *also* narrow to specific hours and/or
// days of week — layered on top of the date match as an AND, e.g. "25 Days
// of Christmas, but only 6-10pm" or "every Friday in October" (a Halloween
// movie night). Reuses the exact same `days`/`startHour`/`endHour` fields
// and hourInRange/day-filter logic dayOfWeek triggers already use — this
// isn't a new trigger shape, just those fields being optionally present on
// a dateRange trigger too. Unset (the default, and every block saved before
// this existed) means "no narrowing," so this is purely additive.
function matchesDateRangeNarrowing(atMs, t) {
  const d = new Date(atMs);
  if (t.days && t.days.length && !t.days.includes(d.getDay())) return false;
  if (t.startHour != null && t.endHour != null && !hourInRange(d.getHours(), t)) return false;
  return true;
}

// Exported so the setup screen can flag a block that matches its trigger
// right now but has no content (see blockHasContent/matchingBlocksIncludingEmpty
// in setup-schedule.js) — matchingBlocks below filters those out entirely,
// which is correct for playback but would hide the "this block exists but
// will never air" case from the calendar/timeline views too.
export function matchesTrigger(atMs, block) {
  const t = block.trigger;
  if (!t) return false;
  if (t.type === 'dateRange') return inDateRange(atMs, t) && matchesDateRangeNarrowing(atMs, t);
  return matchesDayOfWeek(atMs, t);
}

// ch.blocks[] entries whose trigger matches `atMs` and which actually carry
// content, ranked highest-priority-first (ties broken by array order) —
// the candidate order resolveActiveSource walks looking for a usable source.
// Exported (in addition to being used internally) so the setup screen's
// per-channel calendar can flag days where more than one block's trigger
// overlaps, not just show the single winner resolveActiveSource picks.
export function matchingBlocks(ch, atMs) {
  return (ch.blocks || [])
    .map((b, idx) => ({ b, idx }))
    .filter(({ b }) => b.files && b.files.length > 0 && matchesTrigger(atMs, b))
    .sort((x, y) => (y.b.priority || 0) - (x.b.priority || 0) || x.idx - y.idx)
    .map(({ b }) => b);
}

// Exported so the setup screen's calendar can read/write the same
// per-day dayOverrides key a daily/weekly block already uses internally,
// without duplicating the "MM-DD" formatting rule in two places.
export function mdKey(dateMs) {
  const d = new Date(dateMs);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function startOfLocalDay(dateMs) {
  const d = new Date(dateMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Local timestamp of the actual calendar date (this cycle, handling a range
// that wraps New Year like Dec 20 -> Jan 5) that a dateRange trigger's
// `start` falls on — i.e. "day 0" for daily/weekly mode's day-index.
function cycleStartMs(dayStartMs, t) {
  const d = new Date(dayStartMs);
  const year = d.getFullYear();
  const startThisYear = new Date(year, t.startMonth - 1, t.startDay, 0, 0, 0, 0).getTime();
  const endThisYear = new Date(year, t.endMonth - 1, t.endDay, 0, 0, 0, 0).getTime();
  if (startThisYear <= endThisYear) return startThisYear; // non-wrapping range
  const curKey = dateKey(d.getMonth() + 1, d.getDate());
  const startKey = dateKey(t.startMonth, t.startDay);
  return curKey >= startKey ? startThisYear : new Date(year - 1, t.startMonth - 1, t.startDay, 0, 0, 0, 0).getTime();
}

// Exported for the promo/leadDays bumper (interstitials.js's
// eligiblePromoEntries) — the next upcoming instant a dateRange block's own
// range begins, purely forward-looking (unlike cycleStartMs above, which
// finds the cycle *containing* a given day, including a cycle that already
// started). If fromMs is already inside or past this year's occurrence,
// rolls to next year's — a promo naturally shouldn't fire once the thing
// it's promoting has already started airing (resolveActiveSource would
// already be showing the block itself by then).
export function nextBlockStartMs(block, fromMs) {
  const t = block.trigger;
  if (t.type !== 'dateRange') return Infinity;
  const d = new Date(fromMs);
  const year = d.getFullYear();
  const startThisYear = new Date(year, t.startMonth - 1, t.startDay, 0, 0, 0, 0).getTime();
  if (fromMs <= startThisYear) return startThisYear;
  return new Date(year + 1, t.startMonth - 1, t.startDay, 0, 0, 0, 0).getTime();
}

function isLastDayOfRange(dayStartMs, t) {
  const d = new Date(dayStartMs);
  return dateKey(d.getMonth() + 1, d.getDate()) === dateKey(t.endMonth, t.endDay);
}

// Local timestamp a given day unlocks at — that day's own
// dayOverrides[key].unlockTime ("HH:MM") if set, else midnight.
function unlockMsFor(block, dayStartMs) {
  const ov = block.dayOverrides && block.dayOverrides[mdKey(dayStartMs)];
  if (!ov || !ov.unlockTime) return dayStartMs;
  const [h, m] = ov.unlockTime.split(':').map(Number);
  const d = new Date(dayStartMs);
  d.setHours(h || 0, m || 0, 0, 0);
  return d.getTime();
}

// Which single file (or, on the block's finale day, a signal to marathon
// the whole folder) is "current" for a given local day within a
// daily/weekly block — walking backward through `skip` blackout days so the
// previous day's item stays current. Returns null once it walks back before
// the block's own start (caller falls through to the next candidate/default).
function resolveDayContent(block, dayStartMs, safety) {
  if (safety <= 0) return null;
  const t = block.trigger;
  if (dayStartMs < cycleStartMs(dayStartMs, t)) return null;
  const ov = block.dayOverrides && block.dayOverrides[mdKey(dayStartMs)];
  if (ov && ov.skip) return resolveDayContent(block, dayStartMs - DAY_MS, safety - 1);
  if (block.finale && isLastDayOfRange(dayStartMs, t)) {
    return { finale: true };
  }
  if (ov && ov.file) {
    const pinned = block.files.find((f) => f.path === ov.file);
    if (pinned) return { file: ov.title ? { ...pinned, title: ov.title } : pinned };
  }
  const stepDays = block.mode === 'weekly' ? 7 : 1;
  const dayIndex = Math.floor(Math.round((dayStartMs - cycleStartMs(dayStartMs, t)) / DAY_MS) / stepDays);
  const base = block.files[dayIndex % block.files.length];
  return { file: ov && ov.title ? { ...base, title: ov.title } : base };
}

// Resolves a daily/weekly-mode block to the same {files, anchor, key} shape
// computeSourcePosition already understands: a single "today's" file (or,
// on a finale day, the whole block folder) looping against its unlock
// instant — so no new position math is needed, only new source selection.
// Returns null if there's nothing to show yet (walked back past the
// block's own start), so resolveActiveSource tries the next candidate.
function resolveDailySource(block, atMs) {
  const today = startOfLocalDay(atMs);
  const effectiveDay = atMs < unlockMsFor(block, today) ? today - DAY_MS : today;
  const content = resolveDayContent(block, effectiveDay, DAILY_SAFETY_CAP);
  if (!content) return null;
  if (content.finale) {
    return { files: block.files, anchor: effectiveDay, key: `${block.id}-finale`, block };
  }
  return {
    files: [content.file], anchor: unlockMsFor(block, effectiveDay),
    key: `${block.id}-${mdKey(effectiveDay)}`, block,
  };
}

// The calendar day a dayOfWeek trigger's current occurrence "belongs to" —
// normally just atMs's own local day, but for a midnight-wrapping hour range
// (e.g. 22-2) the post-midnight tail (hour < startHour) still belongs to the
// occurrence that started the evening before, so weekly-occurrence counting
// doesn't see it as a separate, discontinuous day.
function occurrenceDayFor(atMs, t) {
  const d = new Date(atMs);
  const today = startOfLocalDay(atMs);
  if (t.startHour > t.endHour && d.getHours() < t.startHour) return today - DAY_MS;
  return today;
}

// Next (or same-day) local-midnight timestamp on which `weekday` (0=Sun..
// 6=Sat) falls, on or after dateMs — so a block's first real occurrence
// (the first time its day/hour trigger actually matches after creation)
// lands at occurrence index 0, not some earlier date the block never aired.
function alignToWeekday(dateMs, weekday) {
  const d = new Date(dateMs);
  const diff = (weekday - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Weekly-rotation mode for a standing dayOfWeek block (e.g. every Friday
// 8-10pm) — a different file from the block's folder each week instead of
// looping the whole folder, the "Disney Channel Movie" pattern. Mirrors
// resolveDailySource's shape (one file, anchored to when this occurrence's
// window opened) but keyed by weekly occurrence count instead of calendar
// date, since a dayOfWeek trigger has no calendar "day 1" of its own — the
// block's own `anchor` (set when its folder was assigned) stands in for
// that, aligned to the trigger's weekday so occurrence counting starts from
// a real occurrence of that day rather than an arbitrary scan date. Only
// meaningful (and only offered in the setup UI) for a trigger with exactly
// one day selected — a multi-day trigger has no single "once a week" cadence
// to rotate against. Returns null if there's nothing to show yet (the
// current occurrence is before the block's own first occurrence), mirroring
// resolveDailySource's same null-on-not-started-yet contract.
function resolveWeeklyOccurrenceSource(block, atMs) {
  const t = block.trigger;
  const weekday = t.days[0];
  // Falls back to atMs (not Date.now()) for a block missing its anchor —
  // keeps this consistent with the viewNow() discipline (time-machine scrubs
  // would otherwise resolve against real wall time) and, since atMs tracks
  // the query instant itself, resolves deterministically to occurrence 0
  // every call instead of drifting with whatever moment Date.now() happened
  // to be evaluated at.
  const anchorMs = block.anchor || atMs;
  const alignedAnchorDay = alignToWeekday(anchorMs, weekday);
  const occurrenceDay = occurrenceDayFor(atMs, t);
  const occurrenceIndex = Math.round((occurrenceDay - alignedAnchorDay) / (7 * DAY_MS));
  if (occurrenceIndex < 0 || !block.files.length) return null;
  const file = block.files[occurrenceIndex % block.files.length];
  const windowStart = new Date(occurrenceDay);
  windowStart.setHours(t.startHour, 0, 0, 0);
  return { files: [file], anchor: windowStart.getTime(), key: `${block.id}-w${occurrenceIndex}`, block };
}

// Which file list + anchor is broadcasting on this channel at a given
// moment: highest-priority matching block wins (daily/weekly dateRange
// blocks resolve via resolveDailySource, weekly-mode dayOfWeek blocks via
// resolveWeeklyOccurrenceSource, instead of playing their folder straight
// through), else the channel's default folder.
export function resolveActiveSource(ch, atMs) {
  const candidates = matchingBlocks(ch, atMs);
  for (let i = 0; i < candidates.length; i++) {
    const b = candidates[i];
    if (b.trigger.type === 'dateRange' && (b.mode === 'daily' || b.mode === 'weekly')) {
      const daily = resolveDailySource(b, atMs);
      if (daily) return daily;
      continue; // walked back past this block's own start — try the next candidate
    }
    if (b.trigger.type === 'dayOfWeek' && b.mode === 'weekly' && b.trigger.days && b.trigger.days.length === 1) {
      const weekly = resolveWeeklyOccurrenceSource(b, atMs);
      if (weekly) return weekly;
      continue;
    }
    return { files: b.files, anchor: b.anchor, key: b.id, block: b };
  }
  return { files: ch.files, anchor: ch.anchor, key: -1, block: null };
}

// Next wall-clock instant where the channel's active source changes, or
// Infinity if it never does within the scan window. For a daily/weekly
// block (outside its finale day) this is computed exactly — the next
// unlock instant — rather than scanned, so a custom (non-hour-aligned)
// unlockTime retunes at the right minute instead of drifting up to an hour
// late. Everything else falls back to an hourly scan up to 35 days ahead: a
// day-of-week-scoped block can be up to a week out, and a date-range block
// can be much further (e.g. checked from Nov 1 for a Dec 1 start) — 35 days
// covers "coming up soon" while staying cheap (840 hourly steps). Anything
// further out isn't wrong, it just won't self-correct proactively until the
// next tune/retune brings it into this window.
const BOUNDARY_SCAN_HOURS = 24 * 35;

// capMs (optional): a caller that only cares whether a boundary falls
// before some known instant — getChannelSchedule below is the main one,
// which immediately clamps this function's return value to its own
// windowEnd via Math.min() either way — can pass that instant here so the
// scan itself stops there too, instead of always walking up to the full
// 35-day/840-hour range only to have most of that precision thrown away by
// the caller's own clamp a moment later. Returning Infinity for "nothing
// found before capMs" produces the exact same Math.min(boundary, windowEnd)
// result a full scan would have, since a true boundary beyond windowEnd
// clamps to windowEnd either way — this is a pure performance change, the
// visible result for that caller is identical. Omit capMs for the original
// "give me the real next boundary" behavior (e.g. arming a retune timer).
export function nextSourceBoundary(ch, fromMs, capMs) {
  if (!ch.blocks || ch.blocks.length === 0) return Infinity;
  const from = resolveActiveSource(ch, fromMs);
  const b = from.block;
  const isDailyRollover = b && b.trigger.type === 'dateRange' && (b.mode === 'daily' || b.mode === 'weekly') &&
    !from.key.endsWith('-finale');
  if (isDailyRollover) {
    const today = startOfLocalDay(fromMs);
    const todayUnlock = unlockMsFor(b, today);
    const t = b.trigger;
    // An hour-window narrowing (see matchesDateRangeNarrowing) also cuts the
    // day off early, at endHour, not just at the next day's unlock — same
    // "same-day window only" assumption an advent-mode block's daily airtime
    // already makes elsewhere (no midnight-wrap support here).
    if (t.startHour != null && t.endHour != null) {
      const windowEnd = new Date(today);
      windowEnd.setHours(t.endHour, 0, 0, 0);
      if (fromMs < todayUnlock) return todayUnlock;
      if (fromMs < windowEnd.getTime()) return windowEnd.getTime();
    }
    return fromMs < todayUnlock ? todayUnlock : unlockMsFor(b, today + DAY_MS);
  }
  const d = new Date(fromMs);
  d.setMinutes(0, 0, 0);
  for (let i = 1; i <= BOUNDARY_SCAN_HOURS; i++) {
    const hourStart = d.getTime() + i * 3600000;
    if (capMs != null && hourStart > capMs) return Infinity;
    if (resolveActiveSource(ch, hourStart).key !== from.key) return hourStart;
  }
  return Infinity;
}

// A channel's broadcast day — outside these hours it goes off the air
// entirely (a sign-off card, see showSignOffCard in playback.js) rather
// than playing content, independent of blocks/default folder. Disabled
// (the default, and every channel before this existed) means "broadcasts
// around the clock," so this is purely additive.
export function isWithinBroadcastHours(ch, atMs) {
  const bh = ch.broadcastHours;
  if (!bh || !bh.enabled) return true;
  return hourInRange(new Date(atMs).getHours(), bh);
}

// Next wall-clock instant the broadcast-hours gate flips (sign-on or
// sign-off) — same hourly-scan shape as nextCommercialsBoundary, since a
// wrap-safe hour window has no single fast-path formula worth special-casing
// the way a daily/weekly block's calendar-date rollover does.
export function nextBroadcastHoursBoundary(ch, fromMs) {
  const bh = ch.broadcastHours;
  if (!bh || !bh.enabled) return Infinity;
  const fromState = isWithinBroadcastHours(ch, fromMs);
  const d = new Date(fromMs);
  d.setMinutes(0, 0, 0);
  for (let i = 1; i <= BOUNDARY_SCAN_HOURS; i++) {
    const hourStart = d.getTime() + i * 3600000;
    if (isWithinBroadcastHours(ch, hourStart) !== fromState) return hourStart;
  }
  return Infinity;
}

// Backward counterpart of nextBroadcastHoursBoundary — the most recent
// instant at/before fromMs where the gate flipped *into* fromMs's current
// state. Needed for the sign-on bumper (interstitials.js): a few seconds
// after sign-on, the channel is already back "within broadcast hours," so
// the forward-only function above can't find the boundary just crossed —
// this one looks the other direction for exactly that case. -Infinity (not
// found within the scan window) mirrors nextBroadcastHoursBoundary's
// Infinity sentinel, both meant to be checked with isFinite().
export function prevBroadcastHoursBoundary(ch, fromMs) {
  const bh = ch.broadcastHours;
  if (!bh || !bh.enabled) return -Infinity;
  const fromState = isWithinBroadcastHours(ch, fromMs);
  const d = new Date(fromMs);
  d.setMinutes(0, 0, 0);
  let hourStart = d.getTime();
  for (let i = 0; i <= BOUNDARY_SCAN_HOURS; i++) {
    const prevHourStart = hourStart - 3600000;
    if (isWithinBroadcastHours(ch, prevHourStart) !== fromState) return hourStart;
    hourStart = prevHourStart;
  }
  return -Infinity;
}

// Which commercials config applies to a channel at a given moment. A tagged
// ad preset (S.config.interstitials.presets — setup-interstitials.js's AD
// PRESETS panel) wins over everything else whenever the content airing right
// now (fileTags, passed in by the caller — resolveBreakAt already computes
// this) carries one of the preset's contentTags: presets exist precisely to
// give a specific *show* its own break structure (a 30-min cartoon's 2-episode
// pod layout, a 2-hour movie's spread-out breaks) regardless of which
// channel/block it happens to be airing on. Falling short of a preset match,
// falls back to the highest-priority block that both matches its trigger
// right now AND carries its own `commercials` override, else the channel's
// default. Deliberately independent of resolveActiveSource for the
// block/channel fallback — a block can override ad settings for its hours
// without also overriding content (a "quiet hours" block with no folder).
// Memoized on (channel, exact atMs, fileTags) — this function is pure given
// those inputs, but nextCommercialsBoundary below calls it in an hour-by-hour
// scan, and the guide/setup-schedule preview paths re-query the same handful
// of (channel, hour) pairs on every tick even when nothing changed. Keyed on
// S.configGeneration rather than any object identity, since config is
// mutated in place with no version field of its own (see CLAUDE.md's "Config
// mutation" section) — the cache is simply thrown away whenever that
// generation counter shows config has moved on, so a stale entry can never
// outlive the edit that invalidated it. Capped in size so a long session
// scanning many distinct timestamps within one generation can't grow this
// unbounded.
const RAC_CACHE_MAX = 2000;
let racCache = new Map();
let racCacheGen = -1;

export function resolveActiveCommercials(ch, atMs, fileTags) {
  if (S.configGeneration !== racCacheGen) {
    racCache = new Map();
    racCacheGen = S.configGeneration;
  } else if (racCache.size > RAC_CACHE_MAX) {
    racCache.clear();
  }
  const tagKey = fileTags && fileTags.length ? fileTags.join(',') : '';
  const cacheKey = `${ch.number}|${atMs}|${tagKey}`;
  const cached = racCache.get(cacheKey);
  if (cached) return cached;
  const result = computeActiveCommercials(ch, atMs, fileTags);
  racCache.set(cacheKey, result);
  return result;
}

function computeActiveCommercials(ch, atMs, fileTags) {
  // ch.adsEnabled is the channel-level kill-switch — false means no breaks at
  // all on this channel regardless of flows, presets, or block overrides.
  if (ch.adsEnabled === false) return { commercials: { enabled: false }, key: 'disabled' };

  const flows = (S.config.interstitials && S.config.interstitials.flows) || [];
  const tags = fileTags || [];
  
  // Channel and content-tag constraints are independent gates, both applied
  // whenever set (AND, not "tags only matter if there's no channel scope") —
  // matching flowStepPreviewPaths' own channel+tag filtering (setup-
  // interstitials-flowbuilder.js) and the flow status banner's "FLOW ACTIVE
  // FOR CH X // SHOWS: #tag" wording, both of which already treat the two as
  // independently AND'd. Every flow's editor always shows both a channel
  // picker and a contentTags field, so a flow scoped to specific channels
  // that ALSO sets contentTags needs the tags enforced too — otherwise two
  // different show-specific flows aimed at the same channel would collapse
  // to "whichever comes first in the array wins for all of that channel's
  // content," with contentTags silently doing nothing.
  const flow = flows.find((f) => {
    if (f.enabled === false) return false;
    if (f.channels && f.channels.length > 0 && !f.channels.includes(ch.number)) return false;

    if (f.contentTags && f.contentTags.length > 0) {
      if (!tags.length || !f.contentTags.some((t) => tags.includes(t))) return false;
    }

    return true;
  });

  if (flow) {
    const steps = flow.steps || [];
    const contentIndices = steps.map((s, i) => (s.type === 'contentSegment' ? i : -1)).filter((i) => i >= 0);
    const firstContentIdx = contentIndices.length > 0 ? contentIndices[0] : -1;
    const lastContentIdx = contentIndices.length > 0 ? contentIndices[contentIndices.length - 1] : -1;
    const segmentCount = contentIndices.length;

    const preSteps = firstContentIdx > 0 ? steps.slice(0, firstContentIdx) : (firstContentIdx === -1 ? steps : []);

    // For multi-segment flows (e.g. [bumpIn, content, adPod, content, bumpIn]):
    // - interSteps = steps strictly between the first and last contentSegment.
    //   These are the inter-episode interstitials (commercials, idents between
    //   episodes) and fire at every file boundary EXCEPT the last episode of
    //   each N-episode cycle.
    // - cycleEndSteps = steps after the last contentSegment (e.g. a trailing
    //   bump-in/station-id) that only fire once per full N-episode cycle —
    //   i.e. after episode N, 2N, 3N, … not after every single episode.
    // For single-segment flows (segmentCount <= 1), every boundary IS the
    // cycle end, so interSteps is empty and cycleEndSteps covers all post steps.
    let interSteps = [];
    let cycleEndSteps = [];
    if (segmentCount > 1) {
      // Between first and last content segment: inter-episode interstitials
      interSteps = steps.slice(firstContentIdx + 1, lastContentIdx);
      // After last content segment: end-of-cycle bumpers
      cycleEndSteps = lastContentIdx + 1 < steps.length ? steps.slice(lastContentIdx + 1) : [];
    } else {
      // Single-segment: everything after the content is a "cycle end" (fires every boundary)
      const postIdx = lastContentIdx >= 0 ? lastContentIdx + 1 : (firstContentIdx === -1 ? steps.length : 0);
      cycleEndSteps = postIdx < steps.length ? steps.slice(postIdx) : [];
    }

    // Exposed on the returned object as `postSteps` — interstitials.js's flow
    // builder reads that exact property name (its own "post" segment is the
    // inter-episode path, gated by hasPost below) — `interSteps` above is
    // just this function's own more descriptive local name for the same steps.
    const postSteps = interSteps;

    const adPodSteps = steps.filter((s) => s.type === 'adPod');

    // Legacy auto-derived percentage breakpoints from bare adPod steps when a
    // flow has no contentSegment markers at all (single-file breakpoint
    // model) — unchanged from before the explicit cadence panel (below)
    // existed, so old flows built this way keep behaving identically.
    let legacyBreakpoints = [];
    if (segmentCount === 0 && adPodSteps.length > 0) {
      for (let i = 1; i <= adPodSteps.length; i++) {
        legacyBreakpoints.push(Math.round((i / (adPodSteps.length + 1)) * 100 * 10) / 10);
      }
    }

    // Explicit mid-show ad cadence (flow.cadence — setup-interstitials-
    // flowbuilder.js's "MID-SHOW AD CADENCE" panel): the cadence-preset
    // functionality (a fixed "every N minutes" timer, or breaks "at set %
    // points") folded directly into the flow itself, so a flow no longer has
    // to give up per-show/per-movie cadence in exchange for its own bumper/
    // pod sequence — preSteps/postSteps/cycleEndSteps above still fire at
    // episode/file boundaries exactly as before; this additionally fires
    // *within* whichever content segment (or bare file, for a segment-less
    // flow) is currently airing, mirroring what resolveActiveCommercials'
    // own 'everyNMinutes'/'breakpoints' timing modes gave a channel/block/
    // preset before flows existed.
    const cadence = flow.cadence && flow.cadence.enabled ? flow.cadence : null;
    const midTiming = cadence ? (cadence.timing === 'everyNMinutes' ? 'everyNMinutes' : 'breakpoints') : 'breakpoints';
    const midBreakpoints = cadence ? (cadence.breakpoints || []) : legacyBreakpoints;
    const midIntervalMinutes = cadence ? cadence.intervalMinutes : null;
    const hasMid = cadence
      ? (midTiming === 'everyNMinutes' ? !!midIntervalMinutes : midBreakpoints.length > 0)
      : midBreakpoints.length > 0;

    const podStep = adPodSteps[0] || {};
    return {
      commercials: {
        timing: 'flow',
        flowId: flow.id,
        breakpoints: midBreakpoints,
        segmentCount,
        podMin: podStep.podMin || 1,
        podMax: podStep.podMax || 3,
        bumpInTags: podStep.bumpInTags,
        commercialTags: podStep.commercialTags,
        bumpOutTags: podStep.bumpOutTags,
        adPodSteps,
        preSteps,
        postSteps,
        cycleEndSteps,
        hasPre: preSteps.length > 0,
        hasPost: postSteps.length > 0,
        hasCycleEnd: cycleEndSteps.length > 0,
        hasMid,
        midTiming,
        midIntervalMinutes,
        midPodMin: cadence ? (cadence.podMin || 1) : null,
        midPodMax: cadence ? (cadence.podMax || cadence.podMin || 1) : null,
        midBumpInTags: cadence ? cadence.bumpInTags : null,
        midCommercialTags: cadence ? cadence.commercialTags : null,
        midBumpOutTags: cadence ? cadence.bumpOutTags : null,
      },
      key: `flow:${flow.id}`
    };
  }
  const presets = (S.config.interstitials && S.config.interstitials.presets) || [];
  if (fileTags && fileTags.length) {
    const preset = presets.find((p) => p.enabled !== false && p.contentTags && p.contentTags.length &&
      p.contentTags.some((t) => fileTags.includes(t)));
    if (preset) return { commercials: preset, key: `preset:${preset.id}` };
  }
  const candidates = (ch.blocks || [])
    .map((b, idx) => ({ b, idx }))
    .filter(({ b }) => b.commercials && matchesTrigger(atMs, b))
    .sort((x, y) => (y.b.priority || 0) - (x.b.priority || 0) || x.idx - y.idx);
  if (candidates.length) return { commercials: candidates[0].b.commercials, key: candidates[0].b.id };
  // Post-migration ch.commercials is deleted; fall back to the global default
  // cadence (S.config.commercials) so channels without a flow still get
  // interval-mode breaks, using the interval the Programming tab's GLOBAL
  // DEFAULT AD CADENCE panel configures. ch.adsEnabled was already verified
  // true (not false) at the top of this function, so force enabled: true —
  // the global config's own enabled flag is a legacy field (no UI exposes it
  // anymore) and would suppress ads for everyone if left as the default false.
  const globalCc = S.config.commercials || {};
  return { commercials: ch.commercials || { ...globalCc, enabled: true }, key: -1 };
}

// Next wall-clock instant where the active commercials config changes —
// mirrors nextSourceBoundary's hourly scan but keyed on
// resolveActiveCommercials instead, since a block can change the ad
// schedule at a boundary where the content itself doesn't change. Ad
// overrides aren't day-indexed, so there's no daily/weekly fast path here.
export function nextCommercialsBoundary(ch, fromMs) {
  if (!ch.blocks || ch.blocks.length === 0) return Infinity;
  const fromKey = resolveActiveCommercials(ch, fromMs).key;
  const d = new Date(fromMs);
  d.setMinutes(0, 0, 0);
  for (let i = 1; i <= BOUNDARY_SCAN_HOURS; i++) {
    const hourStart = d.getTime() + i * 3600000;
    if (resolveActiveCommercials(ch, hourStart).key !== fromKey) return hourStart;
  }
  return Infinity;
}

// Compute the live position within a specific source at a specific time.
export function computeSourcePosition(source, atMs, opts) {
  opts = opts || {};
  const files = source && source.files;
  if (!files || !files.length) return null;
  const total = files.reduce((sum, f) => sum + (f.duration || 0), 0);
  if (total <= 0 || !source.anchor) return null;
  let lostMs = 0;
  if (!opts.ignoreContentLost) {
    lostMs = S.contentLostMs || 0;
    if (S.activeBreakKey && S.activeBreakInterruptsContent && S.breakEnteredAtMs) {
      lostMs += (atMs - S.breakEnteredAtMs);
    }
  }
  const effectiveMs = atMs - lostMs;
  const elapsedRaw = (effectiveMs - source.anchor) / 1000;
  const elapsed = ((elapsedRaw % total) + total) % total;
  let acc = 0;
  for (let i = 0; i < files.length; i++) {
    const d = files[i].duration || 0;
    if (elapsed < acc + d) {
      return { fileIndex: i, offset: elapsed - acc, total, elapsed, files, file: files[i] };
    }
    acc += d;
  }
  return { fileIndex: 0, offset: 0, total, elapsed, files, file: files[0] };
}

// Compute { file, fileIndex, offset, ... } for a channel at this instant,
// as if it has been broadcasting continuously since its anchor — routed
// through whichever block (or the default folder) is active now.
export function computeLivePosition(ch) {
  return computeSourcePosition(resolveActiveSource(ch, viewNow()), viewNow());
}

export function walkSourceSchedule(source, segStart, segEnd) {
  const files = source.files;
  const total = files.reduce((sum, f) => sum + f.duration, 0);
  if (total <= 0 || !source.anchor) return [];
  const elapsedRaw = (segStart - source.anchor) / 1000;
  const elapsed = ((elapsedRaw % total) + total) % total;
  let acc = 0, idx = 0;
  for (; idx < files.length; idx++) {
    const d = files[idx].duration;
    if (elapsed < acc + d) break;
    acc += d;
  }
  if (idx >= files.length) idx = 0;

  const entries = [];
  let cursor = segStart - (elapsed - acc) * 1000;
  let i = idx, safety = 0;
  while (cursor < segEnd && safety < 1000) {
    const file = files[i % files.length];
    const start = cursor;
    const end = Math.min(cursor + file.duration * 1000, segEnd);
    entries.push({ file, start, end, block: source.block });
    cursor = cursor + file.duration * 1000;
    i++;
    safety++;
  }
  return entries;
}

// Channel schedule across [windowStart, windowEnd), segmented wherever the
// active source changes (a block starting/ending, or a daily/weekly block's
// day rollover) so each stretch reads from its own source.
export function getChannelSchedule(ch, windowStart, windowEnd) {
  const entries = [];
  let segStart = windowStart;
  let safety = 0;
  while (segStart < windowEnd && safety < 30) {
    const boundary = nextSourceBoundary(ch, segStart, windowEnd);
    const segEnd = Math.min(boundary, windowEnd);
    const source = resolveActiveSource(ch, segStart);
    entries.push(...walkSourceSchedule(source, segStart, segEnd));
    segStart = segEnd;
    safety++;
  }
  return entries;
}
