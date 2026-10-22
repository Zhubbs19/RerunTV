// Baked-in black bars (letterbox/pillarbox burned into the video itself) for
// the "Remove baked-in black bars" display option (renderer/js/playback/bars.js).
// The page can't look at pixels: media is served from app://media, a different
// origin, so a canvas read of the player is blocked (see media/loudness.js for
// the same constraint). ffmpeg's cropdetect runs here instead, over a few short
// samples of each file, and the result is cached in <userData>/crop-cache.json
// keyed by path and checked against the file's size and mtime.
//
// The result is stored as fractions of the decoded frame, so it doesn't depend
// on how the renderer later scales the picture:
//   { x, y, w, h }  the picture inside the frame, or null for "no bars".
//
// Same shape as the loudness service: one ffmpeg at a time at below-normal
// priority; a file the player asks for jumps the queue, the background sweep of
// the lineup waits behind it. Nothing is written but the cache (ffmpeg's
// output goes to the null muxer).

const { spawn } = require('child_process');
const fs = require('fs');
const { atomicWriteFile } = require('../util/atomic-write');
const os = require('os');
const path = require('path');

const CACHE_VERSION = 1;
const MAX_CACHE_ENTRIES = 50000;
const SAMPLE_SECONDS = 4;
const SAMPLE_TIMEOUT_MS = 45000;
const SWEEP_GAP_MS = 1500;
// Bars thinner than this share of the frame on every edge are compression
// noise or overscan, not letterboxing.
const MIN_BAR_FRACTION = 0.03;
// A "picture" smaller than this share of the frame in either direction means
// the samples were mostly black (a fade, a title card), not a real crop.
const MIN_PICTURE_FRACTION = 0.3;

// Every "crop=W:H:X:Y" ffmpeg printed, as { w, h, x, y }.
function parseCropLines(stderr) {
  const out = [];
  const re = /crop=(\d+):(\d+):(\d+):(\d+)/g;
  let m;
  const text = String(stderr || '');
  while ((m = re.exec(text))) out.push({ w: Number(m[1]), h: Number(m[2]), x: Number(m[3]), y: Number(m[4]) });
  return out;
}

