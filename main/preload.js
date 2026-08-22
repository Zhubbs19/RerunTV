const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Sandboxed renderers can't read a dropped File object's real filesystem
  // path directly (File.path was removed) — webUtils.getPathForFile is the
  // replacement, but it only exists in the preload/main-world context, so
  // OS drag-and-drop (setup-dragdrop.js) has to bounce through here instead
  // of reading File objects straight off the DragEvent itself.
  getPathForFile: (file) => webUtils.getPathForFile(file),
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
  selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
  selectImage: () => ipcRenderer.invoke('dialog:selectImage'),
  selectAudio: () => ipcRenderer.invoke('dialog:selectAudio'),
  selectVideo: () => ipcRenderer.invoke('dialog:selectVideo'),
  selectExecutable: () => ipcRenderer.invoke('dialog:selectExecutable'),
  selectCss: () => ipcRenderer.invoke('dialog:selectCss'),
  scanFolder: (folderPath) => ipcRenderer.invoke('fs:scanFolder', folderPath),
  checkPathsExist: (paths) => ipcRenderer.invoke('fs:checkPathsExist', paths),
  // Rotating config backups (see main.js) — listBackups for the setup
  // screen's BACKUPS panel, restoreBackup to roll the live config back to a
  // previous snapshot.
  listBackups: () => ipcRenderer.invoke('backups:list'),
  restoreBackup: (file) => ipcRenderer.invoke('backups:restore', file),
  deleteBackup: (file) => ipcRenderer.invoke('backups:delete', file),
  setBackupLabel: (file, label) => ipcRenderer.invoke('backups:setLabel', file, label),
  createBackupNow: () => ipcRenderer.invoke('backups:createNow'),
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  exportConfig: (config, suggestedName) => ipcRenderer.invoke('config:export', config, suggestedName),
  openPrintableManual: (html) => ipcRenderer.invoke('manual:openPrintable', html),
  importConfig: () => ipcRenderer.invoke('config:import'),
  toFileUrl: (filePath) => ipcRenderer.invoke('path:toFileUrl', filePath),
  basename: (filePath) => ipcRenderer.invoke('path:basename', filePath),
  resolvePlayablePath: (filePath) => ipcRenderer.invoke('media:resolvePlayablePath', filePath),
  transcode: (filePath) => ipcRenderer.invoke('media:transcode', filePath),
  toggleFullscreen: () => ipcRenderer.invoke('window:toggleFullscreen'),
  // App-wide display mode's "lock window" mode (display-mode.js) — locks/
  // unlocks the real OS window's aspect ratio. aspect: null clears the lock.
  setAspectLock: (aspect) => ipcRenderer.invoke('window:setAspectLock', { aspect }),
  // Fires for every fullscreen enter/exit, not just the F-key toggle above —
  // see main.js's enter-full-screen/leave-full-screen listeners — so the
  // renderer's hint-bar-hiding stays correct even when fullscreen is
  // triggered by an OS-level control instead of the app's own shortcut.
  onFullscreenChange: (cb) => ipcRenderer.on('window:fullscreenChanged', (event, isFullscreen) => cb(isFullscreen)),
  // Universal remote (phone browser) — see plugins/universal-remote/main.js's startRemoteServer.
  // onRemoteCommand fires for every button press relayed from the phone;
  // sendRemoteState/getRemoteUrl are the renderer's two halves of talking
  // back (current-channel readout, and the LAN URL shown in setup).
  onRemoteCommand: (cb) => ipcRenderer.on('remote:command', (event, cmd) => cb(cmd)),
  sendRemoteState: (state) => ipcRenderer.send('remote:state', state),
  getRemoteUrl: () => ipcRenderer.invoke('remote:getUrl'),
  // Host-visibility readout of who's currently polling the remote/viewer/
  // party LAN servers — see main.js's trackConnection/getConnectedDevices.
  getConnectedDevices: () => ipcRenderer.invoke('network:getConnections'),
  // Android companion remote's direct-tune and channel-flag-editor actions
  // (see plugins/universal-remote/main.js's startRemoteServer POST /tune and POST /channel/flag).
  onRemoteTune: (cb) => ipcRenderer.on('remote:tune', (event, data) => cb(data)),
  onRemoteSetChannelFlag: (cb) => ipcRenderer.on('remote:setChannelFlag', (event, data) => cb(data)),
  // Android companion remote's TRIGGER TRIVIA button (see
  // plugins/universal-remote/main.js's POST /party/trivia/start) — same
  // relay pattern as the other onRemote*/onParty* listeners above.
  onPartyTriggerTrivia: (cb) => ipcRenderer.on('party:triggerTrivia', () => cb()),
  // Party channel (party.js) — the LAN party page's guest actions (see
  // plugins/party-channel/main.js's startPartyServer) arrive here the same way remote commands do.
  // getPartyJoinInfo returns {url, qrDataUrl} for the idle screen/setup
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
  pluginsOpenFolder: () => ipcRenderer.invoke('plugins:openFolder'),
  pluginsSetEnabled: (id, enabled) => ipcRenderer.invoke('plugins:setEnabled', id, enabled),
  pluginsInstallFromZip: (opts) => ipcRenderer.invoke('plugins:installFromZip', opts),
  pluginsApproveCapabilities: (id, signature) => ipcRenderer.invoke('plugins:approveCapabilities', id, signature),
  pluginsRevokeCapabilities: (id) => ipcRenderer.invoke('plugins:revokeCapabilities', id),
  pluginsUninstall: (id) => ipcRenderer.invoke('plugins:uninstall', id),
});
