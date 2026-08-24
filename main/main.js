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
const { installMainLogCapture, recordDiagnostic, redactDiagnosticValue, getMainLogs } = require('./main-diagnostics');
installMainLogCapture();

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
let interactiveBootInProgress = !HEADLESS;

// Split out of this file into focused main-*.js modules — config/backups,
// window-state, LAN address discovery, the app:// protocol handler,
// media/transcode helpers, the mainWindow reference, and each LAN-facing
// server (remote/viewer/discovery/party) — plus any plugin's own
// main-process work (a child process, an HTTP bridge, etc.), which lives
// entirely in that plugin's own main.js, not here. What's left in main.js
// itself is app lifecycle, window creation, and the ipcMain registrations
// that tie all of the above to the renderer.
const { registerAppSchemePrivileges, registerAppProtocol, setMediaDispatchServices, mimeFor } = require('./main-protocol');
const {
  FFMPEG_STATIC_PATH, getFfmpegPath, setFfmpegPath, backupPathFor, recoverPendingSwap, scanFolderForVideos, transcodeVideo,
} = require('./main-media');
const { loadConfig, saveConfig, listBackups, previewBackup, restoreBackup, deleteBackup, setBackupLabel, setBackupPinned, backupCurrentConfig } = require('./main-config');
const { loadWindowState, saveWindowState, boundsOnScreen } = require('./main-window-state');
const { getLanUrls, getViewerUrls, getLanAddresses, REMOTE_PORT, VIEWER_PORT } = require('./main-lan');
const { getConnectedDevices, trackConnection } = require('./main-connections');
const { fetchJsonCached } = require('./main-api-cache');
const { readJsonBody, serveStaticFile } = require('./main-http-util');
const { setMainWindow, getMainWindow } = require('./main-window-ref');
const { startViewerServer } = require('./main-viewer-server');
const { startDiscoveryServer } = require('./main-discovery-server');
const { isLanServiceEnabled } = require('./main-lan-security');
const { getPluginsDir, discoverPlugins, loadMainPlugins, seedBundledPlugins, installPluginFromZip, uninstallPlugin, registerFallbackHandlers, recordPluginIntegrity } = require('./main-plugins');
const { wireAppQuitPropagation } = require('./main-plugin-isolation');
const {
  parseMediaRef, wrapMediaRef, setApprovedMediaSourceProviders, callMediaService,
  MEDIA_LIST_TIMEOUT_MS, MEDIA_PROBE_TIMEOUT_MS, MEDIA_CHECK_TIMEOUT_MS,
} = require('./main-media-dispatch');
const { initAutoUpdater } = require('./main-updater');
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
let pluginsNeedingIntegrityApproval = [];
// providerId -> pluginId, for every media-source provider actually
// activated this boot — see loadMainPlugins()'s doc comment
// (main-plugins.js) and setApprovedMediaSourceProviders
// (main-media-dispatch.js), which this same value also feeds. Read by
// plugins:listMediaSourceProviders below so the CHANNELS tab's CHOOSE
// SOURCE picker only ever offers a provider that's real and callable right
// now, not just declared in some plugin's manifest.json.
let activatedMediaSourceProviders = {};
// Module-scope so the fs:scanFolder/media:probeDuration/fs:checkPathsExist/
// media:resolvePlayablePath/media:transcode handlers below (registered at
// module load, outside whenReady) can reach it for their non-local dispatch
// branch (callMediaService, main-media-dispatch.js) — same object
// loadMainPlugins() populates inside whenReady below, just referenced from
// a wider scope than before this existed.
let pluginServicesRef = {};
let viewerAccessUrls = [];
let pluginDisabledAtBoot = [];

