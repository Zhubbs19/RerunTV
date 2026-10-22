// Schedule queries — the read side of programming, as one pure module.
// docs/design/02-programming-timeline.md §3 (contract C2).
//
// Everything here is a question asked of the existing resolvers
// (getChannelSchedule, breakEntriesInWindow, resolveActiveSource,
// resolveActiveCommercials, resolveBreakAt, isWithinBroadcastHours); this
// file adds no scheduling rules of its own. What it adds is the shape every
// "show me a stretch of the schedule" screen needs: whole days computed once
// and cached, windows stitched from those days, a per-instant explanation,
// and a diff between two versions of a channel so an edit can show its
// impact before it is applied.
//
// No DOM, and "now" is always an argument — callers pass viewNow().
//
// Caching. Results are cached per channel OBJECT (a WeakMap), keyed inside by
// day and S.configGeneration. Keying on the object rather than ch.number is
// deliberate: diffSchedules resolves a proposed deep copy of a channel that
// shares its number, and a number-keyed cache would hand the copy the real
// channel's days (or poison the real channel's cache with the copy's). Every
// in-place config edit bumps configGeneration (CLAUDE.md), which retires
// older entries; a wholesale config replacement produces new channel
// objects, and the old ones' entries go with them.
import { applyCommand, cloneJson } from './commands.js';
import { boundarySlot, breakEntriesInWindow, effectiveContentTags, resolveBreakAt } from './interstitials.js';
import {
  computeSourcePosition, getChannelSchedule, isWithinBroadcastHours, matchesTrigger, matchingAdBlocks, matchingBlocks,
  matchingFlows, matchingPresets, mdKey, resolveActiveCommercials, resolveActiveSource,
} from './schedule.js';
import { S } from './state.js';

// A week back and two ahead is the widest window any screen asks for at once
// (ON AIR paging, a DVR expansion window); beyond that, oldest days go first.
const DAYS_PER_CHANNEL_MAX = 28;
const channelCaches = new WeakMap();

