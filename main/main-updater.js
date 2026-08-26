const { app, ipcMain, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { loadConfig, backupUserDataForUpdate } = require('./main-config');
const { fetchJsonCached } = require('./main-api-cache');
const {
  normalizeUpdateStrategy, prepareVersionTransition, rememberDownloadedRelease: recordDownloadedRelease,
} = require('./main-updater-state');

// Auto-update via electron-updater, fed by this repo's GitHub Releases (see
// package.json's build.publish). Releases are published by
// .github/workflows/build-installer.yml on every push to the deploy branch
// — that workflow's own "Create GitHub Release" step is what actually
// uploads the installer + latest.yml + .blockmap this depends on (running
// `npm run dist` locally works too, but nothing here requires it). Windows-
// only in practice right now: build.win.target is nsis, which electron-
// updater supports out of the box, while build.mac's target (dmg) and
// build.linux's target (AppImage) need their own auto-update wiring (mac
// needs a "zip" target alongside dmg for Squirrel.Mac; AppImage is
// supported but untested here) — skip silently rather than error on those.
//
// This repo (Zhubbs19/RerunTV) is private — GitHub 404s an unauthenticated
// request to its API the same way it would for a repo that doesn't exist,
// for both the release-notes fetch below and electron-updater's own check.
// build.publish.private: true (package.json) tells electron-updater to use
// its PrivateGitHubProvider, which needs a token read from the GH_TOKEN or
// GITHUB_TOKEN environment variable at runtime — set one of those
// (system/user env var, not a one-off shell session, so a desktop-launched
// shortcut inherits it too) with at least read access to this repo before
// expecting either feature to work. No token is baked into the build itself
// — it's read fresh from this machine's environment every time.
//
// Never active outside a packaged install: `electron .` in dev has no
// app-update.yml (nothing was ever published for it to compare against) and
// autoUpdater throws immediately if asked to check. checkForUpdates() below
// reports that explicitly ('dev-mode') instead of calling into autoUpdater
// at all — the HELP tab's CHECK NOW button and the settings there both stay
// usable for a developer running from source, just inert.
//
// User-facing control lives in one config.updates.strategy value rather
// than two overlapping toggles: startup-auto, background-auto,
// background-notify, manual, or off. See main-updater-state.js for legacy
// migration. Read fresh at every decision so a settings change takes effect
// without a restart.
let autoUpdater = null;
let progressWindow = null;
let progressWindowReady = false;
let latestProgressState = null;
let latestThemeColors = null;
let progressCloseTimer = null;
let startupUpdateActive = false;
let startupUpdateResolve = null;
let startupCheckTimer = null;
let manualCheckRequested = false;

function updateStatePath() {
  return path.join(app.getPath('userData'), 'update-state.json');
}

function readUpdateState() {
  try {
    return JSON.parse(fs.readFileSync(updateStatePath(), 'utf8'));
  } catch (e) {
    return {};
  }
}

function writeUpdateState(state) {
  try {
    const file = updateStatePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, file);
  } catch (e) {
    console.error('[auto-updater] could not persist update state:', e.message);
  }
}

// Called after userData restoration and before the renderer asks for its
// one-time notice. A brand-new install establishes a baseline silently;
// only a later version transition creates a pending changelog.
function preparePostUpdateNotice() {
  const currentVersion = app.getVersion();
  const state = readUpdateState();
  const before = JSON.stringify(state);
  prepareVersionTransition(state, currentVersion);
  if (JSON.stringify(state) !== before) writeUpdateState(state);
}

function rememberDownloadedRelease(info) {
  const state = readUpdateState();
  recordDownloadedRelease(state, info);
  writeUpdateState(state);
}

function progressDetail(progress) {
  const transferredMb = Number(progress.transferred || 0) / (1024 * 1024);
  const totalMb = Number(progress.total || 0) / (1024 * 1024);
  const speedMb = Number(progress.bytesPerSecond || 0) / (1024 * 1024);
  const size = totalMb > 0 ? `${transferredMb.toFixed(1)} of ${totalMb.toFixed(1)} MB` : '';
  const speed = speedMb > 0 ? `${speedMb.toFixed(1)} MB/s` : '';
  return [size, speed].filter(Boolean).join('  •  ') || 'Downloading the update package…';
}

