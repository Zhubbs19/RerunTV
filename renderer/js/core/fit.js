// Fit to time slots: makes each program on a channel end on the next :00 or
// :30 (or the hour, with a 60-minute grid) instead of at an odd time like
// 10:43, the way a real station formats a show or movie for its slot.
//
// It works on the schedule maths itself, not on playback, so the guide, the
// time machine and live TV all agree. resolveActiveSource (schedule.js)
// passes every source through applyFit, which:
//   - floors the source's anchor to the grid (local time), and
//   - swaps each file for a copy whose `duration` is its AIRING slot (a
//     multiple of the grid, counted from the loop start) and whose `fit` is
//     the plan for filling that slot.
// Every existing loop walker (computeSourcePosition, walkSourceSchedule,
// getChannelSchedule) then lands programs on the grid with no change of its
// own. The plan says what airs at each second of the slot: program at a
// (possibly sped-up) rate, sped-up end credits, or a break. mapFitAir turns
// "seconds into the slot" into "seconds into the video file".
//
// A program is either EXTENDED to the next boundary (the spare time becomes
// breaks: real ads and bumpers from the pool, or placeholder slots where
// they would go) or SHORTENED to the previous one by speeding up its end
// credits and, if that isn't enough, playing the whole program a few percent
// fast ("time compression"). Shortening is capped (maxTrimMinutes,
// maxSpeedupPct, creditsMaxSqueezeSeconds); anything that would need more
// is extended instead. Pure: depends only on (files, settings), a file's
// fades to black (breakMarks) included.
import { S } from './state.js';
import { fadeSnapWindowMs, fadesOf, snapOffsetsToFades } from './fades.js';

export const FIT_DEFAULTS = Object.freeze({
  enabled: false,
  gridMinutes: 30,
  strategy: 'auto', // 'auto' | 'extend' | 'trim'
  maxTrimMinutes: 5,
  maxSpeedupPct: 4,
  minBreakMinutesPerHalfHour: 0,
  breakPlacement: 'spread', // 'spread' | 'end'
  breaksPerHalfHour: 2,
  minProgramMinutes: 10,
  fill: 'pool', // 'pool' | 'placeholders'
  placeholders: true,
  placeholderSpotSeconds: 30,
  placeholderBumperSeconds: 5,
  bumpers: true,
  disclaimer: true,
  disclaimerText: '',
  creditsApplies: 'fit', // 'always' | 'movies' | 'fit' | 'never'
  creditsRate: 3,
  creditsLeadSeconds: 90,
  creditsMaxSqueezeSeconds: 180,
  creditsLayout: 'side', // 'side' | 'right' | 'corner' | 'banner' (playback/broadcast-fx.js)
});

export const FIT_STRATEGIES = ['auto', 'extend', 'trim'];
export const CREDITS_APPLIES = ['always', 'movies', 'fit', 'never'];
export const DEFAULT_FIT_DISCLAIMER = 'THIS PROGRAM HAS BEEN MODIFIED FROM ITS ORIGINAL VERSION. IT HAS BEEN FORMATTED TO RUN IN THE TIME ALLOTTED.';
export const DEFAULT_FIT_MOVIE_DISCLAIMER = 'THIS FILM HAS BEEN MODIFIED FROM ITS ORIGINAL VERSION. IT HAS BEEN FORMATTED FOR TELEVISION AND EDITED TO RUN IN THE TIME ALLOTTED.';

// A break shorter than this is held on the program's last frame instead of
// being filled (a few frames of rounding, not a real break).
export const MIN_FIT_BREAK_S = 1;
// Each spread break is at least this long, so a small amount of spare time
// becomes one break rather than several tiny ones.
const MIN_SPREAD_BREAK_S = 60;

