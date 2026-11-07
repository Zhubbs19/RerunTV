// Act breaks: the fades to black where a broadcast once cut away to
// commercials. A show recorded or released without its ads still carries
// them — a second or two of black, usually with the sound gone — and a
// break placed there looks like the real thing instead of cutting a scene
// in half.
//
// One ffmpeg pass per file reads both signals at once: blackdetect on a
// tiny scaled copy of the picture, silencedetect on the sound. Each black
// stretch becomes a candidate mark with a strength: longer black is
// stronger, and silence at the same moment makes it much stronger. The
// schedule (renderer/js/core/interstitials.js) snaps its mid-show breaks to
// nearby marks; it never invents breaks of its own from them.
//
// A second, short pass over the end of the file finds where its end credits
// start (findCreditsStart): the centre of a credits frame sits on the video
// black floor, with text on it, and the credits are the run of such frames
// that carries on to the end. Only credits on black are found; credits over
// picture or a coloured backdrop give null, and the channel's own lead time
// applies.
//
// Same shape as cropdetect.js and loudness.js: one ffmpeg at a time at
// below-normal priority, results cached in <dir>/break-marks-cache.json
// keyed by path, size and mtime. A 22-minute episode takes 20-50 seconds, a
// film a few minutes; the credits pass adds a few seconds.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { atomicWriteFile } = require('../util/atomic-write');

// v2: the end margin became a share of the file (credits); v1 results are redone.
const CACHE_VERSION = 2;
// Most cached files kept; the oldest are dropped past this.
const MAX_CACHE_ENTRIES = 50000;
// Longest one ffmpeg pass may run before it is killed.
const RUN_TIMEOUT_MS = 20 * 60 * 1000;
// Openings and end credits fade to black too; neither is an act break. A
// film's credits run for minutes with black between cards, so the end
// margin grows with the file: the last 8%, and never under a minute.
const EDGE_START_S = 30;
const EDGE_END_S = 60;
const EDGE_END_SHARE = 0.08;
// Fades closer together than this are one transition (fade out, a black
// title card, fade in).
const MERGE_S = 8;
// A blip of black with nothing else going for it is a cut, not a fade.
const MIN_STRENGTH = 0.05;

/**
 * Black stretches from blackdetect output.
 * @param {string} stderr ffmpeg's detector lines.
 * @returns {Array<object>} `{ start, end }` in seconds.
 */
function parseBlackLines(stderr) {
  const out = [];
  const re = /black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)/g;
  let m;
  while ((m = re.exec(stderr))) out.push({ start: Number(m[1]), end: Number(m[2]) });
  return out.filter((r) => Number.isFinite(r.start) && r.end > r.start);
}

/**
 * Silent stretches from silencedetect output (start/end pairs).
 * @param {string} stderr ffmpeg's detector lines.
 * @returns {Array<object>} `{ start, end }` in seconds.
 */
function parseSilenceLines(stderr) {
  const out = [];
  let open = null;
  const re = /silence_(start|end):\s*([\d.]+)/g;
  let m;
  while ((m = re.exec(stderr))) {
    const t = Number(m[2]);
    if (m[1] === 'start') open = t;
    else if (open != null && t > open) { out.push({ start: open, end: t }); open = null; }
  }
  return out;
}

/**
 * Input duration from ffmpeg's `Duration:` line.
 * @param {string} stderr ffmpeg output containing the line.
 * @returns {?number} Seconds, or null when not found.
 */