app.whenReady().then(async () => {
  // `services` is a single shared object, mutated in place by whichever
  // plugins publish a capability onto it (ffmpeg-transcode -> ffmpegPath,
  // party-channel -> partyReactionEmoji/viewerLiveLinkUrls) — see
  // loadMainPlugins()'s doc comment in main-plugins.js. Declared before
  // startViewerServer() below (which reads it on every request, well after
  // boot has had time to populate it) so that server can be handed the same
  // reference rather than a snapshot.
  const pluginServices = {};
  pluginServicesRef = pluginServices;
  setMediaDispatchServices(pluginServices);
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
  if (!HEADLESS) {
    // The updater's small pre-launch window is served through app:// too,
    // so the protocol must exist before the startup gate. A genuinely fresh
    // install skips the gate once; renderer onboarding explains and saves
    // the user's update policy before later launches enforce it.
    registerAppProtocol(path.join(__dirname, '..'), getPluginsDir());
    const installingUpdate = await initAutoUpdater(getMainWindow, {
      skipStartupCheck: !!bootConfig._isFirstRun,
    });
    if (installingUpdate) return;
  }
  if (isLanServiceEnabled(bootConfig, 'viewer')) {
    const viewerRuntime = startViewerServer(pluginServices, {
      pluginsDir: getPluginsDir(),
      listPlugins: () => discoverPlugins().map((plugin) => (
        plugin.error ? plugin : {
          ...plugin,
          loadError: pluginMainLoadErrors[plugin.id] || null,
          needsIntegrityApproval: plugin.integrityStatus === 'unverified' || plugin.integrityStatus === 'modified',
        }
      )),
    });
    viewerAccessUrls = getViewerUrls().map((entry) => ({ ...entry, url: viewerRuntime.access.pairingUrl(entry.url) }));
  }
  const disabledPluginIds = (bootConfig.plugins && bootConfig.plugins.disabled) || [];
  pluginDisabledAtBoot = [...disabledPluginIds];
  const approvedCapabilities = (bootConfig.plugins && bootConfig.plugins.approvedCapabilities) || {};
  const loadResult = await loadMainPlugins(disabledPluginIds, {
    fetchJsonCached, getMainWindow, getLanAddresses, readJsonBody,
    serveStatic: serveStaticFile,
    trackConnection, mimeFor, loadConfig, busboy, QRCode,
    getViewerUrls: () => viewerAccessUrls, remotePort: REMOTE_PORT,
    ffmpegStaticPath: FFMPEG_STATIC_PATH, services: pluginServices,
  }, approvedCapabilities);
  pluginMainLoadErrors = loadResult.loadErrors;
  pluginsNeedingApproval = loadResult.needsApproval;
  pluginsNeedingIntegrityApproval = loadResult.needsIntegrityApproval;
  registerFallbackHandlers(disabledPluginIds.concat(pluginsNeedingApproval, pluginsNeedingIntegrityApproval), ipcMain, loadResult.allPlugins);
  setFfmpegPath(pluginServices.ffmpegPath || null);
  activatedMediaSourceProviders = loadResult.activatedMediaSourceProviders;
  setApprovedMediaSourceProviders(loadResult.activatedMediaSourceProviders);
  const remoteEnabled = Array.isArray(pluginServices.remoteAccessUrls) && pluginServices.remoteAccessUrls.length > 0;
  if (viewerAccessUrls.length || remoteEnabled) {
    startDiscoveryServer({ viewerEnabled: !!viewerAccessUrls.length, remoteEnabled });
  }

  if (HEADLESS) {
    // No window, no app:// protocol (only ever used to load the host's own
    // renderer — nothing to register it for here) — just the LAN servers
    // above, which is the whole point of this mode. window-all-closed
    // never fires with zero windows ever created, so the process simply
    // keeps running until it's stopped externally (Ctrl+C in the console
    // this was launched from, or the process being killed).
    console.log('RerunTV is running in SERVER mode — no window on this machine.');
    console.log('Enabled LAN services are available to paired devices:');
    viewerAccessUrls.forEach((u) => console.log(`  Watch at ${u.url}  (${u.name})`));
    (pluginServices.remoteAccessUrls || []).forEach((u) => console.log(`  Remote at ${u.url}  (${u.name})`));
    console.log('Press Ctrl+C to stop.');
    return;
  }

  createWindow();
  interactiveBootInProgress = false;
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // The pre-launch updater window can close after an up-to-date/error
  // result while plugin boot is still finishing and before createWindow().
  // That transient zero-window interval is not a user quit.
  if (interactiveBootInProgress) return;
  if (process.platform !== 'darwin') app.quit();
});

