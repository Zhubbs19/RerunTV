const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Sandboxed renderers can't read a dropped File object's real filesystem
  // path directly (File.path was removed) — webUtils.getPathForFile is the
  // replacement, but it only exists in the preload/main-world context, so
  // OS drag-and-drop (setup-dragdrop.js) has to bounce through here instead
  // of reading File objects straight off the DragEvent itself.
  getPathForFile: (file) => webUtils.getPathForFile(file),
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
  // 'dev-mode' (running from source, nothing to check against), 'up-to-date',
  // 'downloading' (found one, autoUpdater is fetching it now), 'disabled'
  // (config.updates.strategy is 'off'), or 'error'. Once a 'downloading' result
  // actually finishes, onUpdateStatus below fires separately — see
  // main-updater.js and renderer/js/update-notice.js.
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  // {state: 'downloaded', version, showPopup}; background-notify and manual
  // checks show the toast, while background-auto installs on normal quit.
  onUpdateStatus: (cb) => ipcRenderer.on('updates:status', (event, status) => cb(status)),
  installUpdateNow: () => ipcRenderer.invoke('updates:installNow'),
  // Live GitHub Releases feed for the HELP tab's RELEASE NOTES panel — see
  // main-updater.js's registerReleaseNotesHandler.
  getReleaseNotes: () => ipcRenderer.invoke('updates:getReleaseNotes'),
  // One-shot changelog shown after the installed app version changes. The
  // main process persists the old/new versions and downloaded release notes
  // across quitAndInstall(), so this remains available after an offline
  // restart and is acknowledged only after the user dismisses it.
  getPostUpdateNotice: () => ipcRenderer.invoke('updates:getPostUpdateNotice'),
  acknowledgePostUpdateNotice: (version) => ipcRenderer.invoke('updates:acknowledgePostUpdateNotice', version),
  // Fire-and-forget: lets the frameless update-progress popup (main-updater.js,
  // a separate BrowserWindow with no access to the renderer's CSS at all)
  // re-skin to match the active theme instead of always showing its hardcoded
  // fallback palette. `colors` is a plain {cssVarName: value} map of core's
  // palette custom properties (--ink/--gold/--cyan/etc, resolved live off
  // <html>) — see themes.js.
  reportThemeColors: (colors) => ipcRenderer.send('theme:colors', colors),
  selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
  selectImage: () => ipcRenderer.invoke('dialog:selectImage'),
  selectAudio: () => ipcRenderer.invoke('dialog:selectAudio'),
  selectVideo: () => ipcRenderer.invoke('dialog:selectVideo'),
  selectExecutable: () => ipcRenderer.invoke('dialog:selectExecutable'),
  selectCss: () => ipcRenderer.invoke('dialog:selectCss'),
  // (source, ref) ordering matches resolvePlayablePath/transcode/
  // probeDuration below — source always leads. Every call site passes both
  // explicitly now (see main-media-dispatch.js for what a non-'local'
  // source dispatches to); `source` still defaults to 'local' here only as
  // a last-resort guard against a stray one-arg call, not as a supported
  // calling convention.
  scanFolder: (source, ref) => ipcRenderer.invoke('fs:scanFolder', source || 'local', ref),
  // `entries` is [{source, ref}].
  checkPathsExist: (entries) => ipcRenderer.invoke('fs:checkPathsExist', entries),
  probeDuration: (source, ref) => ipcRenderer.invoke('media:probeDuration', source, ref),
  // Rotating config backups (see main.js) — listBackups for the setup
  // screen's BACKUPS panel, restoreBackup to roll the live config back to a
  // previous snapshot.
  listBackups: () => ipcRenderer.invoke('backups:list'),
  previewBackup: (file) => ipcRenderer.invoke('backups:preview', file),
  restoreBackup: (file) => ipcRenderer.invoke('backups:restore', file),
  deleteBackup: (file) => ipcRenderer.invoke('backups:delete', file),
  setBackupLabel: (file, label) => ipcRenderer.invoke('backups:setLabel', file, label),
  setBackupPinned: (file, pinned) => ipcRenderer.invoke('backups:setPinned', file, pinned),
  createBackupNow: () => ipcRenderer.invoke('backups:createNow'),
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  exportConfig: (config, suggestedName) => ipcRenderer.invoke('config:export', config, suggestedName),
  openPrintableManual: (html) => ipcRenderer.invoke('manual:openPrintable', html),
  importConfig: () => ipcRenderer.invoke('config:import'),
  toFileUrl: (filePath) => ipcRenderer.invoke('path:toFileUrl', filePath),
  basename: (filePath) => ipcRenderer.invoke('path:basename', filePath),
  resolvePlayablePath: (source, filePath) => ipcRenderer.invoke('media:resolvePlayablePath', source, filePath),
  transcode: (source, filePath) => ipcRenderer.invoke('media:transcode', source, filePath),
  toggleFullscreen: () => ipcRenderer.invoke('window:toggleFullscreen'),
  // App-wide display mode's "lock window" mode (display-mode.js) — locks/
  // unlocks the real OS window's aspect ratio. aspect: null clears the lock.
  setAspectLock: (aspect) => ipcRenderer.invoke('window:setAspectLock', { aspect }),
  // Fires for every fullscreen enter/exit, not just the F-key toggle above —
  // see main.js's enter-full-screen/leave-full-screen listeners — so the
  // renderer's hint-bar-hiding stays correct even when fullscreen is
  // triggered by an OS-level control instead of the app's own shortcut.
  onFullscreenChange: (cb) => ipcRenderer.on('window:fullscreenChanged', (event, isFullscreen) => cb(isFullscreen)),
  // Companion app (phone-browser remote + Android app; remote control,
  // Settings, Files, all one plugin/port now — see plugins/companion-app/
  // main.js). onRemoteCommand fires for every button press relayed from the
  // phone; sendRemoteState is the renderer's other half, talking back
  // (current-channel readout).
  onRemoteCommand: (cb) => ipcRenderer.on('remote:command', (event, cmd) => cb(cmd)),
  sendRemoteState: (state) => ipcRenderer.send('remote:state', state),
  // Host-visibility readout of who's currently polling the companion/viewer/
  // party LAN servers — see main.js's trackConnection/getConnectedDevices.
  getConnectedDevices: () => ipcRenderer.invoke('network:getConnections'),
  // Companion app's direct-tune and channel-flag-editor actions (see
  // plugins/companion-app/main.js's POST /tune and POST /channel/flag).
  onRemoteTune: (cb) => ipcRenderer.on('remote:tune', (event, data) => cb(data)),
  onRemoteSetChannelFlag: (cb) => ipcRenderer.on('remote:setChannelFlag', (event, data) => cb(data)),
  // Companion app's TRIGGER TRIVIA button (see plugins/companion-app/
  // main.js's POST /party/trivia/start) — same relay pattern as the other
  // onRemote*/onParty* listeners above.
  onPartyTriggerTrivia: (cb) => ipcRenderer.on('party:triggerTrivia', () => cb()),
  // Companion app's Settings tab — see plugins/companion-app/main.js's
  // POST /api/settings. onCompanionApplySettings fires with a
  // {sectionKey: {...nested values...}} patch, recursively merged into
  // matching S.config keys (app.js's deepMergeExistingKeys);
  // getCompanionUrl is the setup panel's half, mirroring getViewerUrl.
  onCompanionApplySettings: (cb) => ipcRenderer.on('companion:applySettings', (event, patch) => cb(patch)),
  getCompanionUrl: () => ipcRenderer.invoke('companion:getUrl'),
  // Party channel (party.js) — the LAN party page's guest actions (see
  // plugins/party-channel/main.js's startPartyServer) arrive here the same way remote commands do.
  // getPartyJoinInfo returns {url, qrDataUrl, pairingCode} for the idle screen/setup
  // panel; sendPartyQueueState is the renderer's half going back the other
  // way, cached in main so the party page's GET /queue has something to poll.
  onPartyPost: (cb) => ipcRenderer.on('party:post', (event, data) => cb(data)),
  onPartyAnnounce: (cb) => ipcRenderer.on('party:announce', (event, data) => cb(data)),
  onPartyNews: (cb) => ipcRenderer.on('party:news', (event, data) => cb(data)),
  onPartyBingo: (cb) => ipcRenderer.on('party:bingo', (event, data) => cb(data)),
  onPartySoundboardPlay: (cb) => ipcRenderer.on('party:soundboardPlay', (event, data) => cb(data)),
  onPartyEffect: (cb) => ipcRenderer.on('party:effect', (event, data) => cb(data)),
  onPartyCheckin: (cb) => ipcRenderer.on('party:checkin', (event, data) => cb(data)),
  onPartyVote: (cb) => ipcRenderer.on('party:vote', (event, data) => cb(data)),
  onPartyReaction: (cb) => ipcRenderer.on('party:reaction', (event, data) => cb(data)),
  sendPartyVoteState: (tally) => ipcRenderer.send('party:voteState', tally),
  captureVideoFrame: (filePath, timeSeconds) => ipcRenderer.invoke('party:captureVideoFrame', { filePath, timeSeconds }),
  onPartyCaption: (cb) => ipcRenderer.on('party:caption', (event, data) => cb(data)),
  sendPartyTriviaState: (state) => ipcRenderer.send('party:triviaState', state),
  onPartyTriviaAnswer: (cb) => ipcRenderer.on('party:triviaAnswer', (event, data) => cb(data)),
  // Optional audio-channel plugins. These are intentionally narrow named
  // bridges rather than an arbitrary IPC passthrough; each matching main
  // plugin still has to declare and receive approval for its channels.
  spotifyStart: (opts) => ipcRenderer.invoke('spotify:start', opts),
  spotifyStop: () => ipcRenderer.invoke('spotify:stop'),
  spotifyGetStreamUrl: () => ipcRenderer.invoke('spotify:getStreamUrl'),
  onSpotifyStatus: (cb) => ipcRenderer.on('spotify:status', (event, data) => cb(data)),
  onSpotifyEvent: (cb) => ipcRenderer.on('spotify:event', (event, data) => cb(data)),
  youtubeSearch: (opts) => ipcRenderer.invoke('youtube:search', opts),
  youtubePlay: (opts) => ipcRenderer.invoke('youtube:play', opts),
  youtubeStop: () => ipcRenderer.invoke('youtube:stop'),
  onYoutubeStatus: (cb) => ipcRenderer.on('youtube:status', (event, data) => cb(data)),
  sendPartyJukeboxState: (state) => ipcRenderer.send('party:jukeboxState', state),
  onPartyJukeboxAdd: (cb) => ipcRenderer.on('party:jukeboxAdd', (event, data) => cb(data)),
  onPartyJukeboxSkipVote: (cb) => ipcRenderer.on('party:jukeboxSkipVote', () => cb()),
  onPartyJukeboxFun: (cb) => ipcRenderer.on('party:jukeboxFun', (event, data) => cb(data)),
  videoSplicerLaunch: () => ipcRenderer.invoke('videoSplicer:launch'),
  // AUX channel capture — see plugins/video-in/main.js's desktop:listSources.
  listDesktopSources: () => ipcRenderer.invoke('desktop:listSources'),
  sendPartyQueueState: (state) => ipcRenderer.send('party:queueState', state),
  getPartyJoinInfo: () => ipcRenderer.invoke('party:getJoinInfo'),
  // LAN viewer (Jellyfin-style multi-device watching) — see main.js's
  // startViewerServer. Only used to display the URL in settings; the
  // viewer page itself is a separate, independent load of this same
  // renderer bundle served over HTTP, not driven through this bridge.
  getViewerUrl: () => ipcRenderer.invoke('viewer:getUrl'),
  // TMDB metadata lookup (a plugin's own TITLES-tab match action, see
  // plugins/tmdb-metadata) — handled by that plugin's own main.js, not core.
  tmdbSearch: (opts) => ipcRenderer.invoke('tmdb:search', opts),
  tmdbGetCredits: (opts) => ipcRenderer.invoke('tmdb:getCredits', opts),
  // Closed captions (sidecar/embedded subtitle discovery + extraction) —
  // handled by plugins/closed-captions's own main.js, not core.
  captionsScanForFile: (filePath) => ipcRenderer.invoke('captions:scanForFile', filePath),
  captionsExtractTrack: (opts) => ipcRenderer.invoke('captions:extractTrack', opts),
  // NOAA/NWS active alerts (real EAS trigger) — handled by
  // plugins/noaa-weather's own main.js, not core.
  noaaGetActiveAlerts: (opts) => ipcRenderer.invoke('noaa:getActiveAlerts', opts),
  // Real forecast for the weather channel (CH3) — see
  // plugins/noaa-weather/main.js and plugins/local-weather/renderer.js's
  // forecast rendering.
  noaaGetForecast: (opts) => ipcRenderer.invoke('noaa:getForecast', opts),
  // Plugins — see main-plugins.js and renderer/js/plugins.js.
  pluginsList: () => ipcRenderer.invoke('plugins:list'),
  getDiagnostics: () => ipcRenderer.invoke('diagnostics:get'),
  exportDiagnostics: (rendererSnapshot) => ipcRenderer.invoke('diagnostics:export', rendererSnapshot),
  pluginsOpenFolder: () => ipcRenderer.invoke('plugins:openFolder'),
  pluginsSetEnabled: (id, enabled) => ipcRenderer.invoke('plugins:setEnabled', id, enabled),
  pluginsInstallFromZip: (opts) => ipcRenderer.invoke('plugins:installFromZip', opts),
  pluginsApproveCapabilities: (id, signature) => ipcRenderer.invoke('plugins:approveCapabilities', id, signature),
  pluginsRevokeCapabilities: (id) => ipcRenderer.invoke('plugins:revokeCapabilities', id),
  pluginsApproveIntegrity: (id, hash) => ipcRenderer.invoke('plugins:approveIntegrity', id, hash),
  pluginsUninstall: (id) => ipcRenderer.invoke('plugins:uninstall', id),
  // Media-source abstraction — see main-media-dispatch.js and
  // PLUGIN_DEVELOPMENT.md's "Media sources" section. listMediaSourceProviders
  // backs the CHANNELS tab's CHOOSE SOURCE picker; callMediaSourceHook is a
  // generic passthrough to a provider's own optional UI-facing verbs (only
  // `pickFolder` today) — reserved-key-on-ctx.callService, same mechanism
  // as every other cross-plugin service call, just reachable from the
  // renderer since only the renderer has a "show a folder picker" UI to
  // trigger it from.
  listMediaSourceProviders: () => ipcRenderer.invoke('plugins:listMediaSourceProviders'),
  callMediaSourceHook: (providerId, verb, ...args) => ipcRenderer.invoke('mediaSource:callHook', providerId, verb, args),
});