function parseDuration(stderr) {
  const m = /Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(stderr);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

/**
 * Candidate act breaks from one pass's black and silent stretches:
 * [{ at, strength }] sorted by time, `at` in seconds into the file (once
 * the picture has gone black), `strength` 0-1.
 * @param {object} pass One detection pass.
 * @param {Array<object>} pass.black `{ start, end }` black stretches.
 * @param {Array<object>} pass.silence `{ start, end }` silent stretches.
 * @param {number} pass.duration File duration in seconds.
 * @returns {Array<object>} The marks; empty for a file too short to have any.
 */
function findBreakMarks({ black, silence, duration }) {
  if (!Number.isFinite(duration) || duration <= EDGE_START_S + EDGE_END_S) return [];
  const candidates = black.map((b) => {
    const length = b.end - b.start;
    const quiet = silence.some((s) => s.start <= b.end + 0.75 && s.end >= b.start - 0.75);
    const strength = Math.min(1, length / 1.5) * 0.6 + (quiet ? 0.4 : 0);
    return { at: Math.min(b.start + 1, b.start + length / 2), strength };
  }).filter((c) => c.at >= EDGE_START_S && c.at <= duration - Math.max(EDGE_END_S, duration * EDGE_END_SHARE) && c.strength >= MIN_STRENGTH);
  const merged = [];
  candidates.sort((a, b) => a.at - b.at).forEach((c) => {
    const last = merged[merged.length - 1];
    if (last && c.at - last.at < MERGE_S) {
      if (c.strength > last.strength) merged[merged.length - 1] = c;
      return;
    }
    merged.push(c);
  });
  return merged.map((c) => ({ at: Math.round(c.at * 10) / 10, strength: Math.round(c.strength * 100) / 100 }));
}

// Credits: how much of the end is read, what a credits frame is (in the
// centre 60% of the picture, so letterbox bars don't count: its darkest
// tenth on the black floor and an average under CREDITS_MAX_YAVG), and what
// a run of them must look like to be believed.
const CREDITS_TAIL_FILM_S = 900;
const CREDITS_TAIL_SHOW_S = 240;
const CREDITS_FILM_MIN_S = 3600;
const CREDITS_MAX_YLOW = 17;
const CREDITS_MAX_YAVG = 80;
const CREDITS_GAP_S = 15;
// A closing logo or a last card on picture can follow the credits.
const CREDITS_END_SLACK_S = 60;
const CREDITS_MIN_S = 20;
const CREDITS_MIN_DENSITY = 0.6;

/**
 * Where the credits pass starts reading: the last 15 minutes of a film or 4 of a show, never more than half the file.
 * @param {number} duration File duration in seconds.
 * @returns {number} Start offset in seconds.
 */
function creditsTailStart(duration) {
  const tail = duration > CREDITS_FILM_MIN_S ? CREDITS_TAIL_FILM_S : CREDITS_TAIL_SHOW_S;
  return Math.max(0, duration - Math.min(tail, duration / 2));
}

/**
 * Where the end credits start, from per-frame stats over the end of a file
 * ([{ t, ylow, yavg }], t in seconds into the file):
 * { at, leadS, density } or null. Credits frames no more than
 * CREDITS_GAP_S apart make one run; the credits are the last run long and
 * dense enough to believe, ending within CREDITS_END_SLACK_S of the end. A
 * run that starts at the edge of what was read could be longer than the
 * read, so it isn't believed either.
 * @param {object} input Credits pass inputs.
 * @param {Array<object>} input.frames Per-frame stats.
 * @param {number} input.duration File duration in seconds.
 * @param {number} input.tailStart Where the pass started reading, in seconds.
 * @returns {?object} The credits start, or null.
 */
function findCreditsStart({ frames, duration, tailStart }) {
  if (!Array.isArray(frames) || !frames.length || !(duration > 0)) return null;
  const isCredits = (f) => f.ylow <= CREDITS_MAX_YLOW && f.yavg < CREDITS_MAX_YAVG;
  const runs = [];
  let run = null;
  frames.forEach((f) => {
    if (run && f.t - run.end > CREDITS_GAP_S) { runs.push(run); run = null; }
    if (run) run.seen += 1;
    if (!isCredits(f)) return;
    if (!run) run = { start: f.t, end: f.t, hits: 0, seen: 1 };
    run.end = f.t;
    run.hits += 1;
    // Frames after the run's last credits frame aren't part of it yet.
    run.seenAtEnd = run.seen;
  });
  if (run) runs.push(run);
  const believable = runs.filter((r) => r.end - r.start >= CREDITS_MIN_S && r.hits / r.seenAtEnd >= CREDITS_MIN_DENSITY);
  const credits = believable[believable.length - 1];
  if (!credits || duration - credits.end > CREDITS_END_SLACK_S || credits.start <= tailStart + 5) return null;
  const density = credits.hits / credits.seenAtEnd;
  return { at: Math.round(credits.start * 10) / 10, leadS: Math.round(duration - credits.start), density: Math.round(density * 100) / 100 };
}

/**
 * Per-frame luma stats, two a second, over the file from `startS` on.
 * @param {string} ffmpegPath Path of the ffmpeg binary.
 * @param {string} filePath The media file.
 * @param {number} startS Offset to start reading at, in seconds.
 * @returns {Promise<?Array<object>>} `{ t, ylow, yavg }` frames, or null on failure or timeout.
 */
function runCreditsPass(ffmpegPath, filePath, startS) {
  return new Promise((resolve) => {
    const args = [
      '-hide_banner', '-nostats', '-nostdin', '-ss', String(startS), '-i', filePath, '-an', '-sn', '-dn',
      '-vf', 'fps=2,crop=iw*0.6:ih*0.6,scale=160:-2,signalstats,metadata=print:file=-',
      '-f', 'null', '-',
    ];
    let child;
    try {
      child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) {
      resolve(null);
      return;
    }
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (e) { /* not permitted: run at normal */ }
    const frames = [];
    let current = null;
    let tail = '';
    child.stdout.on('data', (chunk) => {
      const lines = (tail + chunk.toString('utf8')).split(/\r?\n/);
      tail = lines.pop();
      lines.forEach((line) => {
        const pts = /pts_time:([\d.]+)/.exec(line);
        if (pts) {
          current = { t: startS + Number(pts[1]), ylow: 255, yavg: 255 };
          frames.push(current);
          return;
        }
        const stat = /lavfi\.signalstats\.(YLOW|YAVG)=([\d.]+)/.exec(line);
        if (stat && current) current[stat[1] === 'YLOW' ? 'ylow' : 'yavg'] = Number(stat[2]);
      });
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch (e) { /* gone */ } }, RUN_TIMEOUT_MS);
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(timedOut || code !== 0 ? null : frames);
    });
  });
}

