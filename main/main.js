const { app, BrowserWindow, ipcMain, dialog, shell, screen, powerSaveBlocker, Notification } = require('electron');

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
const { installMainLogCapture, registerDiagnosticsIpc } = require('./main-diagnostics');
installMainLogCapture();

// "Server mode" — a --headless launch never creates or shows the full
// RerunTV BrowserWindow on this machine. --server opens the loopback-only
// server/pairing webpage after boot; --headless only prints its URL. Every
// LAN-facing server (viewer,
// remote, discovery, a plugin's own bridge/stream server) still starts exactly as normal
// — see app.whenReady() below. Every existing mainWindow reference (via
// main-window-ref.js's getMainWindow()) is already either null-guarded or
// only ever reachable from IPC calls a host renderer would make — which
// never exists in this mode — so mainWindow simply staying unset forever is
// safe with no further changes needed elsewhere. See package.json's
// "server" script / run-server.bat for how this is meant to be launched.
const SERVER_CONTROL = process.argv.includes('--server');
// Usage mode launch flags (docs/design/01 §4, §9): `--mode=tv` starts the
// renderer in TV mode unless this device already chose a mode in its own
// settings; `--kiosk` is a mini-PC under a TV — fullscreen, no OS chrome.
const LAUNCH_MODE = (process.argv.find((arg) => /^--mode=(tv|desktop)$/.test(arg)) || '').slice('--mode='.length) || null;
const KIOSK = process.argv.includes('--kiosk');
const HEADLESS = process.argv.includes('--headless') || SERVER_CONTROL;
// Server-control mode is windowless after boot, but it deliberately uses the
// updater's small BrowserWindow before opening the local control site. Keep
// window-all-closed from treating that updater window as the whole app while
// the remaining server/plugin boot is still in progress.
const STARTUP_UPDATE_UI = !HEADLESS || SERVER_CONTROL;
let interactiveBootInProgress = STARTUP_UPDATE_UI;

// Split out of this file into focused main-*.js modules — config/backups,
// window-state, LAN address discovery, the app:// protocol handler,
// media/transcode helpers, the mainWindow reference, and each LAN-facing
// server (remote/viewer/discovery/party) — plus any plugin's own
// main-process work (a child process, an HTTP bridge, etc.), which lives
// entirely in that plugin's own main.js, not here. What's left in main.js
// itself is app lifecycle, window creation, and the ipcMain registrations
// that tie all of the above to the renderer.
const { registerAppSchemePrivileges, registerAppProtocol, setMediaDispatchServices, setAllowedMediaSrcPorts, mimeFor } = require('./main-protocol');
const { FFMPEG_STATIC_PATH, setFfmpegPath } = require('./main-media');
const { loadConfig, registerBackupsIpc, registerConfigIpc, applyHeadlessSettingsPatch, onViewerRelevantConfigChange } = require('./main-config');
const { loadWindowState, saveWindowState, boundsOnScreen } = require('./main-window-state');
const { getViewerUrls, getLanAddresses, VIEWER_PORT, registerLanIpc } = require('./main-lan');
const { trackConnection, registerConnectionsIpc } = require('./main-connections');
const { fetchJsonCached } = require('./main-api-cache');
const { readJsonBody, serveStaticFile } = require('./main-http-util');
const { setMainWindow, getMainWindow } = require('./main-window-ref');
const { startViewerServer } = require('./main-viewer-server');
const { startMediaBridge } = require('./main-media-bridge');
const { startDiscoveryServer } = require('./main-discovery-server');
const { isLanServiceEnabled, createLanAccess } = require('./main-lan-security');
const { registerDialogIpc } = require('./main-dialogs');
const { applyWindowUiScale, normalizeUiScalePreference } = require('./main-ui-scale');
const { registerStartupServerIpc } = require('./main-startup-server');
const { registerHistoryIpc, flushHistoryNow } = require('./main-history');

