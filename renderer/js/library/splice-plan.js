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

function asCut(c) {
  const at = Number(c.at ?? c.time);
  const from = Number.isFinite(Number(c.from)) ? Number(c.from) : at;
  const to = Number.isFinite(Number(c.to)) ? Number(c.to) : at;
  return { ...c, at, from: Math.min(from, at), to: Math.max(to, at) };
}

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

export function classify(duration, { bumperMax = 20, commercialMax = 120 } = {}) {
  if (duration <= bumperMax) return 'bumpers';
  if (duration <= commercialMax) return 'commercials';
  return 'episodes';
}

let nextCutId = 1;
const newId = () => `c${nextCutId++}`;

// fileResult: one file's detect/review result from splice.js.
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

export const keptCuts = (model) => model.cuts.filter((c) => c.kept).sort((a, b) => a.at - b.at);
export const clipKey = (clip) => `${clip.prevId}|${clip.nextId}`;

// The clips as they stand: [{ key, index, start, end, duration, category,
// name, autoCategory }].
export function clipsOf(model, { trimGaps = true, bumperMax, commercialMax } = {}) {
  return clipsFromCuts(keptCuts(model), model.duration, { trimGaps, edges: model.edges }).map((clip, i) => {
    const key = clipKey(clip);
    const meta = model.meta[key] || {};
    const autoCategory = classify(clip.duration, { bumperMax, commercialMax });
    return { ...clip, key, index: i + 1, autoCategory, category: meta.category || autoCategory, name: meta.name || '' };
  });
}

export function setClipMeta(model, key, fields) {
  model.meta[key] = { ...(model.meta[key] || {}), ...fields };
}

// Moves a cut (its whole gap) by delta seconds, staying clear of the kept
// cuts either side and of the ends of the recording. Returns the new `at`.
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

// A new zero-length cut at t, unless one is already that close.
export function addCut(model, t) {
  const at = Math.min(model.duration - MIN_CUT_SPACING, Math.max(MIN_CUT_SPACING, Number(t)));
  if (!Number.isFinite(at)) return null;
  if (keptCuts(model).some((c) => at >= c.from - MIN_CUT_SPACING && at <= c.to + MIN_CUT_SPACING)) return null;
  const cut = { id: newId(), at, from: at, to: at, kind: 'manual', kept: true, moved: false, thumbPath: null };
  model.cuts.push(cut);
  model.cuts.sort((a, b) => a.at - b.at);
  return cut;
}

export function setKept(model, id, kept) {
  const cut = model.cuts.find((c) => c.id === id);
  if (!cut) return;
  // A cut added by hand and then removed is simply gone.
  if (!kept && cut.kind === 'manual' && !cut.thumbPath) model.cuts = model.cuts.filter((c) => c.id !== id);
  else cut.kept = kept;
}

// Joins a clip to the one after it by dropping the cut between them.
export function mergeWithNext(model, clip) {
  if (clip.nextId && clip.nextId !== 'end') setKept(model, clip.nextId, false);
}

// "Series - S01E01", "Series - S01E02", … for the episode clips, in order.
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

// What splice.js --plan takes.
export function planFor(models, opts = {}) {
  return {
    files: models.map((model) => ({
      sourcePath: model.sourcePath,
      clips: clipsOf(model, opts).map((clip) => ({ start: clip.start, end: clip.end, category: clip.category, ...(clip.name ? { name: clip.name } : {}) })),
    })),
  };
}

export function counts(clips) {
  const out = { episodes: 0, commercials: 0, bumpers: 0, skip: 0 };
  clips.forEach((clip) => { out[clip.category] = (out[clip.category] || 0) + 1; });
  return out;
}
