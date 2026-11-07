// The SPLICER page's cut editor, as data (setup/splicer.js draws it). Pure:
// no DOM, no host calls, so tests/splicer.test.js runs it directly.
//
// One model per recording: the cuts the detectors found (each a gap
// `from`..`to` around a boundary `at`, see main/splicer/cuts.js), which of
// them to keep, and what the person said about each clip — its name and
// where it goes. Clips are never stored: they are what the kept cuts leave
// between them, recomputed on every change, so nudging a cut can't leave a
// clip list out of step with it. A clip's name and category are keyed by the
// two cuts around it, so they survive nudges and are dropped when those cuts
// change (a merge makes a different clip).
//
// clipsFromCuts mirrors main/splicer/cuts.js; the test checks they agree.

export const CATEGORIES = ['episodes', 'commercials', 'bumpers', 'skip'];

const MIN_CUT_SPACING = 0.2;

/**
 * Normalizes a cut: `at` from `at` or `time`, and a gap that always contains it.
 * @param {object} c A detected or saved cut.
 * @returns {object} A copy with numeric `at`, `from` and `to`.
 */
function asCut(c) {
  const at = Number(c.at ?? c.time);
  const from = Number.isFinite(Number(c.from)) ? Number(c.from) : at;
  const to = Number.isFinite(Number(c.to)) ? Number(c.to) : at;
  return { ...c, at, from: Math.min(from, at), to: Math.max(to, at) };
}

/**
 * Lists the clips that a set of cuts leaves between them.
 * @param {Array<object>} cutList The cuts, in any order.
 * @param {number} duration The recording length in seconds.
 * @param {object} [opts] Options.
 * @param {boolean} [opts.trimGaps=true] Leave each cut's gap out of the clips.
 * @param {?object} [opts.edges] `{ start, end }` to use instead of 0 and the duration.
 * @returns {Array<object>} `{ start, end, duration, prevId, nextId }` per clip of at least 0.05 s.
 */
export function clipsFromCuts(cutList, duration, { trimGaps = true, edges = null } = {}) {
  const cuts = cutList.map(asCut).sort((a, b) => a.at - b.at);
  const first = edges ? edges.start : 0;
  const last = edges ? edges.end : duration;
  const clips = [];
  for (let i = 0; i <= cuts.length; i++) {
    const prev = cuts[i - 1];
    const next = cuts[i];
    const start = prev ? (trimGaps ? prev.to : prev.at) : first;
    const end = next ? (trimGaps ? next.from : next.at) : last;
    if (end - start >= 0.05) clips.push({ start, end, duration: end - start, prevId: prev ? prev.id : 'start', nextId: next ? next.id : 'end' });
  }
  return clips;
}

/**
 * Guesses a clip's category from its length.
 * @param {number} duration The clip length in seconds.
 * @param {object} [opts] Thresholds.
 * @param {number} [opts.bumperMax=20] The longest bumper, in seconds.
 * @param {number} [opts.commercialMax=120] The longest commercial, in seconds.
 * @returns {string} `'bumpers'`, `'commercials'` or `'episodes'`.
 */
export function classify(duration, { bumperMax = 20, commercialMax = 120 } = {}) {
  if (duration <= bumperMax) return 'bumpers';
  if (duration <= commercialMax) return 'commercials';
  return 'episodes';
}

let nextCutId = 1;
/**
 * Makes a new cut id.
 * @returns {string} The id.
 */
const newId = () => `c${nextCutId++}`;

/**
 * fileResult: one file's detect/review result from splice.js.
 * Builds the cut editor's model for one recording.
 * @param {object} fileResult One file's detect/review result from splice.js.
 * @returns {object} The model: source, duration, fps, edges, cuts and per-clip meta.
 */
export function createModel(fileResult) {
  const thumbs = new Map((fileResult.candidates || []).map((c) => [c.index, c.thumbPath]));
  return {
    sourcePath: fileResult.sourcePath,
    sourceFile: fileResult.sourceFile,
    duration: fileResult.duration,
    fps: fileResult.fps || 30,
    edges: fileResult.edges || null,
    cuts: (fileResult.cuts || []).map((c) => ({
      ...asCut(c), id: newId(), kind: c.kind || 'manual', kept: true, moved: false, thumbPath: thumbs.get(c.index) || null,
    })),
    meta: {},
  };
}

/**
 * Returns the kept cuts in time order.
 * @param {object} model The cut editor model.
 * @returns {Array<object>} The kept cuts.
 */
export const keptCuts = (model) => model.cuts.filter((c) => c.kept).sort((a, b) => a.at - b.at);
/**
 * Returns the key a clip's name and category are stored under.
 * @param {object} clip A clip.
 * @returns {string} The ids of the cuts either side, joined.
 */
export const clipKey = (clip) => `${clip.prevId}|${clip.nextId}`;

/**
 * The clips as they stand: [{ key, index, start, end, duration, category,
 * name, autoCategory }].
 * @param {object} model The cut editor model.
 * @param {object} [opts] Options.
 * @param {boolean} [opts.trimGaps=true] Leave each cut's gap out of the clips.
 * @param {number} [opts.bumperMax] The longest bumper, in seconds.
 * @param {number} [opts.commercialMax] The longest commercial, in seconds.
 * @returns {Array<object>} The clips.
 */
