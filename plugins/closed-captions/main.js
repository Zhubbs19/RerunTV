// Closed captions — discovers real caption data (a sidecar .srt/.vtt file, or
// an embedded subtitle stream inside the video container) and extracts/
// converts it to a cached WebVTT file the renderer can hand straight to a
// native <track> element. No ffprobe binary is bundled with this app (only
// ffmpeg-static) — embedded-stream discovery instead runs `ffmpeg -i <file>`
// and parses its own stderr banner (a plain, well-known technique; ffmpeg
// always prints one "Stream #0:N(lang): Subtitle: codec" line per subtitle
// stream when just asked to open a file, no extra flags needed).
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const SUBTITLE_EXTENSIONS = ['.vtt', '.srt'];

function sidecarCandidates(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, path.extname(filePath));
  return SUBTITLE_EXTENSIONS.map((ext) => path.join(dir, base + ext));
}

// Runs a spawned process to completion and resolves with its combined
// stdout+stderr — ffmpeg writes its stream-info banner to stderr even on a
// clean exit, and prints a real (non-zero) error for a file it can't open at
// all, which the caller below treats as "no embedded streams" rather than a
// hard failure (a corrupt/unreadable file should just mean "no captions
// found," not break the tune-in it's not even blocking).
function runFfmpeg(ffmpegPath, args, spawnFn) {
  return new Promise((resolve) => {
    const child = spawnFn(ffmpegPath, args, { windowsHide: true });
    let output = '';
    child.stdout && child.stdout.on('data', (d) => { output += d.toString(); });
    child.stderr && child.stderr.on('data', (d) => { output += d.toString(); });
    child.on('error', () => resolve({ ok: false, output }));
    child.on('close', (code) => resolve({ ok: code === 0, output }));
  });
}

// Parses ffmpeg's own human-readable stream banner — lines look like:
//   Stream #0:2(eng): Subtitle: subrip
//   Stream #0:3(spa): Subtitle: ass
function parseSubtitleStreams(output) {
  const streams = [];
  const re = /Stream #0:(\d+)(?:\(([a-z]{2,3})\))?[^:]*:\s*Subtitle:\s*(\w+)/gi;
  let m;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(output))) {
    streams.push({ type: 'embedded', index: Number(m[1]), lang: m[2] || null, codec: m[3] });
  }
  return streams;
}

function cacheKeyFor(filePath, track) {
  return crypto.createHash('sha1').update(`${filePath}::${JSON.stringify(track)}`).digest('hex');
}

function activate(ctx) {
  const { ipcMain, fs, spawn } = ctx;

  ipcMain.handle('captions:scanForFile', async (event, filePath) => {
    if (!filePath) return { tracks: [] };
    const tracks = [];

    for (const candidate of sidecarCandidates(filePath)) {
      if (fs.existsSync(candidate)) {
        tracks.push({ type: 'sidecar', ext: path.extname(candidate).slice(1), path: candidate });
      }
    }

    const ffmpegPath = ctx.services.ffmpegPath;
    if (ffmpegPath && fs.existsSync(ffmpegPath)) {
      const result = await runFfmpeg(ffmpegPath, ['-hide_banner', '-i', filePath], spawn);
      tracks.push(...parseSubtitleStreams(result.output));
    }

    return { tracks };
  });

  ipcMain.handle('captions:extractTrack', async (event, opts) => {
    const { filePath, track } = opts || {};
    if (!filePath || !track) return { error: 'filePath and track are required' };

    // A sidecar .vtt is already exactly what a <track> element wants —
    // no extraction, no cache entry, just hand back its own file URL.
    if (track.type === 'sidecar' && track.ext === 'vtt') {
      return { url: pathToFileURL(track.path).href };
    }

    const ffmpegPath = ctx.services.ffmpegPath;
    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
      return { error: 'ffmpeg is unavailable (ffmpeg-transcode plugin disabled?)' };
    }

    const cacheRelName = `${cacheKeyFor(filePath, track)}.vtt`;
    const cacheAbsPath = path.join(fs.dataDir, cacheRelName);
    if (!fs.existsSync(cacheAbsPath)) {
      const args = track.type === 'sidecar'
        // Sidecar .srt -> .vtt, plain format conversion.
        ? ['-y', '-i', track.path, '-c:s', 'webvtt', cacheAbsPath]
        // Embedded stream -> extracted .vtt.
        : ['-y', '-i', filePath, '-map', `0:${track.index}`, '-c:s', 'webvtt', cacheAbsPath];
      const result = await runFfmpeg(ffmpegPath, args, spawn);
      if (!result.ok || !fs.existsSync(cacheAbsPath)) {
        return { error: 'ffmpeg failed to produce a caption track' };
      }
    }

    return { url: pathToFileURL(cacheAbsPath).href };
  });
}

module.exports = { activate };
