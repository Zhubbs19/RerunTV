const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');

// Two running instances would each hold an independent in-memory config and
// independently debounce-save (saveConfigDebounced, state.js) to the same
// channels.json — whichever instance's timer fires last silently clobbers
// the other's edits, and both would also try to bind the same remote/
// plugin-owned HTTP ports. Refusing a second launch (and focusing the
// existing window instead) avoids both.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  // Nothing expensive has run yet (no window, no config load, no server
  // ports bound) — exit immediately rather than letting the rest of this
  // script's top-level setup run pointlessly before app.quit() takes effect.
  app.quit();
  process.exit(0);
}
const path = require('path');
const fs = require('fs');

// Portable install: see main-config.js's own header comment for the full
// rationale. The one-time migration logic itself lives there
// (migrateUserDataIfNeeded), but it has to be CALLED from right here, first —
// before any other require() below has a chance to capture
// app.getPath('userData') at module-load time. Requiring main-config.js is
// itself safe to do this early: none of its own top-level code touches
// app.getPath('userData') (see its own header comment).
require('./main-config').migrateUserDataIfNeeded();

// "Server mode" — a --headless (or --server) launch never creates or shows
// a BrowserWindow on this machine, but every LAN-facing server (viewer,
// remote, discovery, a plugin's own bridge/stream server) still starts exactly as normal
// — see app.whenReady() below. Every existing mainWindow reference (via
// main-window-ref.js's getMainWindow()) is already either null-guarded or
// only ever reachable from IPC calls a host renderer would make — which
// never exists in this mode — so mainWindow simply staying unset forever is
// safe with no further changes needed elsewhere. See package.json's
// "server" script / run-server.bat for how this is meant to be launched.
const HEADLESS = process.argv.includes('--headless') || process.argv.includes('--server');

// Split out of this file into focused main-*.js modules — config/backups,
// window-state, LAN address discovery, the app:// protocol handler,
// media/transcode helpers, the mainWindow reference, and each LAN-facing
// server (remote/viewer/discovery/party) — plus any plugin's own
// main-process work (a child process, an HTTP bridge, etc.), which lives
// entirely in that plugin's own main.js, not here. What's left in main.js
// itself is app lifecycle, window creation, and the ipcMain registrations
// that tie all of the above to the renderer.
const { registerAppSchemePrivileges, registerAppProtocol, mimeFor } = require('./main-protocol');
const {
  FFMPEG_STATIC_PATH, getFfmpegPath, setFfmpegPath, backupPathFor, recoverPendingSwap, scanFolderForVideos, transcodeVideo,
} = require('./main-media');
const { loadConfig, saveConfig, listBackups, restoreBackup, deleteBackup, setBackupLabel, backupCurrentConfig } = require('./main-config');
const { loadWindowState, saveWindowState, boundsOnScreen } = require('./main-window-state');
const { getLanUrls, getViewerUrls, getLanAddresses, REMOTE_PORT } = require('./main-lan');
const { getConnectedDevices, trackConnection } = require('./main-connections');
const { fetchJsonCached } = require('./main-api-cache');
const { readJsonBody, serveStaticFile } = require('./main-http-util');
const { setMainWindow, getMainWindow } = require('./main-window-ref');
const { startViewerServer } = require('./main-viewer-server');
const { startDiscoveryServer } = require('./main-discovery-server');
const { getPluginsDir, discoverPlugins, loadMainPlugins, seedBundledPlugins, installPluginFromZip, uninstallPlugin, registerFallbackHandlers } = require('./main-plugins');
const { wireAppQuitPropagation } = require('./main-plugin-isolation');
// Handed to the party-channel/universal-remote plugins via ctx — both need
// these npm packages (multipart upload parsing, QR code generation) but
// can't require() them directly themselves (they run from userData/plugins/,
// outside this app's own node_modules resolution path — same reason
// ffmpeg-static's path has to be resolved here and handed over too).
const busboy = require('busboy');
const QRCode = require('qrcode');

// The renderer is served over a custom app:// scheme rather than file://
// because Chromium refuses to load ES modules from a file:// origin. That
// choice cascades: a non-file:// page also can't load file:// media, so
// video is streamed through the same handler (see main-protocol.js's
// serveFile — the schedule math seeks constantly, so partial requests are
// not optional here). Must run before app is ready, same as in the original
// single-file version.
registerAppSchemePrivileges();