// "Stream #0:0: Video: h264 (High), yuv420p(tv), 1920x1080 [SAR 1:1 …]" -> { w, h }.
function parseFrameSize(stderr) {
  const m = /Video:[^\n]*?,\s*(\d{2,5})x(\d{2,5})[\s,[]/.exec(String(stderr || ''));
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

// The most frequent crop in one sample: cropdetect settles on the same box
// frame after frame, with the odd outlier on a dark scene.
function modeCrop(crops) {
  if (!crops.length) return null;
  const counts = new Map();
  let best = null;
  let bestCount = 0;
  for (const c of crops) {
    const key = `${c.w}:${c.h}:${c.x}:${c.y}`;
    const n = (counts.get(key) || 0) + 1;
    counts.set(key, n);
    if (n > bestCount) { best = c; bestCount = n; }
  }
  return best;
}

// Several samples -> one crop. The largest box that holds every sample's
// picture: a dark scene makes cropdetect over-crop, never under-crop, so the
// union is the safe answer. Returns fractions of the frame, or null when there
// are no real bars (or the samples don't agree on anything usable).
function combineCrops(samples, frame) {
  const usable = samples.filter(Boolean);
  if (!usable.length || !frame || !(frame.w > 0) || !(frame.h > 0)) return null;
  const x1 = Math.min(...usable.map((c) => c.x));
  const y1 = Math.min(...usable.map((c) => c.y));
  const x2 = Math.max(...usable.map((c) => c.x + c.w));
  const y2 = Math.max(...usable.map((c) => c.y + c.h));
  const box = { x: x1 / frame.w, y: y1 / frame.h, w: (x2 - x1) / frame.w, h: (y2 - y1) / frame.h };
  if (box.w > 1.001 || box.h > 1.001 || box.w < MIN_PICTURE_FRACTION || box.h < MIN_PICTURE_FRACTION) return null;
  const bars = [box.x, box.y, 1 - box.x - box.w, 1 - box.y - box.h];
  if (Math.max(...bars) < MIN_BAR_FRACTION) return null;
  const round = (n) => Math.round(n * 10000) / 10000;
  return { x: round(box.x), y: round(box.y), w: round(box.w), h: round(box.h) };
}

// Sample start times (seconds) for a file of `duration` seconds.
function sampleStarts(duration) {
  if (!(duration > 120)) return [Math.max(0, Math.floor((duration || 0) * 0.2))];
  return [0.1, 0.3, 0.5, 0.7, 0.9].map((f) => Math.floor(duration * f));
}

function runSample(ffmpegPath, filePath, start) {
  return new Promise((resolve) => {
    const args = [
      '-hide_banner', '-nostats', '-nostdin',
      '-ss', String(start), '-t', String(SAMPLE_SECONDS), '-i', filePath,
      '-an', '-sn', '-dn',
      '-vf', 'fps=3,cropdetect=limit=24:round=2:reset=0', '-f', 'null', '-',
    ];
    let child;
    try {
      child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      resolve({ crop: null, frame: null });
      return;
    }
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (e) { /* not permitted: run at normal */ }
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 200000) stderr = stderr.slice(-40000);
    });
    const timer = setTimeout(() => { try { child.kill(); } catch (e) { /* gone */ } }, SAMPLE_TIMEOUT_MS);
    const done = () => {
      clearTimeout(timer);
      // The first frames are cropdetect's warm-up; judge by the settled ones.
      const crops = parseCropLines(stderr);
      resolve({ crop: modeCrop(crops.slice(Math.floor(crops.length / 3))), frame: parseFrameSize(stderr) });
    };
    child.on('error', () => { clearTimeout(timer); resolve({ crop: null, frame: null }); });
    child.on('close', done);
  });
}

async function measureCrop(ffmpegPath, filePath, duration) {
  const samples = [];
  let frame = null;
  for (const start of sampleStarts(duration)) {
    const r = await runSample(ffmpegPath, filePath, start);
    samples.push(r.crop);
    if (!frame) frame = r.frame;
  }
  return combineCrops(samples, frame);
}

// ---------- Service ----------

