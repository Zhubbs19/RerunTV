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

  function readOnlyNoop(label) {
    return (...args) => {
      console.warn(`[LAN viewer] ${label}() is a no-op here — this device is a read-only viewer. Make this change on the host instead.`);
      return Promise.resolve(null);
    };
  }

  const browserApi = {
    // ---- Setup/editing actions: intentionally inert on a viewer. A
    // curious user opening Setup here can click around freely, but nothing
    // they do here ever reaches the host's real channels.json.
    getPathForFile: () => '',
    selectFolder: readOnlyNoop('selectFolder'),
    selectImage: readOnlyNoop('selectImage'),
    selectAudio: readOnlyNoop('selectAudio'),
    selectVideo: readOnlyNoop('selectVideo'),
    selectExecutable: readOnlyNoop('selectExecutable'),
    selectCss: readOnlyNoop('selectCss'),
    scanFolder: readOnlyNoop('scanFolder'),
    probeDuration: readOnlyNoop('probeDuration'),
    saveConfig: readOnlyNoop('saveConfig'),
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

    // ---- Config / media: the real read path a viewer needs.
    loadConfig: () => fetch('/api/config').then((r) => r.json()),
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
    onRemoteCommand: () => {},
    sendRemoteState: (state) => {
      if (window.AndroidRemoteBridge && window.AndroidRemoteBridge.reportState) {
        try { window.AndroidRemoteBridge.reportState(JSON.stringify(state)); } catch (e) {}
      }
    },
    getRemoteUrl: () => Promise.resolve([]),
    // Host-only visibility readout — a viewer has no LAN servers of its own
    // to report connections for.
    getConnectedDevices: () => Promise.resolve([]),
    // Android companion remote's direct-tune/channel-flag-edit relays (see
    // main.js's startRemoteServer) — host-only, same no-op reasoning as
    // onRemoteCommand above (a viewer already has its own direct input).
    onRemoteTune: () => {},
    onRemoteSetChannelFlag: () => {},

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
    onPartyReaction: () => {},
    sendPartyVoteState: () => {},
    captureVideoFrame: () => Promise.resolve(null),
    onPartyCaption: () => {},
    sendPartyTriviaState: () => {},
    onPartyTriviaAnswer: () => {},
    onPartyTriggerTrivia: () => {},
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