function clampNum(v, lo, hi, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

function given(v) {
  return v != null && v !== '';
}

// Clamps every field to a sane range so a hand-edited or half-saved config
// can't produce a negative slot or a divide by zero.
export function normalizeFitConfig(raw) {
  const r = raw || {};
  const d = FIT_DEFAULTS;
  return {
    gridMinutes: Number(r.gridMinutes) === 60 ? 60 : 30,
    strategy: FIT_STRATEGIES.includes(r.strategy) ? r.strategy : d.strategy,
    maxTrimMinutes: clampNum(r.maxTrimMinutes, 0, 30, d.maxTrimMinutes),
    maxSpeedupPct: clampNum(r.maxSpeedupPct, 0, 10, d.maxSpeedupPct),
    minBreakMinutesPerHalfHour: clampNum(r.minBreakMinutesPerHalfHour, 0, 15, d.minBreakMinutesPerHalfHour),
    breakPlacement: r.breakPlacement === 'end' ? 'end' : 'spread',
    breaksPerHalfHour: Math.round(clampNum(r.breaksPerHalfHour, 1, 6, d.breaksPerHalfHour)),
    minProgramMinutes: clampNum(r.minProgramMinutes, 0, 60, d.minProgramMinutes),
    fill: r.fill === 'placeholders' ? 'placeholders' : 'pool',
    placeholders: r.placeholders !== false,
    placeholderSpotSeconds: clampNum(r.placeholderSpotSeconds, 5, 120, d.placeholderSpotSeconds),
    placeholderBumperSeconds: clampNum(r.placeholderBumperSeconds, 0, 30, d.placeholderBumperSeconds),
    bumpers: r.bumpers !== false,
    disclaimer: r.disclaimer !== false,
    disclaimerText: typeof r.disclaimerText === 'string' ? r.disclaimerText.trim() : '',
    creditsApplies: CREDITS_APPLIES.includes(r.creditsApplies) ? r.creditsApplies : d.creditsApplies,
    creditsRate: clampNum(r.creditsRate, 1, 8, d.creditsRate),
    creditsLeadSeconds: clampNum(r.creditsLeadSeconds, 0, 1200, d.creditsLeadSeconds),
    creditsMaxSqueezeSeconds: clampNum(r.creditsMaxSqueezeSeconds, 0, 1800, d.creditsMaxSqueezeSeconds),
    creditsLayout: ['side', 'right', 'corner', 'banner'].includes(r.creditsLayout) ? r.creditsLayout : d.creditsLayout,
  };
}

// The box-wide settings (S.config.programFit) with a channel's own
// (ch.programFit) laid over them, or null when fitting is off for this
// channel. ch.programFit.mode: 'on' | 'off' | unset (follow the box). For the
// credits fields, a channel's END CREDITS panel (ch.creditsSpeedup, while it
// is on) sits between the two: ch.programFit, then ch.creditsSpeedup, then
// the box.
export function fitConfigFor(ch) {
  if (!ch) return null;
  const box = (S.config && S.config.programFit) || {};
  const own = ch.programFit || {};
  if (own.mode === 'off') return null;
  if (own.mode !== 'on' && !box.enabled) return null;
  const cs = ch.creditsSpeedup && ch.creditsSpeedup.enabled ? ch.creditsSpeedup : {};
  const fromCredits = {
    creditsRate: cs.rate, creditsLeadSeconds: cs.leadSeconds, creditsApplies: cs.applies, creditsMaxSqueezeSeconds: cs.maxSqueezeSeconds,
  };
  const merged = {};
  for (const key of Object.keys(FIT_DEFAULTS)) {
    if (given(own[key])) merged[key] = own[key];
    else if (given(fromCredits[key])) merged[key] = fromCredits[key];
    else merged[key] = given(box[key]) ? box[key] : FIT_DEFAULTS[key];
  }
  return normalizeFitConfig(merged);
}

function fileDurationS(file) {
  const d = Number(file && file.duration);
  return Number.isFinite(d) && d > 0 ? d : 0;
}

function isMovie(file) {
  return !!(file && file.facets && file.facets.contentType === 'movie');
}

// Where a spread layout's n-1 in-program breaks go, in seconds of the
// program (before its credits): even points, each moved to a nearby fade to
// black while PROGRAMMING › CADENCE & PRESETS › "Line up mid-show breaks with
// fades" is on (core/fades.js). A point with no fade in reach keeps its even
// spot; one crowded out by its neighbour is dropped, and its time goes to the
// break after the program.
function spreadBreakPoints(file, body, n) {
  const even = [];
  for (let k = 1; k < n; k++) even.push((body * k) / n);
  const windowMs = even.length ? fadeSnapWindowMs(S.config) : 0;
  const fades = windowMs ? fadesOf(file) : null;
  if (!fades) return even;
  return snapOffsetsToFades(even.map((s) => s * 1000), fades, windowMs)
    .filter((ms) => ms != null && ms > 0 && ms < body * 1000)
    .map((ms) => ms / 1000);
}

// The plan for one program starting cursorS seconds into a grid-aligned loop.
// Returns null when the file airs as is: zero length, or shorter than
// minProgramMinutes (a run of shorts is fitted as a group, by whichever full
// program follows it; the loop's last file is always fitted so the loop
// itself lasts a whole number of grid slots).
export function planFit(file, cursorS, isLast, cfg) {
  const d = fileDurationS(file);
  if (d <= 0) return null;
  if (!isLast && d < cfg.minProgramMinutes * 60) return null;
  const grid = cfg.gridMinutes * 60;
  const usable = 1 - cfg.minBreakMinutesPerHalfHour / 30;

  const leadRaw = file.creditsLeadS != null && file.creditsLeadS !== '' ? Number(file.creditsLeadS) : cfg.creditsLeadSeconds;
  const lead = Math.min(Math.max(0, Number.isFinite(leadRaw) ? leadRaw : 0), d / 2);
  const creditsOk = cfg.creditsApplies !== 'never' && lead > 0 && cfg.creditsRate > 1
    && (cfg.creditsApplies !== 'movies' || isMovie(file));
  const leadUsed = creditsOk ? lead : 0;
  const creditsMax = creditsOk ? Math.min(lead * (1 - 1 / cfg.creditsRate), cfg.creditsMaxSqueezeSeconds) : 0;
  // 'always'/'movies': the credits are squeezed whether or not the fit needs it.
  const forced = creditsOk && cfg.creditsApplies !== 'fit' ? creditsMax : 0;
  const body = d - leadUsed;
  const compressMax = body * (1 - 1 / (1 + cfg.maxSpeedupPct / 100));
  const air0 = d - forced;

  let upEnd = Math.ceil((cursorS + air0 / usable) / grid - 1e-9) * grid;
  if (upEnd <= cursorS) upEnd += grid;
  const upSlot = upEnd - cursorS;
  const downSlot = upSlot - grid;
  const trimNeeded = air0 - downSlot * usable;
  const extendFill = upSlot * usable - air0;
  const canTrim = cfg.strategy !== 'extend' && downSlot > 0 && trimNeeded > 0
    && trimNeeded <= cfg.maxTrimMinutes * 60 + 1e-6
    && trimNeeded <= (creditsMax - forced) + compressMax + 1e-6;
  // 'auto' shortens only when that changes the program less than extending
  // would; 'trim' shortens whenever the caps allow it.
  const trim = canTrim && (cfg.strategy === 'trim' || trimNeeded < extendFill);

  let creditsSave = forced;
  let compressSave = 0;
  let slot = upSlot;
  if (trim) {
    slot = downSlot;
    const fromCredits = Math.min(trimNeeded, creditsMax - forced);
    creditsSave += fromCredits;
    compressSave = Math.max(0, trimNeeded - fromCredits);
  }
  const rateCredits = creditsSave > 0 ? leadUsed / (leadUsed - creditsSave) : 1;
  const rateBody = compressSave > 0 ? body / (body - compressSave) : 1;
  const airS = body / rateBody + leadUsed / rateCredits;
  const breakTotal = Math.max(0, slot - airS);

  // Break layout. 'spread' puts n-1 breaks inside the program at even points
  // and the last one after it (before the next program); 'end' puts all the
  // spare time after the program.
  let n = 1;
  if (cfg.breakPlacement === 'spread') {
    n = Math.max(1, Math.round((slot / 1800) * cfg.breaksPerHalfHour));
    n = Math.max(1, Math.min(n, Math.floor(breakTotal / MIN_SPREAD_BREAK_S)));
  }
  const breakLen = Math.floor(breakTotal / n);
  const points = spreadBreakPoints(file, body, n);
  const segments = [];
  let air = 0;
  let content = 0;
  const pushContent = (toContent, rate) => {
    if (toContent <= content) return;
    const len = (toContent - content) / rate;
    segments.push({ kind: 'content', airStart: air, airEnd: air + len, contentStart: content, rate });
    air += len;
    content = toContent;
  };
  const pushBreak = (len, index) => {
    if (len <= 0.001) return;
    segments.push({ kind: 'break', airStart: air, airEnd: air + len, contentAt: content, index });
    air += len;
  };
  points.forEach((at, i) => {
    pushContent(at, rateBody);
    pushBreak(breakLen, i);
  });
  pushContent(body, rateBody);
  if (leadUsed > 0) {
    const creditsSeg = { kind: 'credits', airStart: air, airEnd: air + leadUsed / rateCredits, contentStart: content, rate: rateCredits };
    segments.push(creditsSeg);
    air = creditsSeg.airEnd;
    content = d;
  }
  // The last break takes whatever is left, so the segments end exactly on the slot.
  pushBreak(slot - air, points.length);

  return {
    slotS: slot,
    contentS: d,
    airS,
    mode: trim ? 'trim' : 'extend',
    trimmed: trim,
    savedS: creditsSave + compressSave,
    rateBody,
    rateCredits,
    creditsAtS: leadUsed > 0 ? body : null,
    breakS: breakTotal,
    segments,
  };
}

// Where the airing is `airS` seconds into a fitted slot:
//   { kind: 'content' | 'credits', contentS, rate, segAirEnd } or
//   { kind: 'break', index, contentS (the frame the program stopped on), segAirStart, segAirEnd }.
export function mapFitAir(plan, airS) {
  const segs = plan.segments;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (airS < s.airEnd || i === segs.length - 1) {
      if (s.kind === 'break') {
        return { kind: 'break', index: s.index, contentS: s.contentAt, segAirStart: s.airStart, segAirEnd: s.airEnd };
      }
      const into = Math.max(0, airS - s.airStart);
      return {
        kind: s.kind, contentS: Math.min(plan.contentS, s.contentStart + into * s.rate),
        rate: s.rate, segAirStart: s.airStart, segAirEnd: s.airEnd,
      };
    }
  }
  return { kind: 'content', contentS: 0, rate: 1, segAirStart: 0, segAirEnd: 0 };
}

