// Per-file loudness for the volume leveler (renderer/js/playback/leveler.js).
// ffmpeg's EBU R128 meter is run over three short samples of each file (near
// the start, middle and end) rather than the whole thing, which is plenty to
// tell a quiet 1970s sitcom from a loud commercial and takes a second or two
// instead of decoding a whole episode. Results are cached in
// <userData>/loudness-cache.json, keyed by path and checked against the file's
// size and mtime.
//
// Why not a compressor in Web Audio: media is served from app://media, a
// different origin from the app://bundle page, so a MediaElementSource on the
// player hears only silence. Opening that route to cross-origin reads would
// let the page read any file on disk, which is a line this app doesn't cross
// (see the tier-2 notes on canvas snapshots). Measuring in main and setting
// the element's volume needs no such access.
//
// One ffmpeg at a time, below-normal priority: a file asked for by the player
// jumps the queue, the background sweep of the lineup waits behind it.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CACHE_VERSION = 1;
const MAX_CACHE_ENTRIES = 50000;
const SAMPLE_SECONDS = 30;
const SAMPLE_TIMEOUT_MS = 60000;
const SWEEP_GAP_MS = 1500;
// ebur128's floor for silence; a sample this quiet says nothing about the file.
const SILENT_LUFS = -69;

// "    I:         -23.4 LUFS" in ebur128's closing summary.
function parseIntegratedLoudness(stderr) {
  const summary = String(stderr || '').split(/Summary:/).pop();
  const match = /I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/.exec(summary);
  return match ? Number(match[1]) : null;
}

// Energy-domain mean of several integrated measurements, ignoring silent ones.
function combineLoudness(values) {
  const usable = values.filter((v) => typeof v === 'number' && Number.isFinite(v) && v > SILENT_LUFS);
  if (!usable.length) return null;
  const meanPower = usable.reduce((sum, v) => sum + 10 ** (v / 10), 0) / usable.length;
  return Math.round(10 * Math.log10(meanPower) * 10) / 10;
}

// Sample start times (seconds) for a file of `duration` seconds.
function sampleStarts(duration) {
  if (!(duration > SAMPLE_SECONDS * 4)) return [0];
  return [0.1, 0.45, 0.8].map((f) => Math.floor(duration * f));
}

function runSample(ffmpegPath, filePath, start, seconds) {
  return new Promise((resolve) => {
    const args = [
      '-hide_banner', '-nostats', '-nostdin',
      '-ss', String(start), '-t', String(seconds), '-i', filePath,
      '-map', '0:a:0?', '-vn', '-sn', '-dn',
      '-af', 'ebur128=framelog=quiet', '-f', 'null', '-',
    ];
    let child;
    try {
      child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      resolve(null);
      return;
    }
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (e) { /* not permitted: run at normal */ }
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 200000) stderr = stderr.slice(-20000);
    });
    const timer = setTimeout(() => { try { child.kill(); } catch (e) { /* gone */ } }, SAMPLE_TIMEOUT_MS);
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => { clearTimeout(timer); resolve(parseIntegratedLoudness(stderr)); });
  });
}

async function measureLoudness(ffmpegPath, filePath, duration) {
  const starts = sampleStarts(duration);
  const values = [];
  for (const start of starts) {
    values.push(await runSample(ffmpegPath, filePath, start, starts.length === 1 ? SAMPLE_SECONDS * 3 : SAMPLE_SECONDS));
  }
  return combineLoudness(values);
}

// ---------- Service ----------

function createLoudnessService({ userDataDir, getFfmpegPath }) {
  const cachePath = path.join(userDataDir, 'loudness-cache.json');
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
      fs.promises.writeFile(cachePath, JSON.stringify(cache), 'utf8').catch(() => {});
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
    while (queue.length) {
      const job = queue.shift();
      const ffmpegPath = getFfmpegPath();
      let lufs = null;
      if (ffmpegPath) {
        const st = await statLocal(job.filePath);
        const hit = st && cached(job.filePath, st);
        if (hit) lufs = hit.lufs;
        else if (st) {
          lufs = await measureLoudness(ffmpegPath, job.filePath, job.duration);
          // A file with no measurable audio is recorded too, so it isn't retried every sweep.
          cache.entries[job.filePath] = { size: st.size, mtimeMs: st.mtimeMs, lufs, at: Date.now() };
          saveSoon();
        }
      }
      inFlight.delete(job.filePath);
      job.resolvers.forEach((resolve) => resolve(lufs));
      if (job.background && queue.length) await new Promise((r) => setTimeout(r, SWEEP_GAP_MS));
    }
    running = false;
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
    // The file's loudness in LUFS: straight from the cache, else measured now
    // (ahead of any background work). null when unknown or unmeasurable.
    async get(filePath, duration) {
      const st = await statLocal(filePath);
      if (!st) return null;
      const hit = cached(filePath, st);
      if (hit) return hit.lufs;
      if (!getFfmpegPath()) return null;
      return enqueue(filePath, duration);
    },
    // Queue files for measuring in the background; ones already cached are skipped.
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
    // Drops the background sweep (the leveler was switched off).
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
      return { available: !!getFfmpegPath(), queued: queue.length, measured: Object.keys(cache.entries).length };
    },
  };
}

function registerLoudnessIpc(ipcMain, service) {
  ipcMain.handle('loudness:get', async (event, filePath, duration) => service.get(filePath, duration));
  ipcMain.handle('loudness:prefetch', async (event, items) => service.prefetch(items));
  ipcMain.handle('loudness:cancelBackground', async () => { service.cancelBackground(); return true; });
  ipcMain.handle('loudness:status', async () => service.status());
}

module.exports = {
  combineLoudness,
  createLoudnessService,
  parseIntegratedLoudness,
  registerLoudnessIpc,
  sampleStarts,
};
