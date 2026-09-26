// The Video Splicer's decisions, with no ffmpeg and no disk: argument parsing,
// merging the detectors' signals into cuts, turning cuts into clips, sorting
// clips into bumpers / commercials / episodes, finding logo runs in a list of
// per-frame scores, and matching repeated clips. splice.js, logo-detect.js
// and tests/splicer.test.js use these; renderer/js/library/splice-plan.js
// mirrors clipsFromCuts for the SPLICER page's editor (the test checks they
// agree).
//
// A cut is { at, from, to, kind }: `at` is where the boundary is, `from`..`to`
// the gap around it (a stretch of black or silence) that belongs to neither
// clip. A scene change or a logo card is a gap of zero length.
'use strict';

const DEFAULT_VIDEO_EXTS = ['mp4', 'mkv', 'mov', 'avi', 'ts', 'm4v', 'wmv'];

// Two detections closer than this are the same boundary.
const SAME_BOUNDARY_SEC = 1.5;
// A black stretch this close to either end of the recording is lead-in or
// run-out, trimmed off the first or last clip rather than cut at.
const EDGE_SEC = 0.25;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function fmtTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = (seconds % 60).toFixed(3);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(6, '0')}`;
}

const gap = (from, to, kind) => ({ at: (from + to) / 2, from, to, kind });
const point = (at, kind) => ({ at, from: at, to: at, kind });

// Old candidates.json files and hand-written plans hold bare times.
function asCut(c) {
  if (typeof c === 'number') return point(c, 'manual');
  const at = Number(c.at ?? c.time);
  const from = Number.isFinite(Number(c.from)) ? Number(c.from) : at;
  const to = Number.isFinite(Number(c.to)) ? Number(c.to) : at;
  return { ...c, at, from: Math.min(from, at), to: Math.max(to, at), kind: c.kind || 'manual' };
}

// Black-frame gaps are the strongest signal. Logo-match cuts are next —
// sparse but very low false-positive rate when a reference is given.
// Scene-change cuts catch hard visual cuts with no black frame (common on
// digitally spliced masters). Silence gaps fill in remaining audio-only
// cuts. Each weaker signal is only added where a stronger one hasn't
// already claimed that spot.
//   signals: { black: [{from,to}], silence: [{from,to}], scene: [t], logo: [t] }
function mergeBoundaries(signals, duration, minClip) {
  const all = (signals.black || []).map((r) => gap(r.from, r.to, 'black'));
  const weaker = [
    (signals.logo || []).map((t) => point(t, 'logo')),
    (signals.scene || []).map((t) => point(t, 'scene')),
    (signals.silence || []).map((r) => gap(r.from, r.to, 'silence')),
  ];
  for (const list of weaker) {
    for (const cut of list) {
      if (!all.some((claimed) => Math.abs(claimed.at - cut.at) < SAME_BOUNDARY_SEC)) all.push(cut);
    }
  }
  all.sort((a, b) => a.at - b.at);

  // Collapse cuts within minClip of each other, and drop anything within
  // minClip of the start/end of the file.
  const cuts = [];
  for (const c of all) {
    if (c.at < minClip || c.at > duration - minClip) continue;
    if (cuts.length && c.at - cuts[cuts.length - 1].at < minClip) continue;
    cuts.push(c);
  }
  return cuts;
}

// Black at the very start or end of the recording (lead-in, run-out).
function edgeTrim(blackRuns, duration) {
  let start = 0;
  let end = duration;
  for (const r of blackRuns || []) {
    if (r.from <= EDGE_SEC && r.to < duration) start = Math.max(start, r.to);
    if (r.to >= duration - EDGE_SEC && r.from > 0) end = Math.min(end, r.from);
  }
  return end - start > 1 ? { start, end } : { start: 0, end: duration };
}

// Clips between cuts. trimGaps: a clip ends where a gap starts and the next
// begins where it ends, so neither keeps black or silence from the break.
// Off, both meet in the middle of the gap. A clip too short to keep is left
// out; its time stays in the gaps.
function clipsFromCuts(cutList, duration, { trimGaps = true, edges = null } = {}) {
  const cuts = cutList.map(asCut).sort((a, b) => a.at - b.at);
  const first = edges ? edges.start : 0;
  const last = edges ? edges.end : duration;
  const clips = [];
  for (let i = 0; i <= cuts.length; i++) {
    const prev = cuts[i - 1];
    const next = cuts[i];
    const start = prev ? (trimGaps ? prev.to : prev.at) : first;
    const end = next ? (trimGaps ? next.from : next.at) : last;
    if (end - start >= 0.05) clips.push({ start, end, duration: end - start });
  }
  return clips;
}

function classify(durationSec, opts) {
  if (durationSec <= opts.bumperMax) return 'bumpers';
  if (durationSec <= opts.commercialMax) return 'commercials';
  return 'episodes';
}

function meanAbsDiff(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

// Runs of consecutive matching frames at least minRunFrames long, as
// { startFrame, endFrame } (inclusive).
function matchRuns(isMatch, minRunFrames) {
  const runs = [];
  let runStart = null;
  for (let i = 0; i <= isMatch.length; i++) {
    const match = i < isMatch.length && isMatch[i];
    if (match && runStart === null) {
      runStart = i;
    } else if (!match && runStart !== null) {
      if (i - runStart >= minRunFrames) runs.push({ startFrame: runStart, endFrame: i - 1 });
      runStart = null;
    }
  }
  return runs;
}

// The cuts a reviewed candidates.json keeps once `exclude` is dropped.
function keptCandidateCuts(candidates, exclude) {
  const dropped = new Set(exclude || []);
  return candidates.filter((c) => !dropped.has(c.index)).map(asCut).sort((a, b) => a.at - b.at);
}

// Clips that are the same thing aired twice: about as long, and alike at the
// same points through. `signatures` are per-clip lists of small grayscale
// frames. Returns index -> index of the first clip it repeats.
function findRepeats(clips, signatures, { maxDurationDiff = 1, maxDiff = 14 } = {}) {
  const sameAs = {};
  for (let i = 0; i < clips.length; i += 1) {
    if (!signatures[i]) continue;
    for (let j = 0; j < i; j += 1) {
      if (sameAs[j] !== undefined || !signatures[j]) continue;
      if (Math.abs(clips[i].duration - clips[j].duration) > maxDurationDiff) continue;
      const diffs = signatures[i].map((frame, k) => meanAbsDiff(frame, signatures[j][k]));
      if (diffs.length && diffs.reduce((a, b) => a + b, 0) / diffs.length <= maxDiff) { sameAs[i] = j; break; }
    }
  }
  return sameAs;
}

// A clip's file name from a person-given title: what Windows accepts.
function safeFileName(name) {
  return String(name || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').replace(/[. ]+$/, '').trim().slice(0, 120);
}

// Re-encoded output is H.264/AAC; containers that can't hold it become .mp4.
function reencodeExt(ext) {
  return ['.mp4', '.m4v', '.mkv', '.mov'].includes(String(ext).toLowerCase()) ? ext : '.mp4';
}

module.exports = {
  DEFAULT_VIDEO_EXTS, EDGE_SEC, parseArgs, fmtTime, asCut, mergeBoundaries, edgeTrim, clipsFromCuts, classify,
  meanAbsDiff, matchRuns, keptCandidateCuts, findRepeats, safeFileName, reencodeExt,
};
