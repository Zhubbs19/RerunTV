// One-click "download ffmpeg for me" used by the FFmpeg Transcode plugin's
// settings panel (plugins/ffmpeg-transcode/settings.js) when neither
// ffmpeg-static nor a system ffmpeg on PATH resolved (media.js's
// FFMPEG_STATIC_PATH stays null — see that file's header comment). This has
// to live in core rather than in the plugin itself: an isolated plugin's
// main.js runs from userData/plugins/<id>/, outside the app's own
// node_modules tree, so it cannot require('adm-zip') the way this file can.
//
// Only platforms with a stable, no-admin-needed, zip-packaged static build
// get an actual automated download+extract:
//   - Windows: gyan.dev's evergreen "release-essentials" zip URL (x64 only).
//   - macOS: evermeet.cx's evergreen "latest zip" endpoint (x86_64 only —
//     runs fine under Rosetta on Apple Silicon, not a native arm64 build).
// Linux static builds are only published as .tar.xz, and there's no tar/xz
// library in this project's dependencies to extract one safely — rather than
// shell out to `apt`/`dnf` with sudo (which this app has no business doing
// unattended), getPlatformInstallInfo() reports Linux as unsupported and the
// settings panel shows a copyable package-manager command instead.
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const WINDOWS_ZIP_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
const MAC_ZIP_URL = 'https://evermeet.cx/ffmpeg/getrelease/zip';

function ffmpegInstallDir() {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'ffmpeg-bin');
}

function linuxPackageManagerCommand() {
  // Best-effort detection only — used to prefill a copyable command, never
  // executed. `/etc/os-release`-style detection would be more precise, but
  // "which package manager exists on PATH" is enough for a suggestion.
  const candidates = [
    { bin: 'apt-get', cmd: 'sudo apt-get update && sudo apt-get install -y ffmpeg' },
    { bin: 'dnf', cmd: 'sudo dnf install -y ffmpeg' },
    { bin: 'pacman', cmd: 'sudo pacman -S ffmpeg' },
    { bin: 'zypper', cmd: 'sudo zypper install ffmpeg' },
  ];
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const { bin, cmd } of candidates) {
    if (pathDirs.some((dir) => fs.existsSync(path.join(dir, bin)))) return cmd;
  }
  return 'sudo apt-get update && sudo apt-get install -y ffmpeg';
}

// What the settings panel needs to decide whether to show "INSTALL FFMPEG"
// as a real one-click download or as a copyable terminal command instead.
function getPlatformInstallInfo() {
  if (process.platform === 'win32' && process.arch === 'x64') {
    return { method: 'download', label: 'Windows (64-bit)' };
  }
  if (process.platform === 'darwin' && (process.arch === 'x64' || process.arch === 'arm64')) {
    return { method: 'download', label: process.arch === 'arm64' ? 'macOS (via Rosetta)' : 'macOS' };
  }
  if (process.platform === 'linux') {
    return { method: 'command', label: 'Linux', command: linuxPackageManagerCommand() };
  }
  return { method: 'unsupported', label: `${process.platform}/${process.arch}` };
}

// The whole download must finish within this window, and may not exceed the
// size cap (the real builds are ~100 MB), so a stalled or hostile server can't
// hang the install forever or fill memory.
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_DOWNLOAD_BYTES = 400 * 1024 * 1024;

