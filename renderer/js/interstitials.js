// Deterministic tagged-interstitial resolution — a pure function of
// (channel, timestamp), mirroring how schedule.js resolves *content* purely
// from viewNow(). This is what lets the time machine "remember" past/future
// commercials: live playback and the VCR-shuttle preview both call
// resolveBreakAt() with whatever instant they're looking at, so they always
// agree, with no separate history to store.
//
// Breaks don't consume timeline time — exactly like the old per-system
// setTimeout-driven breaks, a break is an interruption overlaid on top of the
// content schedule, not something that shifts what plays after it.
// computeSourcePosition (schedule.js) is untouched; only "is a break showing
// right now instead of content" is new.
import {
  computeSourcePosition, isWithinBroadcastHours, nextBlockStartMs, nextBroadcastHoursBoundary,
  prevBroadcastHoursBoundary, resolveActiveCommercials, resolveActiveSource,
} from './schedule.js';
import { S } from './state.js';
import { hashString, mulberry32 } from './util.js';

const TRIVIA_DURATION_S = 8;
const CHANNELID_TEXT_DURATION_S = 5;
const SIGNOFF_DURATION_S = 20;
const SIGNON_DURATION_S = 20;
const PREMIERE_JINGLE_DURATION_S = 8;
// A LOCAL AVAIL / SPONSOR CARD entry stands in for a real ad slot (unlike
// upNext/stationId/promo/ident, which are quick bumpers a text-only entry
// rarely needs — those keep the generic bumper branch's 0-fallback below),
// so it needs a real ad-length default when the entry itself has no
// file/dynamic duration to fall back on.
const LOCAL_AVAIL_DURATION_S = 15;
const BOUNDARY_SAFETY_CAP = 500;
const DAY_MS = 86400000;