// ---------- App / window / network ----------
ipcMain.handle('app:getVersion', async () => {
  return app.getVersion();
});

ipcMain.handle('remote:getUrl', async () => {
  return pluginServicesRef.remoteAccessUrls || [];
});

ipcMain.handle('network:getConnections', async () => {
  return getConnectedDevices();
});

ipcMain.handle('viewer:getUrl', async () => {
  return viewerAccessUrls;
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
    p.error ? p : {
      ...p,
      loadError: pluginMainLoadErrors[p.id] || null,
      needsApproval: pluginsNeedingApproval.includes(p.id),
      needsIntegrityApproval: p.integrityStatus === 'unverified' || p.integrityStatus === 'modified',
    }
  ));
});

// A filtered projection of the same discoverPlugins() data plugins:list
// already exposes — no new discovery mechanism, just narrowed to
// {providerId, displayName, pluginId} for every mediaSource capability
// entry belonging to a plugin that's actually activated right now
// (activatedMediaSourceProviders, populated once at boot — see
// loadMainPlugins()'s doc comment, main-plugins.js). A provider a plugin
// merely *declares* but that's disabled/errored/awaiting approval doesn't
// show up here — the CHANNELS tab's CHOOSE SOURCE picker (setup-
// channels.js) should never offer something it can't actually call.
// Generic passthrough to any of a media-source provider's own registered
// EXTRA service verbs — pickFolder, getFetchProgress, getLocalCachePath,
// getDisplayName, and any plugin-invented verb (configure/signIn/status/
// listFolders/...), reached from setup-channels.js's CHOOSE SOURCE flow and
// a plugin's own settings-panel renderer.js. Gated by callMediaService's
// own assertKnownProvider check, same defense-in-depth as every other
// media-source dispatch call — but that alone isn't enough here: the four
// RESERVED core verbs (list/probe/readRange/checkAvailable) must stay
// unreachable through this generic door. In particular, readRange is only
// ever meant to be called by serveFileViaPlugin (main-protocol.js), which
// wraps it in a chunk-size cap specifically because an uncapped Range
// crossing the plugin-process RPC boundary risks a multi-gigabyte
// structured-clone payload — calling it directly through this passthrough
// would bypass that cap entirely (found in review, never actually
// exploited, but a real gap: nothing else in the dispatch chain enforces
// the cap, only this call site's own choice of arguments does).
const RESERVED_MEDIA_SOURCE_VERBS = new Set(['list', 'probe', 'readRange', 'checkAvailable']);
ipcMain.handle('mediaSource:callHook', async (event, providerId, verb, args) => {
  if (RESERVED_MEDIA_SOURCE_VERBS.has(verb)) {
    throw new Error(`"${verb}" is a reserved media-source verb and can't be called via mediaSource:callHook — it's only ever invoked internally by core's own dispatch layer.`);
  }
  recordDiagnostic('plugin-capability', 'log', `${providerId} called media-source hook ${verb}`);
  return callMediaService(pluginServicesRef, providerId, verb, args || []);
});