/**
 * Runs the blackdetect and silencedetect pass over a whole file.
 * @param {string} ffmpegPath Path of the ffmpeg binary.
 * @param {string} filePath The media file.
 * @returns {Promise<?object>} `{ duration, black, silence }`, or null on failure or timeout.
 */
function runDetect(ffmpegPath, filePath) {
  return new Promise((resolve) => {
    const args = [
      '-hide_banner', '-nostats', '-nostdin', '-hwaccel', 'auto', '-i', filePath, '-sn', '-dn',
      '-vf', 'scale=128:-2,blackdetect=d=0.1:pic_th=0.95:pix_th=0.12',
      '-af', 'silencedetect=n=-50dB:d=0.25',
      '-f', 'null', '-',
    ];
    let child;
    try {
      child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      resolve(null);
      return;
    }
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (e) { /* not permitted: run at normal */ }
    // Only the detector lines matter; keep them and the duration, drop the rest.
    let duration = null;
    let kept = '';
    let tail = '';
    child.stderr.on('data', (chunk) => {
      const text = tail + chunk.toString('utf8');
      const lines = text.split(/\r?\n/);
      tail = lines.pop();
      lines.forEach((line) => {
        if (duration == null && line.includes('Duration:')) duration = parseDuration(line);
        if (line.includes('black_start') || line.includes('silence_')) kept += `${line}\n`;
      });
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch (e) { /* gone */ } }, RUN_TIMEOUT_MS);
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      kept += tail;
      if (timedOut || code !== 0 || duration == null) { resolve(null); return; }
      resolve({ duration, black: parseBlackLines(kept), silence: parseSilenceLines(kept) });
    });
  });
}

