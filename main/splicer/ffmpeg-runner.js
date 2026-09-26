// The one ffmpeg runner the Video Splicer's scripts (splice.js, combine.js,
// logo-detect.js) share. Two jobs:
//   * Find ffmpeg. Inside RerunTV the job runner (service.js) passes the path
//     it resolved in RERUNTV_FFMPEG_PATH; run by hand from the repo, it falls
//     back to ffmpeg-static if that happens to be installed, then to `ffmpeg`
//     on PATH.
//   * Stop cleanly. Cancelling a job has to stop the ffmpeg it is waiting on,
//     not just the script: on Windows, killing a parent leaves its children
//     running, and a full-file scan left behind keeps the disk busy for
//     minutes. So every ffmpeg goes through spawnFfmpeg, and a "cancel"
//     message from the job runner (Electron utility process parentPort) or a
//     Ctrl+C from a terminal kills them all before exiting.
'use strict';

const { spawn } = require('child_process');

function resolveFfmpegPath() {
  if (process.env.RERUNTV_FFMPEG_PATH) return process.env.RERUNTV_FFMPEG_PATH;
  try {
    return require('ffmpeg-static');
  } catch (e) {
    return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  }
}

const ffmpegPath = resolveFfmpegPath();
const running = new Set();

function stopAll() {
  for (const proc of running) {
    try { proc.kill('SIGKILL'); } catch (e) { /* already gone */ }
  }
  running.clear();
}

let cancelled = false;
function cancelAndExit() {
  if (cancelled) return;
  cancelled = true;
  console.log('Cancelled.');
  stopAll();
  process.exit(130);
}

if (process.parentPort) {
  process.parentPort.on('message', (event) => {
    if (event && event.data === 'cancel') cancelAndExit();
  });
}
process.on('SIGINT', cancelAndExit);
process.on('SIGTERM', cancelAndExit);

function spawnFfmpeg(args) {
  const proc = spawn(ffmpegPath, args, { windowsHide: true });
  running.add(proc);
  proc.once('close', () => running.delete(proc));
  proc.once('error', () => running.delete(proc));
  return proc;
}

// Resolves { code, stderr } whatever the exit code; rejects only when ffmpeg
// can't start at all.
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawnFfmpeg(args);
    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code, stderr }));
  });
}

// Same as runFfmpeg, but also reports live progress via ffmpeg's
// `-progress pipe:1` (percent of duration), for long single-pass scans where
// the caller would otherwise see nothing until the whole file has been read.
function runFfmpegWithProgress(args, totalDuration, onPercent) {
  return new Promise((resolve, reject) => {
    const report = totalDuration && onPercent;
    const proc = spawnFfmpeg(report ? [...args, '-progress', 'pipe:1'] : args);
    let stderr = '';
    let lastPct = -1;
    let buf = '';
    if (report) {
      proc.stdout.on('data', (chunk) => {
        buf += chunk.toString();
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          const m = /^out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
          if (m) {
            const sec = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
            const pct = Math.min(100, Math.max(0, Math.round((sec / totalDuration) * 100)));
            if (pct !== lastPct) { lastPct = pct; onPercent(pct); }
          }
        }
      });
    }
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code, stderr }));
  });
}

function runFfmpegCollectStdout(args) {
  return new Promise((resolve, reject) => {
    const proc = spawnFfmpeg(args);
    const chunks = [];
    let stderr = '';
    proc.stdout.on('data', (c) => chunks.push(c));
    proc.stderr.on('data', (c) => { stderr += c.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}:\n${stderr.slice(-800)}`));
      resolve(Buffer.concat(chunks));
    });
  });
}

// Raw frames as they're decoded, frameSize bytes each, handed to onFrame(frame,
// index) — for scans over a whole recording that must neither hold it all in
// memory nor go quiet until the end.
function runFfmpegFrames(args, frameSize, onFrame) {
  return new Promise((resolve, reject) => {
    const proc = spawnFfmpeg(args);
    let pending = Buffer.alloc(0);
    let index = 0;
    let stderr = '';
    proc.stdout.on('data', (chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let offset = 0;
      while (pending.length - offset >= frameSize) {
        onFrame(pending.subarray(offset, offset + frameSize), index);
        index += 1;
        offset += frameSize;
      }
      pending = Buffer.from(pending.subarray(offset));
    });
    proc.stderr.on('data', (c) => { stderr += c.toString(); if (stderr.length > 20000) stderr = stderr.slice(-10000); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}:\n${stderr.slice(-800)}`));
      resolve(index);
    });
  });
}

module.exports = { ffmpegPath, runFfmpeg, runFfmpegWithProgress, runFfmpegCollectStdout, runFfmpegFrames };
