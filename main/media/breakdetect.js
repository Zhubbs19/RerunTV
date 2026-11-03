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
// Same shape as cropdetect.js and loudness.js: one ffmpeg at a time at
// below-normal priority, results cached in <dir>/break-marks-cache.json
// keyed by path, size and mtime. A 22-minute episode takes 20-50 seconds, a
// film a few minutes.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { atomicWriteFile } = require('../util/atomic-write');

// v2: the end margin became a share of the file (credits); v1 results are redone.
const CACHE_VERSION = 2;
const MAX_CACHE_ENTRIES = 50000;
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

function parseBlackLines(stderr) {
  const out = [];
  const re = /black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)/g;
  let m;
  while ((m = re.exec(stderr))) out.push({ start: Number(m[1]), end: Number(m[2]) });
  return out.filter((r) => Number.isFinite(r.start) && r.end > r.start);
}

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

function parseDuration(stderr) {
  const m = /Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(stderr);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

/**
 * Candidate act breaks from one pass's black and silent stretches:
 * [{ at, strength }] sorted by time, `at` in seconds into the file (once
 * the picture has gone black), `strength` 0-1.
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
 * detect(filePath) -> { marks: [{ at, strength }], duration } | null
 * Cached; one ffmpeg at a time. null when ffmpeg is missing or the file
 * can't be read.
 */
function createBreakDetectService({ dir, getFfmpegPath = () => null, run = runDetect, fsImpl = fs, now = () => Date.now() }) {
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
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.result;
    const ffmpegPath = getFfmpegPath();
    if (!ffmpegPath) return null;
    const pass = await run(ffmpegPath, filePath);
    if (!pass) return null;
    const result = { marks: findBreakMarks(pass), duration: Math.round(pass.duration * 10) / 10 };
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

module.exports = { createBreakDetectService, findBreakMarks, parseBlackLines, parseSilenceLines, parseDuration };