function seededShuffle(arr, seed) {
  const rand = mulberry32(seed);
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Entries eligible for a break of this type on this channel/block right now.
// fileTags (the tags — see setup-panels.js's TITLES tab — of whichever
// content file is airing around this break, or [] when there isn't one, e.g.
// an empty channel) additionally narrows to entries whose own contentTags
// (setup-interstitials.js) are unset/empty (untargeted — eligible for any
// content, today's default) or share at least one tag with the content, the
// same "unset/'any' = wildcard, otherwise must match" pattern channelAffinity/
// blockAffinity already use above. Entries with contentTiming set ('pre'/
// 'post'/'both' — see setup-interstitials.js) are excluded here entirely:
// they don't participate in ordinary cadence-driven breaks at all, only in
// the dedicated forced-pre/post-roll resolution below, so they never get
// double-counted between the two mechanisms.
// Exported so a one-off consumer that just needs "which pool entries are
// eligible, pick one" (e.g. playback.js's credits-squeeze video mode) can
// reuse this exact filter/pick pair instead of re-deriving channel-
// affinity/block-affinity/content-tag matching by hand.
export function poolFor(pool, type, ch, block, fileTags, targetTiming) {
  return pool.filter((e) => {
    if (e.type !== type) return false;
    if (targetTiming) {
      if (e.contentTiming && e.contentTiming !== 'any' && e.contentTiming !== 'both' && e.contentTiming !== targetTiming) {
        return false;
      }
    }
    return (e.channelAffinity === 'any' || e.channelAffinity === ch.number) &&
      (e.blockAffinity == null || (block && e.blockAffinity === block.id)) &&
      (!e.contentTags || !e.contentTags.length || (fileTags && fileTags.length && e.contentTags.some((t) => fileTags.includes(t))));
  });
}

// Unlike every other type, a promo's channelAffinity/blockAffinity name the
// block being *promoted* (a dateRange-triggered block on this same
// channel), not "which block this plays during" — so 'any'/unset simply
// means the entry can never be eligible (see the type def's comment,
// setup-interstitials.js), rather than falling back to a wildcard. Eligible
// only inside the entry's own leadDays window counting down to that
// target's next start.
function eligiblePromoEntries(pool, ch, atMs) {
  return pool.filter((e) => {
    if (e.type !== 'promo' || e.channelAffinity !== ch.number || e.blockAffinity == null) return false;
    const target = (ch.blocks || []).find((b) => b.id === e.blockAffinity);
    if (!target || target.trigger.type !== 'dateRange') return false;
    const startMs = nextBlockStartMs(target, atMs);
    if (!isFinite(startMs)) return false;
    const leadMs = Math.max(0, e.leadDays || 0) * DAY_MS;
    return atMs >= startMs - leadMs && atMs < startMs;
  });
}

// Is `atMs`'s local calendar day the very first day of `target`'s dateRange
// cycle? nextBlockStartMs is purely forward-looking (schedule.js): called
// with fromMs pinned to the start of today, it returns today's own midnight
// exactly when today IS the range's start day (fromMs <= startThisYear with
// equality), and some other (later) date otherwise — so a straight equality
// check against today's midnight is sufficient, no separate day-counting.
function isBlockPremiereDay(target, atMs) {
  if (!target || target.trigger.type !== 'dateRange') return false;
  const dayStart = new Date(atMs);
  dayStart.setHours(0, 0, 0, 0);
  const ds = dayStart.getTime();
  return nextBlockStartMs(target, ds) === ds;
}

// A one-shot "coming up now!" sting for a dateRange block's premiere —
// distinct from `promo` (which counts down BEFORE the moment, via
// leadDays) in that this fires exactly AT it. Scoped to daily/weekly
// dateRange blocks specifically: that's the shape a "series premiere"
// takes (a marathon/finale-style block airing day by day, see
// resolveDailySource/schedule.js) — a plain dateRange block has no single
// well-defined "first content boundary" of its own to anchor this to, so
// it's left out rather than guessed at.
function eligiblePremiereJingleEntries(pool, ch, block) {
  if (!block || block.trigger.type !== 'dateRange' || (block.mode !== 'daily' && block.mode !== 'weekly')) return [];
  return pool.filter((e) => e.type === 'premiereJingle' && e.channelAffinity === ch.number && e.blockAffinity === block.id);
}

// Deterministically picks one entry for a given slot index, with no stored
// state: an entry with weight N is expanded N times, the expanded list is
// seeded-shuffled once per "cycle" (a full pass through it) so repeats can't
// happen within a cycle — the same effect a configured min-repeat cooldown
// would give, just derived instead of tracked — and re-shuffled (a new seed)
// every cycle after that for variety over the long run. Same (pool, seedKey,
// slotIndex) always produces the same result, whether slotIndex is in the
// past or the future.
export function pickDeterministic(pool, seedKey, slotIndex) {
  if (!pool.length) return null;
  const expanded = [];
  pool.forEach((e) => { for (let i = 0; i < Math.max(1, e.weight || 1); i++) expanded.push(e); });
  const cycleLen = expanded.length;
  const cycleIndex = Math.floor(slotIndex / cycleLen);
  const shuffled = seededShuffle(expanded, hashString(`${seedKey}:${cycleIndex}`));
  return shuffled[((slotIndex % cycleLen) + cycleLen) % cycleLen];
}

// Which fixed-cadence slot `atMs` falls in, anchored to a content source's
// own anchor so the cadence is stable regardless of when you tuned in — same
// day-index-style pattern schedule.js already uses for daily/weekly blocks.
function intervalSlot(anchorMs, atMs, intervalMs) {
  const slotIndex = Math.floor((atMs - anchorMs) / intervalMs);
  return { slotIndex, slotStart: anchorMs + slotIndex * intervalMs };
}

// The content file "airing" at atMs, as a global ordinal (not just its index
// within one loop of the folder) plus its exact absolute start/end — derived
// entirely from computeSourcePosition's own output, no new position math.
// knownPos lets a caller that already computed computeSourcePosition(source,
// atMs, { ignoreContentLost: true }) — the exact call this function would
// otherwise make internally — pass it straight through instead of paying
// for the same linear file-list scan again. resolveBreakAt below is the
// main beneficiary: it's on the hottest path in the app (every tune, every
// break-boundary timer tick, every time-machine shuttle-drag frame) and
// calls boundarySlot() up to twice per invocation, always for the same
// (source, atMs) its own posNow already covers.
export function boundarySlot(source, atMs, knownPos) {
  const pos = knownPos || computeSourcePosition(source, atMs, { ignoreContentLost: true });
  if (!pos) return null;
  const elapsedRaw = (atMs - source.anchor) / 1000;
  const cyclesElapsed = Math.floor(elapsedRaw / pos.total);
  const ordinal = cyclesElapsed * pos.files.length + pos.fileIndex;
  const fileStartMs = atMs - pos.offset * 1000;
  const fileEndMs = fileStartMs + pos.file.duration * 1000;
  return { ordinal, fileStartMs, fileEndMs };
}

// A dynamic entry (live text templated over a looping background clip — see
// setup-interstitials.js's DYNAMIC checkbox and startBreak's dynamic branch,
// playback.js) has no `file` of its own (the background loops indefinitely,
// so there's no natural "how long is this" the way a real file's probed
// duration gives one) — its author-set durationS stands in instead. Centralized
// here so windowFor/windowEndingAt/buildPod all agree on the same rule.
function entryDurationS(entry, fallbackDurationS) {
  if (entry.dynamic) return entry.durationS || 15;
  return entry.file ? entry.file.duration : fallbackDurationS;
}

// An optional held beat on black AFTER this entry finishes (setup-
// interstitials.js's WAIT AFTER field) — unlike fadeInMs/fadeOutMs (purely
// visual, read only by playback.js, never touches window math), a wait has
// no content to show during it, so it can't be a sub-range of the entry's
// own dur — it has to extend the window itself. Folded directly into
// windowFor/windowEndingAt/buildPod's own windowEnd (not a separate
// synthetic segment) so segmentAt keeps resolving to this same entry
// throughout the hold, keeping every window a pure function of
// (channel, timestamp) exactly as before this existed.
export function entryWaitMs(entry) {
  return (entry && entry.waitMs) || 0;
}

function windowFor(pool, type, ch, block, seedKey, slotIndex, windowStart, fallbackDurationS, fileTags) {
  const entry = pickDeterministic(poolFor(pool, type, ch, block, fileTags), seedKey, slotIndex);
  if (!entry) return null;
  const durationS = entryDurationS(entry, fallbackDurationS);
  return { entry, windowStart, windowEnd: windowStart + durationS * 1000 + entryWaitMs(entry) };
}

// Same as windowFor but anchored to when the window *ends* rather than
// starts — used for the sign-off bumper, which needs to finish exactly at
// the broadcast-hours boundary rather than start there. The wait (if any)
// still trails the entry's own content, so it's the CONTENT that's pulled
// earlier to make room, not the wait itself shifted before windowEnd.
function windowEndingAt(pool, type, ch, block, seedKey, slotIndex, windowEnd, fallbackDurationS, fileTags) {
  const entry = pickDeterministic(poolFor(pool, type, ch, block, fileTags), seedKey, slotIndex);
  if (!entry) return null;
  const durationS = entryDurationS(entry, fallbackDurationS);
  const waitMs = entryWaitMs(entry);
  return { entry, windowStart: windowEnd - durationS * 1000 - waitMs, windowEnd };
}

// Generous upper bound on any realistic podMax — keeps each pod's N
// commercial picks referencing distinct, non-colliding pickDeterministic
// slot indices across consecutive pods (slotIndex increases by 1 per break
// occasion, so `slotIndex * POD_SLOT_STRIDE + i` never collides between one
// pod's spots and the next pod's).
const POD_SLOT_STRIDE = 8;

// A flow step's bumpInTags/commercialTags/bumpOutTags (setup-interstitials.js)
// is [] — not null/undefined — whenever the user leaves that field blank
// (''.split(',').filter(Boolean) => []), since an empty array is truthy in
// JS a plain `step.bumpOutTags || cc.bumpOutTags || fileTags` fallback chain
// stops at that first empty array instead of cascading to the next tier, so
// a step with a blank BUMP-OUT TAGS field could only ever match an untagged
// pool entry — any tagged bump-out ident (the whole point of leaving the
// field blank: "match whatever this content is tagged") silently never
// qualified, so the pod fell through to its last commercial as the final
// segment instead. Treats an empty array the same as absent everywhere a
// tag-list fallback chain is built.
function firstNonEmpty(...lists) {
  for (const l of lists) if (l && l.length) return l;
  return undefined;
}

// A real ad "pod" — an optional bump-in ident, `podMin`-`podMax` `commercial`
// entries chained back-to-back, an optional bump-out ident — instead of one
// bumper per break. podMin===podMax===1 and no adBreakIn/adBreakOut pool
// entries degenerates to exactly one commercial-length window, i.e. today's
// pre-pod behavior, so this is purely additive. Deterministic in the same
// sense as pickDeterministic: same (pool, seedKey, slotIndex) always
// produces the same pod. Returns null when the pool has nothing playable at
// all for this channel/block (mirrors windowFor's null-when-empty).
// The last 4 conceptually-related values (an explicit bump-in/commercial/
// bump-out tag override, plus which contentTiming this pod targets) are
// bundled into one `opts` object rather than 4 more positional params —
// every call site either supplies all of them together (a flow step's own
// per-step overrides) or none at all (the ordinary interval/everyNMinutes/
// breakpoints timing modes never override any of them), so they were
// always conceptually one unit, not 4 independent choices a caller picks
// separately.
function buildPod(pool, ch, block, seedKey, slotIndex, windowStart, podMin, podMax, fileTags, opts) {
  const { inTags: optInTags, commTags: optCommTags, outTags: optOutTags, targetTiming } = opts || {};
  const lo = Math.max(1, podMin || 1);
  const hi = Math.max(lo, podMax || lo);
  const sizeRand = mulberry32(hashString(`${seedKey}:podsize:${slotIndex}`))();
  const podSize = lo + Math.floor(sizeRand * (hi - lo + 1));

  const ccOverride = (ch.commercials && ch.commercials.commercialTags) ? ch.commercials : null;
  const inTags = firstNonEmpty(optInTags, ccOverride && ccOverride.bumpInTags, fileTags);
  const commTags = firstNonEmpty(optCommTags, ccOverride && ccOverride.commercialTags, fileTags);
  const outTags = firstNonEmpty(optOutTags, ccOverride && ccOverride.bumpOutTags, fileTags);

  const segments = [];
  let cursor = windowStart;

  const inEntry = pickDeterministic(poolFor(pool, 'adBreakIn', ch, block, inTags, targetTiming), `${seedKey}:in`, slotIndex);
  if (inEntry) {
    const dur = entryDurationS(inEntry, 0);
    const windowEnd = cursor + dur * 1000 + entryWaitMs(inEntry);
    segments.push({ type: 'adBreakIn', entry: inEntry, windowStart: cursor, windowEnd });
    cursor = windowEnd;
  }

  for (let i = 0; i < podSize; i++) {
    const entry = pickDeterministic(poolFor(pool, 'commercial', ch, block, commTags, targetTiming), seedKey, slotIndex * POD_SLOT_STRIDE + i);
    if (!entry) break;
    const dur = entryDurationS(entry, 0);
    const windowEnd = cursor + dur * 1000 + entryWaitMs(entry);
    segments.push({ type: 'commercial', entry, windowStart: cursor, windowEnd });
    cursor = windowEnd;
  }

  const outEntry = pickDeterministic(poolFor(pool, 'adBreakOut', ch, block, outTags, targetTiming), `${seedKey}:out`, slotIndex);
  if (outEntry) {
    const dur = entryDurationS(outEntry, 0);
    const windowEnd = cursor + dur * 1000 + entryWaitMs(outEntry);
    segments.push({ type: 'adBreakOut', entry: outEntry, windowStart: cursor, windowEnd });
    cursor = windowEnd;
  }

  if (!segments.length) return null;
  return { segments, windowStart, windowEnd: cursor };
}

function segmentAt(pod, atMs) {
  if (!pod || !pod.segments.length) return null;
  const direct = pod.segments.find((s) => atMs >= s.windowStart && atMs < s.windowEnd);
  if (direct) return direct;
  if (atMs >= pod.windowStart && atMs < pod.windowEnd + 3000) {
    const nextSeg = pod.segments.find((s) => atMs < s.windowEnd);
    if (nextSeg) return nextSeg;
  }
  return null;
}

// Maps flow-builder step types (setup-interstitials.js) to the corresponding
// pool entry type strings used throughout the interstitials pool. Keeps this
// file consistent with normalizePoolType (setup-interstitials.js) without
// creating a circular import.
function normalizeFlowStepType(type) {
  if (type === 'stationId') return 'channelId';
  if (type === 'bumpIn') return 'adBreakIn';   // legacy — kept for backward compat
  if (type === 'bumpOut') return 'adBreakOut';  // legacy — kept for backward compat
  // 'ident' is the merged bump-in/out type; handled inline in the flow resolver below
  // upNext, promo, commercial — same key in pool and flow builder
  return type;
}


// Is a break showing on this channel at this exact instant? Checks
// commercial (per its resolved timing mode), channelId, trivia, then upNext,
// in that order — first one whose window contains atMs wins (two break
// types are never meant to overlap in practice: they're spaced by
// intervalMinutes/content-boundaries, not by design against each other, but
// a fixed priority order keeps behavior well-defined on paper either way).
// Returns null when nothing is airing at atMs (including "no content
// scheduled at all," e.g. an empty channel).
export function resolveBreakAt(ch, atMs) {
  const pool = (S.config.interstitials && S.config.interstitials.pool) || [];
  const source = resolveActiveSource(ch, atMs);
  if (!source.anchor) return null;
  const block = source.block;

  // Premiere jingle — checked first (ahead of the ordinary commercial
  // cadence below) since it's a rare, one-day-per-block-lifetime moment
  // that shouldn't lose out to a commercial pod that happens to also start
  // at the same instant. source.anchor for a daily/weekly block is exactly
  // that day's own unlock instant (resolveDailySource, schedule.js), so it
  // doubles as this window's start with no extra lookup needed.
  if (block && isBlockPremiereDay(block, source.anchor)) {
    const eligibleJingles = eligiblePremiereJingleEntries(pool, ch, block);
    if (eligibleJingles.length) {
      const entry = pickDeterministic(eligibleJingles, `premiereJingle:${ch.number}:${block.id}`, Math.floor(source.anchor / DAY_MS));
      if (entry) {
        const durationS = entryDurationS(entry, PREMIERE_JINGLE_DURATION_S);
        const windowStart = source.anchor;
        const windowEnd = windowStart + durationS * 1000 + entryWaitMs(entry);
        if (atMs >= windowStart && atMs < windowEnd) return { type: 'premiereJingle', entry, windowStart, windowEnd };
      }
    }
  }

  // Tags (see the TITLES tab, setup-panels.js) of whichever content file is
  // airing right now — threaded into every poolFor call below so an entry's
  // optional contentTags (setup-interstitials.js) can target ads at specific
  // tagged content instead of only channel/block.
  const posNow = computeSourcePosition(source, atMs, { ignoreContentLost: true });
  const fileTags = (posNow && posNow.file && posNow.file.tags) || [];

  const activeCommercials = resolveActiveCommercials(ch, atMs, fileTags);
  const cc = activeCommercials.commercials; // this channel's effective commercials config (block/preset override already resolved) — short name, used constantly below
  if (cc && cc.enabled !== false) {
    const timing = cc.timing || 'interval';
    // Keyed on the preset id when a preset governs (so ad selection travels
    // with the tagged show, independent of which block happens to be airing
    // it), otherwise unchanged from before presets existed — block.id or
    // 'default' — so existing configs with no presets keep picking exactly
    // the same ads they always have.
    const seedKey = `commercial:${ch.number}:${typeof activeCommercials.key === 'string' && activeCommercials.key.startsWith('preset:') ? activeCommercials.key : (block ? block.id : 'default')}`;
    if (timing === 'interval') {
      const intervalMs = Math.max(1, cc.intervalMinutes || (S.config.commercials && S.config.commercials.intervalMinutes) || 10) * 60000;
      const { slotIndex, slotStart } = intervalSlot(source.anchor, atMs, intervalMs);
      const pod = buildPod(pool, ch, block, seedKey, slotIndex, slotStart, cc.podMin, cc.podMax, fileTags);
      const seg = segmentAt(pod, atMs);
      if (seg) return { type: seg.type, entry: seg.entry, windowStart: seg.windowStart, windowEnd: seg.windowEnd };
    } else if (timing === 'everyNMinutes') {
      // Mid-video ad breaks — breakpoints WITHIN the currently-playing file,
      // not just at whole-file boundaries. Slots every intervalMinutes
      // starting from the file's own real start (bs.fileStartMs), skipping
      // slot 0 (the file's own start — already the domain of the boundary-
      // tied timing modes above, not a "mid-show" break) and any slot that
      // would spill past the file's real end. Needs zero changes to the
      // resume mechanism: endBreak (playback.js) already credits real
      // elapsed break time back via S.contentLostMs regardless of *why*
      // content stopped, so "resume the show where it left off" works
      // identically whether the break happened between files or mid-file.
      const bs = boundarySlot(source, atMs, posNow);
      if (bs) {
        const intervalMs = Math.max(1, cc.intervalMinutes || (S.config.commercials && S.config.commercials.intervalMinutes) || 10) * 60000;
        const slotIndexInFile = Math.floor((atMs - bs.fileStartMs) / intervalMs);
        const slotStart = bs.fileStartMs + slotIndexInFile * intervalMs;
        if (slotStart > bs.fileStartMs && slotStart < bs.fileEndMs) {
          const pod = buildPod(pool, ch, block, seedKey, bs.ordinal * 1000 + slotIndexInFile, slotStart, cc.podMin, cc.podMax, fileTags);
          const seg = segmentAt(pod, atMs);
          if (seg) return { type: seg.type, entry: seg.entry, windowStart: seg.windowStart, windowEnd: seg.windowEnd };
        }
      }
    } else if (timing === 'flow') {
      const bs = boundarySlot(source, atMs, posNow);
      if (bs) {
        // For multi-segment flows, the cycle length is how many episodes constitute
        // one full "block" of the flow. Inter-episode steps (postSteps/interSteps)
        // fire at every boundary EXCEPT the last episode of each cycle;
        // cycleEndSteps fire only at the last episode of each cycle.
        const cycleLen = Math.max(1, cc.segmentCount || 1);
        const posInCycle = bs.ordinal % cycleLen; // 0-based position within the current cycle
        const isLastInCycle = posInCycle === cycleLen - 1;

        const flowSegsToProcess = [];
        // Inter-episode interstitials: only fire between episodes, not at the cycle end
        if (cc.hasPost && !isLastInCycle) {
          flowSegsToProcess.push({ slotIndex: bs.ordinal * 2, label: 'post', steps: cc.postSteps });
        }
        // Pre-episode steps fire at every boundary (before the next episode begins)
        if (cc.hasPre) {
          flowSegsToProcess.push({ slotIndex: bs.ordinal * 2 + 1, label: 'pre', steps: cc.preSteps });
        }
        // Cycle-end steps: only fire after the last episode of each N-episode cycle
        if (cc.hasCycleEnd && isLastInCycle) {
          flowSegsToProcess.push({ slotIndex: bs.ordinal * 2, label: 'post', steps: cc.cycleEndSteps });
        }

        let cursor = bs.fileStartMs;
        for (const segMeta of flowSegsToProcess) {
          const steps = segMeta.steps || [];
          for (let si = 0; si < steps.length; si++) {
            const step = steps[si];
            if (step.type === 'adPod') {
              // Full ad pod with its own bump-in/commercial/bump-out tags and pod size.
              const pod = buildPod(
                pool, ch, block, seedKey,
                segMeta.slotIndex * 100 + si,
                cursor,
                step.podMin || cc.podMin || 1,
                step.podMax || cc.podMax || 1,
                fileTags,
                {
                  inTags: firstNonEmpty(step.bumpInTags, cc.bumpInTags),
                  commTags: firstNonEmpty(step.commercialTags, cc.commercialTags),
                  outTags: firstNonEmpty(step.bumpOutTags, cc.bumpOutTags),
                  targetTiming: segMeta.label,
                }
              );
              if (pod) {
                const seg = segmentAt(pod, atMs);
                if (seg) return { type: seg.type, label: segMeta.label, entry: seg.entry, windowStart: seg.windowStart, windowEnd: seg.windowEnd };
                cursor = pod.windowEnd;
              }
            } else {
              // Bumper step (upNext, stationId, bumpIn, bumpOut, ident, promo, etc.) —
              // look up the matching pool entry by its normalized type and step tags.
              // contentSegment steps (flow markers, not real break content) are skipped.
              if (step.type === 'contentSegment') continue;
              const poolType = normalizeFlowStepType(step.type);
              const stepTags = step.tags && step.tags.length ? step.tags : fileTags;
              // 'ident' tries adBreakIn first, falls back to adBreakOut — unified bump pool
              const typesToTry = poolType === 'ident' ? ['adBreakIn', 'adBreakOut'] : [poolType];
              const fallbackDurationS = poolType === 'localAvail' ? LOCAL_AVAIL_DURATION_S : 0;
              let win = null;
              for (const t of typesToTry) {
                win = windowFor(pool, t, ch, block, `${seedKey}:${segMeta.label}:${si}`, segMeta.slotIndex * 100 + si, cursor, fallbackDurationS, stepTags);
                if (win) break;
              }
              if (win) {
                if (atMs >= win.windowStart && atMs < win.windowEnd) {
                  return { type: win.entry ? win.entry.type : poolType, label: segMeta.label, entry: win.entry, windowStart: win.windowStart, windowEnd: win.windowEnd };
                }
                cursor = win.windowEnd;
              }
            }
          }
        }

        if (cc.hasMid) {
          if (cc.midTiming === 'everyNMinutes' && cc.midIntervalMinutes) {
            // "Every N minutes" mid-show cadence — same slot math as the
            // top-level 'everyNMinutes' commercial timing mode above, just
            // scoped to whatever content segment/file is airing right now
            // instead of being the channel's only ad cadence.
            const intervalMs = Math.max(1, cc.midIntervalMinutes) * 60000;
            const slotIndexInFile = Math.floor((atMs - bs.fileStartMs) / intervalMs);
            const slotStart = bs.fileStartMs + slotIndexInFile * intervalMs;
            if (slotStart > bs.fileStartMs && slotStart < bs.fileEndMs) {
              const podMin = cc.midPodMin || cc.podMin;
              const podMax = cc.midPodMax || cc.podMax;
              const inTags = firstNonEmpty(cc.midBumpInTags, cc.bumpInTags);
              const commTags = firstNonEmpty(cc.midCommercialTags, cc.commercialTags);
              const outTags = firstNonEmpty(cc.midBumpOutTags, cc.bumpOutTags);
              const pod = buildPod(pool, ch, block, seedKey, bs.ordinal * 1000 + slotIndexInFile, slotStart, podMin, podMax, fileTags, { inTags, commTags, outTags });
              const seg = segmentAt(pod, atMs);
              if (seg) return { type: seg.type, entry: seg.entry, windowStart: seg.windowStart, windowEnd: seg.windowEnd };
            }
          } else {
            const fileDurMs = bs.fileEndMs - bs.fileStartMs;
            const pts = (cc.breakpoints || []).filter((p) => p > 0 && p < 100).sort((a, b) => a - b);
            for (let i = 0; i < pts.length; i++) {
              const slotStart = bs.fileStartMs + (pts[i] / 100) * fileDurMs;
              if (slotStart <= bs.fileStartMs || slotStart >= bs.fileEndMs) continue;
              // A legacy auto-derived breakpoint (no explicit cadence panel
              // set, cc.segmentCount === 0 — see schedule.js's legacyBreakpoints)
              // has a same-index adPodSteps entry with its own pod settings,
              // built 1:1 from that same array. An explicit cadence-panel
              // breakpoint (segmentCount > 0) has no such correspondence —
              // cc.adPodSteps there is whichever adPod-type steps the flow's
              // own authored sequence happens to contain (e.g. the between-
              // episode pod), completely unrelated to the cadence panel's own
              // % list — so indexing into it by breakpoint position would
              // silently borrow that unrelated step's tags/pod-size instead
              // of falling through to the cadence panel's own mid* settings.
              const podStep = (!cc.segmentCount && cc.adPodSteps && cc.adPodSteps[i]) || {};
              const podMin = podStep.podMin != null ? podStep.podMin : (cc.midPodMin || cc.podMin);
              const podMax = podStep.podMax != null ? podStep.podMax : (cc.midPodMax || cc.podMax);
              const inTags = firstNonEmpty(podStep.bumpInTags, cc.midBumpInTags, cc.bumpInTags);
              const commTags = firstNonEmpty(podStep.commercialTags, cc.midCommercialTags, cc.commercialTags);
              const outTags = firstNonEmpty(podStep.bumpOutTags, cc.midBumpOutTags, cc.bumpOutTags);
              const pod = buildPod(pool, ch, block, seedKey, bs.ordinal * 1000 + i, slotStart, podMin, podMax, fileTags, { inTags, commTags, outTags });
              const seg = segmentAt(pod, atMs);
              if (seg) return { type: seg.type, entry: seg.entry, windowStart: seg.windowStart, windowEnd: seg.windowEnd };
            }
          }
        }
      }
    } else if (timing === 'breakpoints') {
      // Explicit % positions through the currently-playing file (cc.breakpoints,
      // e.g. [20, 50, 80]) instead of a fixed N-minute cadence — this is what
      // lets an ad preset line breaks up with a show's actual structure (two
      // 11-minute SpongeBob episodes back to back might want a break only at
      // the midpoint, a 2-hour movie might want four evenly-spread breaks)
      // rather than wall-clock timing that ignores it. Each breakpoint gets
      // its own pod, keyed by its index so a pod's contents stay stable
      // regardless of how many other breakpoints exist.
      const bs = boundarySlot(source, atMs, posNow);
      if (bs) {
        const fileDurMs = bs.fileEndMs - bs.fileStartMs;
        const pts = (cc.breakpoints || []).filter((p) => p > 0 && p < 100).sort((a, b) => a - b);
        for (let i = 0; i < pts.length; i++) {
          const slotStart = bs.fileStartMs + (pts[i] / 100) * fileDurMs;
          if (slotStart <= bs.fileStartMs || slotStart >= bs.fileEndMs) continue;
          const podStep = (cc.adPodSteps && cc.adPodSteps[i]) || cc;
          const podMin = podStep.podMin != null ? podStep.podMin : cc.podMin;
          const podMax = podStep.podMax != null ? podStep.podMax : cc.podMax;
          const inTags = firstNonEmpty(podStep.bumpInTags, cc.bumpInTags);
          const commTags = firstNonEmpty(podStep.commercialTags, cc.commercialTags);
          const outTags = firstNonEmpty(podStep.bumpOutTags, cc.bumpOutTags);
          const pod = buildPod(pool, ch, block, seedKey, bs.ordinal * 1000 + i, slotStart, podMin, podMax, fileTags, { inTags, commTags, outTags });
          const seg = segmentAt(pod, atMs);
          if (seg) return { type: seg.type, entry: seg.entry, windowStart: seg.windowStart, windowEnd: seg.windowEnd };
        }
      }
    } else {
      // 'pre'/'post'/'both' don't shift content, so "after show K ends" and
      // "before show K+1 starts" are the same instant — the two pods just
      // play back to back starting there when both are requested, sharing
      // one boundary-ordinal-derived seed key so a standalone 'pre' or
      // 'post' picks the same pod 'both' would.
      //
      // Anchored to bs.fileStartMs, not bs.fileEndMs — fileEndMs is always
      // in the *future* relative to whatever atMs computed it (it's "when
      // the file atMs is currently inside of will end"), so a break window
      // built from it can only ever be satisfied by exact floating-point
      // equality, which real polling essentially never hits (confirmed via
      // a live test: this made upNext/pre/post never fire in practice).
      // fileStartMs = atMs - offset*1000 is always <= atMs by construction,
      // so it correctly anchors "how long ago did the most recent boundary
      // pass" regardless of how far re-querying has drifted past it.
      const bs = boundarySlot(source, atMs, posNow);
      if (bs) {
        const segments = [];
        if (timing === 'post' || timing === 'both') segments.push({ slotIndex: bs.ordinal * 2, label: 'post' });
        if (timing === 'pre' || timing === 'both') segments.push({ slotIndex: bs.ordinal * 2 + 1, label: 'pre' });
        let cursor = bs.fileStartMs;
        for (const segMeta of segments) {
          const pod = buildPod(pool, ch, block, seedKey, segMeta.slotIndex, cursor, cc.podMin, cc.podMax, fileTags, { targetTiming: segMeta.label });
          if (!pod) continue;
          const seg = segmentAt(pod, atMs);
          if (seg) return { type: seg.type, label: segMeta.label, entry: seg.entry, windowStart: seg.windowStart, windowEnd: seg.windowEnd };
          cursor = pod.windowEnd;
        }
      }
    }
  }

  const sid = S.config.stationId; // box-wide station-id bumper config ("sid" as in "station ID")
  if (sid && sid.enabled !== false) {
    const intervalMs = Math.max(1, sid.intervalMinutes || 15) * 60000;
    // Real US stations legally ID at/near the top of the clock hour — anchor
    // this slot to the wall-clock hour (NOT source.anchor, the content
    // loop's own arbitrary start time, which every other intervalSlot call
    // in this file correctly keeps using) so IDs land on :00/:15/:30/:45
    // instead of drifting to whatever offset the channel happened to start
    // looping at.
    const hourAnchorMs = Math.floor(atMs / 3600000) * 3600000;
    const { slotIndex, slotStart } = intervalSlot(hourAnchorMs, atMs, intervalMs);
    const seedKey = `channelId:${ch.number}`;
    const win = windowFor(pool, 'channelId', ch, block, seedKey, slotIndex, slotStart, CHANNELID_TEXT_DURATION_S, fileTags);
    if (win) {
      if (atMs >= win.windowStart && atMs < win.windowEnd) return { type: 'channelId', ...win };
    } else if (atMs >= slotStart && atMs < slotStart + CHANNELID_TEXT_DURATION_S * 1000) {
      // No authored channelId entries — auto-generated "YOU'RE WATCHING <channel>"
      // text bar, same cadence, matching today's zero-config behavior.
      return { type: 'channelId', entry: null, windowStart: slotStart, windowEnd: slotStart + CHANNELID_TEXT_DURATION_S * 1000 };
    }
  }

  const tv = S.config.trivia; // box-wide trivia-break config ("tv" as in "trivia")
  if (tv && tv.enabled) {
    const intervalMs = Math.max(1, tv.intervalMinutes || 20) * 60000;
    const { slotIndex, slotStart } = intervalSlot(source.anchor, atMs, intervalMs);
    const seedKey = `trivia:${ch.number}`;
    const win = windowFor(pool, 'trivia', ch, block, seedKey, slotIndex, slotStart, TRIVIA_DURATION_S, fileTags);
    if (win && atMs >= win.windowStart && atMs < win.windowEnd) return { type: 'trivia', ...win };
  }

  // Optional video "up next" idents — additive to the existing automatic
  // text banner (untouched, unrelated), fires at every content boundary only
  // if the pool actually has eligible entries. Anchored to bs2.fileStartMs,
  // not fileEndMs — see the long comment on the commercial 'pre'/'post'
  // branch above for why (fileEndMs is always in the future from whatever
  // atMs computed it, so the window could only ever be hit by exact
  // floating-point equality — confirmed via a live test that this made
  // upNext never actually fire through real polling before this fix).
  const bs2 = boundarySlot(source, atMs, posNow);
  if (bs2) {
    const seedKey = `upNext:${ch.number}:${block ? block.id : 'default'}`;
    const win = windowFor(pool, 'upNext', ch, block, seedKey, bs2.ordinal, bs2.fileStartMs, 0, fileTags);
    if (win && atMs >= win.windowStart && atMs < win.windowEnd) return { type: 'upNext', ...win };
  }

  // Forced pre-/post-roll for content-tag-targeted commercials
  // (contentTiming set — see setup-interstitials.js) — independent of the
  // channel's own commercial cadence/timing mode entirely (poolFor excludes
  // these from ordinary cadence-driven breaks above), so "always run this ad
  // right before/after anything tagged X" fires exactly at that content's
  // boundary even on a channel using interval-mode ads, or none at all. Both
  // segments start at bs2.fileStartMs and chain forward (post first, then
  // pre) rather than pre ending AT the boundary — same reason as the
  // long comment on the commercial 'pre'/'post'/'both' branch above: a
  // window that only *starts* before an enumerated candidate boundary is
  // never discovered by nextBreakBoundary's forward candidate scan, so it
  // would silently never fire through real polling. 'pre' checks the file
  // about to start (fileTags — already the tags of whatever's airing at/
  // after this boundary); 'post' checks the file that just ended, one slot
  // back in the same files[] loop.
  if (bs2) {
    const forcedPool = pool.filter((e) => e.type === 'commercial' && e.contentTiming && e.contentTags && e.contentTags.length);
    if (forcedPool.length) {
      const prevFile = posNow.files[(posNow.fileIndex - 1 + posNow.files.length) % posNow.files.length];
      const prevTags = (prevFile && prevFile.tags) || [];
      const postEntries = forcedPool.filter((e) =>
        (e.contentTiming === 'post' || e.contentTiming === 'both') && e.contentTags.some((t) => prevTags.includes(t)));
      const preEntries = forcedPool.filter((e) =>
        (e.contentTiming === 'pre' || e.contentTiming === 'both') && e.contentTags.some((t) => fileTags.includes(t)));

      let cursor = bs2.fileStartMs;
      if (postEntries.length) {
        const entry = pickDeterministic(postEntries, `tagPost:${ch.number}`, bs2.ordinal);
        if (entry) {
          const durationS = entryDurationS(entry, 0);
          const windowStart = cursor, windowEnd = cursor + durationS * 1000 + entryWaitMs(entry);
          if (atMs >= windowStart && atMs < windowEnd) return { type: 'commercial', label: 'post', entry, windowStart, windowEnd };
          cursor = windowEnd;
        }
      }
      if (preEntries.length) {
        const entry = pickDeterministic(preEntries, `tagPre:${ch.number}`, bs2.ordinal);
        if (entry) {
          const durationS = entryDurationS(entry, 0);
          const windowStart = cursor, windowEnd = cursor + durationS * 1000 + entryWaitMs(entry);
          if (atMs >= windowStart && atMs < windowEnd) return { type: 'commercial', label: 'pre', entry, windowStart, windowEnd };
        }
      }
    }
  }

  // "This Saturday: [movie]" — a promo counting down to an upcoming
  // dateRange block's premiere, fired at content boundaries like upNext but
  // filtered to entries currently inside their own leadDays window (see
  // eligiblePromoEntries above).
  if (bs2) {
    const eligible = eligiblePromoEntries(pool, ch, atMs);
    if (eligible.length) {
      const entry = pickDeterministic(eligible, `promo:${ch.number}`, bs2.ordinal);
      if (entry) {
        const durationS = entryDurationS(entry, 0);
        const windowStart = bs2.fileStartMs;
        const windowEnd = windowStart + durationS * 1000 + entryWaitMs(entry);
        if (atMs >= windowStart && atMs < windowEnd) return { type: 'promo', entry, windowStart, windowEnd };
      }
    }
  }

  // signOff/signOn idents, right at the broadcast-hours boundary — only
  // meaningful when broadcastHours is on (see isWithinBroadcastHours,
  // schedule.js), and only while currently on the air (off-air itself shows
  // the static sign-off card, not a break — see showSignOffCard,
  // playback.js). Both bumpers only ever matter during the "on" state: a
  // sign-off plays in the closing seconds approaching the *next* boundary,
  // a sign-on plays in the opening seconds just after the *previous*
  // boundary (checked separately since a few seconds after sign-on the
  // channel already reads as "on," so the forward-only boundary lookup
  // alone can't find the instant just crossed). The boundary timestamp
  // itself doubles as a per-day-unique pickDeterministic slot index
  // (pickDeterministic only needs distinct integers, not a compact
  // ordinal), so no separate day-counting is needed.
  if (ch.broadcastHours && ch.broadcastHours.enabled && isWithinBroadcastHours(ch, atMs)) {
    const nextB = nextBroadcastHoursBoundary(ch, atMs);
    if (isFinite(nextB)) {
      const win = windowEndingAt(pool, 'signOff', ch, block, `signOff:${ch.number}`, nextB, nextB, SIGNOFF_DURATION_S);
      if (win && atMs >= win.windowStart && atMs < win.windowEnd) return { type: 'signOff', ...win };
    }
    const prevB = prevBroadcastHoursBoundary(ch, atMs);
    if (isFinite(prevB)) {
      const win = windowFor(pool, 'signOn', ch, block, `signOn:${ch.number}`, prevB, prevB, SIGNON_DURATION_S);
      if (win && atMs >= win.windowStart && atMs < win.windowEnd) return { type: 'signOn', ...win };
    }
  }

  return null;
}

// A raw file-boundary instant (bs.fileEndMs) is derived one way here
// (fileStartMs + this file's own probed duration) but, when nextBreakBoundary
// immediately re-queries resolveBreakAt at that exact millisecond, the
// content position there is recomputed the OTHER way — modulo the channel's
// *entire* lineup's summed duration (277 files' worth of non-round
// floating-point seconds, for a channel like this). Those two paths agree
// almost always, but not bit-for-bit every time, and the rare mismatch
// tips the exact-equality check either side of the boundary: resolveBreakAt
// at that instant can come back "still the old file" (the break gets missed
// entirely — nextBreakBoundary's search loop then has to hunt for the next
// candidate after it, which is often a much later boundary, i.e. "commercial
// played later than expected" or seemingly not at all) or "already past this
// segment into the next" (the currently-airing bumper/ad gets judged over
// before it should be — "commercial cut off early"). Nudging every
// file-boundary candidate a few ms past the raw instant sidesteps the
// ambiguity entirely: a few ms is far larger than the float drift in play,
// and trivially small next to any real break's multi-second window.
const BOUNDARY_EPSILON_MS = 50;

// The earliest candidate boundary >= fromMs across every break-producing
// type, ignoring whether a break actually resolves there — used internally
// by nextBreakBoundary to avoid scanning.
function nextCandidateBoundary(ch, fromMs) {
  const source = resolveActiveSource(ch, fromMs);
  if (!source.anchor) return null;
  const candidates = [];
  const posNow = computeSourcePosition(source, fromMs);
  const fileTags = (posNow && posNow.file && posNow.file.tags) || [];

  const cc = resolveActiveCommercials(ch, fromMs, fileTags).commercials;
  if (cc && cc.enabled !== false) {
    const timing = cc.timing || 'interval';
    if (timing === 'interval') {
      const intervalMs = Math.max(1, cc.intervalMinutes || (S.config.commercials && S.config.commercials.intervalMinutes) || 10) * 60000;
      const { slotStart } = intervalSlot(source.anchor, fromMs, intervalMs);
      candidates.push(slotStart + intervalMs);
    } else if (timing === 'everyNMinutes') {
      const bs = boundarySlot(source, fromMs);
      if (bs) {
        const intervalMs = Math.max(1, cc.intervalMinutes || (S.config.commercials && S.config.commercials.intervalMinutes) || 10) * 60000;
        const slotIndexInFile = Math.floor((fromMs - bs.fileStartMs) / intervalMs);
        const nextSlotStart = bs.fileStartMs + (slotIndexInFile + 1) * intervalMs;
        candidates.push(nextSlotStart < bs.fileEndMs ? nextSlotStart : bs.fileEndMs + BOUNDARY_EPSILON_MS);
      }
    } else if (timing === 'breakpoints') {
      const bs = boundarySlot(source, fromMs);
      if (bs) {
        const fileDurMs = bs.fileEndMs - bs.fileStartMs;
        const pts = (cc.breakpoints || []).filter((p) => p > 0 && p < 100).sort((a, b) => a - b);
        const next = pts.map((p) => bs.fileStartMs + (p / 100) * fileDurMs).find((t) => t > fromMs);
        candidates.push(next != null ? next : bs.fileEndMs + BOUNDARY_EPSILON_MS);
      }
    } else if (timing === 'flow') {
      const bs = boundarySlot(source, fromMs);
      if (bs) {
        // Flow mid-breakpoints — exactly parallel to the 'breakpoints' branch above.
        // Without these, nextCandidateBoundary falls through to the generic bs2.fileEndMs
        // below and the timer fires at the wrong instant (end of the whole file instead
        // of the intermediate adPod slot), causing in-show pod breaks to be missed or
        // heavily delayed when nextBreakBoundary's scan loop must brute-force past them.
        if (cc.hasMid && cc.midTiming === 'everyNMinutes' && cc.midIntervalMinutes) {
          const intervalMs = Math.max(1, cc.midIntervalMinutes) * 60000;
          const slotIndexInFile = Math.floor((fromMs - bs.fileStartMs) / intervalMs);
          const nextSlotStart = bs.fileStartMs + (slotIndexInFile + 1) * intervalMs;
          candidates.push(nextSlotStart < bs.fileEndMs ? nextSlotStart : bs.fileEndMs + BOUNDARY_EPSILON_MS);
        } else if (cc.hasMid) {
          const fileDurMs = bs.fileEndMs - bs.fileStartMs;
          const pts = (cc.breakpoints || []).filter((p) => p > 0 && p < 100).sort((a, b) => a - b);
          const next = pts.map((p) => bs.fileStartMs + (p / 100) * fileDurMs).find((t) => t > fromMs);
          candidates.push(next != null ? next : bs.fileEndMs + BOUNDARY_EPSILON_MS);
        } else {
          candidates.push(bs.fileEndMs + BOUNDARY_EPSILON_MS);
        }
      }
    } else {
      const bs = boundarySlot(source, fromMs);
      if (bs) candidates.push(bs.fileEndMs + BOUNDARY_EPSILON_MS);
    }
  }
  const sid = S.config.stationId;
  if (sid && sid.enabled !== false) {
    const intervalMs = Math.max(1, sid.intervalMinutes || 15) * 60000;
    // Same wall-clock-hour anchor as the real resolution above (not
    // source.anchor) so this candidate boundary agrees with what
    // resolveBreakAt will actually find there.
    const hourAnchorMs = Math.floor(fromMs / 3600000) * 3600000;
    const { slotStart } = intervalSlot(hourAnchorMs, fromMs, intervalMs);
    candidates.push(slotStart + intervalMs);
  }
  const tv = S.config.trivia;
  if (tv && tv.enabled) {
    const intervalMs = Math.max(1, tv.intervalMinutes || 20) * 60000;
    const { slotStart } = intervalSlot(source.anchor, fromMs, intervalMs);
    candidates.push(slotStart + intervalMs);
  }
  const bs2 = boundarySlot(source, fromMs);
  if (bs2) candidates.push(bs2.fileEndMs + BOUNDARY_EPSILON_MS);

  if (ch.broadcastHours && ch.broadcastHours.enabled) {
    const boundary = nextBroadcastHoursBoundary(ch, fromMs);
    if (isFinite(boundary)) candidates.push(boundary);
  }

  return candidates.length ? Math.min(...candidates) : null;
}

// Next wall-clock instant where the break state changes — either the end of
// a break already showing at fromMs, or the start of the next one. Mirrors
// schedule.js's nextSourceBoundary (Infinity when nothing's ever scheduled),
// but computed analytically per-type instead of scanned, since a candidate
// boundary is cheap to derive exactly for every type here.
export function nextBreakBoundary(ch, fromMs) {
  const current = resolveBreakAt(ch, fromMs);
  if (current) return current.windowEnd;
  let t = fromMs, safety = 0;
  while (safety < BOUNDARY_SAFETY_CAP) {
    const candidate = nextCandidateBoundary(ch, t);
    if (candidate == null) return Infinity;
    if (resolveBreakAt(ch, candidate)) return candidate;
    t = candidate + 1;
    safety++;
  }
  return Infinity;
}

// A text-only "YOU'RE WATCHING <channel>" station-ID bar (channelId with no
// real pool entry file — see startBreak's isTextOnlyChannelId, playback.js)
// never interrupts content or changes anything on screen: startBreak skips
// swapping player.src for it entirely, it's just an overlay bar on top of
// whatever's already playing. nextBreakStart/prevBreakStart below exist
// specifically for the time machine's "jump to break" control (the VCR
// OSD's [ / ] keys, timemachine.js) — landing on a station-ID instant is a
// no-op from the viewer's perspective ("the clock jumped but nothing
// visibly happened"), and since it fires far more often than real ad
// content (every 15 min by default, wall-clock-aligned), it was winning
// almost every jump. Everything else (commercial, adBreakIn/Out, trivia,
// upNext, promo, signOff/signOn, premiereJingle, localAvail, or a channelId
// that DOES have a real video entry) is a real, visible interruption and
// stays a valid jump target.
function isJumpableBreak(brk) {
  return !(brk.type === 'channelId' && !(brk.entry && brk.entry.file));
}

// Start of the next break strictly after fromMs — for the time machine's
// "jump to next break" control (timemachine.js), not live scheduling.
// Deliberately distinct from nextBreakBoundary: that function answers "when
// does the break STATE next change" (so if fromMs is already inside a break,
// it returns that break's *end*); this one always answers "where's the next
// (jumpable) break's *start*," skipping past whatever's currently playing —
// and past any non-interrupting station-ID bars in between — so repeated
// presses walk forward through consecutive REAL breaks instead of bouncing
// between one break's start and end, or stalling on a station ID.
export function nextBreakStart(ch, fromMs) {
  const current = resolveBreakAt(ch, fromMs);
  let t = current ? current.windowEnd : fromMs;
  let safety = 0;
  while (safety < BOUNDARY_SAFETY_CAP) {
    // t itself can already be inside a break — most commonly the very next
    // segment of the same multi-segment pod we just stepped out of (e.g. an
    // adBreakIn bumper's end is exactly where the commercial that follows it
    // in the same pod begins). nextCandidateBoundary below only knows about
    // file/interval-anchored boundaries, with no notion of "the next segment
    // in an already-active pod" — without this check, the search would skip
    // straight past that segment to the pod's outer file boundary, silently
    // skipping the commercial itself. This is why "jump to next commercial"
    // sometimes did nothing useful: it depended on exactly where within a pod
    // the previous jump had landed.
    const atT = resolveBreakAt(ch, t);
    if (atT) {
      if (isJumpableBreak(atT)) return t;
      t = atT.windowEnd;
      safety++;
      continue;
    }
    const candidate = nextCandidateBoundary(ch, t);
    if (candidate == null) return Infinity;
    const atCandidate = resolveBreakAt(ch, candidate);
    if (atCandidate && isJumpableBreak(atCandidate)) return candidate;
    t = atCandidate ? atCandidate.windowEnd : candidate + 1;
    safety++;
  }
  return Infinity;
}

// The latest break start strictly before `beforeMs`, within the single file
// bs describes — needed because 'interval'/'everyNMinutes'/'breakpoints'
// timing (and the flow mid-show cadence panel built on the same mechanism)
// can land a break anywhere inside a file, not just at its start/end, unlike
// every other break type prevBreakStart otherwise only has to anchor to file
// boundaries for. Rather than re-deriving each timing mode's slot math
// backward (error-prone to keep in sync with the forward math in
// resolveBreakAt/nextCandidateBoundary above), this just re-walks forward
// with the already-correct nextBreakStart, one break at a time, and keeps
// the last one found before beforeMs — cheap since a single file only ever
// holds a handful of breaks. Bounded by BOUNDARY_SAFETY_CAP as a backstop,
// though a real file's break count within itself will never come close.
function latestBreakStartInFile(ch, bs, beforeMs) {
  let latest = null;
  let t = bs.fileStartMs;
  let guard = 0;
  while (t < beforeMs && t < bs.fileEndMs && guard < BOUNDARY_SAFETY_CAP) {
    const start = nextBreakStart(ch, t);
    if (!isFinite(start) || start >= bs.fileEndMs || start >= beforeMs) break;
    latest = start;
    t = start + 1;
    guard++;
  }
  return latest;
}

// Start of the previous break at or before fromMs — the time machine's
// "jump to previous break" control. No cheap analytical form exists walking
// backward (candidates are naturally derived forward from a source's
// anchor), so this walks file boundaries backward instead: each step moves
// to the start of the file immediately before the current probe position
// (bs.fileStartMs - 1 lands 1ms into the previous file) and checks whether
// a break is showing anywhere from a bit before that boundary (a 'pre'/
// signOff-style break, which ends AT the boundary) through a bit after it
// (a 'post'/flow/interval-style break, which starts AT the boundary), plus
// anywhere strictly inside the file itself (latestBreakStartInFile, for the
// timing modes that aren't boundary-anchored at all) — bs.fileEndMs itself
// needs the same BOUNDARY_EPSILON_MS nudge nextBreakStart relies on, for the
// same float-precision reason (see BOUNDARY_EPSILON_MS). Bounded to
// BOUNDARY_SAFETY_CAP files back so a channel with no breaks configured at
// all can't spin forever.
export function prevBreakStart(ch, fromMs) {
  const current = resolveBreakAt(ch, fromMs);
  let probeMs = current ? current.windowStart : fromMs;
  let safety = 0;
  while (safety < BOUNDARY_SAFETY_CAP) {
    // Querying at probeMs - 1 (not probeMs) guarantees landing inside the
    // file *before* probeMs even when probeMs itself sits exactly on a
    // boundary — otherwise this could loop on the same boundary forever.
    const source = resolveActiveSource(ch, probeMs - 1);
    if (!source.anchor) return -Infinity;
    const bs = boundarySlot(source, probeMs - 1);
    if (!bs) return -Infinity;
    // This file's own end (a 'post'/flow-interstep break anchors there), its
    // own start (a 'pre'-timing break, or the previous cycle's cycle-end
    // step, anchors there), and any interior mid-file break (interval/
    // everyNMinutes/breakpoints/flow-mid-cadence) are all real candidate
    // boundaries — checked nearest-to-probeMs first so the *closest* prior
    // break wins.
    const interior = latestBreakStartInFile(ch, bs, probeMs);
    const candidates = [interior, bs.fileEndMs + BOUNDARY_EPSILON_MS, bs.fileStartMs + BOUNDARY_EPSILON_MS]
      .filter((c) => c != null && c < probeMs)
      .sort((a, b) => b - a);
    for (const candidate of candidates) {
      // Returns the nudged candidate itself, not hit.windowStart — that raw
      // value is (for most break types) exactly the same kind of unnudged
      // file-boundary instant BOUNDARY_EPSILON_MS exists to avoid landing
      // on; re-querying resolveBreakAt at it later (e.g. when the time
      // machine reads viewNow() a moment after this jump) can hit that same
      // ambiguity again. candidate is already past it and safely inside the
      // break's window, at most BOUNDARY_EPSILON_MS later than the true start.
      // isJumpableBreak (see nextBreakStart above) skips a non-interrupting
      // station-ID bar the same way forward jumps do — `interior` already
      // comes pre-filtered via latestBreakStartInFile's own nextBreakStart
      // call, but these other two candidates (file end/start) are checked
      // directly against resolveBreakAt and need the same filter here.
      const hit = resolveBreakAt(ch, candidate);
      if (hit && isJumpableBreak(hit)) return candidate;
    }
    probeMs = bs.fileStartMs;
    safety++;
  }
  return -Infinity;
}

// Generous upper bound on breaks enumerated in one guide window — a busy
// channel might show a dozen or so across several hours; this is just a
// runaway-loop backstop, not a realistic ceiling.
const GUIDE_BREAK_SCAN_CAP = 200;

// Every break's [start, end) inside [windowStart, windowEnd) — for the
// on-screen guide (guide.js), which otherwise only ever shows real content
// entries (getChannelSchedule, schedule.js) and silently absorbs any ad
// break into whichever program it interrupts. Deliberately NOT folded into
// getChannelSchedule itself, since that function has other callers
// (program-search.js, the prevue plugin, setup-channels-diagnostics.js)
// that want content-only entries — this is guide.js's own concern. Reuses
// nextBreakStart/resolveBreakAt (both already boundary-driven/analytic —
// see their own comments — not a per-second scan), so this costs one call
// per actual break in the window, not one per second of it.
export function breakEntriesInWindow(ch, windowStart, windowEnd) {
  const raw = [];
  const current = resolveBreakAt(ch, windowStart);
  let t = windowStart;
  if (current) {
    raw.push({ start: current.windowStart, end: current.windowEnd, breakType: current.type });
    t = current.windowEnd;
  }
  let safety = 0;
  while (t < windowEnd && safety < GUIDE_BREAK_SCAN_CAP) {
    const start = nextBreakStart(ch, t);
    if (!isFinite(start) || start >= windowEnd) break;
    const brk = resolveBreakAt(ch, start);
    if (!brk) break; // shouldn't happen given nextBreakStart's own contract, but avoid ever looping forever
    raw.push({ start: brk.windowStart, end: brk.windowEnd, breakType: brk.type });
    t = brk.windowEnd;
    safety++;
  }
  // nextBreakStart/resolveBreakAt walk one POD SEGMENT at a time (bump-in,
  // each commercial, bump-out are each their own entry with their own
  // windowStart/windowEnd — see buildPod/segmentAt above), which is exactly
  // right for the time machine's "jump to next commercial" stepping but
  // wrong for this display: it fragmented a single ~1-2 minute ad pod into
  // several tiny back-to-back guide blocks, each too narrow for its own
  // label, reading as garbled overlapping text. Merge any back-to-back
  // segments (next one starts exactly where the last one ends) into one
  // span before clamping/returning — one "PAID PROGRAMMING" block per pod,
  // matching how a real TV guide shows it.
  const merged = [];
  raw.forEach((entry) => {
    const last = merged[merged.length - 1];
    if (last && entry.start <= last.end) {
      last.end = Math.max(last.end, entry.end);
    } else {
      merged.push({ start: entry.start, end: entry.end, breakType: entry.breakType });
    }
  });
  return merged
    .map((entry) => ({
      start: Math.max(entry.start, windowStart),
      end: Math.min(entry.end, windowEnd),
      isBreak: true,
      breakType: entry.breakType,
    }))
    .filter((entry) => entry.end > entry.start);
}