// The file list with every file swapped for its fitted copy. Cached per file
// array, thrown away whenever S.configGeneration moves on (CLAUDE.md, "Config
// mutation") or the settings differ, so an edit can never leave a stale fit
// on the air.
let fitCache = new WeakMap();
let fitCacheGen = -1;

export function fittedFiles(files, cfg) {
  if (S.configGeneration !== fitCacheGen) {
    fitCache = new WeakMap();
    fitCacheGen = S.configGeneration;
  }
  const sig = JSON.stringify(cfg);
  const hit = fitCache.get(files);
  if (hit && hit.sig === sig) return hit.files;
  let lastIdx = -1;
  files.forEach((f, i) => { if (fileDurationS(f) > 0) lastIdx = i; });
  let cursor = 0;
  const out = files.map((f, i) => {
    const plan = planFit(f, cursor, i === lastIdx, cfg);
    if (!plan) {
      cursor += fileDurationS(f);
      return f;
    }
    cursor += plan.slotS;
    return { ...f, duration: plan.slotS, fit: plan };
  });
  fitCache.set(files, { sig, files: out });
  return out;
}

// Floors an anchor to the grid in local time, so slot boundaries are the
// clock's own :00 and :30.
export function alignToGrid(anchorMs, gridMinutes) {
  const d = new Date(anchorMs);
  d.setMinutes(Math.floor(d.getMinutes() / gridMinutes) * gridMinutes, 0, 0);
  return d.getTime();
}