// A device that's already entered a LAN service's pairing code once stays
// paired across restarts (createLanAccess's opts.sessionsFile/
// sessionTtlMs) — 90 days, not the module's short un-persisted default,
// since the whole point of persisting is not asking again for as long as
// the device still has the box on its LAN. Shared by every core-owned LAN
// service (currently just the viewer); plugin-owned ones (universal-remote,
// companion-app, party-channel) keep their own copy of this constant since
// they can't import a core main-*.js file by path once packaged (see
// plugins/companion-app/main.js's isPathContained comment for why).
const LAN_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const { getPluginsDir, discoverPlugins, loadMainPlugins, seedBundledPlugins, registerFallbackHandlers, registerPluginsIpc } = require('./main-plugins');
const { wireAppQuitPropagation } = require('./main-plugin-isolation');
const { setApprovedMediaSourceProviders, registerMediaDispatchIpc } = require('./main-media-dispatch');
const { initAutoUpdater, registerThemeIpc, getLatestThemeList } = require('./main-updater');
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

// overrides.hideTitleBar lets window:setTitleBarHidden (below) pass the
// just-requested value straight through when it recreates the window —
// frame is a BrowserWindow constructor-only option, so toggling it live has
// no other way in than tearing down and rebuilding. Every other caller
// (initial boot, macOS 'activate' with no windows open) omits it and falls
// back to whatever's already saved in config, same as before this existed.
function createWindow(overrides = {}) {
  const saved = loadWindowState();
  const bounds = saved && boundsOnScreen(saved) ? saved : {};
  // No saved state (first launch, or userData was reset) used to fall back
  // to a flat 1280x800 below regardless of the real display — on a 4K
  // monitor that opens as a small window nowhere near filling the screen,
  // and every cqw/cqh-scaled panel inside #display-frame (guide.css,
  // setup.css) sizes itself off that too-small effective canvas, reading as
  // a generally cramped/"smushed" layout rather than just a small window.
  // Default to the current display's work area instead so a fresh box
  // fills its screen like a real one would, same as the maximized-state
  // case just below.
  const defaultArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const bootConfig = loadConfig();
  const hideTitleBar = overrides.hideTitleBar !== undefined
    ? overrides.hideTitleBar
    : !!((bootConfig.display || {}).hideTitleBar);
  let uiScalePreference = normalizeUiScalePreference((bootConfig.display || {}).uiScale);

  const mainWindow = new BrowserWindow({
    width: bounds.width || defaultArea.width,
    height: bounds.height || defaultArea.height,
    x: bounds.x !== undefined ? bounds.x : defaultArea.x,
    y: bounds.y !== undefined ? bounds.y : defaultArea.y,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#060606',
    frame: !hideTitleBar,
    kiosk: KIOSK,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // This app's whole point is to keep "broadcasting" while the user
      // works in another window — Chromium's default background throttling
      // (timers clamped, rendering/video-decode deprioritized once the
      // window loses focus or is occluded) reads to playback.js's
      // decode-frame watchdog as a stalled/unplayable file and was
      // triggering unnecessary real ffmpeg transcodes purely from being
      // backgrounded (found live: reported as "happens often when I leave
      // the app and work in another window").
      backgroundThrottling: false,
    },
  });
  setMainWindow(mainWindow);
  mainWindow.setMenuBarVisibility(false);
  // The renderer is an app:// document with a privileged preload bridge;
  // never let in-page content replace it with an arbitrary origin or spawn
  // a child renderer that inherits desktop-app expectations.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('app://bundle/')) event.preventDefault();
  });
  if (saved && saved.isMaximized) mainWindow.maximize();
  // The launch flag rides on the page URL, the same ?mode= a browser client
  // uses, so usage-mode.js has one place to read it from.
  mainWindow.loadURL(`app://bundle/renderer/index.html${LAUNCH_MODE ? `?mode=${LAUNCH_MODE}` : ''}`);
  mainWindow.webContents.on('did-finish-load', () => applyWindowUiScale(mainWindow, uiScalePreference));

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
  let uiScaleTimer = null;
  mainWindow.on('resize', () => {
    persistWindowStateDebounced();
    if (uiScalePreference !== 'auto') return;
    clearTimeout(uiScaleTimer);
    uiScaleTimer = setTimeout(() => applyWindowUiScale(mainWindow, uiScalePreference), 100);
  });
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

  // The renderer can change this live from DISPLAY > INTERFACE without a
  // restart. Kept on the BrowserWindow so automatic mode can also reapply
  // after later resize/fullscreen changes without rereading a debounced
  // config file that may not have been flushed yet.
  mainWindow.__setUiScalePreference = (preference) => {
    uiScalePreference = normalizeUiScalePreference(preference);
    return applyWindowUiScale(mainWindow, uiScalePreference);
  };
}

