// Canonical window.api descriptor used to generate the LAN viewer shim and
// to verify Electron's sandboxed preload in tests/ui/contracts.test.js. Sandboxed
// preload cannot require local files, so its exact surface is enforced by the
// permanent parity test rather than importing this file at runtime.
(function installApiContract(root) {
  const viewerMethods = [
    'getPathForFile', 'getAppVersion', 'selectFolder', 'selectImage', 'selectAudio', 'selectVideo',
    'selectExecutable', 'selectCss', 'scanFolder', 'checkPathsExist', 'probeDuration', 'listBackups', 'previewBackup',
    'restoreBackup', 'deleteBackup', 'setBackupLabel', 'setBackupPinned', 'createBackupNow', 'loadConfig', 'saveConfig', 'applyConfigCommands', 'getConfigSnapshot', 'libraryCall', 'personalCall', 'getConfigRevision', 'onConfigApplied', 'onConfigChanged', 'onPersonalChanged', 'onClientHandoff', 'onSharedSessionChanged',
    'exportConfig', 'openPrintableManual', 'importConfig', 'toFileUrl', 'basename', 'resolvePlayablePath',
    'transcode', 'toggleFullscreen', 'setAspectLock', 'setUiScale', 'onCompanionConfigChanged', 'onRemoteCommand', 'sendRemoteState',
    // The Companion app's ALERTS relays have to stay viewer-facing: in
    // headless/server mode there is no host window at all, so a paired LAN
    // viewer is the only display that could ever show them, and
    // main/lan/viewer-server.js publishes both on the viewer event bus for
    // exactly that reason. They were listed host-only while the shim
    // implemented them, so createApiSurface dropped the implementations and
    // app.js's optional calls went on quietly doing nothing.
    'onCompanionTriggerNews', 'onCompanionSetTicker',
    'getConnectedDevices', 'onRemoteTune', 'onRemoteSetChannelFlag', 'onPartyTriggerTrivia', 'onPartyPost',
    'onPartyAnnounce', 'onPartyNews', 'onPartyBingo', 'onPartySoundboardPlay', 'onPartyEffect',
    'onPartyCheckin', 'onPartyVote', 'onPartyReaction', 'sendPartyVoteState', 'captureVideoFrame',
    'onPartyCaption', 'sendPartyTriviaState', 'onPartyTriviaAnswer', 'listDesktopSources',
    'spotifyStart', 'spotifyStop', 'spotifyGetStreamUrl', 'onSpotifyStatus', 'onSpotifyEvent',
    'youtubeSearch', 'youtubePlay', 'youtubeStop', 'onYoutubeStatus',
    'sendPartyJukeboxState', 'onPartyJukeboxAdd', 'onPartyJukeboxSkipVote', 'onPartyJukeboxFun',
    'videoSplicerLaunch',
    'sendPartyQueueState', 'getPartyJoinInfo', 'getViewerUrl', 'saveRemoteProfile', 'getHandoffInfo', 'tmdbSearch', 'tmdbGetCredits',
    'captionsScanForFile', 'captionsExtractTrack', 'noaaGetActiveAlerts', 'noaaGetForecast', 'pluginsList', 'getDiagnostics', 'exportDiagnostics',
    'pluginsOpenFolder', 'pluginsSetEnabled', 'pluginsInstallFromZip', 'pluginsApproveCapabilities',
    'pluginsRevokeCapabilities', 'pluginsApproveIntegrity', 'pluginsUninstall', 'listMediaSourceProviders',
    'callMediaSourceHook',
  ];
  const hostOnlyMethods = [
    // Host-only because a browser tab genuinely cannot do them, not merely
    // because they are inconvenient there. A tab cannot close the application
    // (TV mode's exit prompt drops EXIT for a viewer — tv/input.js's
    // exitCapability), and both music-choice calls read the HOST filesystem.
    // These three were listed as viewer methods while the shim defined
    // quitApp as null and the music-choice pair not at all, so
    // createApiSurface threw and a LAN browser ended up with no window.api at
    // all. tests/api-surface.test.js keeps the two lists honest now.
    'quitApp', 'musicChoiceScanFolder', 'musicChoiceEmbeddedArt',
    'checkForUpdates', 'onUpdateStatus', 'installUpdateNow', 'getReleaseNotes',
    'getStartupServerStatus', 'setStartupServerEnabled', 'getStartupWindowStatus', 'setStartupWindowEnabled',
    // The control pairing code must never reach a `view`-scope viewer — that
    // would let a read-only session learn its way to a writable one. Host
    // window only, unlike getViewerUrl (the view code) just above it in
    // viewerMethods, which is fine for a viewer to see.
    'getViewerControlUrl',
    'getPostUpdateNotice', 'acknowledgePostUpdateNotice', 'onFullscreenChange', 'onCecKey',
    'setTitleBarHidden', 'reportThemeColors', 'reportInstalledThemes',
    'listScreens', 'setPreferredScreen', 'onScreenChange', 'onScreenPower',
    // Host-only: ffmpeg measures files on the host's own disk.
    'getLoudness', 'prefetchLoudness', 'cancelLoudnessPrefetch', 'getLoudnessStatus',
    'setKeepDisplayAwake', 'showSystemNotification',
    'historyAppend', 'historyList', 'historyClear',
    'onCompanionApplySettings', 'getCompanionUrl',
    'downloadMediaFile', 'onMediaDownloadProgress',
    'castScan', 'castConnect', 'castDisconnect', 'castNow', 'castStop', 'castSetVolume',
    'castListMirrorSources', 'castPrepareMirrorCapture', 'castMirrorChunk', 'castStartMirror', 'castStopMirror',
    'castSetAutoSync', 'castSetNowPlaying', 'castGetStatus', 'onCastStatus',
    // Host-only: recording reads the real source files and spawns ffmpeg on
    // the machine running RerunTV. A LAN viewer has neither, so the tape
    // deck's channel degrades to "recording is unavailable here" there
    // rather than getting a shim that could not work.
    'tapesRecord', 'tapesStatus', 'tapesCancel', 'tapesList', 'tapesReadDisc', 'tapesSetArt', 'tapesDelete',
    'tapesImport', 'onTapesProgress', 'onTapesDone',
    'makemkvStatus', 'makemkvListTitles', 'makemkvRip', 'makemkvJobs', 'makemkvCancel',
    'onMakemkvProgress', 'onMakemkvDone',
    // Host-only: downloads and writes a real ffmpeg binary to disk on the
    // machine running RerunTV — nothing a LAN viewer could meaningfully do.
    'ffmpegInstallCheck', 'ffmpegInstall', 'onFfmpegInstallProgress',
  ];
  const methods = Object.freeze(Object.fromEntries([
    ...viewerMethods.map((name) => [name, Object.freeze({ viewer: 'custom' })]),
    ...hostOnlyMethods.map((name) => [name, Object.freeze({ viewer: 'host-only' })]),
  ]));

  function createApiSurface(implementations, target) {
    const api = {};
    Object.entries(methods).forEach(([name, descriptor]) => {
      if (target === 'viewer' && descriptor.viewer === 'host-only') return;
      if (typeof implementations[name] !== 'function') {
        throw new Error(`${target} window.api is missing contract method "${name}"`);
      }
      api[name] = implementations[name];
    });
    const extras = Object.keys(implementations).filter((name) => !methods[name]);
    if (extras.length) throw new Error(`${target} window.api has methods outside the contract: ${extras.join(', ')}`);
    return Object.freeze(api);
  }

  const contract = Object.freeze({ methods, createApiSurface });
  if (typeof module !== 'undefined' && module.exports) module.exports = contract;
  else {
    root.RCBApiContract = contract;
    if (root.window && root.window !== root) root.window.RCBApiContract = contract;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
