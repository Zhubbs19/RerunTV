const { app } = require('electron');
const path = require('path');
const fs = require('fs');

function getConfigPath() {
  return path.join(app.getPath('userData'), 'channels.json');
}

// ---------- Rotating config backups ----------
// channels.json is real, irreplaceable per-user data (channel lineups,
// blocks, interstitials) with no version control anywhere else — the only
// prior safety nets were the corrupt-JSON preserve-on-load below and a
// manual EXPORT CONFIG button. This snapshots the file that's about to be
// overwritten *before* every write, so a bad edit, an accidental bulk
// action, or something worse always has a recent point to roll back to from
// the setup screen itself (see listBackups/restoreBackup below).
const BACKUPS_DIR = path.join(app.getPath('userData'), 'backups');
const MAX_BACKUPS = 20;
// Snapshotting on literally every debounced autosave (as often as every
// ~1s during active editing) would burn through the whole MAX_BACKUPS
// window in a couple minutes of normal use, leaving nothing but
// near-duplicate recent snapshots — not a meaningful safety net. Rate-
// limited instead: at most one snapshot per this interval during ongoing
// use, plus one forced snapshot at the start of every session (see
// loadConfig below) so "undo this whole session" always has a point to
// return to even in a short session.
const BACKUP_MIN_INTERVAL_MS = 15 * 60 * 1000;
let lastBackupAtMs = 0;

// ---------- Backup labels ----------
// A small sidecar file rather than encoding the label into the backup's own
// filename — keeps the existing filename format (and every regex that
// validates it below) completely untouched, so labeling is purely additive.
// Missing/corrupt labels.json just means no labels yet, never an error.
const LABELS_PATH = path.join(BACKUPS_DIR, 'labels.json');

function readLabels() {
  try {
    return JSON.parse(fs.readFileSync(LABELS_PATH, 'utf-8'));
  } catch (e) {
    return {};
  }
}

function writeLabels(labels) {
  try {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    fs.writeFileSync(LABELS_PATH, JSON.stringify(labels, null, 2), 'utf-8');
  } catch (e) {
    console.error('Writing backup labels failed:', e.message);
  }
}

function setBackupLabel(file, label) {
  if (typeof file !== 'string' || !/^channels-[0-9TZ-]+\.json$/.test(file)) {
    throw new Error('Invalid backup filename');
  }
  const labels = readLabels();
  const trimmed = (label || '').trim().slice(0, 80);
  if (trimmed) labels[file] = trimmed; else delete labels[file];
  writeLabels(labels);
  return true;
}

// Returns the created snapshot's filename (or null if nothing was written —
// no config on disk yet, or skipped by the rate limit) so a caller like the
// new "SNAPSHOT NOW" button can attach a label to the exact file it made,
// not just "whichever one is newest" (a second rapid snapshot elsewhere
// could otherwise race it).
function backupCurrentConfig(force) {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) return null; // nothing to snapshot yet (fresh install)
  const now = Date.now();
  if (!force && now - lastBackupAtMs < BACKUP_MIN_INTERVAL_MS) return null;
  lastBackupAtMs = now;
  try {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `channels-${stamp}.json`;
    fs.copyFileSync(configPath, path.join(BACKUPS_DIR, filename));
    const files = fs.readdirSync(BACKUPS_DIR)
      .filter((f) => /^channels-.+\.json$/.test(f))
      .sort(); // ISO timestamps in the filename sort chronologically as plain strings
    const labels = readLabels();
    let labelsChanged = false;
    while (files.length > MAX_BACKUPS) {
      const oldest = files.shift();
      try { fs.unlinkSync(path.join(BACKUPS_DIR, oldest)); } catch (e) {}
      if (labels[oldest] !== undefined) { delete labels[oldest]; labelsChanged = true; }
    }
    if (labelsChanged) writeLabels(labels);
    return filename;
  } catch (e) {
    console.error('Config backup failed:', e.message);
    return null;
  }
}