// Local midnight, via Date setters rather than ms arithmetic, so a DST day is
// 23 or 25 hours long exactly as the resolvers see it.
export function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function addDays(dayMs, n) {
  const d = new Date(dayMs);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

// Signed-off stretches inside [from, to), from the channel's broadcast hours.
// Broadcast hours flip only on the hour, so walking hour starts is exact.
export function offAirRanges(ch, from, to) {
  const bh = ch.broadcastHours;
  if (!bh || !bh.enabled) return [];
  const ranges = [];
  const cursor = new Date(from);
  cursor.setMinutes(0, 0, 0);
  while (cursor.getTime() < to) {
    const hourStart = cursor.getTime();
    cursor.setHours(cursor.getHours() + 1);
    const hourEnd = cursor.getTime();
    if (isWithinBroadcastHours(ch, hourStart)) continue;
    const start = Math.max(hourStart, from);
    const end = Math.min(hourEnd, to);
    const last = ranges[ranges.length - 1];
    if (last && last.end === start) last.end = end; else ranges.push({ start, end });
  }
  return ranges;
}

function cacheFor(ch) {
  let cache = channelCaches.get(ch);
  if (!cache || cache.generation !== S.configGeneration) {
    cache = { generation: S.configGeneration, days: new Map() };
    channelCaches.set(ch, cache);
  }
  return cache;
}

// One local day, whole. Programs and breaks are each computed on first use
// only — the guide-style callers that want programs alone shouldn't pay for
// break enumeration.
//
// Returns { dayStart, dayEnd, programs, breaks, offAir, ms } where programs
// are getChannelSchedule entries ({ file, start, end, block }) exactly as
// that function yields them for this day — an entry crossing midnight is cut
// at the day edge here, and querySchedule stitches it back together.
export function queryDay(ch, dayStart, { breaks = true } = {}) {
  const cache = cacheFor(ch);
  let day = cache.days.get(dayStart);
  if (!day) {
    const dayEnd = addDays(dayStart, 1);
    day = { dayStart, dayEnd, programs: null, breaks: null, offAir: offAirRanges(ch, dayStart, dayEnd), ms: 0 };
    if (cache.days.size >= DAYS_PER_CHANNEL_MAX) cache.days.delete(cache.days.keys().next().value);
    cache.days.set(dayStart, day);
  }
  if (!day.programs) {
    const began = performance.now();
    day.programs = getChannelSchedule(ch, day.dayStart, day.dayEnd);
    if (day.programs.truncated) day.truncated = true; // the listing hit a safety cap; see schedule.js
    day.ms += performance.now() - began;
  }
  if (breaks && !day.breaks) {
    const began = performance.now();
    try {
      day.breaks = breakEntriesInWindow(ch, day.dayStart, day.dayEnd);
    } catch (e) {
      // A break resolver throwing must not take a whole schedule view down;
      // programs are still worth showing without their break markers.
      console.warn('[schedule-query] break scan failed', e);
      day.breaks = [];
    }
    day.ms += performance.now() - began;
  }
  return day;
}

// Programs cut at a day edge come back as two entries: the first ends at
// midnight, the second starts where the first really started (walkSourceSchedule
// back-dates an in-progress file to its true start). getChannelSchedule cuts
// the same way at every source boundary inside a day, and when both sides of
// that boundary resolve to the same airing (a one-day copy of a block, say)
// the halves are one program too. So any entry that repeats the previous
// one's file and start is folded into it.
//
// "Same start" is within a millisecond, not exact: each day computes its
// start from its own midnight through float modulo arithmetic over the whole
// playlist, so on a real library the two halves disagree in the sub-millisecond
// digits (…146191.0554 vs …146191.056). Exact matching left every channel with
// a duplicate airing at midnight.
const SAME_AIRING_TOLERANCE_MS = 1;

function stitchPrograms(lists) {
  const out = [];
  lists.forEach((list) => list.forEach((entry) => {
    const last = out[out.length - 1];
    if (last
        && last.file && entry.file && last.file.path === entry.file.path
        && Math.abs(last.start - entry.start) < SAME_AIRING_TOLERANCE_MS) {
      last.end = Math.max(last.end, entry.end);
      return;
    }
    out.push({ ...entry });
  }));
  return out;
}

// A break pod cut at midnight is clamped on both sides, so the halves meet
// exactly at the day boundary.
function stitchBreaks(lists) {
  const out = [];
  lists.forEach((list) => list.forEach((entry) => {
    const last = out[out.length - 1];
    if (last && last.end === entry.start && last.breakType === entry.breakType) {
      last.end = entry.end;
      return;
    }
    out.push({ ...entry });
  }));
  return out;
}

function mergeRanges(ranges) {
  const out = [];
  ranges.forEach((r) => {
    const last = out[out.length - 1];
    if (last && last.end >= r.start) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  });
  return out;
}

// Everything airing in [from, to). Entries are whole airings — an entry that
// began before `from` keeps its real start — filtered to those overlapping
// the window, so callers clamp for display themselves the same way they do
// with getChannelSchedule.
export function querySchedule(ch, from, to, { breaks = true, offAir = true } = {}) {
  const days = [];
  for (let day = startOfDay(from); day < to; day = addDays(day, 1)) days.push(queryDay(ch, day, { breaks }));
  const overlaps = (e) => e.end > from && e.start < to;
  const truncated = days.some((d) => d.truncated);
  return {
    ...(truncated ? { truncated: true } : {}),
    from,
    to,
    programs: stitchPrograms(days.map((d) => d.programs)).filter(overlaps),
    breaks: breaks ? stitchBreaks(days.map((d) => d.breaks)).filter(overlaps) : [],
    offAir: offAir
      ? mergeRanges(days.flatMap((d) => d.offAir))
        .filter(overlaps)
        .map((r) => ({ start: Math.max(r.start, from), end: Math.min(r.end, to) }))
      : [],
    ms: days.reduce((sum, d) => sum + d.ms, 0),
  };
}

// What the channel resolves to at one instant, and the pieces that decided
// it. Data only: turning it into sentences is the caller's job (Air Check,
// ON AIR), since the same facts get worded differently per screen.
export function explainAt(ch, atMs) {
  const source = resolveActiveSource(ch, atMs);
  const position = computeSourcePosition(source, atMs, { ignoreContentLost: true });
  const commercials = resolveActiveCommercials(ch, atMs, effectiveContentTags(ch, position && position.file));
  return {
    atMs,
    onAir: isWithinBroadcastHours(ch, atMs),
    source,
    position,
    commercials,
    break: resolveBreakAt(ch, atMs),
    slot: boundarySlot(source, atMs, position),
  };
}

// Whole milliseconds, for the same float-noise reason as the stitching above.
function programKey(entry) {
  return `${Math.round(entry.start)}|${Math.round(entry.end)}|${entry.file && entry.file.path}`;
}
function breakKey(entry) {
  return `${Math.round(entry.start)}|${Math.round(entry.end)}|${entry.breakType}`;
}

// Resolvers read box-wide programming (presets, flows, the ad pool, station
// IDs) from S.config, so a proposed edit to any of those is resolved with
// S.config pointing at the proposal for the duration of one synchronous call.
function withConfig(config, fn) {
  if (!config || config === S.config) return fn();
  const live = S.config;
  S.config = config;
  try {
    return fn();
  } finally {
    S.config = live;
  }
}

// Commands an edit preview may apply to a shallow copy of config: ones that
// only touch the one channel (copied) or the box-wide programming lists
// (copied too). Anything else gets a whole deep copy.
const CHANNEL_SCOPED_TYPES = new Set([
  'block.create', 'block.remove', 'block.setHours', 'block.setDays', 'block.setPriority', 'block.overrideDay',
  'channel.setBroadcastHours', 'channel.set', 'channel.setFields', 'file.set', 'item.set', 'item.insert', 'item.remove',
]);
const SHARED_COLLECTIONS = new Set(['pool', 'presets', 'flows']);

// What config and the channel would look like with `commands` applied, without
// touching either: { config, channel }. The channel is always a fresh copy, so
// its cached days (and cached ad policy) never mix with the live channel's.
// Throws, like dispatch, if a command doesn't fit.
export function proposeEdit(config, channelNumber, commands) {
  const list = Array.isArray(commands) ? commands : [commands];
  const shallow = list.every((cmd) => CHANNEL_SCOPED_TYPES.has(cmd.type)
    && (SHARED_COLLECTIONS.has(cmd.collection) || cmd.channel === channelNumber));
  let proposed;
  if (shallow) {
    proposed = {
      ...config,
      channels: (config.channels || []).map((c) => (c.number === channelNumber ? cloneJson(c) : c)),
    };
    if (list.some((cmd) => SHARED_COLLECTIONS.has(cmd.collection))) proposed.interstitials = cloneJson(config.interstitials);
  } else {
    proposed = cloneJson(config);
  }
  list.forEach((cmd) => applyCommand(proposed, cmd));
  return { config: proposed, channel: (proposed.channels || []).find((c) => c.number === channelNumber) || null };
}

// What changes in [from, to) between two versions of a channel — the
// "this edit moves 14 programs" preview. `before` and `after` must be
// separate objects (typically the live channel and a deep copy with the edit
// applied); see the caching note at the top of this file. `afterConfig` (from
// proposeEdit) resolves `after` against proposed box-wide programming.
//
// Returns { identical, added, removed, breaksAdded, breaksRemoved,
// offAirChanged, changed }, where `changed` is the merged time ranges touched
// by any difference.
export function diffSchedules(before, after, from, to, { breaks = true, afterConfig = null } = {}) {
  const a = querySchedule(before, from, to, { breaks, offAir: true });
  const b = withConfig(afterConfig, () => querySchedule(after, from, to, { breaks, offAir: true }));
  const diff = (listA, listB, key) => {
    const keysB = new Set(listB.map(key));
    return listA.filter((e) => !keysB.has(key(e)));
  };
  const removed = diff(a.programs, b.programs, programKey);
  const added = diff(b.programs, a.programs, programKey);
  const breaksRemoved = breaks ? diff(a.breaks, b.breaks, breakKey) : [];
  const breaksAdded = breaks ? diff(b.breaks, a.breaks, breakKey) : [];
  const offAirKey = (r) => `${r.start}|${r.end}`;
  const offAirChanged = [...diff(a.offAir, b.offAir, offAirKey), ...diff(b.offAir, a.offAir, offAirKey)];
  const changed = mergeRanges(
    [...removed, ...added, ...breaksRemoved, ...breaksAdded, ...offAirChanged]
      .map((e) => ({ start: Math.max(e.start, from), end: Math.min(e.end, to) }))
      .sort((x, y) => x.start - y.start),
  );
  return {
    identical: changed.length === 0,
    added,
    removed,
    breaksAdded,
    breaksRemoved,
    offAirChanged,
    changed,
  };
}

// Every layer that had a say in what airs at one instant, in the order they're
// consulted, each marked with what it did. Data only, like explainAt: the
// explanation panel words it (docs/design/02 §4.2).
//
// Returns { atMs, source, commercials, layers } where each layer is
//   { group: 'content' | 'breaks', kind, item, role, reason }
// kind: 'broadcastHours' | 'block' | 'dayOverride' | 'default' |
//       'adsSwitch' | 'flow' | 'preset' | 'blockAds' | 'channelAds' | 'globalAds'
// item: the block / flow / preset object (null for channel-wide layers)
// role: 'wins'     decided the result
//       'outranked' matched, but a layer above it won
//       'skipped'   matched, but had nothing to give (no content yet)
//       'passes'    consulted and let the layers below decide (on the air)
// Layers that don't match this instant at all aren't listed: they didn't
// contribute. Winners agree with resolveActiveSource and
// resolveActiveCommercials by construction, since the matching lists are
// theirs (schedule.js matchingBlocks/Flows/Presets/AdBlocks).
export function explainLayers(ch, atMs) {
  const info = explainAt(ch, atMs);
  const { source } = info;
  const layers = [];

  const bh = ch.broadcastHours;
  if (bh && bh.enabled) {
    layers.push({ group: 'content', kind: 'broadcastHours', item: null, role: info.onAir ? 'passes' : 'wins', reason: info.onAir ? 'on-air' : 'signed-off' });
  }

  const candidates = matchingBlocks(ch, atMs);
  const winnerIndex = source.block ? candidates.indexOf(source.block) : -1;
  const empty = (ch.blocks || []).filter((b) => !(b.files && b.files.length) && matchesTrigger(atMs, b));
  const ranked = [...candidates, ...empty];
  ranked.forEach((block, i) => {
    let role;
    let reason;
    if (i >= candidates.length) { role = 'skipped'; reason = 'no-content'; }
    else if (i === winnerIndex) { role = info.onAir ? 'wins' : 'outranked'; reason = 'highest-match'; }
    else if (winnerIndex === -1 || i < winnerIndex) { role = 'skipped'; reason = 'not-started'; }
    else { role = 'outranked'; reason = 'lower-priority'; }
    layers.push({ group: 'content', kind: 'block', item: block, role, reason });
    if (i === winnerIndex && block.dayOverrides && source.key !== block.id) {
      // A daily/weekly block's current day may carry a calendar exception.
      const keyDay = String(source.key).slice(block.id.length + 1);
      const key = /^\d{2}-\d{2}$/.test(keyDay) ? keyDay : mdKey(atMs);
      if (block.dayOverrides[key]) layers.push({ group: 'content', kind: 'dayOverride', item: block, key, role, reason: 'calendar-day' });
    }
  });
  layers.push({
    group: 'content', kind: 'default', item: null,
    role: source.block || !info.onAir ? 'outranked' : 'wins',
    reason: (ch.files && ch.files.length) ? 'channel-folders' : 'no-content',
  });

  const tags = effectiveContentTags(ch, info.position && info.position.file);
  const winnerKey = info.commercials.key;
  if (ch.adsEnabled === false) {
    layers.push({ group: 'breaks', kind: 'adsSwitch', item: null, role: 'wins', reason: 'ads-off' });
  } else {
    matchingFlows(ch, tags).forEach((flow) => {
      layers.push({ group: 'breaks', kind: 'flow', item: flow, role: winnerKey === `flow:${flow.id}` ? 'wins' : 'outranked', reason: 'flow-match' });
    });
    matchingPresets(ch, tags).forEach((preset) => {
      layers.push({ group: 'breaks', kind: 'preset', item: preset, role: winnerKey === `preset:${preset.id}` ? 'wins' : 'outranked', reason: 'preset-match' });
    });
    matchingAdBlocks(ch, atMs).forEach((block) => {
      layers.push({ group: 'breaks', kind: 'blockAds', item: block, role: winnerKey === block.id ? 'wins' : 'outranked', reason: 'block-ads' });
    });
    layers.push({
      group: 'breaks', kind: ch.commercials ? 'channelAds' : 'globalAds', item: null,
      role: winnerKey === -1 ? 'wins' : 'outranked', reason: 'default-cadence',
    });
  }
  return { atMs, source, commercials: info.commercials, onAir: info.onAir, layers };
}
