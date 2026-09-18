// Browser-compatible stand-in for preload.js's contextBridge-exposed
// window.api — only defines anything when window.api isn't already set.
// Inside Electron, preload.js has already run in an isolated world before
// any page script executes, so window.api exists and this file is a
// complete no-op there. In a plain LAN browser (the "LAN viewer" feature —
// see main.js's startViewerServer), nothing has defined window.api yet, so
// this becomes the real implementation: playback/runtime methods get browser
// equivalents and setup mutations get explicit inert fallbacks. Host-only
// surfaces such as updates are deliberately omitted so their panels hide.
//
// This is a classic (non-module) script, loaded via a plain <script> tag in
// index.html BEFORE the `type="module"` app.js script — module scripts are
// deferred until after the document parses, but a classic script executes
// immediately when the parser reaches it, so window.api/window.__isViewer
// are guaranteed to exist before any of app.js's imports run.
(function () {
  if (window.api) return; // Electron's preload already provided the real one
  const contract = window.RCBApiContract;
  if (!contract) throw new Error('window.api contract must load before browser-api-shim.js');

  window.__isViewer = true;
  // The LAN control panel (docs/design/06 §3) is this same bundle served at
  // /control. The path is how the page knows to boot into the setup shell
  // rather than straight to playback — it is NOT what makes it writable. Every
  // write below goes to /api/commands, which the host refuses unless this
  // device's session actually holds the control scope, so typing /control with
  // a viewer's session gets an editor that cannot save rather than one that
  // can. controlScope below is the authoritative answer, asked of the host.
  window.__controlClient = /^\/control\/?$/.test(window.location.pathname);

  function readOnlyNoop(label) {
    return (...args) => {
      console.warn(`[LAN viewer] ${label}() is a no-op here — this device is a read-only viewer. Make this change on the host instead.`);
      return Promise.resolve(null);
    };
  }

  const viewerEventListeners = new Map();
  let viewerEventCursor = null;
  let viewerEventPollTimer = null;
  let viewerEventPollActive = false;

  function dispatchViewerEvents(events) {
    (events || []).forEach((event) => {
      const listeners = viewerEventListeners.get(event.channel) || [];
      listeners.forEach((listener) => {
        try { listener(event.data); } catch (e) { console.error('[LAN viewer] remote event failed:', e); }
      });
    });
  }

  async function pollViewerEvents() {
    if (viewerEventPollActive) return;
    viewerEventPollActive = true;
    try {
      const suffix = viewerEventCursor == null ? '' : `?after=${encodeURIComponent(viewerEventCursor)}`;
      const response = await fetch(`/api/remote-events${suffix}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      dispatchViewerEvents(payload.events);
      if (Number.isSafeInteger(payload.cursor)) viewerEventCursor = payload.cursor;
    } catch (e) {
      // A transient server restart should not tear down the viewer; the next
      // poll retries and the TV client's own connection recovery remains in
      // charge of main-frame failures.
    } finally {
      viewerEventPollActive = false;
      viewerEventPollTimer = setTimeout(pollViewerEvents, 250);
    }
  }

  function onViewerEvent(channel, callback) {
    if (typeof callback !== 'function') return () => {};
    if (!viewerEventListeners.has(channel)) viewerEventListeners.set(channel, []);
    viewerEventListeners.get(channel).push(callback);
    if (!viewerEventPollTimer && !viewerEventPollActive) pollViewerEvents();
    return () => {
      const listeners = viewerEventListeners.get(channel) || [];
      viewerEventListeners.set(channel, listeners.filter((listener) => listener !== callback));
    };
  }

  // ---------- Control sessions (docs/design/06 §3) ----------
  // Whether this device may write is the HOST's answer, not this page's.
  // /api/control/state answers 200 for a control session and 403 for a view
  // one, so the probe below is what every write waits on. It is asked once and
  // remembered; a device does not change scope without re-pairing, which
  // reloads the page.
  let controlScopeProbe = null;
  function controlScope() {
    if (!controlScopeProbe) {
      controlScopeProbe = fetch('/api/control/state', { cache: 'no-store' })
        .then((response) => (response.ok ? response.json().then((state) => ({ control: true, ...state })) : { control: false }))
        .catch(() => ({ control: false }));
    }
    return controlScopeProbe;
  }

  const NOT_CONTROL = Object.freeze({
    ok: false, reason: 'read-only', revision: 0,
    message: 'This device is paired to watch, not to change settings. Pair it with the control code shown on the host.',
  });

  // Every config write this client makes. The host is the single writer and
  // applies exactly the same command registry it applies for the Electron
  // window, including the conflict and duplicate rules — a 409 is a refusal
  // with a typed body, which state.js acts on, not a transport error.
  async function postCommands(batch, meta) {
    const scope = await controlScope();
    if (!scope.control) return NOT_CONTROL;
    try {
      const response = await fetch('/api/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ commands: batch, ...meta }),
      });
      const body = await response.json().catch(() => null);
      if (body) return body;
      return { ok: false, reason: 'transport', revision: 0, message: `The host answered ${response.status}.` };
    } catch (e) {
      // Thrown, not returned: state.js re-queues the batch under the same id
      // and the host dedupes the retry if the first one did in fact land.
      throw new Error(`Could not reach the host: ${e.message}`);
    }
  }

  // A control client reads the unredacted-but-credential-stripped config, not
  // the viewer projection — an editor has to show and change real paths.
  // /api/control/config returns { config, revision } from one read, so a
  // client never stitches a config together with a revision from a different
  // instant (docs/design/05 §2.3).
  async function controlSnapshot() {
    const scope = await controlScope();
    if (!scope.control) {
      return fetch('/api/config', { cache: 'no-store' }).then((r) => r.json()).then((config) => ({ config, revision: 0 }));
    }
    return fetch('/api/control/config', { cache: 'no-store' }).then((r) => r.json());
  }

  // A control client's file pickers ask the HOST what is on its disks, since
  // there is no native dialog here and no view of those disks (docs/design/06
  // §5). control-picker.js is a module, so it is dynamic-imported the first
  // time somebody picks something rather than at parse time — this file is a
  // classic script by necessity (see the header).
  let pickerModule = null;
  async function pickHostPath(kind) {
    const scope = await controlScope();
    if (!scope.control) {
      console.warn(`[LAN viewer] choosing a ${kind} is a host action — this device is a read-only viewer.`);
      return null;
    }
    // Relative to THIS file, which is served from /js/ — so a sibling, not
    // './js/…', which would resolve to /js/js/ and 404.
    if (!pickerModule) pickerModule = import('./control-picker.js');
    const { pickHostPath: pick } = await pickerModule;
    return pick(kind);
  }

  let viewerUiScale = 'auto';
  function applyViewerUiScale() {
    const fit = Math.min(window.innerWidth / 1600, window.innerHeight / 900);
    const automatic = fit >= 2 ? 2 : fit >= 1.7 ? 1.75 : fit >= 1.45 ? 1.5 : fit >= 1.2 ? 1.25 : 1;
    const factor = ['100', '125', '150', '175', '200'].includes(viewerUiScale) ? Number(viewerUiScale) / 100 : automatic;
    document.body.style.zoom = String(factor);
    // Exposed so app CSS (guide.css's docked-mode height budget, currently
    // the only consumer) can compensate for this zoom instead of silently
    // squeezing — a fixed-px row height (like every other fixed-px size in
    // this app) grows right along with this zoom for readability, but a
    // flat percentage-of-screen height budget does NOT, so taller zoomed
    // rows fit fewer of themselves in the same unchanged budget. Native
    // Electron/desktop viewers never set this, so it's always 1 there via
    // the CSS var(--viewer-ui-scale, 1) fallback — zero effect off-viewer.
    document.documentElement.style.setProperty('--viewer-ui-scale', String(factor));
    document.body.style.width = (100 / factor) + '%';
    document.body.style.height = (100 / factor) + '%';
    const app = document.getElementById('app');
    if (app) {
      // Full-bleed — #app holds #display-frame (the actual TV picture), so
      // insetting it here would shrink the picture itself and leave a
      // permanent black border, not just protect UI chrome. See tokens.css's
      // android-tv-client comment for why an overscan-safe inset was tried
      // here before and removed.
      app.style.width = (window.innerWidth / factor) + 'px';
      app.style.height = (window.innerHeight / factor) + 'px';
      app.style.margin = '0px';
    }
  }
  window.addEventListener('resize', applyViewerUiScale);

  const browserApi = {
    // ---- Setup/editing actions: intentionally inert on a viewer. A
    // curious user opening Setup here can click around freely, but nothing
    // they do here ever reaches the host's real channels.json.
    getPathForFile: () => '',
    selectFolder: () => pickHostPath('folder'),
    selectImage: () => pickHostPath('image'),
    selectAudio: () => pickHostPath('audio'),
    selectVideo: () => pickHostPath('video'),
    // An executable or a stylesheet is something the host RUNS or LOADS, not
    // media it plays. Choosing one is an administrator's decision and stays at
    // the host window, so these keep refusing even for a control session.
    selectExecutable: readOnlyNoop('selectExecutable'),
    selectCss: readOnlyNoop('selectCss'),
    // Turning a chosen folder into a channel's files. The host walks its own
    // disk; this client only names the folder, which it got from the browser
    // above and which the host re-checks against its roots either way.
    scanFolder: async (source, folderRef) => {
      const scope = await controlScope();
      if (!scope.control) { console.warn('[LAN viewer] scanFolder() is a host action.'); return null; }
      // A plugin-sourced folder is the plugin's to walk, over IPC it has no
      // way to reach from here. Only local disk is browsable remotely.
      if (source && source !== 'local') { console.warn(`[control] ${source} folders can only be scanned on the host.`); return []; }
      const response = await fetch(`/api/control/scan?path=${encodeURIComponent(folderRef)}`, { cache: 'no-store' });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body || body.error) {
        console.warn('[control] folder scan failed:', (body && body.error) || response.status);
        return null;
      }
      return body.files;
    },
    probeDuration: readOnlyNoop('probeDuration'),
    // There is deliberately no whole-config write over the LAN: it would be
    // last-writer-wins across a whole household. `unsupported` tells state.js
    // to send its commands instead of trying to establish agreement this way
    // — it does not need to, having loaded its config from the host in the
    // first place. Import and restore, which genuinely need the whole object,
    // stay on the host (docs/design/06 §5).
    saveConfig: () => Promise.resolve({
      ok: false, reason: 'unsupported', revision: 0,
      message: 'Importing or restoring a whole config is done on the host.',
    }),
    applyConfigCommands: (batch, meta) => postCommands(batch, meta),
    getConfigRevision: () => controlScope().then((scope) => (Number.isInteger(scope.revision) ? scope.revision : 0)),
    getConfigSnapshot: () => controlSnapshot(),
    // The media library over the LAN, for a control session. Same { ok, result
    // | error } shape as the host window's IPC, so the Library screen treats
    // both identically. A viewer is refused before anything is sent.
    libraryCall: async (method, payload) => {
      const scope = await controlScope();
      if (!scope.control) return { ok: false, error: 'This device is paired to watch, not to change the library.' };
      try {
        const response = await fetch(`/api/control/library/${encodeURIComponent(method)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', body: JSON.stringify(payload || {}),
        });
        return (await response.json().catch(() => null)) || { ok: false, error: `The host answered ${response.status}.` };
      } catch (e) {
        return { ok: false, error: `Could not reach the host: ${e.message}` };
      }
    },
    personalCall: async (method, payload) => {
      const administrative = new Set(['createProfile', 'updateProfile', 'deleteProfile']);
      const route = administrative.has(method) ? '/api/control/personal/' : '/api/personal/';
      if (administrative.has(method)) {
        const scope = await controlScope();
        if (!scope.control) return { ok: false, error: 'This device is paired to watch, not to manage household profiles.' };
      }
      try {
        const response = await fetch(`${route}${encodeURIComponent(method)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', body: JSON.stringify(payload || {}),
        });
        return (await response.json().catch(() => null)) || { ok: false, error: `The host answered ${response.status}.` };
      } catch (e) {
        return { ok: false, error: `Could not reach the host: ${e.message}` };
      }
    },
    // Commands the host applied, for a control session only — the route drops
    // these for a view session, because they carry real config values. This is
    // the same update the Electron window gets on config:applied, so state.js
    // reconciles identically on both.
    onConfigApplied: (callback) => onViewerEvent('config:applied', callback),
    onConfigChanged: (callback) => onViewerEvent('config:changed', callback),
    onPersonalChanged: (callback) => onViewerEvent('personal:changed', callback),
    onClientHandoff: (callback) => onViewerEvent('client:handoff', callback),
    onSharedSessionChanged: (callback) => onViewerEvent('session:changed', callback),
    exportConfig: readOnlyNoop('exportConfig'),
    importConfig: readOnlyNoop('importConfig'),
    openPrintableManual: readOnlyNoop('openPrintableManual'),
    // A viewer has no host filesystem access and must never rewrite the
    // host's real channels.json from a backup — both stay host-only.
    checkPathsExist: readOnlyNoop('checkPathsExist'),
    listBackups: () => Promise.resolve([]),
    previewBackup: readOnlyNoop('previewBackup'),
    restoreBackup: readOnlyNoop('restoreBackup'),
    deleteBackup: readOnlyNoop('deleteBackup'),
    setBackupLabel: readOnlyNoop('setBackupLabel'),
    setBackupPinned: readOnlyNoop('setBackupPinned'),
    createBackupNow: readOnlyNoop('createBackupNow'),

    // ---- Config / media: the real read path a viewer needs. A control client
    // gets the same object its snapshot carries — real paths, no credentials —
    // because the setup shell has to show and edit what is actually on the
    // host, not opaque `viewer:` refs.
    loadConfig: () => (window.__controlClient
      ? controlSnapshot().then((snapshot) => snapshot.config)
      : fetch('/api/config').then((r) => r.json())),
    getAppVersion: () => fetch('/api/version').then((r) => r.json()).then((data) => data.version),
    pluginsList: () => fetch('/api/plugins').then((r) => r.json()),
    getDiagnostics: () => Promise.resolve({ app: { platform: 'viewer' }, plugins: [], services: [], logs: [] }),
    exportDiagnostics: () => Promise.resolve({ cancelled: true }),
    pluginsOpenFolder: readOnlyNoop('pluginsOpenFolder'),
    pluginsSetEnabled: readOnlyNoop('pluginsSetEnabled'),
    pluginsInstallFromZip: () => Promise.resolve({ cancelled: true }),
    pluginsApproveCapabilities: readOnlyNoop('pluginsApproveCapabilities'),
    pluginsRevokeCapabilities: readOnlyNoop('pluginsRevokeCapabilities'),
    pluginsApproveIntegrity: readOnlyNoop('pluginsApproveIntegrity'),
    pluginsUninstall: () => Promise.resolve({ success: false, error: 'Plugins can only be uninstalled on the host device' }),
    listMediaSourceProviders: () => Promise.resolve([]),
    callMediaSourceHook: () => Promise.resolve(null),
    // The projected viewer config contains process-scoped `viewer:<id>`
    // references, never host filesystem paths/provider refs. The authenticated
    // /media endpoint resolves that id server-side and rejects raw paths.
    toFileUrl: (filePath) => {
      const match = /^viewer:([A-Za-z0-9_-]+)$/.exec(String(filePath || ''));
      return Promise.resolve(match ? `/media?id=${encodeURIComponent(match[1])}` : '');
    },
    basename: (filePath) => {
      const opaque = /^viewer:([A-Za-z0-9_-]+)$/.exec(String(filePath || ''));
      if (opaque) return fetch(`/api/media-name?id=${encodeURIComponent(opaque[1])}`).then((r) => r.json()).then((data) => data.name || 'media');
      const name = String(filePath).split(/[\\/]/).pop() || '';
      const dot = name.lastIndexOf('.');
      return Promise.resolve(dot > 0 ? name.slice(0, dot) : name);
    },
    // Transcoding mutates the source file on disk via a backup-swap dance
    // (see main.js's media:transcode) that must never run from two
    // processes at once — stays host-only. Reporting every file as
    // "already fixed" means a genuinely broken file on a viewer surfaces
    // the existing PLAYBACK ERROR/OFF THE AIR card (handleUnplayable,
    // playback.js) instead of attempting a fix here.
    resolvePlayablePath: (source, filePath) => Promise.resolve({ path: filePath, alreadyFixed: true }),
    transcode: () => Promise.reject(new Error('Transcoding only runs on the host device')),

    // ---- Fullscreen: the real browser API instead of an Electron window
    // call. On a touch device (phone/tablet), also try to lock the screen
    // to landscape — the natural "watching TV" orientation — right after
    // fullscreen is granted, since most implementations of the Screen
    // Orientation API require the document to already be fullscreen before
    // allowing a lock. This is the one-tap "landscape mode" entry point
    // (the FULLSCREEN button in touch-controls.js's control bar sends 'f',
    // routed here the same way the existing keyboard shortcut already is).
    // Unlocking on exit isn't done explicitly — leaving fullscreen already
    // releases any orientation lock per spec. Gracefully unsupported on
    // iOS Safari (no Screen Orientation API at all as of this writing) —
    // the underlying page layout is already fluid/responsive regardless
    // (see index.html's viewport meta tag), so a physical rotation still
    // works fine there even without the lock.
    toggleFullscreen: () => {
      if (document.fullscreenElement) {
        if (screen.orientation && screen.orientation.unlock) {
          try { screen.orientation.unlock(); } catch (e) {}
        }
        return document.exitFullscreen().then(() => false).catch(() => false);
      }
      return document.documentElement.requestFullscreen().then(() => {
        if (screen.orientation && screen.orientation.lock) {
          screen.orientation.lock('landscape').catch(() => {});
        }
        return true;
      }).catch(() => false);
    },

    // App-wide display mode's "lock window" mode (display-mode.js) locks a
    // real Electron BrowserWindow's aspect ratio — meaningless for a browser
    // tab, which the letterbox/pillarbox CSS already handles regardless. A
    // no-op here just means a viewer never attempts the OS-window lock.
    setAspectLock: () => Promise.resolve(false),
    // quitApp is host-only in the contract and deliberately absent here: a
    // browser tab can't close the application, TV mode's exit prompt leaves
    // EXIT out for a viewer (tv/input.js exitCapability), and the Android
    // client exits through AndroidRemoteBridge.exitApp instead.
    // CSS zoom scales all chrome in Chromium/WebView, with a compensating
    // layout canvas so the TV picture continues to fill its viewport.
    setUiScale: (preference) => {
      viewerUiScale = String(preference || 'auto');
      applyViewerUiScale();
      window.dispatchEvent(new Event('resize'));
      return Promise.resolve(viewerUiScale);
    },

    // ---- Universal remote relay: a viewer has its own direct keyboard/
    // D-pad input, so it doesn't need the phone-remote's command relay in
    // the other direction (this viewer receiving commands). sendRemoteState
    // is different — every tuneToChannel call already invokes it (see
    // playback.js), and the Android TV wrapper listens for exactly that:
    // window.AndroidRemoteBridge only exists there (MainActivity.kt's
    // addJavascriptInterface), never in a plain browser, so this is a safe
    // no-op everywhere else. Forwarding it is what lets that app's own
    // embedded phone-remote server (RemoteServer.kt) answer /state with the
    // real current channel instead of always reporting nothing.
    onRemoteCommand: (callback) => onViewerEvent('remote:command', callback),
    sendRemoteState: (state) => {
      if (window.AndroidRemoteBridge && window.AndroidRemoteBridge.reportState) {
        try { window.AndroidRemoteBridge.reportState(JSON.stringify(state)); } catch (e) {}
      }
      fetch('/api/remote-state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      }).catch(() => {});
    },
    // Host-only visibility readout — a viewer has no LAN servers of its own
    // to report connections for.
    getConnectedDevices: () => Promise.resolve([]),
    // Android companion remote's direct-tune/channel-flag-edit relays (see
    // main.js's startRemoteServer) — host-only, same no-op reasoning as
    // onRemoteCommand above (a viewer already has its own direct input).
    onRemoteTune: (callback) => onViewerEvent('remote:tune', callback),
    onRemoteSetChannelFlag: (callback) => onViewerEvent('remote:setChannelFlag', callback),
    onCompanionConfigChanged: (callback) => onViewerEvent('companion:configChanged', callback),
    // Companion app's ALERTS section (REMOTE tab) — these were missing
    // entirely here, so app.js's own `window.api.onCompanionTriggerNews?.()`
    // / `onCompanionSetTicker?.()` calls silently no-op'd on any LAN viewer,
    // including headless/server mode where a viewer is the only display.
    onCompanionTriggerNews: (callback) => onViewerEvent('companion:triggerNews', callback),
    onCompanionSetTicker: (callback) => onViewerEvent('companion:setTicker', callback),

    // ---- Party channel (party-channel plugin): a viewer tuning to PARTY_CH renders
    // the exact same queue-driven UI as the host (pure function of
    // S.partyQueue/S.partyCurrentItem, nothing viewer-specific about it),
    // but the guest-post/announce/soundboard relays themselves are
    // host-only — only the host process's LAN party server (main.js)
    // receives those, so a viewer would just never see these fire.
    onPartyPost: () => {},
    onPartyAnnounce: () => {},
    onPartyNews: () => {},
    onPartyBingo: () => {},
    onPartySoundboardPlay: () => {},
    onPartyEffect: () => {},
    onPartyCheckin: () => {},
    onPartyVote: () => {},
    // Unlike the other onParty* relays above, reaction/trigger-trivia are
    // also reachable in headless/server mode (main-viewer-server.js's
    // VIEWER_REMOTE_CHANNELS whitelists them) — there's no mainWindow at
    // all in that mode, so a paired LAN viewer is the only display that
    // could ever show these; party-channel/renderer.js already calls
    // window.api.onPartyReaction/onPartyTriggerTrivia when present.
    onPartyReaction: (callback) => onViewerEvent('party:reaction', callback),
    sendPartyVoteState: () => {},
    captureVideoFrame: () => Promise.resolve(null),
    onPartyCaption: () => {},
    sendPartyTriviaState: () => {},
    onPartyTriviaAnswer: () => {},
    onPartyTriggerTrivia: (callback) => onViewerEvent('party:triggerTrivia', callback),
    spotifyStart: () => Promise.resolve(false),
    spotifyStop: () => Promise.resolve(false),
    spotifyGetStreamUrl: () => Promise.resolve(''),
    onSpotifyStatus: () => {},
    onSpotifyEvent: () => {},
    youtubeSearch: () => Promise.resolve({ results: [], error: 'Online audio search only runs on the host device' }),
    youtubePlay: () => Promise.reject(new Error('Online audio playback only runs on the host device')),
    youtubeStop: () => Promise.resolve(false),
    onYoutubeStatus: () => {},
    sendPartyJukeboxState: () => {},
    onPartyJukeboxAdd: () => {},
    onPartyJukeboxSkipVote: () => {},
    onPartyJukeboxFun: () => {},
    videoSplicerLaunch: readOnlyNoop('videoSplicerLaunch'),
    // AUX capture is inherently host-only — a viewer has no desktop of its
    // own to offer as a capture source.
    listDesktopSources: () => Promise.resolve([]),
    sendPartyQueueState: () => {},
    getPartyJoinInfo: () => Promise.resolve({ url: '', qrDataUrl: '', pairingCode: '' }),
    // A viewer opening its own Setup screen has nothing meaningful to show
    // here either — it's not itself reachable as a further "watch on other
    // devices" source, that's the host's role.
    getViewerUrl: () => Promise.resolve([]),
    // TV clients (docs/design/01): the host writes the capture and builds the
    // handoff QR; this viewer is often the Android TV client itself.
    saveRemoteProfile: (profile) => fetch('/api/remote-profile', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(profile),
    }).then((r) => r.json()).catch((e) => ({ ok: false, error: e.message })),
    getHandoffInfo: () => fetch('/api/handoff-info').then((r) => r.json()).catch(() => ({ url: '', qrDataUrl: '', label: '' })),

    // ---- TMDB metadata / NOAA alerts: both go through main.js's fetch+
    // cache helper on the host, not something a viewer can reach on its own.
    // Empty-but-well-shaped results so setup-panels.js/eas.js's normal
    // destructuring (`{ results }`, `{ cast }`, `{ alerts }`) never throws
    // here — a viewer just sees "no results" rather than a broken button,
    // and eas.js's NOAA poll loop (which runs on every tuneToChannel, same
    // as on the host) silently no-ops instead of erroring on every tune.
    tmdbSearch: () => Promise.resolve({ results: [], error: 'TMDB lookups only run on the host device' }),
    tmdbGetCredits: () => Promise.resolve({ cast: [] }),
    captionsScanForFile: () => Promise.resolve({ tracks: [] }),
    captionsExtractTrack: () => Promise.resolve({ error: 'Caption extraction only runs on the host device' }),
    noaaGetActiveAlerts: () => Promise.resolve({ alerts: [] }),
    noaaGetForecast: () => Promise.resolve({ periods: [] }),
  };
  window.api = contract.createApiSurface(browserApi, 'viewer');
})();
