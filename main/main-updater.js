const { app, ipcMain } = require('electron');
const { loadConfig, backupUserDataForUpdate } = require('./main-config');
const { fetchJsonCached } = require('./main-api-cache');

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
// User-facing controls all live in config.updates (applyConfigDefaults,
// app.js): `mode` — 'auto' (background-check + auto-download, default),
// 'manual' (only ever check when the HELP tab's button is clicked), or
// 'off' (never check, at all, even manually); and `showLaunchPopup` — once
// an update finishes downloading, this chooses between interrupting with
// the in-app toast (renderer/js/update-notice.js) or just quietly installing
// on the next normal app quit (autoUpdater.autoInstallOnAppQuit below), read
// fresh from disk at the moment each decision is actually made rather than
// cached at startup, so a setting changed mid-session takes effect on the
// very next check/download without needing a restart.
let autoUpdater = null;
function getAutoUpdater() {
  if (!autoUpdater) {
    ({ autoUpdater } = require('electron-updater'));
    autoUpdater.autoDownload = true;
    // Decided per-download instead — see the update-downloaded handler
    // below — based on config.updates.showLaunchPopup at that moment.
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
  const u = cfg.updates || {};
  return { mode: u.mode || 'auto', showLaunchPopup: u.showLaunchPopup !== false };
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

function registerReleaseNotesHandler() {
  ipcMain.handle('updates:getReleaseNotes', async () => {
    try {
      // This repo is private (see package.json's build.publish.private,
      // which is the same reason autoUpdater itself needs a token — see
      // getAutoUpdater's comment above). GitHub 404s an unauthenticated
      // request to a private repo's API rather than 403ing, same as it
      // does for one that doesn't exist at all — no token, no release
      // notes, same as no token means autoUpdater can't check either.
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
  });
}

// Registers the manual-check/install IPC handlers and, unless disabled,
// kicks off one silent background check shortly after boot. Called from
// main.js's app.whenReady() — never in --headless mode (see main.js's own
// HEADLESS comment: an unattended server restarting itself mid-stream to
// install an update would cut off whatever LAN viewers are currently
// watching), so getMainWindow() below is always expected to resolve to a
// real window once it matters.
function initAutoUpdater(getMainWindow) {
  registerReleaseNotesHandler();

  if (!app.isPackaged) {
    ipcMain.handle('updates:check', async () => ({ status: 'dev-mode' }));
    ipcMain.handle('updates:installNow', async () => {});
    return;
  }

  const updater = getAutoUpdater();

  updater.on('update-downloaded', (info) => {
    const { showLaunchPopup } = updatesConfig();
    updater.autoInstallOnAppQuit = !showLaunchPopup;
    // Backed up here, not only in the installNow handler below — when
    // showLaunchPopup is off, autoInstallOnAppQuit installs on the next
    // normal quit without ever going through that handler, so this is the
    // only guaranteed point before the install can happen either way.
    backupUserDataForUpdate();
    sendStatus(getMainWindow, { state: 'downloaded', version: info.version, showPopup: showLaunchPopup });
  });
  updater.on('error', (err) => {
    console.error('[auto-updater]', err == null ? err : err.stack || err.message || err);
  });

  ipcMain.handle('updates:check', async () => {
    const { mode } = updatesConfig();
    if (mode === 'off') return { status: 'disabled' };
    try {
      const result = await updater.checkForUpdates();
      // checkForUpdates() resolves even when there's nothing newer —
      // updateInfo.version is always current-or-newer, so compare against
      // the running version to tell "checked, nothing new" apart from
      // "found one, now downloading" for the HELP tab's status line.
      const latest = result && result.updateInfo && result.updateInfo.version;
      if (latest && latest !== app.getVersion()) return { status: 'downloading', version: latest };
      return { status: 'up-to-date', version: app.getVersion() };
    } catch (e) {
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
    // isSilent=true: the NSIS wizard's own generic "Welcome to the RerunTV
    // Setup Wizard" pages look identical to a fresh install with no update-
    // specific wording of their own (customizing that would mean a NSIS
    // script, not a runtime flag) — confusing to see mid-update, and
    // indistinguishable from something else entirely trying to install
    // itself. Skipping straight to a silent install and back into the app
    // (isForceRunAfter=true) puts the "an update is happening" messaging
    // entirely in our own already-trusted UI (the toast that led here)
    // instead of a wizard the user never asked to interact with.
    updater.quitAndInstall(true, true);
  });

  // Delayed rather than fired immediately at boot — same reasoning as the
  // rest of this app's startup sequencing (see app.whenReady() in main.js):
  // let the window actually paint and the config/plugin load finish before
  // adding a network round trip to the critical path. Re-reads mode at fire
  // time (not once at init) so a setting flipped to 'manual'/'off' during
  // that window is honored instead of racing it.
  setTimeout(() => {
    const { mode } = updatesConfig();
    if (mode !== 'auto') return;
    updater.checkForUpdates().catch((e) => console.error('[auto-updater] background check failed:', e.message));
  }, 15000);
}

module.exports = { initAutoUpdater };
