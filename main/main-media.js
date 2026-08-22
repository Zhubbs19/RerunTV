const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// ffmpeg-static resolves to a path inside node_modules at dev time. Once this
// app is packaged with electron-builder, node_modules is normally sealed into
// app.asar and a binary can't execute from inside it — electron-builder's
// "asarUnpack" convention is to keep unpacked copies alongside under
// app.asar.unpacked, so redirect there if that's where we're actually running.
// This is the raw, unconditionally-resolved path — always computed (core
// still needs to hand it to the ffmpeg-transcode plugin), but NOT what
// transcode callers should spawn directly. That's getFfmpegPath() below,
// which only returns non-null once the ffmpeg-transcode plugin has actually
// published it (see plugins/ffmpeg-transcode/main.js) — so ffmpeg stays a
// real, disable-able plugin (GPL binary, isolated for licensing clarity)
// rather than an unconditional core dependency, even though its resolution
// still happens here since a plugin under userData/plugins/ can't resolve an
// npm package the app's own node_modules wouldn't be on its require() path.
// require() itself is wrapped rather than assumed to succeed: ffmpeg-static
// being uninstalled (a build that deliberately omits the GPL binary) must
// not crash the whole app before any plugin even loads. If it's missing,
// fall back to a system-installed ffmpeg found on PATH
// (resolveFfmpegFromPath, below) rather than giving up immediately — this
// is what actually lets a build like this one avoid bundling the GPL binary
// at all while still supporting every ffmpeg-dependent feature for anyone
// who already has ffmpeg installed. Only if BOTH fail does
// FFMPEG_STATIC_PATH stay null, and ffmpeg-transcode's own
// activate() (plugins/ffmpeg-transcode/main.js) already handles a falsy path
// by failing just that one plugin, the same per-plugin isolation every other
// plugin load error already gets. This same code path runs in both repos —
// the original always finds ffmpeg-static, so the PATH fallback below simply
// never triggers there.
function resolveFfmpegFromPath() {
  const exeNames = process.platform === 'win32' ? ['ffmpeg.exe'] : ['ffmpeg'];
  const pathDirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    for (const exe of exeNames) {
      const candidate = path.join(dir, exe);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      } catch (e) { /* inaccessible/junk PATH entry — keep looking */ }
    }
  }
  return null;
}

let FFMPEG_STATIC_PATH = null;
try {
  FFMPEG_STATIC_PATH = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
} catch (e) {
  FFMPEG_STATIC_PATH = resolveFfmpegFromPath();
  if (FFMPEG_STATIC_PATH) {
    console.log(`ffmpeg-static not installed — using system ffmpeg found on PATH instead: ${FFMPEG_STATIC_PATH}`);
  } else {
    console.warn('ffmpeg-static not installed and no system ffmpeg found on PATH — the ffmpeg-transcode plugin will fail to load, everything else is unaffected:', e.message);
  }
}

let activeFfmpegPath = null;
function getFfmpegPath() { return activeFfmpegPath; }
function setFfmpegPath(p) { activeFfmpegPath = p || null; }

const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.m4v', '.webm', '.mov', '.mkv', '.avi', '.mpg', '.mpeg',
  '.wmv', '.flv', '.ts', '.m2ts', '.ogv', '.divx', '.asf', '.3gp'
]);

// Everything a channel/block/landing/pub-access entry can point at besides a
// video file — channel icons and background audio tracks (see main.js's
// dialog:selectImage/dialog:selectAudio filters, the only other places a
// user picks a media path from disk). Combined with VIDEO_EXTENSIONS below
// as the allowlist for any handler that serves an arbitrary user-supplied
// path off the LAN (main-viewer-server.js's GET /media) — that endpoint has
// no other access control (LAN trust model, no auth), so without an
// extension allowlist it would let any device on the network read *any*
// file on this machine (channels.json, OS files, anything), not just media.
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac']);
const LAN_MEDIA_EXTENSIONS = new Set([...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS, ...AUDIO_EXTENSIONS]);

// Some source files (old rips especially) use codecs Chromium's <video> can't
// decode — e.g. MPEG-4 Part 2 "DivX/Xvid" muxed into an .mp4 container. There's
// no software fallback for that inside Chromium. Unplayable files get
// transcoded once to H.264 via the bundled ffmpeg and swapped in at the exact
// same path, so nothing else about the channel's config needs to change. The
// original is moved into a sibling "_originals_backup" folder rather than
// deleted — this is a real personal media library, not disposable cache data.
function backupPathFor(srcPath) {
  const backupDir = path.join(path.dirname(srcPath), '_originals_backup');
  return path.join(backupDir, path.basename(srcPath));
}

function pendingTranscodePathFor(srcPath) {
  return `${srcPath}.transcoded.mp4`;
}