function listBackups() {
  try {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    const labels = readLabels();
    return fs.readdirSync(BACKUPS_DIR)
      .filter((f) => /^channels-.+\.json$/.test(f))
      .map((f) => {
        const stat = fs.statSync(path.join(BACKUPS_DIR, f));
        return { file: f, mtimeMs: stat.mtimeMs, size: stat.size, label: labels[f] || null };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch (e) {
    return [];
  }
}

// filename is always one this app itself generated (the renderer only ever
// passes back a `file` value it got from listBackups) — validated anyway
// against the exact pattern backupCurrentConfig writes, so a malformed or
// path-traversal-y value can't escape BACKUPS_DIR.
function restoreBackup(file) {
  if (typeof file !== 'string' || !/^channels-[0-9TZ-]+\.json$/.test(file)) {
    throw new Error('Invalid backup filename');
  }
  const backupPath = path.join(BACKUPS_DIR, file);
  const raw = fs.readFileSync(backupPath, 'utf-8'); // throws if missing
  const parsed = JSON.parse(raw); // throws if somehow corrupt — caller sees the rejection, nothing is overwritten
  backupCurrentConfig(true); // the state being replaced is itself worth keeping, forced past the rate limit
  const configPath = getConfigPath();
  const tempPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, raw, 'utf-8');
  fs.renameSync(tempPath, configPath);
  return parsed;
}

// Manual prune, alongside the automatic MAX_BACKUPS rotation above — a
// snapshot known to be from mid-experiment (a scratch channel, a bad bulk
// action right before it got fixed) doesn't need to sit in the list for 20
// more saves before it ages out on its own. Same filename validation as
// restoreBackup, same reason.
function deleteBackup(file) {
  if (typeof file !== 'string' || !/^channels-[0-9TZ-]+\.json$/.test(file)) {
    throw new Error('Invalid backup filename');
  }
  fs.unlinkSync(path.join(BACKUPS_DIR, file)); // throws if missing — caller sees the rejection
  const labels = readLabels();
  if (labels[file] !== undefined) { delete labels[file]; writeLabels(labels); }
  return true;
}

// Only ever writes one .corrupt-<timestamp> backup per process run, even
// though loadConfig() below is now called repeatedly — originally it only
// ran once at boot, but the LAN viewer's GET /api/config (main.js's
// startViewerServer) calls it on every request, including a viewer's
// periodic poll every 10s. Without this guard, a genuinely corrupted
// channels.json would get a fresh backup file written on every single poll
// for as long as it stayed broken.
let corruptConfigBackupPath = null;
let corruptConfigBackupAttempted = false;

// Only the first loadConfig() call in a process's lifetime should force a
// session-start snapshot — same repeated-poll reasoning as
// corruptConfigBackupAttempted above.
let sessionStartBackupTaken = false;

function loadConfig() {
  const configPath = getConfigPath();
  if (!sessionStartBackupTaken) {
    sessionStartBackupTaken = true;
    backupCurrentConfig(true);
  }
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (e) {
    // No config file yet — a genuinely fresh install, not data loss.
    // _isFirstRun is a one-time signal for the renderer's onboarding screen
    // (app.js init(), onboarding.js) — distinct from just "channels.length
    // === 0", which a returning user can also hit after deleting every
    // channel and shouldn't be re-welcomed for.
    return { channels: [], _isFirstRun: true };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.channels) parsed.channels = [];
    return parsed;
  } catch (e) {
    // The file exists but isn't valid JSON (partial write, external edit,
    // disk corruption). This is real, possibly irreplaceable data — a
    // user's whole channel/block/interstitial library — so preserve the raw
    // bytes alongside the real path instead of silently starting from an
    // empty config with no trace anything went wrong. _configLoadError is
    // read by the renderer's init() (app.js) to surface a one-time warning.
    if (!corruptConfigBackupAttempted) {
      corruptConfigBackupAttempted = true;
      try {
        corruptConfigBackupPath = `${configPath}.corrupt-${Date.now()}`;
        fs.writeFileSync(corruptConfigBackupPath, raw, 'utf-8');
      } catch (e2) { corruptConfigBackupPath = null; }
      console.error('channels.json failed to parse:', e.message, corruptConfigBackupPath ? `— raw contents preserved at ${corruptConfigBackupPath}` : '');
    }
    return { channels: [], _configLoadError: true, _configLoadErrorBackupPath: corruptConfigBackupPath };
  }
}

// Written via temp-file-then-rename rather than a direct write — a crash or
// power loss mid-write to the real path would otherwise leave channels.json
// truncated/corrupt with no way back. The temp file lives next to the real
// one so the rename stays on the same volume (cross-volume renames aren't
// atomic).
function saveConfig(config) {
  backupCurrentConfig(); // snapshot whatever's on disk *before* overwriting it (rate-limited — see above)
  const configPath = getConfigPath();
  const tempPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, JSON.stringify(config, null, 2), 'utf-8');
  fs.renameSync(tempPath, configPath);
  return true;
}

module.exports = {
  getConfigPath, loadConfig, saveConfig, backupCurrentConfig, listBackups, restoreBackup, deleteBackup, setBackupLabel,
};