// Set for the duration of window:setTitleBarHidden's own close()->createWindow()
// swap below, so the momentary zero-window gap that recreate requires doesn't
// trip the window-all-closed handler's app.quit() the same way
// interactiveBootInProgress already guards the pre-launch updater window's
// own zero-window interval.
let intentionalWindowRecreate = false;

app.on('second-instance', (event, commandLine) => {
  if (HEADLESS) {
    const requestedServer = commandLine.includes('--server');
    const requestedHeadless = commandLine.includes('--headless');
    if (requestedServer) {
      shell.openExternal(`http://127.0.0.1:${VIEWER_PORT}/server`);
      return;
    }
    if (!requestedHeadless) {
      // A login-started server owns the single-instance lock. If the user
      // later opens RerunTV normally, restart cleanly into the full desktop
      // UI instead of making that launch appear to do nothing.
      const args = app.isPackaged ? [] : [path.join(__dirname, '..')];
      app.relaunch({ args });
      app.quit();
    }
    return;
  }
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
// Module-scope so registerPluginsIpc/registerMediaDispatchIpc/
// registerDiagnosticsIpc (called below, outside whenReady) can reach it via
// a getter for their non-local dispatch branch (callMediaService,
// main-media-dispatch.js) — same object loadMainPlugins() populates inside
// whenReady below, just referenced from a wider scope than before this
// existed.
let pluginServicesRef = {};
let viewerAccessUrls = [];
// Always set once app.whenReady() starts main-media-bridge.js's host-only
// server (never null past that point, and set unconditionally — not tied to
// whether LAN viewer access is on). This is deliberately NOT the real LAN
// viewer server's own projection even when that service is enabled: that
// server's /media route sits behind main-lan-security.js's pairing/session
// gate, which the host window's own fetch() has no way to satisfy (a
// <video src> can't carry a session cookie/Bearer header the way a paired
// browser tab's request does) — found live, see main.js's whenReady for the
// full story. This bridge has no such gate, so the host window always uses
// it instead, regardless of LAN viewer state.
let viewerProjectionRef = null;
// main-media-bridge.js's own OS-assigned ephemeral port — the port
// path:toFileUrl (main-media-dispatch.js) targets for every mediaSource-
// plugin ref played in the host window. Never null past whenReady().
let mediaBridgePort = null;
let pluginDisabledAtBoot = [];

// Every IPC handler whose logic already lives in a focused main-*.js module
// (see CLAUDE.md's directory map) is registered by that module's own
// registerXIpc() export rather than inline here — main.js just hands over
// accessor functions (not raw values) for the `let`s just above, since
// loadMainPlugins()/startViewerServer() below don't populate their real
// values until app.whenReady() runs, well after these calls. See each
// module's own registerXIpc for the handlers it now owns; what's left below
// is only the handful tightly coupled to createWindow()/mainWindow itself,
// which stays main.js's job per CLAUDE.md's directory map.
registerConnectionsIpc(ipcMain);
registerThemeIpc(ipcMain);
registerLanIpc(ipcMain, {
  getViewerAccessUrls: () => viewerAccessUrls,
  getCompanionAccessUrls: () => pluginServicesRef.companionAccessUrls || [],
  getUserDataDir: () => app.getPath('userData'),
  QRCode,
});
registerDialogIpc(ipcMain);
registerStartupServerIpc(ipcMain);
registerPluginsIpc(ipcMain, {
  getPluginMainLoadErrors: () => pluginMainLoadErrors,
  getPluginsNeedingApproval: () => pluginsNeedingApproval,
  getActivatedMediaSourceProviders: () => activatedMediaSourceProviders,
  getPluginServicesRef: () => pluginServicesRef,
});
registerMediaDispatchIpc(ipcMain, {
  getPluginServicesRef: () => pluginServicesRef,
  getViewerProjectionRef: () => viewerProjectionRef,
  getMediaBridgePort: () => mediaBridgePort,
  getMainWindow,
});
registerBackupsIpc(ipcMain);
registerConfigIpc(ipcMain);
registerHistoryIpc();
registerDiagnosticsIpc(ipcMain, {
  app,
  dialog,
  fs,
  getMainWindow,
  discoverPlugins,
  loadConfig,
  getPluginDisabledAtBoot: () => pluginDisabledAtBoot,
  getPluginMainLoadErrors: () => pluginMainLoadErrors,
  getPluginsNeedingApproval: () => pluginsNeedingApproval,
  getPluginsNeedingIntegrityApproval: () => pluginsNeedingIntegrityApproval,
  getActivatedMediaSourceProviders: () => activatedMediaSourceProviders,
  getPluginServicesRef: () => pluginServicesRef,
});

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
  if (STARTUP_UPDATE_UI) {
    // The updater's small pre-launch window is served through app:// too,
    // so the protocol must exist before the startup gate. A genuinely fresh
    // install skips the gate once; renderer onboarding explains and saves
    // the user's update policy before later launches enforce it.
    registerAppProtocol(path.join(__dirname, '..'), getPluginsDir());
    // seedBundledPlugins() is synchronous fs work with no dependency on the
    // update check (or vice versa) — running them via Promise.all overlaps
    // the updater's network round-trip with the seeding pass instead of
    // paying for both in sequence (the updater's own startup-check can take
    // up to 12s on the "startup-auto" strategy; see CLAUDE.md's test notes).
    const [installingUpdate] = await Promise.all([
      initAutoUpdater(getMainWindow, { skipStartupCheck: !!bootConfig._isFirstRun }),
      Promise.resolve().then(seedBundledPlugins),
    ]);
    if (installingUpdate) return;
  } else {
    seedBundledPlugins();
  }
  // The host window's own mediaSource-plugin playback ALWAYS goes through
  // this bridge, never through the real LAN viewer server below, even when
  // LAN viewer access is on. Found live: reusing the LAN viewer's own
  // /media route for the host window (the original shape of this fix)
  // looked right — same route, same serveMediaRef dispatch — but that
  // route sits behind main-lan-security.js's pairing/session-cookie gate,
  // and the host window's own fetch() never goes through the /_pair
  // handshake a real paired browser tab does. It came back the pairing
  // HTML page instead of media bytes, and the <video> element's request
  // failed outright — a latent bug since LAN hardening was added, since
  // nobody had exercised a plugin channel with LAN viewer also turned on.
  // This bridge has no such gate (loopback-only, ephemeral port, never
  // advertised) specifically so the host window's own use case needs none.
  const bridge = await startMediaBridge();
  viewerProjectionRef = bridge.projection;
  mediaBridgePort = bridge.port;
  // Starting with --headless/--server is itself an explicit request to host
  // RerunTV for a viewer. Do not make a windowless process silently expose
  // nothing just because WATCH ON OTHER DEVICES was last switched off in
  // the desktop UI. The service remains protected by the same pairing code,
  // persisted session, rate limits, and opaque media projection as normal
  // viewer mode; this changes availability, not its security boundary.
  const viewerEnabledForThisRun = HEADLESS || isLanServiceEnabled(bootConfig, 'viewer');
  if (viewerEnabledForThisRun) {
    // Independent of the bridge above — this server's own /media route (and
    // its own separate projection instance) is what an actual remote LAN
    // device uses, gated by pairing same as everything else it serves.
    const viewerRuntime = startViewerServer(pluginServices, {
      pluginsDir: getPluginsDir(),
      access: createLanAccess('viewer', {
        readLimit: 1200, writeLimit: 30,
        sessionsFile: path.join(app.getPath('userData'), 'lan-sessions', 'viewer.json'),
        sessionTtlMs: LAN_SESSION_TTL_MS,
      }),
      listPlugins: () => discoverPlugins().map((plugin) => (
        plugin.error ? plugin : {
          ...plugin,
          loadError: pluginMainLoadErrors[plugin.id] || null,
          needsIntegrityApproval: plugin.integrityStatus === 'unverified' || plugin.integrityStatus === 'modified',
        }
      )),
      getControlState: () => ({
        viewerUrls: viewerAccessUrls,
        companionUrls: pluginServices.companionAccessUrls || [],
        mode: HEADLESS ? 'headless' : 'desktop',
      }),
      requestStop: HEADLESS ? () => app.quit() : null,
    });
    const viewerStarted = await viewerRuntime.ready;
    if (viewerStarted) {
      viewerAccessUrls = getViewerUrls().map((entry) => ({ ...entry, url: viewerRuntime.access.pairingUrl(entry.url) }));
      // Paired viewers refetch as soon as the host writes a change they'd
      // see, instead of waiting for their slow fallback poll. Only a notice
      // goes out — never config itself; each viewer fetches its own redacted
      // projection through the normal authenticated /api/config.
      onViewerRelevantConfigChange(() => pluginServices.viewerRemoteBridge?.publish('config:changed', null));
    }
  }
  const disabledPluginIds = (bootConfig.plugins && bootConfig.plugins.disabled) || [];
  pluginDisabledAtBoot = [...disabledPluginIds];
  const approvedCapabilities = (bootConfig.plugins && bootConfig.plugins.approvedCapabilities) || {};
  if (HEADLESS) {
    pluginServices.applyCompanionSettings = async (patch) => {
      await applyHeadlessSettingsPatch(patch);
      // Send only an invalidation, never an unredacted config/credential patch.
      pluginServices.viewerRemoteBridge?.publish('companion:configChanged', null);
      return true;
    };
  }
  const loadResult = await loadMainPlugins(disabledPluginIds, {
    fetchJsonCached, getMainWindow, getLanAddresses, readJsonBody,
    serveStatic: serveStaticFile,
    trackConnection, mimeFor, loadConfig, busboy, QRCode,
    getViewerUrls: () => viewerAccessUrls,
    getInstalledThemes: () => {
      const reported = getLatestThemeList();
      if (reported.length) return reported;
      // Bundled theme pack ids follow theme-<registered id>. Server mode
      // has no desktop renderer to report its theme registry over IPC.
      const disabled = new Set(loadConfig().plugins?.disabled || []);
      return [{ id: 'digital-2000s', label: 'DIGITAL CABLE (MID 2000s BLUE)' }]
        .concat(discoverPlugins().filter((plugin) => !plugin.error
          && plugin.bundled && plugin.category === 'theme' && plugin.id.startsWith('theme-')
          && plugin.integrityStatus === 'bundled' && !disabled.has(plugin.id))
          .map((plugin) => ({ id: plugin.id.slice(6), label: plugin.name.toUpperCase() })));
    },
    ffmpegStaticPath: FFMPEG_STATIC_PATH, services: pluginServices,
  }, approvedCapabilities);
  pluginMainLoadErrors = loadResult.loadErrors;
  pluginsNeedingApproval = loadResult.needsApproval;
  pluginsNeedingIntegrityApproval = loadResult.needsIntegrityApproval;
  registerFallbackHandlers(disabledPluginIds.concat(pluginsNeedingApproval, pluginsNeedingIntegrityApproval), ipcMain, loadResult.allPlugins);
  setFfmpegPath(pluginServices.ffmpegPath || null);
  activatedMediaSourceProviders = loadResult.activatedMediaSourceProviders;
  setApprovedMediaSourceProviders(loadResult.activatedMediaSourceProviders);
  // Every port a plugin actually needs approved (capabilities.net) is now
  // known — turn that into index.html's dynamic media-src CSP allowance
  // (see setAllowedMediaSrcPorts's doc comment, main-protocol.js) instead of
  // requiring a hand-maintained port list in that static <meta> tag.
  // mediaBridgePort is VIEWER_PORT itself when the LAN viewer is enabled
  // (already covered) or main-media-bridge.js's own ephemeral port when it
  // isn't — either way path:toFileUrl may point a mediaSource-plugin
  // channel's <video src> at it, so it always needs to be CSP-allowed too.
  setAllowedMediaSrcPorts([VIEWER_PORT, mediaBridgePort, ...loadResult.activatedNetPorts]);
  const companionEnabled = Array.isArray(pluginServices.companionAccessUrls) && pluginServices.companionAccessUrls.length > 0;
  if (viewerAccessUrls.length || companionEnabled) {
    startDiscoveryServer({ viewerEnabled: !!viewerAccessUrls.length, companionEnabled });
  }

  if (HEADLESS) {
    // No window, no app:// protocol (only ever used to load the host's own
    // renderer — nothing to register it for here) — just the LAN servers
    // above, which is the whole point of this mode. window-all-closed
    // never fires with zero windows ever created, so the process simply
    // keeps running until it's stopped externally (Ctrl+C in the console
    // this was launched from, or the process being killed).
    console.log('RerunTV is running in HEADLESS VIEWER mode — no window on this machine.');
    console.log('The viewer is available to paired devices:');
    viewerAccessUrls.forEach((u) => console.log(`  Watch at ${u.url}  (${u.name})`));
    (pluginServices.companionAccessUrls || []).forEach((u) => console.log(`  Companion/remote at ${u.url}  (${u.name})`));
    const controlUrl = `http://127.0.0.1:${VIEWER_PORT}/server`;
    console.log(`Local control panel: ${controlUrl}`);
    if (SERVER_CONTROL && viewerAccessUrls.length) {
      console.log('Opening the local control panel in your browser.');
      shell.openExternal(controlUrl);
    } else if (SERVER_CONTROL) {
      console.log('The control panel could not open because the viewer server did not start.');
    } else {
      console.log('Press Ctrl+C to stop.');
    }
    interactiveBootInProgress = false;
    return;
  }

  createWindow();
  interactiveBootInProgress = false;
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// The viewing log batches its writes, so the last couple of seconds of it
// would otherwise die with the process on quit.
app.on('will-quit', () => flushHistoryNow());

app.on('window-all-closed', () => {
  // The pre-launch updater window can close after an up-to-date/error
  // result while plugin boot is still finishing and before createWindow().
  // That transient zero-window interval is not a user quit.
  if (interactiveBootInProgress || intentionalWindowRecreate) return;
  if (process.platform !== 'darwin') app.quit();
});

// ---------- App / window ----------
// theme:colors/themes:list -> main-updater.js's registerThemeIpc (called
// above), alongside setThemeColors/the theme-pack list it already owns for
// the frameless update-progress popup. network:getConnections ->
// main-connections.js. viewer:getUrl/companion:getUrl -> main-lan.js. The
// three window-lifecycle handlers below stay here: they're tightly coupled
// to createWindow()/intentionalWindowRecreate, both of which are main.js's
// own job per CLAUDE.md's directory map (window creation stays here).
ipcMain.handle('app:getVersion', async () => {
  return app.getVersion();
});

ipcMain.handle('window:toggleFullscreen', async () => {
  const mainWindow = getMainWindow();
  if (!mainWindow) return false;
  mainWindow.setFullScreen(!mainWindow.isFullScreen());
  return mainWindow.isFullScreen();
});

// TV mode's exit prompt (tv-input.js): Back on bare live TV offers EXIT, so a
// kiosk box driven only by a remote can still be closed on purpose.
ipcMain.handle('window:quit', async () => {
  app.quit();
  return true;
});

ipcMain.handle('window:setUiScale', async (event, preference) => {
  const mainWindow = getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed() || typeof mainWindow.__setUiScalePreference !== 'function') return 1;
  return mainWindow.__setUiScalePreference(preference);
});

// DISPLAY tab's "hide title bar" option (config.display.hideTitleBar) — a
// borderless window that still behaves like a normal windowed app (movable,
// resizable, coexists with the taskbar/other windows), unlike the real OS
// fullscreen toggleFullscreen above. `frame` only takes effect at
// BrowserWindow construction, so there's no live way to strip/restore the
// title bar on the existing window — this closes it and opens a replacement
// with the new frame setting, reusing the same bounds-persistence the normal
// close path already writes (persistWindowState, above) so the replacement
// opens at the same size/position instead of resetting to a default.
ipcMain.handle('window:setTitleBarHidden', async (event, hidden) => {
  const mainWindow = getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return !!hidden;
  // The actual close+recreate is deferred to the next tick rather than
  // awaited here — this handler's reply goes back to the very webContents
  // that's about to be destroyed by mainWindow.close(), and closing it before
  // this promise resolves risks the reply never reaching a renderer that no
  // longer exists to receive it. Returning first lets that reply flush.
  setImmediate(() => {
    if (mainWindow.isDestroyed()) return;
    intentionalWindowRecreate = true;
    mainWindow.once('closed', () => {
      intentionalWindowRecreate = false;
      createWindow({ hideTitleBar: !!hidden });
    });
    mainWindow.close();
  });
  return !!hidden;
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

// A set that's switched on shouldn't let the monitor go dark underneath it.
// Chromium keeps the display up on its own while real video is decoding, but
// a virtual/plugin channel, a no-signal card, an open guide, and a paused
// trivia break are all still-image states where it doesn't — and those are
// exactly the states a cable box is expected to sit in indefinitely. The
// renderer owns the policy (only it knows whether the set is powered on and
// whether the user wants this at all); main just holds the blocker, since
// powerSaveBlocker is main-process-only. Held per-app rather than per-window
// so the title-bar toggle's close-and-recreate (window:setTitleBarHidden
// above) doesn't drop it and leave the renderer believing it's still held —
// the replacement renderer reasserts on boot regardless.
// Passing null/undefined asks what's currently held without changing it.
// Without that, nothing anywhere — diagnostics, a test, or a person reading
// the code — can answer "is the lock actually held right now?", since the
// setter's return value is just the state it was asked for and reads the
// same whether or not it changed anything.
let displayWakeLockId = null;
ipcMain.handle('power:setKeepDisplayAwake', async (event, keepAwake) => {
  const held = displayWakeLockId != null && powerSaveBlocker.isStarted(displayWakeLockId);
  if (keepAwake == null) return held;
  const wanted = !!keepAwake;
  if (wanted === held) return held;
  if (wanted) {
    displayWakeLockId = powerSaveBlocker.start('prevent-display-sleep');
  } else {
    if (displayWakeLockId != null) powerSaveBlocker.stop(displayWakeLockId);
    displayWakeLockId = null;
  }
  return wanted;
});

// Last-resort delivery for a program reminder the user cannot see, because
// the app is deliberately built to keep broadcasting behind other windows —
// which is precisely when guide.js's in-app toast is hidden. The renderer
// decides when that's the case; main only refuses the obviously-wrong case
// of firing one while the window is focused, so a race between the renderer
// checking focus and this handler running can't produce a notification for
// something already on screen.
ipcMain.handle('notify:show', async (event, { title, body } = {}) => {
  if (!Notification.isSupported()) return false;
  const mainWindow = getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()) return false;
  const notification = new Notification({
    title: String(title || 'RerunTV').slice(0, 120),
    body: String(body || '').slice(0, 400),
  });
  notification.on('click', () => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  notification.show();
  return true;
});

// dialog:select* -> main-dialogs.js (registerDialogIpc, above). plugins:* /
// mediaSource:callHook -> main-plugins.js (registerPluginsIpc, above).
// fs:scanFolder / media:probeDuration / fs:checkPathsExist / path:toFileUrl /
// media:resolvePlayablePath / media:transcode -> main-media-dispatch.js
// (registerMediaDispatchIpc, above — it already owns the local-vs-plugin
// dispatch decision every one of those handlers makes, so the transcode IPC
// surface moved there too rather than splitting it into main-media.js on its
// own). backups:*/config:* -> main-config.js (registerBackupsIpc/
// registerConfigIpc, above). diagnostics:* -> main-diagnostics.js
// (registerDiagnosticsIpc, above).
//
// A plugin that's disabled/missing can still register safe fallback IPC
// handlers for whatever channels its renderer side calls unconditionally,
// via its own main.js's registerFallback(ipcMain) export — see
// registerFallbackHandlers (main-plugins.js) for the generic mechanism.
// remote:state, party:queueState/voteState/triviaState/jukeboxState are all
// ipcMain.on (fire-and-forget, no return value) — registered only by a
// plugin's own activate() when installed+enabled. No fallback needed:
// ipcRenderer.send() to a channel with zero listeners is a silent no-op,
// not an error.

// ---------- Manual, paths ----------
// Both handlers below have zero module-specific state of their own (no
// mutable capture, no natural "owning" module) — left here rather than
// arbitrarily assigned to main-media.js or main-media-dispatch.js.
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

ipcMain.handle('path:basename', async (event, filePath) => {
  return path.basename(filePath, path.extname(filePath));
});