function createWindow() {
  const saved = loadWindowState();
  const bounds = saved && boundsOnScreen(saved) ? saved : {};

  const mainWindow = new BrowserWindow({
    width: bounds.width || 1280,
    height: bounds.height || 800,
    x: bounds.x,
    y: bounds.y,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#060606',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  setMainWindow(mainWindow);
  mainWindow.setMenuBarVisibility(false);
  if (saved && saved.isMaximized) mainWindow.maximize();
  mainWindow.loadURL('app://bundle/renderer/index.html');

  let saveStateTimer = null;
  const persistWindowState = () => {
    if (mainWindow.isDestroyed()) return;
    const isMaximized = mainWindow.isMaximized();
    const b = isMaximized ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    saveWindowState({ ...b, isMaximized });
  };
  const persistWindowStateDebounced = () => {
    clearTimeout(saveStateTimer);
    saveStateTimer = setTimeout(persistWindowState, 500);
  };
  mainWindow.on('resize', persistWindowStateDebounced);
  mainWindow.on('move', persistWindowStateDebounced);
  mainWindow.on('close', persistWindowState);

  // Covers every way fullscreen can be entered/left — the F-key toggle
  // below (window:toggleFullscreen), OS-level window controls (macOS green
  // traffic light, double-clicking the title bar), and OS fullscreen
  // shortcuts (F11) — not just the app's own toggle, so the renderer's
  // hint-bar-hiding stays correct regardless of trigger.
  const sendFullscreenState = () => {
    if (mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('window:fullscreenChanged', mainWindow.isFullScreen());
  };
  mainWindow.on('enter-full-screen', sendFullscreenState);
  mainWindow.on('leave-full-screen', sendFullscreenState);
}

app.on('second-instance', () => {
  const mainWindow = getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

// Populated once at boot by loadMainPlugins() below — {pluginId: errorMessage}
// for any plugin whose main.js threw on require()/activate(). Read by the
// plugins:list IPC handler so a broken plugin shows up in the PLUGINS setup
// panel instead of just vanishing silently.
let pluginMainLoadErrors = {};
// Plugin ids loadMainPlugins() skipped because their current manifest
// capabilities aren't in config.plugins.approvedCapabilities yet — surfaced
// to plugins:list the same way pluginMainLoadErrors is, so the PLUGINS tab
// can show an APPROVE PERMISSIONS prompt instead of silently not-activating.
let pluginsNeedingApproval = [];

app.whenReady().then(async () => {
  // `services` is a single shared object, mutated in place by whichever
  // plugins publish a capability onto it (ffmpeg-transcode -> ffmpegPath,
  // party-channel -> partyReactionEmoji/viewerLiveLinkUrls) — see
  // loadMainPlugins()'s doc comment in main-plugins.js. Declared before
  // startViewerServer() below (which reads it on every request, well after
  // boot has had time to populate it) so that server can be handed the same
  // reference rather than a snapshot.
  const pluginServices = {};
  startViewerServer(pluginServices);
  startDiscoveryServer();
  wireAppQuitPropagation();
  // The remote/party servers, and any plugin's own bridge/stream server,
  // used to start here too — now started by the universal-remote/
  // party-channel plugins' (and any other plugin's) own activate(), below.

  // Loaded before the window so a plugin's main.js (e.g. registering its own
  // ipcMain handlers) is ready before the renderer's first config:load/
  // plugins:list round-trip. Runs in headless/server mode too — an
  // integration plugin may have nothing to do with the on-screen UI at all.
  const bootConfig = loadConfig();
  seedBundledPlugins();
  const disabledPluginIds = (bootConfig.plugins && bootConfig.plugins.disabled) || [];
  const approvedCapabilities = (bootConfig.plugins && bootConfig.plugins.approvedCapabilities) || {};
  const loadResult = await loadMainPlugins(disabledPluginIds, {
    fetchJsonCached, getMainWindow, getLanAddresses, readJsonBody,
    serveStatic: serveStaticFile,
    trackConnection, mimeFor, loadConfig, busboy, QRCode,
    getViewerUrls, remotePort: REMOTE_PORT,
    ffmpegStaticPath: FFMPEG_STATIC_PATH, services: pluginServices,
  }, approvedCapabilities);
  pluginMainLoadErrors = loadResult.loadErrors;
  pluginsNeedingApproval = loadResult.needsApproval;
  registerFallbackHandlers(disabledPluginIds.concat(pluginsNeedingApproval), ipcMain, loadResult.allPlugins);
  setFfmpegPath(pluginServices.ffmpegPath || null);

  if (HEADLESS) {
    // No window, no app:// protocol (only ever used to load the host's own
    // renderer — nothing to register it for here) — just the LAN servers
    // above, which is the whole point of this mode. window-all-closed
    // never fires with zero windows ever created, so the process simply
    // keeps running until it's stopped externally (Ctrl+C in the console
    // this was launched from, or the process being killed).
    console.log('RerunTV is running in SERVER mode — no window on this machine.');
    console.log('The LAN viewer, remote control, and auto-discovery are all active for other devices:');
    getViewerUrls().forEach((u) => console.log(`  Watch at ${u.url}  (${u.name})`));
    getLanUrls().forEach((u) => console.log(`  Remote at ${u.url}  (${u.name})`));
    console.log('Press Ctrl+C to stop.');
    return;
  }

  registerAppProtocol(path.join(__dirname, '..'), getPluginsDir());
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------- App / window / network ----------
ipcMain.handle('app:getVersion', async () => {
  return app.getVersion();
});

ipcMain.handle('remote:getUrl', async () => {
  return getLanUrls();
});

ipcMain.handle('network:getConnections', async () => {
  return getConnectedDevices();
});

ipcMain.handle('viewer:getUrl', async () => {
  return getViewerUrls();
});

ipcMain.handle('window:toggleFullscreen', async () => {
  const mainWindow = getMainWindow();
  if (!mainWindow) return false;
  mainWindow.setFullScreen(!mainWindow.isFullScreen());
  return mainWindow.isFullScreen();
});

// App-wide display mode's "lock window" mode (DISPLAY > APP DISPLAY MODE,
// display-mode.js) — locks real OS window resizing to a fixed aspect, the
// more authentic option vs. just letterboxing inside whatever size the
// window already is. aspect: null clears the lock (used when switching back
// to 'letterbox' mode, or resolution/aspect otherwise no longer needs it).
const ASPECT_RATIO_VALUES = { '16:9': [16, 9], '4:3': [4, 3] };
ipcMain.handle('window:setAspectLock', async (event, { aspect } = {}) => {
  const mainWindow = getMainWindow();
  if (!mainWindow) return false;
  if (!aspect || !ASPECT_RATIO_VALUES[aspect]) {
    mainWindow.setAspectRatio(0);
    return true;
  }
  const [w, h] = ASPECT_RATIO_VALUES[aspect];
  // A maximized window ignores both setAspectRatio and setContentSize below
  // (its visible bounds stay OS-controlled at the screen's own size/ratio) —
  // unmaximize first so locking to a mismatched aspect (e.g. 4:3 on a 16:9
  // monitor) is actually visible, not silently a no-op.
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  mainWindow.setAspectRatio(w / h);
  // Without an explicit starting size, the window stays at whatever
  // (mismatched) size it already was until the user manually drags it —
  // setAspectRatio alone only constrains future resizes, it doesn't snap the
  // current size to the ratio.
  const [curW] = mainWindow.getContentSize();
  mainWindow.setContentSize(curW, Math.round(curW * (h / w)));
  return true;
});

// ---------- File/folder picker dialogs ----------
ipcMain.handle('dialog:selectFolder', async () => {
  const result = await dialog.showOpenDialog(getMainWindow(), {
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('dialog:selectImage', async () => {
  const result = await dialog.showOpenDialog(getMainWindow(), {
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('dialog:selectAudio', async () => {
  const result = await dialog.showOpenDialog(getMainWindow(), {
    properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('dialog:selectVideo', async () => {
  const result = await dialog.showOpenDialog(getMainWindow(), {
    properties: ['openFile'],
    filters: [{ name: 'Videos', extensions: ['mp4', 'mkv', 'avi', 'mov', 'webm', 'm4v'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('dialog:selectExecutable', async () => {
  const result = await dialog.showOpenDialog(getMainWindow(), {
    properties: ['openFile'],
    filters: [{ name: 'Programs', extensions: ['exe'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('dialog:selectCss', async () => {
  const result = await dialog.showOpenDialog(getMainWindow(), {
    properties: ['openFile'],
    filters: [{ name: 'Stylesheets', extensions: ['css'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// ---------- Plugins (management) ----------
// See main-plugins.js for the discovery/loading model, the
// declared-capabilities check (buildCheckedCtx) a plugin's fs/spawn/http/
// ipcMain access is run through, and the trust-model note (this is a
// same-process check, not a hard sandbox — see that file's header comment
// for why). Enabling/disabling here only edits config.plugins.disabled —
// actually starting/stopping a main-process plugin's activate() side
// effects (spawned processes, registered ipcMain handlers) requires a
// restart, which the PLUGINS setup panel says explicitly.
ipcMain.handle('plugins:list', async () => {
  return discoverPlugins().map((p) => (
    p.error ? p : { ...p, loadError: pluginMainLoadErrors[p.id] || null, needsApproval: pluginsNeedingApproval.includes(p.id) }
  ));
});

// Persists the user's approval of exactly this plugin's *current* declared
// capabilities (setup-plugins.js's approval prompt) — keyed by a signature
// of the capabilities themselves (main-plugins.js's capabilitiesSignature),
// not just the plugin id, so a later update that adds a new port/channel/
// binary re-prompts instead of silently inheriting a stale approval. Takes
// effect on next launch, same "restart to activate" convention as
// installing or enabling a plugin already uses.
ipcMain.handle('plugins:approveCapabilities', async (event, id, signature) => {
  const config = loadConfig();
  if (!config.plugins) config.plugins = { disabled: [] };
  if (!config.plugins.approvedCapabilities) config.plugins.approvedCapabilities = {};
  config.plugins.approvedCapabilities[id] = signature;
  saveConfig(config);
  return true;
});

// The undo-approval counterpart to plugins:approveCapabilities above — drops
// the stored signature so the plugin reverts to needing a fresh approval
// (same inactive treatment as never having approved it at all, or as being
// disabled) until re-approved. Also takes effect on next launch.
ipcMain.handle('plugins:revokeCapabilities', async (event, id) => {
  const config = loadConfig();
  if (config.plugins && config.plugins.approvedCapabilities) {
    delete config.plugins.approvedCapabilities[id];
    saveConfig(config);
  }
  return true;
});

// Permanently deletes a plugin's own folder (setup-plugins.js's FULLY
// UNINSTALL action, behind its own themed danger-confirm dialog since this
// can't be undone) — see uninstallPlugin() (main-plugins.js) for why a
// bundled plugin refuses this. Also clears any config.plugins state
// referencing the now-gone id so a stale disabled/approved entry doesn't
// linger forever.
ipcMain.handle('plugins:uninstall', async (event, id) => {
  const result = uninstallPlugin(id);
  if (result.success) {
    const config = loadConfig();
    if (config.plugins) {
      if (Array.isArray(config.plugins.disabled)) {
        const idx = config.plugins.disabled.indexOf(id);
        if (idx !== -1) config.plugins.disabled.splice(idx, 1);
      }
      if (config.plugins.approvedCapabilities) delete config.plugins.approvedCapabilities[id];
    }
    saveConfig(config);
  }
  return result;
});

ipcMain.handle('plugins:openFolder', async () => {
  await shell.openPath(getPluginsDir());
  return true;
});

// opts: { zipPath, overwrite }. Without zipPath, opens the file picker
// first (the normal first call from the renderer's INSTALL FROM ZIP…
// button) — the response always echoes back whichever zipPath was used, so
// if the result comes back { alreadyExists: true } the renderer can show
// its own themed confirm dialog and call again with { zipPath, overwrite:
// true } to actually overwrite, without re-prompting the file picker a
// second time for the same file. Main-process code has no themed-dialog
// access of its own, so the confirm step has to happen in the renderer.
ipcMain.handle('plugins:installFromZip', async (event, opts) => {
  opts = opts || {};
  let zipPath = opts.zipPath;
  if (!zipPath) {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: ['openFile'],
      filters: [{ name: 'Plugin (zip)', extensions: ['zip'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return { cancelled: true };
    [zipPath] = result.filePaths;
  }
  return { zipPath, ...installPluginFromZip(zipPath, { overwrite: opts.overwrite }) };
});

ipcMain.handle('plugins:setEnabled', async (event, id, enabled) => {
  const config = loadConfig();
  if (!config.plugins) config.plugins = { disabled: [] };
  if (!Array.isArray(config.plugins.disabled)) config.plugins.disabled = [];
  const idx = config.plugins.disabled.indexOf(id);
  if (enabled && idx !== -1) config.plugins.disabled.splice(idx, 1);
  if (!enabled && idx === -1) config.plugins.disabled.push(id);
  saveConfig(config);
  return config.plugins.disabled;
});

// ---------- Filesystem ----------
ipcMain.handle('fs:scanFolder', async (event, folderPath) => {
  return scanFolderForVideos(folderPath);
});

// Cheap existence-only check (no decode, no ffprobe) — used by the setup
// screen's CHECK CHANNELS health scan to flag files whose paths no longer
// resolve (moved/renamed/deleted media), distinct from FIX PLAYBACK's much
// heavier per-file decode probe which only ever runs one channel at a time.
ipcMain.handle('fs:checkPathsExist', async (event, paths) => {
  // Async + concurrent rather than a serial existsSync loop — a library
  // with dozens-to-hundreds of files would otherwise block this whole
  // process (window, every LAN request, every other IPC call) for the
  // scan's entire duration, one blocking syscall at a time.
  return Promise.all((paths || []).map(async (p) => {
    try { await fs.promises.access(p); return true; } catch (e) { return false; }
  }));
});

// ---------- Config backups ----------
ipcMain.handle('backups:list', async () => {
  return listBackups();
});

ipcMain.handle('backups:restore', async (event, file) => {
  return restoreBackup(file);
});

ipcMain.handle('backups:delete', async (event, file) => {
  return deleteBackup(file);
});

ipcMain.handle('backups:setLabel', async (event, file, label) => {
  return setBackupLabel(file, label);
});

// Forces a snapshot right now, bypassing the normal 15-min rate limit —
// "before I do something risky" is a real, deliberate moment, not the
// steady-state autosave case that limit exists to throttle. Returns the
// created filename (or null if there's nothing to snapshot yet) so the
// caller can immediately attach the user's label to the exact file just
// written, not "whichever is newest" a moment later.
ipcMain.handle('backups:createNow', async () => {
  return backupCurrentConfig(true);
});

// ---------- Config load/save/export/import ----------
ipcMain.handle('config:load', async () => {
  return loadConfig();
});

ipcMain.handle('config:save', async (event, config) => {
  return saveConfig(config);
});

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
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.channels)) {
    throw new Error('That file doesn\'t look like a RerunTV config (no channels array).');
  }
  return parsed;
});

// ---------- Manual, paths, media ----------
// The HELP tab's PRINTABLE MANUAL button (setup-settings.js) hands over a
// self-contained HTML string to write out and open — a sandboxed renderer
// can't write files or window.open() itself, so the OS's own browser is the
// simplest way to get a real, printable window with working Ctrl+P.
ipcMain.handle('manual:openPrintable', async (event, html) => {
  // Unique filename (pid+timestamp) so two rapid clicks don't race a
  // still-open browser window's read against a second click's write.
  const filePath = path.join(app.getPath('temp'), `retro-cable-box-manual-${process.pid}-${Date.now()}.html`);
  fs.writeFileSync(filePath, html, 'utf-8');
  await shell.openPath(filePath);
  return filePath;
});

// Media goes through the app:// media host rather than file://, since the
// renderer's origin is no longer file:// and Chromium won't load file://
// subresources from it.
ipcMain.handle('path:toFileUrl', async (event, filePath) => {
  return `app://media/?p=${encodeURIComponent(filePath)}`;
});

ipcMain.handle('path:basename', async (event, filePath) => {
  return path.basename(filePath, path.extname(filePath));
});

// Cheap check only — never spawns ffmpeg. srcPath is always the path to play;
// alreadyFixed tells the caller whether it's already the swapped-in H.264
// copy (a backup exists), so a further playback failure is a real error
// rather than something a transcode could fix.
ipcMain.handle('media:resolvePlayablePath', async (event, srcPath) => {
  recoverPendingSwap(srcPath);
  return { path: srcPath, alreadyFixed: fs.existsSync(backupPathFor(srcPath)) };
});

// ---------- Plugin API fallbacks ----------
// A plugin that's disabled/missing can still register safe fallback IPC
// handlers for whatever channels its renderer side calls unconditionally,
// via its own main.js's registerFallback(ipcMain) export — see
// registerFallbackHandlers (main-plugins.js) for the generic mechanism.
// remote:state, party:queueState/voteState/triviaState/jukeboxState are all
// ipcMain.on (fire-and-forget, no return value) — registered only by a
// plugin's own activate() when installed+enabled. No fallback needed:
// ipcRenderer.send() to a channel with zero listeners is a silent no-op,
// not an error.

// The actual transcode/swap logic (spawning ffmpeg, the backup-then-promote
// rename dance, retrying a Windows rename that loses a race with a still-
// closing file handle) lives in main-media.js's transcodeVideo() — this
// handler is just the IPC surface for it.
ipcMain.handle('media:transcode', async (event, srcPath) => {
  return transcodeVideo(srcPath);
});