function createCropDetectService({ userDataDir, getFfmpegPath }) {
  const cachePath = path.join(userDataDir, 'crop-cache.json');
  let cache = { version: CACHE_VERSION, entries: {} };
  try {
    const loaded = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (loaded && loaded.version === CACHE_VERSION && loaded.entries) cache = loaded;
  } catch (e) { /* no cache yet */ }

  let saveTimer = null;
  const saveSoon = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const keys = Object.keys(cache.entries);
      if (keys.length > MAX_CACHE_ENTRIES) {
        keys.sort((a, b) => (cache.entries[a].at || 0) - (cache.entries[b].at || 0))
          .slice(0, keys.length - MAX_CACHE_ENTRIES)
          .forEach((k) => { delete cache.entries[k]; });
      }
      atomicWriteFile(cachePath, JSON.stringify(cache), { encoding: 'utf8' }).catch(() => {});
    }, 2000);
  };

  // Local files only: a mediasource: ref is fetched on demand from a plugin
  // and isn't something ffmpeg can open by path.
  async function statLocal(filePath) {
    if (typeof filePath !== 'string' || !filePath || filePath.startsWith('mediasource:')) return null;
    try {
      const st = await fs.promises.stat(filePath);
      return st.isFile() ? st : null;
    } catch (e) {
      return null;
    }
  }

  function cached(filePath, st) {
    const entry = cache.entries[filePath];
    return entry && entry.size === st.size && entry.mtimeMs === st.mtimeMs ? entry : null;
  }

  const queue = [];
  const inFlight = new Map();
  let running = false;

  async function pump() {
    if (running) return;
    running = true;
    try {
    while (queue.length) {
      const job = queue.shift();
      let crop = null;
      try {
      const ffmpegPath = getFfmpegPath();
      if (ffmpegPath) {
        const st = await statLocal(job.filePath);
        const hit = st && cached(job.filePath, st);
        if (hit) crop = hit.crop;
        else if (st) {
          crop = await measureCrop(ffmpegPath, job.filePath, job.duration);
          // "No bars" is recorded too, so the file isn't re-measured every sweep.
          cache.entries[job.filePath] = { size: st.size, mtimeMs: st.mtimeMs, crop, at: Date.now() };
          saveSoon();
        }
      }
      } catch (e) {
        // A failed measurement is "unknown", never a stuck queue: the waiters
        // below still resolve and the next job still runs.
        crop = null;
      } finally {
        inFlight.delete(job.filePath);
        job.resolvers.forEach((resolve) => resolve(crop));
      }
      if (job.background && queue.length) await new Promise((r) => setTimeout(r, SWEEP_GAP_MS));
    }
    } finally {
      running = false;
    }
  }

  function enqueue(filePath, duration, { background = false } = {}) {
    const existing = inFlight.get(filePath);
    if (existing) {
      // The player wants one the sweep had queued: move it to the front.
      if (!background && existing.background) {
        existing.background = false;
        const i = queue.indexOf(existing);
        if (i > 0) { queue.splice(i, 1); queue.unshift(existing); }
      }
      return new Promise((resolve) => existing.resolvers.push(resolve));
    }
    const job = { filePath, duration: Number(duration) || 0, background, resolvers: [] };
    const promise = new Promise((resolve) => job.resolvers.push(resolve));
    inFlight.set(filePath, job);
    if (background) queue.push(job);
    else queue.unshift(job);
    pump();
    return promise;
  }

  return {
    // The picture's box inside the file's frame (fractions), from the cache or
    // measured now ahead of any background work. null: no bars, or unknown.
    async get(filePath, duration) {
      const st = await statLocal(filePath);
      if (!st) return null;
      const hit = cached(filePath, st);
      if (hit) return hit.crop;
      if (!getFfmpegPath()) return null;
      return enqueue(filePath, duration);
    },
    // Queue files for checking in the background; ones already cached are skipped.
    async prefetch(items) {
      if (!getFfmpegPath() || !Array.isArray(items)) return 0;
      let queued = 0;
      for (const item of items.slice(0, MAX_CACHE_ENTRIES)) {
        if (!item || typeof item.path !== 'string') continue;
        const st = await statLocal(item.path);
        if (!st || cached(item.path, st) || inFlight.has(item.path)) continue;
        enqueue(item.path, item.duration, { background: true });
        queued += 1;
      }
      return queued;
    },
    // Drops the background sweep (the option was switched off).
    cancelBackground() {
      for (let i = queue.length - 1; i >= 0; i -= 1) {
        const job = queue[i];
        if (!job.background) continue;
        queue.splice(i, 1);
        inFlight.delete(job.filePath);
        job.resolvers.forEach((resolve) => resolve(null));
      }
    },
    status() {
      const entries = Object.values(cache.entries);
      return {
        available: !!getFfmpegPath(),
        queued: queue.length,
        checked: entries.length,
        withBars: entries.filter((e) => e.crop).length,
      };
    },
  };
}

function registerCropDetectIpc(ipcMain, service) {
  ipcMain.handle('cropdetect:get', async (event, filePath, duration) => service.get(filePath, duration));
  ipcMain.handle('cropdetect:prefetch', async (event, items) => service.prefetch(items));
  ipcMain.handle('cropdetect:cancelBackground', async () => { service.cancelBackground(); return true; });
  ipcMain.handle('cropdetect:status', async () => service.status());
}

module.exports = {
  combineCrops,
  createCropDetectService,
  modeCrop,
  parseCropLines,
  parseFrameSize,
  registerCropDetectIpc,
  sampleStarts,
};