function sendProgressState(state) {
  latestProgressState = state;
  if (progressWindowReady && progressWindow && !progressWindow.isDestroyed()) {
    progressWindow.webContents.send('update-progress:state', state);
  }
}

function sendThemeColors() {
  if (progressWindowReady && progressWindow && !progressWindow.isDestroyed()) {
    progressWindow.webContents.send('update-progress:theme', latestThemeColors);
  }
}

// Called from main.js's 'theme:colors' listener whenever the renderer's
// active theme pack changes (themes.js's applyTheme) — cached here (not just
// forwarded) so a progress window created later, or already open, always has
// the latest report to draw from, same as latestProgressState above.
function setThemeColors(colors) {
  latestThemeColors = colors && typeof colors === 'object' ? colors : null;
  sendThemeColors();
}

function showProgressWindow(getMainWindow, state) {
  clearTimeout(progressCloseTimer);
  if (!progressWindow || progressWindow.isDestroyed()) {
    const parent = getMainWindow();
    progressWindowReady = false;
    progressWindow = new BrowserWindow({
      width: 520,
      height: 210,
      parent: parent && !parent.isDestroyed() ? parent : undefined,
      modal: false,
      frame: false,
      transparent: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, 'update-progress-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    progressWindow.setMenuBarVisibility(false);
    progressWindow.on('closed', () => {
      progressWindow = null;
      progressWindowReady = false;
    });
    progressWindow.webContents.on('did-finish-load', () => {
      progressWindowReady = true;
      sendThemeColors();
      if (latestProgressState) sendProgressState(latestProgressState);
      if (progressWindow && !progressWindow.isDestroyed()) progressWindow.showInactive();
    });
    progressWindow.loadURL('app://bundle/renderer/update-progress.html');
  }
  sendProgressState(state);
}

function closeProgressWindow(delayMs = 0) {
  clearTimeout(progressCloseTimer);
  progressCloseTimer = setTimeout(() => {
    if (progressWindow && !progressWindow.isDestroyed()) progressWindow.close();
  }, delayMs);
}
function getAutoUpdater() {
  if (!autoUpdater) {
    ({ autoUpdater } = require('electron-updater'));
    autoUpdater.autoDownload = true;
    // Decided per download by the active strategy below.
    autoUpdater.autoInstallOnAppQuit = false;
    // Every release this repo's CI actually publishes (.github/workflows/
    // build-installer.yml, deploy branch) is tagged --prerelease — there is
    // no separate "stable" channel right now. electron-updater's GitHub
    // provider ignores prereleases by default, which would make every check
    // report "up to date" forever regardless of what's actually been
    // shipped. Revisit this the day a real numbered (non-alpha) release
    // process exists.
    autoUpdater.allowPrerelease = true;
  }
  return autoUpdater;
}

function updatesConfig() {
  const cfg = loadConfig();
  return { strategy: normalizeUpdateStrategy(cfg.updates) };
}

function finishStartupUpdate(installing) {
  if (!startupUpdateActive) return;
  startupUpdateActive = false;
  clearTimeout(startupCheckTimer);
  startupCheckTimer = null;
  const resolve = startupUpdateResolve;
  startupUpdateResolve = null;
  if (!installing) closeProgressWindow();
  if (resolve) resolve(!!installing);
}

function sendStatus(getMainWindow, payload) {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) win.webContents.send('updates:status', payload);
}

const GITHUB_OWNER = 'Zhubbs19';
const GITHUB_REPO = 'RerunTV';
// Release cadence here is measured in days, not minutes — no reason to hit
// GitHub's (unauthenticated, 60/hour) API more than once an hour even
// across several HELP-tab visits in one session. Shares fetchJsonCached's
// disk cache/offline-fallback with the TMDB/NOAA integrations (main-api-
// cache.js) — same "never let a slow/unreachable API stall the caller"
// behavior, for free.
const RELEASE_NOTES_TTL_MS = 60 * 60 * 1000;

async function fetchReleaseNotes() {
  try {
    const headers = { 'User-Agent': 'RerunTV', Accept: 'application/vnd.github+json' };
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (token) headers.Authorization = `token ${token}`;
    const data = await fetchJsonCached(
      'github-releases',
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=10`,
      { headers },
      RELEASE_NOTES_TTL_MS,
    );
    if (!Array.isArray(data)) return [];
    return data.map((r) => ({
      tag: r.tag_name,
      name: r.name || r.tag_name,
      body: r.body || '',
      publishedAt: r.published_at,
      prerelease: !!r.prerelease,
      url: r.html_url,
    }));
  } catch (e) {
    return [];
  }
}

function registerReleaseNotesHandler() {
  ipcMain.handle('updates:getReleaseNotes', async () => {
    // This repo is private (see package.json's build.publish.private,
    // which is the same reason autoUpdater itself needs a token). GitHub
    // returns 404 to an unauthenticated private-repo request.
    return fetchReleaseNotes();
  });

  ipcMain.handle('updates:getPostUpdateNotice', async () => {
    const state = readUpdateState();
    const pending = state.pendingNotice;
    if (!pending) return null;
    if (!pending.notes) {
      const releases = await fetchReleaseNotes();
      const version = String(pending.toVersion || '').replace(/^v/i, '');
      const match = releases.find((release) => String(release.tag || '').replace(/^v/i, '') === version);
      if (match) {
        pending.name = match.name;
        pending.notes = match.body;
        pending.publishedAt = match.publishedAt;
        state.pendingNotice = pending;
        writeUpdateState(state);
      }
    }
    return pending;
  });

  ipcMain.handle('updates:acknowledgePostUpdateNotice', async (_event, version) => {
    const state = readUpdateState();
    if (state.pendingNotice && state.pendingNotice.toVersion === version) {
      delete state.pendingNotice;
      writeUpdateState(state);
    }
  });
}

// Registers update IPC/events, optionally runs the startup gate, and starts
// a delayed background check for policies that request one. The startup
// gate runs before the full app window/plugin boot: only this small progress
// window is visible while a found release downloads and installs. A fresh
// install skips that gate once so onboarding can explain and save the choice
// first. Headless mode never calls this function.
async function initAutoUpdater(getMainWindow, { skipStartupCheck = false } = {}) {
  preparePostUpdateNotice();
  registerReleaseNotesHandler();

  if (!app.isPackaged) {
    ipcMain.handle('updates:check', async () => ({ status: 'dev-mode' }));
    ipcMain.handle('updates:installNow', async () => {});
    return false;
  }

  const updater = getAutoUpdater();

  updater.on('update-available', (info) => {
    // The launch timeout only protects a slow/unreachable check. Once a
    // real release has been found, downloading it is the chosen startup
    // policy and must not suddenly fall through into the full app.
    if (startupUpdateActive) {
      clearTimeout(startupCheckTimer);
      startupCheckTimer = null;
    }
    showProgressWindow(getMainWindow, {
      kind: 'download', title: `DOWNLOADING RERUNTV v${info.version}`,
      detail: 'Starting the update download…', percent: 0,
    });
  });
  updater.on('download-progress', (progress) => {
    showProgressWindow(getMainWindow, {
      kind: 'download', title: 'DOWNLOADING UPDATE',
      detail: progressDetail(progress), percent: progress.percent,
    });
    sendStatus(getMainWindow, { state: 'progress', version: progress.version, percent: progress.percent });
  });
  updater.on('update-not-available', () => {
    manualCheckRequested = false;
    finishStartupUpdate(false);
    closeProgressWindow();
  });

  updater.on('update-downloaded', (info) => {
    const { strategy } = updatesConfig();
    // Persist release metadata before the safety copy so both the changelog
    // and its previous-version baseline survive an installer that replaces
    // the portable userData directory.
    rememberDownloadedRelease(info);
    backupUserDataForUpdate();

    if (startupUpdateActive && strategy === 'startup-auto') {
      updater.autoInstallOnAppQuit = false;
      showProgressWindow(getMainWindow, {
        kind: 'install', title: 'APPLYING UPDATE',
        detail: 'RerunTV will open automatically when the update is complete.',
        percent: 100, indeterminate: true,
      });
      finishStartupUpdate(true);
      // Let the applying state paint before Electron hands off to NSIS.
      setTimeout(() => updater.quitAndInstall(true, true), 650);
      return;
    }

    const showPopup = strategy === 'background-notify' || manualCheckRequested;
    updater.autoInstallOnAppQuit = !showPopup;
    showProgressWindow(getMainWindow, {
      kind: 'complete', title: 'UPDATE READY',
      detail: `RerunTV v${info.version} is ready to install.`, percent: 100,
    });
    closeProgressWindow(1200);
    sendStatus(getMainWindow, { state: 'downloaded', version: info.version, showPopup });
    manualCheckRequested = false;
  });
  updater.on('error', (err) => {
    console.error('[auto-updater]', err == null ? err : err.stack || err.message || err);
    manualCheckRequested = false;
    if (progressWindow && !progressWindow.isDestroyed()) {
      showProgressWindow(getMainWindow, {
        kind: 'error', title: 'UPDATE PAUSED',
        detail: 'The update could not be downloaded. RerunTV will keep running normally.', percent: 0,
      });
      closeProgressWindow(4500);
    }
    finishStartupUpdate(false);
  });

  ipcMain.handle('updates:check', async () => {
    const { strategy } = updatesConfig();
    if (strategy === 'off') return { status: 'disabled' };
    manualCheckRequested = true;
    try {
      const result = await updater.checkForUpdates();
      // checkForUpdates() resolves even when there's nothing newer —
      // updateInfo.version is always current-or-newer, so compare against
      // the running version to tell "checked, nothing new" apart from
      // "found one, now downloading" for the HELP tab's status line.
      const latest = result && result.updateInfo && result.updateInfo.version;
      if (latest && latest !== app.getVersion()) return { status: 'downloading', version: latest };
      manualCheckRequested = false;
      return { status: 'up-to-date', version: app.getVersion() };
    } catch (e) {
      manualCheckRequested = false;
      return { status: 'error', message: e.message };
    }
  });

  ipcMain.handle('updates:installNow', async () => {
    // The portable userData folder lives inside this app's own install
    // directory (main-config.js) — the NSIS installer quitAndInstall() is
    // about to run can wipe/replace that whole directory as part of laying
    // down the new version. Safety-copy it out first; main-config.js's
    // restoreUserDataIfWiped() reconciles it back on the next boot.
    backupUserDataForUpdate();
    showProgressWindow(getMainWindow, {
      kind: 'install', title: 'APPLYING UPDATE',
      detail: 'RerunTV will close and reopen automatically. Keep this window open.',
      percent: 100, indeterminate: true,
    });
    // isSilent=true: the NSIS wizard's own generic "Welcome to the RerunTV
    // Setup Wizard" pages look identical to a fresh install with no update-
    // specific wording of their own (customizing that would mean a NSIS
    // script, not a runtime flag) — confusing to see mid-update, and
    // indistinguishable from something else entirely trying to install
    // itself. Skipping straight to a silent install and back into the app
    // (isForceRunAfter=true) puts the "an update is happening" messaging
    // entirely in our own already-trusted UI (the toast that led here)
    // instead of a wizard the user never asked to interact with.
    // Give the frameless progress window enough time to paint its applying
    // state before Electron exits into the silent NSIS update process.
    setTimeout(() => updater.quitAndInstall(true, true), 650);
  });

  const { strategy } = updatesConfig();
  if (!skipStartupCheck && strategy === 'startup-auto') {
    startupUpdateActive = true;
    const gate = new Promise((resolve) => { startupUpdateResolve = resolve; });
    showProgressWindow(getMainWindow, {
      kind: 'check', title: 'CHECKING FOR UPDATES',
      detail: 'Making sure RerunTV is ready before launch…', percent: 0, indeterminate: true,
    });
    // A missing network/token must never make the application unusable.
    // This timeout covers only the availability check; update-available
    // clears it and lets the selected download finish.
    startupCheckTimer = setTimeout(() => {
      console.warn('[auto-updater] startup check timed out; continuing normal launch');
      finishStartupUpdate(false);
    }, 12000);
    updater.checkForUpdates().catch((e) => {
      console.error('[auto-updater] startup check failed:', e.message);
      finishStartupUpdate(false);
    });
    return gate;
  }

  if (strategy === 'background-auto' || strategy === 'background-notify') {
    setTimeout(() => {
      const current = updatesConfig().strategy;
      if (current !== 'background-auto' && current !== 'background-notify') return;
      updater.checkForUpdates().catch((e) => console.error('[auto-updater] background check failed:', e.message));
    }, 2500);
  }
  return false;
}

module.exports = { initAutoUpdater, setThemeColors };
