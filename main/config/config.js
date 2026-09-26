const { app, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { compareConfigs, configSummary } = require('./diff');
const crypto = require('crypto');
const { createChangeAnnouncer, createConfigHost } = require('./host');
const { getMainWindow } = require('./window-ref');

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
  'update-state.json', 'viewing-history.json',
  'backups', 'plugins',
  // The Video Splicer's remembered folders and options (main/splicer/service.js).
  'video-splicer',
  // The media library's catalogue, reviews and smart channels (docs/design/07).
  'library',
  // Household profiles, favorites, DVR and personal history (docs/design/09).
  'profiles',
  // Images uploaded from the LAN control panel. Channels reference them by
  // absolute path as logos/overlays, so losing them breaks those channels.
  'assets',
  // Not 'lan-sessions': paired-device session tokens. Losing them only means
  // re-pairing, and they shouldn't sit in a temp-dir copy between boots.
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

// Shared by the one-time OS-profile migration below AND the pre-update
// backup/restore pair (backupUserDataForUpdate, restoreUserDataIfWiped) —
// "what actually matters" in a userData dir is the same list either way:
// this app's own files/folders, plus whatever a plugin's own manifest
// declares, plus channels.json's rotating backups/corrupt-preserves (which
// sit alongside it by name, not as one of the fixed entries above).
function copyOwnDataEntries(fromDir, toDir) {
  const entriesToCopy = OWN_DATA_ENTRIES.concat(pluginDeclaredDataDirs(fromDir));
  fs.readdirSync(fromDir).forEach((name) => {
    if (entriesToCopy.includes(name) || name.startsWith('channels.json.')) {
      fs.cpSync(path.join(fromDir, name), path.join(toDir, name), { recursive: true });
    }
  });
}

function portableUserDataDir() {
  // config.js now lives in main/config/.  In development the portable data
  // directory remains at the application root, alongside package.json — not
  // inside main/ (which would also bypass the test harness's protected copy).
  const appDir = app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..', '..');
  return path.join(appDir, 'userData');
}

// A temp location OUTSIDE the app's own install directory — the whole point
// is surviving an installer step that wipes/replaces that directory (see
// backupUserDataForUpdate's own comment). Namespaced by install path (not
// just a fixed name) so a portable install run from more than one location
// on the same machine can't clobber each other's pending backup.
function pendingUpdateBackupDir() {
  const crypto = require('crypto');
  const key = crypto.createHash('sha1').update(portableUserDataDir()).digest('hex').slice(0, 16);
  return path.join(app.getPath('temp'), `rerun-tv-update-userdata-${key}`);
}

// Called by main-updater.js immediately before quitAndInstall() — the
// portable userData folder lives INSIDE the app's own install directory
// (see this module's header comment), and an NSIS update install is free to
// wipe/replace that whole directory as part of laying down the new version.
// Found live: a real update cycle lost the user's entire channel lineup this
// way. Copies (not moves) the current data to a safe location outside the
// install dir; restoreUserDataIfWiped() below reconciles it back on the next
// boot, whichever way the install actually behaved.
let preUpdateSnapshotTaken = false;

function backupUserDataForUpdate() {
  try {
    const localDir = portableUserDataDir();
    if (!fs.existsSync(localDir) || !fs.existsSync(path.join(localDir, 'channels.json'))) return;
    // Keep an ordinary, user-visible restore point as well as the external
    // whole-userData safety copy. This makes the Backups screen explain
    // exactly which snapshot preceded an update and lets users inspect or
    // restore it without digging through a temporary directory.
    if (!preUpdateSnapshotTaken) {
      backupCurrentConfig(true, 'before-update');
      preUpdateSnapshotTaken = true;
    }
    const backupDir = pendingUpdateBackupDir();
    fs.rmSync(backupDir, { recursive: true, force: true }); // clear any stale backup from a previous update attempt
    fs.mkdirSync(backupDir, { recursive: true });
    copyOwnDataEntries(localDir, backupDir);
  } catch (e) {
    console.error('Could not back up userData ahead of an update install — continuing without a safety copy:', e.message);
  }
}

// Called at the very start of migrateUserDataIfNeeded() below, before that
// function decides where 'userData' should point — reconciles whatever
// backupUserDataForUpdate() left behind against what the just-installed
// update actually left in place.
function restoreUserDataIfWiped() {
  const backupDir = pendingUpdateBackupDir();
  if (!fs.existsSync(backupDir)) return; // no update was in flight, or nothing needed backing up
  try {
    const localDir = portableUserDataDir();
    const wiped = !fs.existsSync(localDir) || !fs.existsSync(path.join(localDir, 'channels.json'));
    if (wiped) {
      fs.mkdirSync(localDir, { recursive: true });
      copyOwnDataEntries(backupDir, localDir);
    }
    // Either restored, or the install left the real data intact and this was
    // only ever a safety net — the backup's one-shot either way.
    fs.rmSync(backupDir, { recursive: true, force: true });
  } catch (e) {
    console.error('Could not restore userData from its pre-update backup — the backup is left in place for manual recovery:', e.message, backupDir);
  }
}

function migrateUserDataIfNeeded() {
  restoreUserDataIfWiped();
  const defaultUserDataDir = app.getPath('userData');
  const localUserDataDir = portableUserDataDir();
  const samePath = path.resolve(defaultUserDataDir) === path.resolve(localUserDataDir);
  // One-time migration is due: the two locations genuinely differ, nothing's
  // been copied to the local folder yet, and there's old OS-profile data to
  // bring over in the first place.
  const needsOneTimeMigration = !samePath && !fs.existsSync(localUserDataDir) && fs.existsSync(defaultUserDataDir);
  if (needsOneTimeMigration) {
    try {
      fs.mkdirSync(localUserDataDir, { recursive: true });
      copyOwnDataEntries(defaultUserDataDir, localUserDataDir);
    } catch (e) {
      console.error('Could not migrate existing userData into the portable local folder — continuing with the OS-profile location instead:', e.message);
      try { fs.rmSync(localUserDataDir, { recursive: true, force: true }); } catch (e2) { /* leave the partial copy for inspection if even cleanup fails */ }
    }
  }
  // Use the local folder if it now has (or already had) data, or if there's
  // no old OS-profile data to fall back to anyway (a fresh install).
  const shouldUseLocalDir = fs.existsSync(localUserDataDir) || !fs.existsSync(defaultUserDataDir);
  if (shouldUseLocalDir) {
    if (!fs.existsSync(localUserDataDir)) fs.mkdirSync(localUserDataDir, { recursive: true });
    app.setPath('userData', localUserDataDir);
  }
}

function getConfigPath() {
  return path.join(app.getPath('userData'), 'channels.json');
}

// ---------- channels.json read cache ----------
// loadConfig() is called far more often than channels.json actually
// changes — every LAN viewer's ~10s config poll, every party-channel/
// universal-remote request that touches config, on top of the renderer's
// own config:load — and each call used to mean a fresh synchronous
// readFileSync + JSON.parse of the whole file, done on the Electron main
// process's single thread, blocking every other pending IPC/LAN request
// for however long that took. Caches the raw file text (not the parsed
// object — loadConfig() still does a fresh JSON.parse per call off the
// cached string, so every caller still gets its own independently-
// mutable object, same as before this cache existed; several call sites
// mutate the returned object in place before calling saveConfig() with
// it, and sharing one parsed object across callers would corrupt that).
// Invalidated explicitly by writeConfigFile() below (the only place in
// this module that writes channels.json) and defensively by an mtime
// check on every read, in case something outside this process's own
// writes ever touches the file (a user hand-editing it while the app is
// running, restoring from an external tool, etc.).
let cachedConfigRaw = null;
let cachedConfigMtimeMs = null;

function readConfigFileCached() {
  const configPath = getConfigPath();
  const stat = fs.statSync(configPath); // throws ENOENT if missing, same as a direct readFileSync would
  if (cachedConfigRaw === null || stat.mtimeMs !== cachedConfigMtimeMs) {
    cachedConfigRaw = fs.readFileSync(configPath, 'utf-8');
    cachedConfigMtimeMs = stat.mtimeMs;
  }
  return cachedConfigRaw;
}

// Every write to channels.json in this module goes through here so the
// read cache above can never observe stale content after a save/restore.
function writeConfigFile(raw) {
  const configPath = getConfigPath();
  const tempPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, raw, 'utf-8');
  fs.renameSync(tempPath, configPath);
  cachedConfigRaw = null;
  cachedConfigMtimeMs = null;
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
function getBackupMetadataPath() { return path.join(getBackupsDir(), 'metadata.json'); }

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

function readBackupMetadata() {
  try { return JSON.parse(fs.readFileSync(getBackupMetadataPath(), 'utf-8')); }
  catch (e) { return {}; }
}

function writeBackupMetadata(metadata) {
  try { fs.writeFileSync(getBackupMetadataPath(), JSON.stringify(metadata, null, 2), 'utf-8'); }
  catch (e) { console.error('Writing backup metadata failed:', e.message); }
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

function setBackupPinned(file, pinned) {
  if (!isValidBackupFilename(file)) throw new Error('Invalid backup filename');
  const metadata = readBackupMetadata();
  metadata[file] = { ...(metadata[file] || {}), pinned: !!pinned };
  writeBackupMetadata(metadata);
  return true;
}

// Returns the created snapshot's filename (or null if nothing was written —
// no config on disk yet, or skipped by the rate limit) so a caller like the
// new "SNAPSHOT NOW" button can attach a label to the exact file it made,
// not just "whichever one is newest" (a second rapid snapshot elsewhere
// could otherwise race it).
function backupCurrentConfig(force, reason = force ? 'manual' : 'automatic') {
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
    const metadata = readBackupMetadata();
    metadata[filename] = { reason, createdAt: now };
    writeBackupMetadata(metadata);
    const files = fs.readdirSync(backupsDir)
      .filter((f) => /^channels-.+\.json$/.test(f))
      .sort(); // ISO timestamps in the filename sort chronologically as plain strings
    const labels = readLabels();
    let labelsChanged = false;
    const removable = files.filter((file) => !metadata[file]?.pinned);
    while (removable.length > MAX_BACKUPS) {
      const oldest = removable.shift();
      files.splice(files.indexOf(oldest), 1);
      try { fs.unlinkSync(path.join(backupsDir, oldest)); } catch (e) {}
      if (labels[oldest] !== undefined) { delete labels[oldest]; labelsChanged = true; }
      if (metadata[oldest] !== undefined) delete metadata[oldest];
    }
    if (labelsChanged) writeLabels(labels);
    writeBackupMetadata(metadata);
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
    const metadata = readBackupMetadata();
    return fs.readdirSync(backupsDir)
      .filter((f) => /^channels-.+\.json$/.test(f))
      .map((f) => {
        const stat = fs.statSync(path.join(backupsDir, f));
        return { file: f, mtimeMs: stat.mtimeMs, size: stat.size, label: labels[f] || null, reason: metadata[f]?.reason || 'automatic', pinned: !!metadata[f]?.pinned };
      })
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.mtimeMs - a.mtimeMs);
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
  backupCurrentConfig(true, 'before-restore'); // the state being replaced is itself worth keeping, forced past the rate limit
  writeConfigFile(raw);
  // Host edits from before the restore must not be replayed onto the
  // renderer's next save of the restored config (config-host.js).
  configHost.noteReset();
  configChanges.written(parsed);
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
  const metadata = readBackupMetadata();
  if (metadata[file] !== undefined) { delete metadata[file]; writeBackupMetadata(metadata); }
  return true;
}

function previewBackup(file) {
  if (!isValidBackupFilename(file)) throw new Error('Invalid backup filename');
  const snapshot = JSON.parse(fs.readFileSync(path.join(getBackupsDir(), file), 'utf-8'));
  let current = { channels: [] };
  try { current = JSON.parse(readConfigFileCached()); } catch (e) { /* report an empty current summary */ }
  return { snapshot: configSummary(snapshot), current: configSummary(current), diff: compareConfigs(current, snapshot) };
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
    backupCurrentConfig(true, 'session-start');
  }
  let raw;
  try {
    raw = readConfigFileCached();
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

// Written via temp-file-then-rename (writeConfigFile above) rather than a
// direct write — a crash or power loss mid-write to the real path would
// otherwise leave channels.json truncated/corrupt with no way back. The
// temp file lives next to the real one so the rename stays on the same
// volume (cross-volume renames aren't atomic).
function saveConfig(config) {
  backupCurrentConfig(false, 'automatic'); // snapshot whatever's on disk *before* overwriting it (rate-limited — see above)
  writeConfigFile(JSON.stringify(config, null, 2));
  configChanges.written(config);
  return true;
}

// Listeners for "a write changed something a LAN viewer would care about"
// (config-host.js's createChangeAnnouncer). main.js publishes it on the viewer
// event bus.
const configWrittenListeners = new Set();
const configChanges = createChangeAnnouncer({
  hash: (text) => crypto.createHash('sha1').update(text).digest('hex'),
  notify: () => configWrittenListeners.forEach((fn) => {
    try { fn(); } catch (e) { console.warn('[config] change listener failed:', e.message); }
  }),
});
let configChangesPrimed = false;

function onViewerRelevantConfigChange(fn) {
  configWrittenListeners.add(fn);
  if (!configChangesPrimed) {
    configChangesPrimed = true;
    const current = loadConfig();
    if (!current._configLoadError && !current._isFirstRun) configChanges.prime(current);
  }
  return () => configWrittenListeners.delete(fn);
}

// Everything that wants the commands the host just applied. The Electron
// window is told directly in broadcast() below; the LAN viewer server
// subscribes here so paired control clients hear the same thing (main.js).
const configAppliedListeners = new Set();

function onConfigApplied(fn) {
  configAppliedListeners.add(fn);
  return () => configAppliedListeners.delete(fn);
}

// The one owner of host-side config edits (config-host.js). Commands come from
// the same renderer/js/commands.js the renderer uses, loaded as an ES module.
const COMMANDS_MODULE_PATH = path.join(__dirname, '..', '..', 'renderer', 'js', 'core', 'commands.js');

const configHost = createConfigHost({
  load: loadConfig,
  save: saveConfig,
  broadcast: (update) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('config:applied', update);
    configAppliedListeners.forEach((listener) => {
      try { listener(update); } catch (e) { console.warn('[config-host] applied listener failed:', e.message); }
    });
  },
  // Two levels up: this file lives in main/config/, so the renderer bundle is
  // ../../renderer. Kept as a named constant because it is resolved lazily at
  // the first host command, long after boot, where a wrong path would surface
  // only as a failed plugin approval — tests/config-host.test.js checks it.
  loadCommands: () => import(pathToFileURL(COMMANDS_MODULE_PATH).href),
});

// Headless Companion edits have no desktop renderer/autosave owner. Merge
// only existing, same-shaped settings into the current disk config; never
// accept a projected viewer config or replace the channel/plugin registry.
// Applied as a config.patch of plain value sets (never splices), so it can be
// replayed onto a later renderer save without doubling anything.
async function applyHeadlessSettingsPatch(patch) {
  const config = loadConfig();
  if (config._configLoadError) throw new Error('Cannot edit an unreadable config');
  const blocked = new Set(['__proto__', 'prototype', 'constructor']);
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const ops = [];
  const undo = [];
  function merge(target, incoming, pathSoFar, root = false) {
    for (const [key, value] of Object.entries(incoming)) {
      if (blocked.has(key) || key.startsWith('_') || !Object.prototype.hasOwnProperty.call(target, key)) continue;
      if (root && ['channels', 'plugins', 'pluginSettingsMeta'].includes(key)) continue;
      const current = target[key];
      if (object(current) && object(value)) {
        merge(current, value, [...pathSoFar, key]);
      } else if (Array.isArray(current) ? Array.isArray(value)
        : !object(current) && !object(value) && !Array.isArray(value) && typeof current === typeof value) {
        if (JSON.stringify(current) !== JSON.stringify(value)) {
          ops.push({ p: [...pathSoFar, key], v: JSON.parse(JSON.stringify(value)) });
          undo.unshift({ p: [...pathSoFar, key], v: JSON.parse(JSON.stringify(current)) });
        }
      }
    }
  }
  if (!object(patch)) throw new Error('A settings patch object is required');
  merge(config, patch, [], true);
  if (ops.length) await configHost.applyCommands({ type: 'config.patch', ops, undo, label: 'Companion settings' }, { source: 'companion' });
  return true;
}

function registerBackupsIpc(ipcMain) {
  ipcMain.handle('backups:list', async () => listBackups());
  ipcMain.handle('backups:preview', async (event, file) => previewBackup(file));
  ipcMain.handle('backups:restore', async (event, file) => restoreBackup(file));
  ipcMain.handle('backups:delete', async (event, file) => deleteBackup(file));
  ipcMain.handle('backups:setLabel', async (event, file, label) => setBackupLabel(file, label));
  ipcMain.handle('backups:setPinned', async (event, file, pinned) => setBackupPinned(file, pinned));

  // Forces a snapshot right now, bypassing the normal 15-min rate limit —
  // "before I do something risky" is a real, deliberate moment, not the
  // steady-state autosave case that limit exists to throttle. Returns the
  // created filename (or null if there's nothing to snapshot yet) so the
  // caller can immediately attach the user's label to the exact file just
  // written, not "whichever is newest" a moment later.
  ipcMain.handle('backups:createNow', async () => backupCurrentConfig(true, 'manual'));
}

function registerConfigIpc(ipcMain) {
  ipcMain.handle('config:load', async () => loadConfig());
  // baseRevision: the newest host revision the renderer had applied when it
  // built `config` — host edits since then are replayed onto it before it's
  // written (config-host.js).
  ipcMain.handle('config:save', async (event, config, baseRevision, client) => configHost.reconcileSave(config, baseRevision, { client }));
  ipcMain.handle('config:revision', async () => configHost.getRevision());
  // Config plus the revision it is at, in one reply — what a client rebuilds
  // itself from after the host refuses one of its batches (docs/design/05 §2.3).
  ipcMain.handle('config:snapshot', async () => configHost.snapshot());

  // The command write path (docs/design/05 §2.2). A client applies its batch
  // optimistically, then posts it here with the revision it was built against
  // and an id of its own; the host is the only writer. The reply is either the
  // applied update (which the client reconciles against, and which every other
  // client receives as config:applied) or a typed refusal it has to act on.
  ipcMain.handle('config:command', async (event, batch, meta) => configHost.applyCommands(batch, {
    ...(meta || {}),
    origin: 'client',
    source: (meta && meta.source) || 'renderer',
  }));

  ipcMain.handle('config:export', async (event, config, suggestedName) => {
    const safeName = typeof suggestedName === 'string' && suggestedName.trim()
      ? suggestedName.replace(/[\\/:*?"<>|]/g, '_').trim()
      : `retro-cable-box-config-${new Date().toISOString().slice(0, 10)}`;
    const result = await dialog.showSaveDialog(getMainWindow(), {
      defaultPath: `${safeName}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return null;
    fs.writeFileSync(result.filePath, JSON.stringify(config, null, 2), 'utf-8');
    return result.filePath;
  });

  ipcMain.handle('config:import', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const raw = fs.readFileSync(result.filePaths[0], 'utf-8');
    const parsed = JSON.parse(raw);
    const isConfig = parsed && typeof parsed === 'object' && Array.isArray(parsed.channels);
    const isChannelPackage = parsed && parsed.kind === 'reruntv-channel-package' && parsed.channel;
    if (!isConfig && !isChannelPackage) {
      throw new Error('That file doesn\'t look like a RerunTV config or channel package.');
    }
    return parsed;
  });
}

module.exports = {
  migrateUserDataIfNeeded, backupUserDataForUpdate,
  getConfigPath, loadConfig, saveConfig, backupCurrentConfig, listBackups, previewBackup, restoreBackup, deleteBackup, setBackupLabel, setBackupPinned,
  registerBackupsIpc, registerConfigIpc, applyHeadlessSettingsPatch, configHost, onViewerRelevantConfigChange, onConfigApplied,
};
