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

async function downloadToBuffer(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const totalBytes = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let receivedBytes = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    receivedBytes += value.length;
    onProgress({ phase: 'downloading', receivedBytes, totalBytes });
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
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
  onProgress({ phase: 'extracting' });
  const destPath = path.join(ffmpegInstallDir(), process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  extractFfmpegBinary(zipBuffer, destPath);
  onProgress({ phase: 'done' });
  return destPath;
}

function registerFfmpegInstallIpc(ipcMain, { getMainWindow }) {
  ipcMain.handle('ffmpeg:installInfo', () => getPlatformInstallInfo());
  ipcMain.handle('ffmpeg:install', async () => {
    const win = getMainWindow();
    const sendProgress = (data) => { if (win && !win.isDestroyed()) win.webContents.send('ffmpeg:installProgress', data); };
    try {
      const installedPath = await installFfmpeg(sendProgress);
      return { path: installedPath };
    } catch (e) {
      return { error: e.message };
    }
  });
}

module.exports = { registerFfmpegInstallIpc, getPlatformInstallInfo, installFfmpeg, ffmpegInstallDir };