async function downloadToBuffer(url, onProgress) {
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const totalBytes = Number(res.headers.get('content-length')) || 0;
  if (totalBytes > MAX_DOWNLOAD_BYTES) throw new Error('download is larger than expected — aborting');
  const reader = res.body.getReader();
  const chunks = [];
  let receivedBytes = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    receivedBytes += value.length;
    if (receivedBytes > MAX_DOWNLOAD_BYTES) {
      reader.cancel().catch(() => {});
      throw new Error('download exceeded the size limit — aborting');
    }
    onProgress({ phase: 'downloading', receivedBytes, totalBytes });
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

// gyan.dev publishes the SHA-256 of each build next to it as <url>.sha256
// (a bare hex digest, sometimes followed by a file name). This does not defend
// against the publisher itself being compromised, but it does catch a truncated,
// corrupted or tampered-in-transit download before anything is extracted.
// Returns the expected digest, or null when the text holds none.
function parseSha256(text) {
  const match = /(?:^|[^0-9a-fA-F])([0-9a-fA-F]{64})(?![0-9a-fA-F])/.exec(String(text || ''));
  return match ? match[1].toLowerCase() : null;
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// Throws when a published digest exists and does not match. A source that
// publishes no digest (or whose digest file cannot be fetched) is not blocked:
// an unreachable checksum file must not make the one-click install unusable.
async function verifyDownload(zipBuffer, checksumUrl, fetchImpl = fetch) {
  if (!checksumUrl) return { verified: false, reason: 'no checksum published' };
  let expected = null;
  try {
    const res = await fetchImpl(checksumUrl, { signal: AbortSignal.timeout(30 * 1000) });
    if (res.ok) expected = parseSha256((await res.text()).slice(0, 4096));
  } catch (e) { /* treated as unavailable below */ }
  if (!expected) return { verified: false, reason: 'checksum unavailable' };
  if (sha256Hex(zipBuffer) !== expected) throw new Error('The downloaded ffmpeg does not match its published checksum — not installing it.');
  return { verified: true };
}

// Finds the actual ffmpeg binary inside a downloaded zip (Windows builds
// nest it under a versioned folder's bin/, macOS builds are a single bare
// file at the zip's root) and writes just that one file out.
function extractFfmpegBinary(zipBuffer, destPath) {
  const zip = new AdmZip(zipBuffer);
  const wantName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const entry = zip.getEntries().find((e) => !e.isDirectory
    && path.basename(e.entryName).toLowerCase() === wantName.toLowerCase());
  if (!entry) throw new Error('downloaded archive did not contain an ffmpeg binary');
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, zip.readFile(entry));
  if (process.platform !== 'win32') fs.chmodSync(destPath, 0o755);
}

async function installFfmpeg(onProgress) {
  const info = getPlatformInstallInfo();
  if (info.method !== 'download') {
    throw new Error(info.method === 'command'
      ? 'Automatic download is not available on Linux — use the command shown instead.'
      : `Automatic download is not available for ${info.label}.`);
  }
  const url = process.platform === 'win32' ? WINDOWS_ZIP_URL : MAC_ZIP_URL;
  const zipBuffer = await downloadToBuffer(url, onProgress);
  onProgress({ phase: 'verifying' });
  // evermeet.cx publishes no checksum file alongside its zip; gyan.dev does.
  const checked = await verifyDownload(zipBuffer, process.platform === 'win32' ? `${WINDOWS_ZIP_URL}.sha256` : null);
  if (!checked.verified) console.warn(`[ffmpeg-install] download not checksum-verified (${checked.reason})`);
  onProgress({ phase: 'extracting' });
  const destPath = path.join(ffmpegInstallDir(), process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  extractFfmpegBinary(zipBuffer, destPath);
  onProgress({ phase: 'done' });
  return destPath;
}

function registerFfmpegInstallIpc(ipcMain, { getMainWindow }) {
  ipcMain.handle('ffmpeg:installInfo', () => getPlatformInstallInfo());
  let installInFlight = false;
  ipcMain.handle('ffmpeg:install', async () => {
    if (installInFlight) return { error: 'An ffmpeg install is already running.' };
    installInFlight = true;
    const win = getMainWindow();
    const sendProgress = (data) => { if (win && !win.isDestroyed()) win.webContents.send('ffmpeg:installProgress', data); };
    try {
      const installedPath = await installFfmpeg(sendProgress);
      return { path: installedPath };
    } catch (e) {
      return { error: e.message };
    } finally {
      installInFlight = false;
    }
  });
}

module.exports = { parseSha256, sha256Hex, verifyDownload, registerFfmpegInstallIpc, getPlatformInstallInfo, installFfmpeg, ffmpegInstallDir };
