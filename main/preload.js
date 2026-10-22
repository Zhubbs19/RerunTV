const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Sandboxed renderers can't read a dropped File object's real filesystem
  // path directly (File.path was removed) — webUtils.getPathForFile is the
  // replacement, but it only exists in the preload/main-world context, so
  // OS drag-and-drop (setup-dragdrop.js) has to bounce through here instead
  // of reading File objects straight off the DragEvent itself.
  getPathForFile: (file) => webUtils.getPathForFile(file),
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
  getStartupServerStatus: () => ipcRenderer.invoke('startupServer:getStatus'),
  setStartupServerEnabled: (enabled) => ipcRenderer.invoke('startupServer:setEnabled', enabled),
  // Open the full window at sign-in instead (startup-server.js); turning one
  // on turns the other off.
  getStartupWindowStatus: () => ipcRenderer.invoke('startupWindow:getStatus'),
  setStartupWindowEnabled: (enabled) => ipcRenderer.invoke('startupWindow:setEnabled', enabled),
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
  // Pushes the current theme-pack registry (plugins.js's themePackEntries())
  // to main after every plugin (re)load — companion-app/main.js's
  // GET /api/themes reads it back via ctx.getInstalledThemes, so the
  // Android app's theme dropdown has a real, install-accurate option list
  // instead of free text. See plugins.js's reportInstalledThemes.
  reportInstalledThemes: (themes) => ipcRenderer.send('themes:list', themes),
  // Display wake lock held while the TV is powered on, and the OS-level
  // fallback for a program reminder that fires while the window is
  // unfocused — see main.js's power:setKeepDisplayAwake / notify:show.
  // Resolves to the resulting held state; call it with null to read that
  // state without changing it.
  setKeepDisplayAwake: (keepAwake) => ipcRenderer.invoke('power:setKeepDisplayAwake', keepAwake),
  showSystemNotification: (opts) => ipcRenderer.invoke('notify:show', opts),
  // Viewing history — its own file, not part of channels.json. See
  // main-history.js for why.
  historyAppend: (entry) => ipcRenderer.invoke('history:append', entry),
  historyList: (limit) => ipcRenderer.invoke('history:list', limit),
  historyClear: () => ipcRenderer.invoke('history:clear'),
  selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
  selectImage: () => ipcRenderer.invoke('dialog:selectImage'),
  selectAudio: () => ipcRenderer.invoke('dialog:selectAudio'),
  selectVideo: (opts) => ipcRenderer.invoke('dialog:selectVideo', opts),
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
  createBackupNow: (reason) => ipcRenderer.invoke('backups:createNow', reason),
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (config, baseRevision, client) => ipcRenderer.invoke('config:save', config, baseRevision, client),
  applyConfigCommands: (batch, meta) => ipcRenderer.invoke('config:command', batch, meta),
  getConfigSnapshot: () => ipcRenderer.invoke('config:snapshot'),
  libraryCall: (method, payload) => ipcRenderer.invoke('library:call', method, payload),
  // Video Splicer (main/splicer/service.js): split a recording into clips or
  // join clips into one file, with its runs' output streamed as events.
  splicerCall: (method, payload) => ipcRenderer.invoke('splicer:call', method, payload),
  onSplicerJob: (cb) => ipcRenderer.on('splicer:job', (event, data) => cb(data)),
  personalCall: (method, payload) => ipcRenderer.invoke('personal:call', method, payload),
  getConfigRevision: () => ipcRenderer.invoke('config:revision'),
  onConfigApplied: (cb) => ipcRenderer.on('config:applied', (event, update) => cb(update)),
  onPersonalChanged: (cb) => ipcRenderer.on('personal:changed', (event, update) => cb(update)),
  onClientHandoff: (cb) => ipcRenderer.on('client:handoff', (event, update) => cb(update)),
  onSharedSessionChanged: (cb) => ipcRenderer.on('session:changed', (event, update) => cb(update)),
  // LAN viewers only (browser-api-shim.js): the host window is the one
  // writing config, so there is nothing for it to be told.
  onConfigChanged: () => () => {},
  exportConfig: (config, suggestedName) => ipcRenderer.invoke('config:export', config, suggestedName),
  openPrintableManual: (html) => ipcRenderer.invoke('manual:openPrintable', html),
  importConfig: () => ipcRenderer.invoke('config:import'),
  toFileUrl: (filePath) => ipcRenderer.invoke('path:toFileUrl', filePath),
  basename: (filePath) => ipcRenderer.invoke('path:basename', filePath),
  resolvePlayablePath: (source, filePath) => ipcRenderer.invoke('media:resolvePlayablePath', source, filePath),
  transcode: (source, filePath) => ipcRenderer.invoke('media:transcode', source, filePath),
  // Downloads a mediaSource-plugin file to a real local folder — setup-
  // panels.js's per-file DOWNLOAD action. Host-only: a LAN viewer can't edit
  // channels, so it never needs this.
  downloadMediaFile: (source, ref, destDir, suggestedName) => ipcRenderer.invoke('media:downloadFile', source, ref, destDir, suggestedName),
  onMediaDownloadProgress: (cb) => {
    const listener = (event, payload) => cb(payload);
    ipcRenderer.on('media:downloadProgress', listener);
    return () => ipcRenderer.removeListener('media:downloadProgress', listener);
  },
  toggleFullscreen: () => ipcRenderer.invoke('window:toggleFullscreen'),
  quitApp: () => ipcRenderer.invoke('window:quit'),
  // SYSTEM › POWER's "Shut down this PC" (playback/pc-power.js). The countdown
  // runs in the main process (main/system/shutdown.js) so the companion
  // remote can start or cancel the same one; onPcShutdownChanged is how the
  // window hears about that.
  shutdownPc: (opts) => ipcRenderer.invoke('system:shutdownPc', opts),
  cancelPcShutdown: () => ipcRenderer.invoke('system:cancelPcShutdown'),
  getPcShutdownStatus: () => ipcRenderer.invoke('system:pcShutdownStatus'),
  onPcShutdownChanged: (cb) => ipcRenderer.on('system:pcShutdownChanged', (event, status) => cb(status)),
  // App-wide display mode's "lock window" mode (display-mode.js) — locks/
  // unlocks the real OS window's aspect ratio. aspect: null clears the lock.
  setAspectLock: (aspect) => ipcRenderer.invoke('window:setAspectLock', { aspect }),
  // Enlarges the complete interface through Chromium's page zoom so core,
  // plugin UI, themes, dialogs, and the program guide remain in lockstep.
  setUiScale: (preference) => ipcRenderer.invoke('window:setUiScale', preference),
  // PICTURE & SOUND's "Show on screen": the connected screens, and which one
  // the window should live on ({ id, label }, or null for the last one used).
  listScreens: () => ipcRenderer.invoke('window:listScreens'),
  setPreferredScreen: (ref) => ipcRenderer.invoke('window:setPreferredScreen', ref),
  // Fires with { id, label } whenever the window ends up on a different
  // screen, for "TV mode on" (usage-mode.js).
  onScreenChange: (cb) => ipcRenderer.on('window:screenChanged', (event, ref) => cb(ref)),
  // { state: 'lost' | 'returned', screen } when the window's screen goes away
  // (a TV switched off) and when the window is back on it (tv-screen.js).
  onScreenPower: (cb) => ipcRenderer.on('window:screenPower', (event, payload) => cb(payload)),
  // Volume leveler (media/loudness.js): a local file's loudness in LUFS
  // (measured with ffmpeg on first ask, then cached), and a background sweep.
  getLoudness: (filePath, duration) => ipcRenderer.invoke('loudness:get', filePath, duration),
  prefetchLoudness: (items) => ipcRenderer.invoke('loudness:prefetch', items),
  cancelLoudnessPrefetch: () => ipcRenderer.invoke('loudness:cancelBackground'),
  getLoudnessStatus: () => ipcRenderer.invoke('loudness:status'),
  // Baked-in black bars (media/cropdetect.js): the picture's box inside a
  // local file's frame, found with ffmpeg and cached, plus a background sweep.
  getCrop: (filePath, duration) => ipcRenderer.invoke('cropdetect:get', filePath, duration),
  prefetchCrops: (items) => ipcRenderer.invoke('cropdetect:prefetch', items),
  cancelCropPrefetch: () => ipcRenderer.invoke('cropdetect:cancelBackground'),
  getCropStatus: () => ipcRenderer.invoke('cropdetect:status'),
  // DISPLAY tab's HIDE TITLE BAR toggle (setup-settings.js) — closes and
  // reopens the real OS window with/without its frame, since that's a
  // BrowserWindow constructor-only option (see main.js's
  // window:setTitleBarHidden). Host-only: meaningless for a LAN viewer's
  // browser tab, which has no OS window of its own to reframe.
  setTitleBarHidden: (hidden) => ipcRenderer.invoke('window:setTitleBarHidden', hidden),
  // Fires for every fullscreen enter/exit, not just the F-key toggle above —
  // see main.js's enter-full-screen/leave-full-screen listeners — so the
  // renderer's hint-bar-hiding stays correct even when fullscreen is
  // triggered by an OS-level control instead of the app's own shortcut.
  onFullscreenChange: (cb) => ipcRenderer.on('window:fullscreenChanged', (event, isFullscreen) => cb(isFullscreen)),
  // HDMI-CEC remote presses from main-cec.js (launched with --cec).
  onCecKey: (cb) => ipcRenderer.on('cec:key', (event, press) => cb(press)),
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
  onCompanionConfigChanged: (cb) => ipcRenderer.on('companion:configChanged', () => cb()),
  getCompanionUrl: () => ipcRenderer.invoke('companion:getUrl'),
  // Companion app's ALERTS section (REMOTE tab) — see plugins/companion-app/
  // main.js's POST /news/trigger and POST /ticker/set.
  onCompanionTriggerNews: (cb) => ipcRenderer.on('companion:triggerNews', (event, data) => cb(data)),
  onCompanionSetTicker: (cb) => ipcRenderer.on('companion:setTicker', (event, data) => cb(data)),
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
  digitalMusicScanFolder: (opts) => ipcRenderer.invoke('digital-music:scanFolder', opts),
  digitalMusicEmbeddedArt: (opts) => ipcRenderer.invoke('digital-music:embeddedArt', opts),
  digitalMusicReadTags: (opts) => ipcRenderer.invoke('digital-music:readTags', opts),
  sendPartyJukeboxState: (state) => ipcRenderer.send('party:jukeboxState', state),
  onPartyJukeboxAdd: (cb) => ipcRenderer.on('party:jukeboxAdd', (event, data) => cb(data)),
  onPartyJukeboxSkipVote: (cb) => ipcRenderer.on('party:jukeboxSkipVote', () => cb()),
  onPartyJukeboxFun: (cb) => ipcRenderer.on('party:jukeboxFun', (event, data) => cb(data)),
  // AUX channel capture — see plugins/video-in/main.js's desktop:listSources.
  listDesktopSources: () => ipcRenderer.invoke('desktop:listSources'),
  sendPartyQueueState: (state) => ipcRenderer.send('party:queueState', state),
  getPartyJoinInfo: () => ipcRenderer.invoke('party:getJoinInfo'),
  // LAN viewer (Jellyfin-style multi-device watching) — see main.js's
  // startViewerServer. Only used to display the URL in settings; the
  // viewer page itself is a separate, independent load of this same
  // renderer bundle served over HTTP, not driven through this bridge.
  getViewerUrl: () => ipcRenderer.invoke('viewer:getUrl'),
  getViewerControlUrl: () => ipcRenderer.invoke('viewer:getControlUrl'),
  // TV clients (docs/design/01): save a Remote-test capture on the host, and
  // the phone/computer handoff URL + QR.
  saveRemoteProfile: (profile) => ipcRenderer.invoke('tvClient:saveRemoteProfile', profile),
  getHandoffInfo: (opts) => ipcRenderer.invoke('tvClient:getHandoffInfo', opts),
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
  // Cast to TV (Chromecast/Google TV) — handled by plugins/cast-to-tv's own
  // main.js, not core.
  castScan: () => ipcRenderer.invoke('cast:scan'),
  castConnect: (host) => ipcRenderer.invoke('cast:connect', host),
  castDisconnect: () => ipcRenderer.invoke('cast:disconnect'),
  castNow: (host) => ipcRenderer.invoke('cast:castNow', host),
  castListMirrorSources: () => ipcRenderer.invoke('cast:listMirrorSources'),
  castPrepareMirrorCapture: (sourceId) => ipcRenderer.invoke('cast:prepareMirrorCapture', sourceId),
  // Awaitable so TCP backpressure reaches the encoder instead of silently
  // buffering increasingly stale frames in the main process.
  castMirrorChunk: (bytes) => ipcRenderer.invoke('cast:mirrorChunk', bytes),
  castStartMirror: (host, mimeType, quality) => ipcRenderer.invoke('cast:startMirror', host, mimeType, quality),
  castStopMirror: () => ipcRenderer.invoke('cast:stopMirror'),
  castStop: () => ipcRenderer.invoke('cast:stop'),
  castSetVolume: (level) => ipcRenderer.invoke('cast:setVolume', level),
  castSetAutoSync: (enabled) => ipcRenderer.invoke('cast:setAutoSync', enabled),
  castSetNowPlaying: (info) => ipcRenderer.send('cast:setNowPlaying', info),
  castGetStatus: () => ipcRenderer.invoke('cast:getStatus'),
  onCastStatus: (cb) => ipcRenderer.on('cast:status', (event, data) => cb(data)),
  // Recording ("taping") a channel's broadcast to a file, and the shelf of
  // finished tapes CH 101 plays back — handled by plugins/tape-deck's own
  // main.js, not core.
  tapesRecord: (plan) => ipcRenderer.invoke('tapes:record', plan),
  tapesStatus: () => ipcRenderer.invoke('tapes:status'),
  tapesCancel: (id) => ipcRenderer.invoke('tapes:cancel', id),
  tapesList: () => ipcRenderer.invoke('tapes:list'),
  tapesReadDisc: (videoTsPath) => ipcRenderer.invoke('tapes:readDisc', videoTsPath),
  tapesImport: (opts) => ipcRenderer.invoke('tapes:import', opts),
  // MakeMKV — a separate application the user installs and licenses
  // themselves, driven by plugins/makemkv's own main.js, not by core. Same
  // narrow named-bridge shape as every other optional plugin above.
  makemkvStatus: () => ipcRenderer.invoke('makemkv:status'),
  makemkvListTitles: (source) => ipcRenderer.invoke('makemkv:listTitles', source),
  makemkvRip: (opts) => ipcRenderer.invoke('makemkv:rip', opts),
  makemkvJobs: () => ipcRenderer.invoke('makemkv:jobs'),
  makemkvCancel: (id) => ipcRenderer.invoke('makemkv:cancel', id),
  onMakemkvProgress: (cb) => ipcRenderer.on('makemkv:progress', (event, data) => cb(data)),
  onMakemkvDone: (cb) => ipcRenderer.on('makemkv:done', (event, data) => cb(data)),
  tapesSetArt: (opts) => ipcRenderer.invoke('tapes:setArt', opts),
  tapesDelete: (id) => ipcRenderer.invoke('tapes:delete', id),
  onTapesProgress: (cb) => ipcRenderer.on('tapes:progress', (event, data) => cb(data)),
  onTapesDone: (cb) => ipcRenderer.on('tapes:done', (event, data) => cb(data)),
  // FFmpeg Transcode plugin's "INSTALL FFMPEG" button — main/media/ffmpeg-install.js.
  ffmpegInstallCheck: () => ipcRenderer.invoke('ffmpeg:installInfo'),
  ffmpegInstall: () => ipcRenderer.invoke('ffmpeg:install'),
  onFfmpegInstallProgress: (cb) => ipcRenderer.on('ffmpeg:installProgress', (event, data) => cb(data)),
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