export function clipsOf(model, { trimGaps = true, bumperMax, commercialMax } = {}) {
  return clipsFromCuts(keptCuts(model), model.duration, { trimGaps, edges: model.edges }).map((clip, i) => {
    const key = clipKey(clip);
    const meta = model.meta[key] || {};
    const autoCategory = classify(clip.duration, { bumperMax, commercialMax });
    return { ...clip, key, index: i + 1, autoCategory, category: meta.category || autoCategory, name: meta.name || '' };
  });
}

/**
 * Merges fields into a clip's saved name and category.
 * @param {object} model The cut editor model, changed in place.
 * @param {string} key The clip key.
 * @param {object} fields `name` and/or `category`.
 */
export function setClipMeta(model, key, fields) {
  model.meta[key] = { ...(model.meta[key] || {}), ...fields };
}

/**
 * Moves a cut (its whole gap) by delta seconds, staying clear of the kept
 * cuts either side and of the ends of the recording. Returns the new `at`.
 * @param {object} model The cut editor model, changed in place.
 * @param {string} id The cut id.
 * @param {number} delta Seconds to move; negative moves earlier.
 * @returns {?number} The new `at`, or `null` when there is no such cut.
 */
export function moveCut(model, id, delta) {
  const cut = model.cuts.find((c) => c.id === id);
  if (!cut) return null;
  const kept = keptCuts(model).filter((c) => c.id !== id);
  const prev = kept.filter((c) => c.at < cut.at).pop();
  const next = kept.find((c) => c.at > cut.at);
  const lo = Math.max(0, prev ? prev.to + MIN_CUT_SPACING : 0) + (cut.at - cut.from);
  const hi = Math.min(model.duration, next ? next.from - MIN_CUT_SPACING : model.duration) - (cut.to - cut.at);
  const at = Math.min(hi, Math.max(lo, cut.at + delta));
  const shift = at - cut.at;
  if (Math.abs(shift) < 1e-6) return cut.at;
  // A clip keyed on this cut keeps its name: the key is the cut's id.
  cut.at += shift; cut.from += shift; cut.to += shift;
  cut.moved = true;
  return cut.at;
}

/**
 * A new zero-length cut at t, unless one is already that close.
 * @param {object} model The cut editor model, changed in place.
 * @param {number} t The time in seconds.
 * @returns {?object} The new cut, or `null` when it is too close to another.
 */
export function addCut(model, t) {
  const at = Math.min(model.duration - MIN_CUT_SPACING, Math.max(MIN_CUT_SPACING, Number(t)));
  if (!Number.isFinite(at)) return null;
  if (keptCuts(model).some((c) => at >= c.from - MIN_CUT_SPACING && at <= c.to + MIN_CUT_SPACING)) return null;
  const cut = { id: newId(), at, from: at, to: at, kind: 'manual', kept: true, moved: false, thumbPath: null };
  model.cuts.push(cut);
  model.cuts.sort((a, b) => a.at - b.at);
  return cut;
}

/**
 * Keeps or drops a cut. A hand-added cut that is dropped is removed entirely.
 * @param {object} model The cut editor model, changed in place.
 * @param {string} id The cut id.
 * @param {boolean} kept Whether to keep it.
 */
export function setKept(model, id, kept) {
  const cut = model.cuts.find((c) => c.id === id);
  if (!cut) return;
  // A cut added by hand and then removed is simply gone.
  if (!kept && cut.kind === 'manual' && !cut.thumbPath) model.cuts = model.cuts.filter((c) => c.id !== id);
  else cut.kept = kept;
}

/**
 * Joins a clip to the one after it by dropping the cut between them.
 * @param {object} model The cut editor model, changed in place.
 * @param {object} clip The clip.
 */
export function mergeWithNext(model, clip) {
  if (clip.nextId && clip.nextId !== 'end') setKept(model, clip.nextId, false);
}

/**
 * "Series - S01E01", "Series - S01E02", … for the episode clips, in order.
 * @param {Array<object>} clips The clips.
 * @param {string} series The series name; blank gives the code alone.
 * @param {object} [opts] Numbering.
 * @param {number} [opts.season=1] The season number.
 * @param {number} [opts.episode=1] The first episode number.
 * @returns {object} Clip key to name, for the episode clips.
 */
export function episodeNames(clips, series, { season = 1, episode = 1 } = {}) {
  const pad = (n) => String(n).padStart(2, '0');
  const names = {};
  let n = episode;
  clips.forEach((clip) => {
    if (clip.category !== 'episodes') return;
    const code = `S${pad(season)}E${pad(n)}`;
    names[clip.key] = series ? `${series} - ${code}` : code;
    n += 1;
  });
  return names;
}

/**
 * What splice.js --plan takes.
 * @param {Array<object>} models Cut editor models.
 * @param {object} [opts] `clipsOf` options.
 * @returns {object} `{ files }`, each with its source path and clips.
 */
export function planFor(models, opts = {}) {
  return {
    files: models.map((model) => ({
      sourcePath: model.sourcePath,
      clips: clipsOf(model, opts).map((clip) => ({ start: clip.start, end: clip.end, category: clip.category, ...(clip.name ? { name: clip.name } : {}) })),
    })),
  };
}

/**
 * Counts clips per category.
 * @param {Array<object>} clips The clips.
 * @returns {object} Counts keyed by category.
 */
export function counts(clips) {
  const out = { episodes: 0, commercials: 0, bumpers: 0, skip: 0 };
  clips.forEach((clip) => { out[clip.category] = (out[clip.category] || 0) + 1; });
  return out;
}