/**
 * detect(filePath) -> { marks: [{ at, strength }], duration, credits: { at, leadS, density } | null } | null
 * Cached; one ffmpeg at a time. null when ffmpeg is missing or the file
 * can't be read. A file cached before credits were looked for only gets
 * the short credits pass.
 * Creates the cached, one-at-a-time break detection service.
 * @param {object} opts Options.
 * @param {?string} opts.dir Folder for the cache file; null disables the cache.
 * @param {Function} [opts.getFfmpegPath] Returns the ffmpeg path, or null when missing.
 * @param {Function} [opts.run=runDetect] The black/silence pass (injected for tests).
 * @param {Function} [opts.runCredits=runCreditsPass] The credits pass (injected for tests).
 * @param {object} [opts.fsImpl=fs] File system module.
 * @param {Function} [opts.now] Clock in ms, for cache entry ages.
 * @returns {object} `{ available(), detect(filePath) }`.
 */
function createBreakDetectService({ dir, getFfmpegPath = () => null, run = runDetect, runCredits = runCreditsPass, fsImpl = fs, now = () => Date.now() }) {
  const cachePath = dir ? path.join(dir, 'break-marks-cache.json') : null;
  let cache = { version: CACHE_VERSION, entries: {} };
  if (cachePath) {
    try {
      const loaded = JSON.parse(fsImpl.readFileSync(cachePath, 'utf8'));
      if (loaded && loaded.version === CACHE_VERSION && loaded.entries) cache = loaded;
    } catch (e) { /* no cache yet */ }
  }
  let saveTimer = null;
  const saveSoon = () => {
    if (!cachePath) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const keys = Object.keys(cache.entries);
      if (keys.length > MAX_CACHE_ENTRIES) {
        keys.sort((a, b) => (cache.entries[a].at || 0) - (cache.entries[b].at || 0))
          .slice(0, keys.length - MAX_CACHE_ENTRIES)
          .forEach((k) => { delete cache.entries[k]; });
      }
      atomicWriteFile(cachePath, JSON.stringify(cache), { encoding: 'utf8', mkdir: true }).catch(() => {});
    }, 2000);
  };

  let chain = Promise.resolve();
  async function detectNow(filePath) {
    let st;
    try { st = await fsImpl.promises.stat(filePath); } catch (e) { return null; }
    if (!st.isFile()) return null;
    const hit = cache.entries[filePath];
    const fresh = hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs;
    if (fresh && hit.result.credits !== undefined) return hit.result;
    const ffmpegPath = getFfmpegPath();
    if (!ffmpegPath) return null;
    let result = fresh ? { ...hit.result } : null;
    if (!result) {
      const pass = await run(ffmpegPath, filePath);
      if (!pass) return null;
      result = { marks: findBreakMarks(pass), duration: Math.round(pass.duration * 10) / 10 };
    }
    const tailStart = creditsTailStart(result.duration);
    const frames = await runCredits(ffmpegPath, filePath, tailStart);
    result.credits = frames ? findCreditsStart({ frames, duration: result.duration, tailStart }) : null;
    cache.entries[filePath] = { size: st.size, mtimeMs: st.mtimeMs, result, at: now() };
    saveSoon();
    return result;
  }

  return {
    available: () => !!getFfmpegPath(),
    detect(filePath) {
      const next = chain.then(() => detectNow(filePath).catch(() => null));
      chain = next.catch(() => null);
      return next;
    },
  };
}

module.exports = { createBreakDetectService, findBreakMarks, findCreditsStart, creditsTailStart, parseBlackLines, parseSilenceLines, parseDuration };
