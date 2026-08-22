const { app } = require('electron');
const path = require('path');
const fs = require('fs');

// ---------- Portable-install userData migration ----------
// All per-user data (channels.json, backups, plugins, window state, any
// plugin's own data folder) lives in a `userData/` folder next to the app
// itself rather than Electron's OS-profile default (%APPDATA%/
// retro-cable-box on Windows) — the whole box, config included, stays
// inside one folder you can copy/move/back up as a unit.
//
// migrateUserDataIfNeeded() below MUST run — and finish repointing
// app.setPath('userData', ...) — before ANYTHING in this process calls
// app.getPath('userData'), including every other function in this very
// module. That's exactly why getConfigPath()/getBackupsDir()/getLabelsPath()
// are functions rather than top-level constants: requiring this module (or
// any other main-*.js module) must never itself capture the path before
// migration has had a chance to run. main.js calls this first, before
// requiring anything else that touches userData.
//
// One-time migration: if a previous OS-profile install already has real
// data and the local folder doesn't exist yet, copy it over (not move — the
// original is left in place untouched) so upgrading to this layout never
// looks like data loss. Only this app's own files/folders are copied —
// never Electron/Chromium's own profile internals (Cache/, GPUCache/, Local
// State, Session Storage/, etc.), which are (a) irrelevant to migrate
// (freshly regenerated at the new location regardless) and (b) sometimes
// still locked by whatever process most recently touched them, which made
// an earlier blind recursive-copy attempt here fail outright.
const OWN_DATA_ENTRIES = [
  'channels.json', 'window-state.json', 'api-cache.json',
  'backups', 'plugins',
];

// A plugin can declare manifest `"dataDir": "some-folder-name"` for a
// root-level userData folder it owns beyond its own plugins/<id>/ folder
// (already covered by the 'plugins' entry above) — e.g. a party server's
// guest-uploaded media, a music-channel plugin's download cache. Read via a
// raw manifest scan (not main-plugins.js's discoverPlugins(), which isn't
// safe to call before this migration has even decided where userData
// lives) so core doesn't need to hardcode any specific plugin's data
// folder name here.
function pluginDeclaredDataDirs(userDataDir) {
  const dirs = [];
  try {
    fs.readdirSync(path.join(userDataDir, 'plugins'), { withFileTypes: true }).forEach((entry) => {
      if (!entry.isDirectory()) return;
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(userDataDir, 'plugins', entry.name, 'manifest.json'), 'utf-8'));
        if (typeof manifest.dataDir === 'string' && manifest.dataDir) dirs.push(manifest.dataDir);
      } catch (e) { /* unreadable/missing manifest — nothing to learn from it */ }
    });
  } catch (e) { /* no plugins folder at the old location at all */ }
  return dirs;
}

function migrateUserDataIfNeeded() {
  const defaultUserDataDir = app.getPath('userData');
  const appDir = app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..');
  const localUserDataDir = path.join(appDir, 'userData');
  const samePath = path.resolve(defaultUserDataDir) === path.resolve(localUserDataDir);
  if (!samePath && !fs.existsSync(localUserDataDir) && fs.existsSync(defaultUserDataDir)) {
    try {
      fs.mkdirSync(localUserDataDir, { recursive: true });
      const entriesToCopy = OWN_DATA_ENTRIES.concat(pluginDeclaredDataDirs(defaultUserDataDir));
      // channels.json.bak-* / .corrupt-* sit alongside channels.json itself
      // (see loadConfig/restoreBackup below) — swept in too, same
      // glob-by-prefix as everywhere else that handles those.
      fs.readdirSync(defaultUserDataDir).forEach((name) => {
        if (entriesToCopy.includes(name) || name.startsWith('channels.json.')) {
          fs.cpSync(path.join(defaultUserDataDir, name), path.join(localUserDataDir, name), { recursive: true });
        }
      });
    } catch (e) {
      console.error('Could not migrate existing userData into the portable local folder — continuing with the OS-profile location instead:', e.message);
      try { fs.rmSync(localUserDataDir, { recursive: true, force: true }); } catch (e2) { /* leave the partial copy for inspection if even cleanup fails */ }
    }
  }
  if (fs.existsSync(localUserDataDir) || !fs.existsSync(defaultUserDataDir)) {
    if (!fs.existsSync(localUserDataDir)) fs.mkdirSync(localUserDataDir, { recursive: true });
    app.setPath('userData', localUserDataDir);
  }
}

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
// A function, not a top-level constant — computed lazily on every call so
// this module never captures app.getPath('userData') at require() time.
// That matters because requiring this module is now also how the one-time
// portable-userData migration below gets invoked, and that migration has to
// run (and finish repointing 'userData') before ANYTHING captures the path
// — including this module's own require().
function getBackupsDir() { return path.join(app.getPath('userData'), 'backups'); }
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
function getLabelsPath() { return path.join(getBackupsDir(), 'labels.json'); }

function readLabels() {
  try {
    return JSON.parse(fs.readFileSync(getLabelsPath(), 'utf-8'));
  } catch (e) {
    return {};
  }
}

function writeLabels(labels) {
  try {
    fs.mkdirSync(getBackupsDir(), { recursive: true });
    fs.writeFileSync(getLabelsPath(), JSON.stringify(labels, null, 2), 'utf-8');
  } catch (e) {
    console.error('Writing backup labels failed:', e.message);
  }
}

// Every one of backupCurrentConfig's own filenames matches this, and every
// caller below that takes a `file` value back from the renderer (which only
// ever echoes one it originally got from listBackups) re-validates against
// it anyway before touching the filesystem, rather than trusting it — a
// malformed or path-traversal-y value can't escape the backups directory.
function isValidBackupFilename(file) {
  return typeof file === 'string' && /^channels-[0-9TZ-]+\.json$/.test(file);
}

function setBackupLabel(file, label) {
  if (!isValidBackupFilename(file)) {
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
    const backupsDir = getBackupsDir();
    fs.mkdirSync(backupsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `channels-${stamp}.json`;
    fs.copyFileSync(configPath, path.join(backupsDir, filename));
    const files = fs.readdirSync(backupsDir)
      .filter((f) => /^channels-.+\.json$/.test(f))
      .sort(); // ISO timestamps in the filename sort chronologically as plain strings
    const labels = readLabels();
    let labelsChanged = false;
    while (files.length > MAX_BACKUPS) {
      const oldest = files.shift();
      try { fs.unlinkSync(path.join(backupsDir, oldest)); } catch (e) {}
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
    const backupsDir = getBackupsDir();
    fs.mkdirSync(backupsDir, { recursive: true });
    const labels = readLabels();
    return fs.readdirSync(backupsDir)
      .filter((f) => /^channels-.+\.json$/.test(f))
      .map((f) => {
        const stat = fs.statSync(path.join(backupsDir, f));
        return { file: f, mtimeMs: stat.mtimeMs, size: stat.size, label: labels[f] || null };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch (e) {
    return [];
  }
}

function restoreBackup(file) {
  if (!isValidBackupFilename(file)) {
    throw new Error('Invalid backup filename');
  }
  const backupPath = path.join(getBackupsDir(), file);
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
  if (!isValidBackupFilename(file)) {
    throw new Error('Invalid backup filename');
  }
  fs.unlinkSync(path.join(getBackupsDir(), file)); // throws if missing — caller sees the rejection
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
  migrateUserDataIfNeeded,
  getConfigPath, loadConfig, saveConfig, backupCurrentConfig, listBackups, restoreBackup, deleteBackup, setBackupLabel,
};