// If the app crashed between the two renames that make up a swap (original
// moved to backup, transcoded output not yet promoted), finish it now rather
// than leaving the channel with a missing file at srcPath.
function recoverPendingSwap(srcPath) {
  const backupPath = backupPathFor(srcPath);
  const pendingPath = pendingTranscodePathFor(srcPath);
  if (fs.existsSync(backupPath) && !fs.existsSync(srcPath) && fs.existsSync(pendingPath)) {
    // Best-effort: this runs on every transcode request (not just genuine
    // post-crash recovery), so a transient lock here must not blow up the
    // whole media:transcode call — leave it for the next attempt instead.
    try { fs.renameSync(pendingPath, srcPath); } catch (e) {}
  }
}

function scanFolderForVideos(folderPath) {
  const results = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip backup folders created by the codec-fix swap — the original
        // files parked there would otherwise show up as duplicate entries.
        if (entry.name === '_originals_backup') continue;
        walk(fullPath);
      } else if (VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        results.push(fullPath);
      }
    }
  }
  walk(folderPath);
  results.sort();
  return results;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// Windows (unlike POSIX) refuses to rename a file that still has an open
// handle from another process — a brief one can outlive the renderer
// releasing player.src (media pipeline teardown isn't synchronous) or come
// from AV/indexing scanning the freshly-written large file. A few short
// retries absorbs that instead of failing the whole swap outright.
const RENAME_RETRY_ATTEMPTS = 5;
const RENAME_RETRY_BASE_MS = 300;
async function renameWithRetry(from, to) {
  for (let i = 1; i <= RENAME_RETRY_ATTEMPTS; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      if (i === RENAME_RETRY_ATTEMPTS) throw e;
      await sleep(RENAME_RETRY_BASE_MS * i);
    }
  }
}

// Transcodes srcPath to H.264 via the resolved ffmpeg (getFfmpegPath()
// above) and swaps the result in at srcPath's own path, backing up the
// original to _originals_backup/ — moved out of main.js's ipcMain handler
// (which now just calls this and returns the result) so the actual
// transcode/swap logic lives alongside the rest of this module's
// media-path helpers instead of inline in app-wiring code.
async function transcodeVideo(srcPath) {
  recoverPendingSwap(srcPath);

  const backupPath = backupPathFor(srcPath);
  if (fs.existsSync(backupPath)) return { path: srcPath }; // already swapped previously

  const ffmpegPath = getFfmpegPath();
  if (!ffmpegPath) return { error: 'The FFmpeg Transcode plugin is disabled or missing (PLUGINS tab) — this file needs it to fix an incompatible codec.' };

  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  const pendingPath = pendingTranscodePathFor(srcPath);

  return new Promise((resolve) => {
    const ff = spawn(ffmpegPath, [
      '-y',
      '-i', srcPath,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k',
      '-movflags', '+faststart',
      pendingPath,
      // ffmpeg writes its progress/log output to stderr, never stdout — but
      // Node's default 'pipe' stdio still opens a stdout pipe regardless.
      // Nothing here ever reads it, so if ffmpeg ever did write enough to
      // fill that pipe's OS buffer, the process would block writing to it
      // forever with no timeout on this side. 'ignore' avoids creating the
      // pipe at all instead of leaving it to fill.
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    let stderr = '';
    ff.stderr.on('data', (d) => { stderr += d.toString(); });

    ff.on('error', (err) => {
      resolve({ error: `couldn't launch bundled ffmpeg (${err.message})` });
    });

    ff.on('close', async (code) => {
      if (code === 0 && fs.existsSync(pendingPath)) {
        try {
          // original -> backup, then transcoded -> takes over original's path.
          // If the second rename fails after the first succeeds, the file at
          // srcPath would otherwise vanish (moved to backup, nothing put back)
          // — restore the original on any failure so a channel entry is never
          // left pointing at a missing file, rather than only on the first
          // rename's own failure.
          await renameWithRetry(srcPath, backupPath);
          try {
            await renameWithRetry(pendingPath, srcPath);
          } catch (e) {
            try { fs.renameSync(backupPath, srcPath); } catch (e2) {}
            throw e;
          }
          resolve({ path: srcPath });
        } catch (e) {
          // Never leave the multi-hundred-MB transcode output orphaned on a
          // failed swap — this is exactly what accumulated as dead weight
          // across the library before this retry/cleanup existed.
          try { fs.unlinkSync(pendingPath); } catch (e2) {}
          resolve({ error: `swap failed: ${e.message}` });
        }
      } else {
        try { fs.unlinkSync(pendingPath); } catch (e) {}
        resolve({ error: `ffmpeg exited with code ${code}: ${stderr.slice(-300)}` });
      }
    });
  });
}

module.exports = {
  FFMPEG_STATIC_PATH, getFfmpegPath, setFfmpegPath,
  VIDEO_EXTENSIONS, LAN_MEDIA_EXTENSIONS, backupPathFor, pendingTranscodePathFor, recoverPendingSwap, scanFolderForVideos,
  transcodeVideo,
};
