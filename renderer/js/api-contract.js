// Canonical window.api descriptor used to generate the LAN viewer shim and
// to verify Electron's sandboxed preload in test/contracts.test.js. Sandboxed
// preload cannot require local files, so its exact surface is enforced by the
// permanent parity test rather than importing this file at runtime.
(function installApiContract(root) {
  const viewerMethods = [
    'getPathForFile', 'getAppVersion', 'selectFolder', 'selectImage', 'selectAudio', 'selectVideo',
    'selectExecutable', 'selectCss', 'scanFolder', 'checkPathsExist', 'probeDuration', 'listBackups', 'previewBackup',
    'restoreBackup', 'deleteBackup', 'setBackupLabel', 'setBackupPinned', 'createBackupNow', 'loadConfig', 'saveConfig',
    'exportConfig', 'openPrintableManual', 'importConfig', 'toFileUrl', 'basename', 'resolvePlayablePath',
    'transcode', 'toggleFullscreen', 'setAspectLock', 'setUiScale', 'onCompanionConfigChanged', 'onRemoteCommand', 'sendRemoteState',
    'getConnectedDevices', 'onRemoteTune', 'onRemoteSetChannelFlag', 'onPartyTriggerTrivia', 'onPartyPost',
    'onPartyAnnounce', 'onPartyNews', 'onPartyBingo', 'onPartySoundboardPlay', 'onPartyEffect',
    'onPartyCheckin', 'onPartyVote', 'onPartyReaction', 'sendPartyVoteState', 'captureVideoFrame',
    'onPartyCaption', 'sendPartyTriviaState', 'onPartyTriviaAnswer', 'listDesktopSources',
    'spotifyStart', 'spotifyStop', 'spotifyGetStreamUrl', 'onSpotifyStatus', 'onSpotifyEvent',
    'youtubeSearch', 'youtubePlay', 'youtubeStop', 'onYoutubeStatus', 'musicChoiceScanFolder', 'musicChoiceEmbeddedArt',
    'sendPartyJukeboxState', 'onPartyJukeboxAdd', 'onPartyJukeboxSkipVote', 'onPartyJukeboxFun',
    'videoSplicerLaunch',
    'sendPartyQueueState', 'getPartyJoinInfo', 'getViewerUrl', 'tmdbSearch', 'tmdbGetCredits',
    'captionsScanForFile', 'captionsExtractTrack', 'noaaGetActiveAlerts', 'noaaGetForecast', 'pluginsList', 'getDiagnostics', 'exportDiagnostics',
    'pluginsOpenFolder', 'pluginsSetEnabled', 'pluginsInstallFromZip', 'pluginsApproveCapabilities',
    'pluginsRevokeCapabilities', 'pluginsApproveIntegrity', 'pluginsUninstall', 'listMediaSourceProviders',
    'callMediaSourceHook',
  ];
  const hostOnlyMethods = [
    'checkForUpdates', 'onUpdateStatus', 'installUpdateNow', 'getReleaseNotes',
    'getStartupServerStatus', 'setStartupServerEnabled',
    'getPostUpdateNotice', 'acknowledgePostUpdateNotice', 'onFullscreenChange',
    'setTitleBarHidden', 'reportThemeColors', 'reportInstalledThemes',
    'setKeepDisplayAwake', 'showSystemNotification',
    'historyAppend', 'historyList', 'historyClear',
    'onCompanionApplySettings', 'getCompanionUrl', 'onCompanionTriggerNews',
    'onCompanionSetTicker', 'downloadMediaFile', 'onMediaDownloadProgress',
    'castScan', 'castConnect', 'castDisconnect', 'castNow', 'castStop', 'castSetVolume',
    'castListMirrorSources', 'castPrepareMirrorCapture', 'castMirrorChunk', 'castStartMirror', 'castStopMirror',
    'castSetAutoSync', 'castSetNowPlaying', 'castGetStatus', 'onCastStatus',
    // Host-only: recording reads the real source files and spawns ffmpeg on
    // the machine running RerunTV. A LAN viewer has neither, so the tape
    // deck's channel degrades to "recording is unavailable here" there
    // rather than getting a shim that could not work.
    'tapesRecord', 'tapesStatus', 'tapesCancel', 'tapesList', 'tapesReadDisc', 'tapesSetArt', 'tapesDelete',
    'onTapesProgress', 'onTapesDone',
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