// The source as it airs with fitting applied, or the source unchanged when
// fitting is off for this channel.
export function applyFit(ch, source) {
  if (!source || !source.files || !source.files.length || !source.anchor) return source;
  const cfg = fitConfigFor(ch);
  if (!cfg) return source;
  return { ...source, files: fittedFiles(source.files, cfg), anchor: alignToGrid(source.anchor, cfg.gridMinutes), fit: cfg };
}

// The seconds into the video file a position from computeSourcePosition
// means: its fitted content offset when the file is fitted, else its offset.
export function seekOffsetOf(pos) {
  if (!pos) return 0;
  return pos.contentOffset != null ? pos.contentOffset : pos.offset;
}

// The playback rate the program runs at for a position (1 unless fitted).
export function playbackRateOf(pos) {
  return pos && pos.fitAt && pos.fitAt.kind !== 'break' ? pos.fitAt.rate : 1;
}

// The disclaimer card text for a fitted program, or null when nothing was cut.
export function fitDisclaimerFor(cfg, file) {
  if (!cfg || !cfg.disclaimer || !file || !file.fit || !file.fit.trimmed) return null;
  if (cfg.disclaimerText) return cfg.disclaimerText.toUpperCase();
  return isMovie(file) ? DEFAULT_FIT_MOVIE_DISCLAIMER : DEFAULT_FIT_DISCLAIMER;
}