ipcMain.handle('plugins:listMediaSourceProviders', async () => {
  const providers = [];
  discoverPlugins().forEach((p) => {
    if (p.error || !p.capabilities || !p.capabilities.mediaSource) return;
    p.capabilities.mediaSource.forEach((entry) => {
      if (activatedMediaSourceProviders[entry.providerId] !== p.id) return;
      providers.push({ providerId: entry.providerId, displayName: entry.displayName || entry.providerId, pluginId: p.id });
    });
  });
  return providers;
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

ipcMain.handle('plugins:approveIntegrity', async (event, id, hash) => {
  const plugin = discoverPlugins().find((entry) => !entry.error && entry.id === id);
  if (!plugin || plugin.integrityHash !== hash) {
    throw new Error('Plugin files changed again before integrity approval could be saved.');
  }
  recordPluginIntegrity(id, hash);
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

// ---------- Filesystem / media sources ----------
// Local stays the exact pre-existing implementation, unchanged. A non-local
// source dispatches to that plugin's registered `list` service instead —
// see main-media-dispatch.js's header comment for the full contract. The
// plugin's own raw refs are wrapped with the mediasource:<id>: prefix here,
// once, so a provider author never has to think about that bookkeeping.
ipcMain.handle('fs:scanFolder', async (event, source, folderRef) => {
  if (!source || source === 'local') return scanFolderForVideos(folderRef);
  const result = await callMediaService(pluginServicesRef, source, 'list', [folderRef], MEDIA_LIST_TIMEOUT_MS);
  if (!result || result.error) return [];
  return (result.refs || []).map((r) => wrapMediaRef(source, r));
});

// New — a plugin-sourced ref can't be probed via the renderer's <video>-
// element trick (setup-util.js's probeDuration), since there's no playback
// dispatch path for it independent of this call in the first place. Local
// returns null, which setup-util.js's probeDurationForEntry reads as "fall
// back to the existing renderer-side <video> probe" — the local path is
// untouched by this feature at all, not just unchanged in behavior.
ipcMain.handle('media:probeDuration', async (event, source, ref) => {
  if (!source || source === 'local') return null;
  try {
    const result = await callMediaService(pluginServicesRef, source, 'probe', [ref], MEDIA_PROBE_TIMEOUT_MS);
    return (result && typeof result.duration === 'number') ? result.duration : 180;
  } catch (e) { return 180; } // same fallback probeDuration already uses for a local decode timeout/error
});

// Cheap existence-only check (no decode, no ffprobe) — used by the setup
// screen's CHECK CHANNELS health scan to flag files whose paths no longer
// resolve (moved/renamed/deleted media), distinct from FIX PLAYBACK's much
// heavier per-file decode probe which only ever runs one channel at a time.
// `entries` is [{source, ref}] — a non-local entry's "still there" check is
// necessarily a network round-trip per provider's own checkAvailable, so a
// provider being unreachable/disabled is treated the same as a missing
// local file (an honest "not available" here) rather than surfacing as a
// distinct error state the setup UI has no way to show anyway.
ipcMain.handle('fs:checkPathsExist', async (event, entries) => {
  // Async + concurrent rather than a serial existsSync loop — a library
  // with dozens-to-hundreds of files would otherwise block this whole
  // process (window, every LAN request, every other IPC call) for the
  // scan's entire duration, one blocking syscall at a time.
  return Promise.all((entries || []).map(async (e) => {
    const source = e && e.source;
    const ref = e && typeof e === 'object' ? e.ref : e; // tolerate a bare path string too
    if (!source || source === 'local') {
      try { await fs.promises.access(ref); return true; } catch (err) { return false; }
    }
    try { return !!(await callMediaService(pluginServicesRef, source, 'checkAvailable', [ref], MEDIA_CHECK_TIMEOUT_MS)); } catch (err) { return false; }
  }));
});

// ---------- Config backups ----------
ipcMain.handle('backups:list', async () => {
  return listBackups();
});

ipcMain.handle('backups:preview', async (event, file) => {
  return previewBackup(file);
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

ipcMain.handle('backups:setPinned', async (event, file, pinned) => {
  return setBackupPinned(file, pinned);
});

// Forces a snapshot right now, bypassing the normal 15-min rate limit —
// "before I do something risky" is a real, deliberate moment, not the
// steady-state autosave case that limit exists to throttle. Returns the
// created filename (or null if there's nothing to snapshot yet) so the
// caller can immediately attach the user's label to the exact file just
// written, not "whichever is newest" a moment later.
ipcMain.handle('backups:createNow', async () => {
  return backupCurrentConfig(true, 'manual');
});

// ---------- Developer diagnostics ----------
function pluginDiagnosticInventory() {
  const currentDisabled = new Set(((loadConfig().plugins || {}).disabled) || []);
  const bootDisabled = new Set(pluginDisabledAtBoot);
  return discoverPlugins().map((plugin) => (plugin.error ? {
    id: plugin.dir, state: 'manifest-error', error: plugin.error,
  } : {
    id: plugin.id, name: plugin.name, version: plugin.version, isolated: !!plugin.isolated,
    state: pluginMainLoadErrors[plugin.id] ? 'load-error'
      : (bootDisabled.has(plugin.id) ? 'disabled'
        : (pluginsNeedingApproval.includes(plugin.id) ? 'needs-capability-approval'
          : (pluginsNeedingIntegrityApproval.includes(plugin.id) ? 'needs-integrity-approval' : 'active'))),
    configuredEnabled: !currentDisabled.has(plugin.id),
    loadError: pluginMainLoadErrors[plugin.id] || null,
    capabilities: plugin.capabilities,
  }));
}

function pluginRestartPending() {
  const current = ((loadConfig().plugins || {}).disabled || []).slice().sort();
  const boot = pluginDisabledAtBoot.slice().sort();
  return JSON.stringify(current) !== JSON.stringify(boot);
}

ipcMain.handle('diagnostics:get', async () => ({
  generatedAt: new Date().toISOString(),
  app: { version: app.getVersion(), platform: process.platform, arch: process.arch, electron: process.versions.electron },
  plugins: pluginDiagnosticInventory(),
  mediaSourceProviders: { ...activatedMediaSourceProviders },
  services: Object.keys(pluginServicesRef).sort(),
  restartRequired: pluginRestartPending(),
  logs: getMainLogs(),
}));

ipcMain.handle('diagnostics:export', async (event, rendererSnapshot) => {
  const result = await dialog.showSaveDialog(getMainWindow(), {
    title: 'Export redacted support bundle',
    defaultPath: `reruntv-support-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return { cancelled: true };
  const bundle = {
    format: 'reruntv-support-bundle', version: 1, generatedAt: new Date().toISOString(),
    app: { version: app.getVersion(), platform: process.platform, arch: process.arch, electron: process.versions.electron },
    plugins: pluginDiagnosticInventory(), mediaSourceProviders: { ...activatedMediaSourceProviders },
    services: Object.keys(pluginServicesRef).sort(), restartRequired: pluginRestartPending(), mainLogs: getMainLogs(), renderer: rendererSnapshot || {},
  };
  fs.writeFileSync(result.filePath, `${JSON.stringify(redactDiagnosticValue(bundle, { userDataPath: app.getPath('userData') }), null, 2)}\n`, 'utf8');
  recordDiagnostic('diagnostics', 'log', 'Exported redacted support bundle');
  return { success: true, filePath: result.filePath };
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
  const isConfig = parsed && typeof parsed === 'object' && Array.isArray(parsed.channels);
  const isChannelPackage = parsed && parsed.kind === 'reruntv-channel-package' && parsed.channel;
  if (!isConfig && !isChannelPackage) {
    throw new Error('That file doesn\'t look like a RerunTV config or channel package.');
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
  // A media-source-plugin ref (still-prefixed, i.e. not yet resolved to a
  // real local cache path by resolvePlayablePath) is routed through the LAN
  // viewer's own already-running, genuine http.Server (main-viewer-server.js
  // — same /media route a LAN viewer device already uses, which happens to
  // already dispatch through serveMediaRef the exact same way app://media
  // does) instead of Electron's custom app:// protocol.handle. Found live:
  // Chromium's <video> element never issues a follow-up Range request
  // through app://media for a plugin-backed resource, no matter what's in
  // the response — but does for a genuine local file through that same
  // handler, and (this is what's being tested) may behave like any other
  // ordinary HTTP video URL when the exact same data is served through a
  // real loopback HTTP connection instead of Electron's Response-based
  // custom-protocol dispatch. Local refs are untouched — zero behavior
  // change, same app://media path proven reliable for every local channel.
  if (parseMediaRef(filePath).source !== 'local') {
    return `http://127.0.0.1:${VIEWER_PORT}/media?p=${encodeURIComponent(filePath)}`;
  }
  return `app://media/?p=${encodeURIComponent(filePath)}`;
});

ipcMain.handle('path:basename', async (event, filePath) => {
  return path.basename(filePath, path.extname(filePath));
});

// Cheap check only — never spawns ffmpeg. srcPath is always the path to play;
// alreadyFixed tells the caller whether it's already the swapped-in H.264
// copy (a backup exists), so a further playback failure is a real error
// rather than something a transcode could fix. Explicit no-op for a
// non-local source, per media-source-abstraction design: there's no local
// file to rename-swap a transcoded copy into, so `transcodable: false` here
// tells playback.js's handleUnplayable() not to attempt the FIX PLAYBACK
// flow at all rather than trying and failing at it.
ipcMain.handle('media:resolvePlayablePath', async (event, source, srcPath) => {
  if (source && source !== 'local') {
    // Once a media-source plugin has a file fully cached to local disk
    // (getLocalCachePath, an optional verb alongside getFetchProgress —
    // see PLUGIN_DEVELOPMENT.md's "Media sources" section), redirect
    // playback to that real local path instead of continuing to serve it
    // as a live plugin stream. Found live: Chromium's <video> element never issues a
    // follow-up Range request through the app://media custom protocol for
    // a plugin-backed resource — exactly one request, regardless of what's
    // in the response — even though it happily makes many for a genuine
    // local file through that same protocol. Rather than keep chasing
    // that, once the bytes are actually on disk there's no reason to route
    // through the RPC-per-chunk path at all: toFileUrl'ing a real local
    // path here means main-protocol.js's parseMediaRef sees it as
    // source:'local' and serves it via serveFile — the exact,
    // already-proven-reliable code path every local channel already uses.
    try {
      const { ref } = parseMediaRef(srcPath);
      const localPath = await callMediaService(pluginServicesRef, source, 'getLocalCachePath', [ref], MEDIA_CHECK_TIMEOUT_MS);
      if (localPath) {
        // Genuinely a local file now (in the plugin's own cache dir, but a
        // real file on this disk ffmpeg can read/write same as any other)
        // — full local-file treatment, auto-fix included, not the
        // can't-be-auto-fixed messaging that's still correct for a file
        // that's actually still a live plugin stream.
        recoverPendingSwap(localPath);
        return { path: localPath, alreadyFixed: fs.existsSync(backupPathFor(localPath)), transcodable: true };
      }
    } catch (e) { /* provider doesn't implement getLocalCachePath, or isn't cached yet — fall through */ }
    return { path: srcPath, alreadyFixed: false, transcodable: false };
  }
  recoverPendingSwap(srcPath);
  return { path: srcPath, alreadyFixed: fs.existsSync(backupPathFor(srcPath)), transcodable: true };
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
// handler is just the IPC surface for it. A non-local source has no local
// file for that rename dance to operate on at all — surfaced as a clear,
// specific error rather than attempting local rename semantics against an
// opaque plugin ref (which would just throw confusingly inside
// transcodeVideo instead).
ipcMain.handle('media:transcode', async (event, source, srcPath) => {
  if (source && source !== 'local') {
    return { error: "This file is served by a plugin media source and can't be codec-fixed in place — try re-encoding it at the source, or copying it locally first." };
  }
  return transcodeVideo(srcPath);
});
