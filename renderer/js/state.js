// Shared mutable runtime state. Modules read and write through S so the
// ownership of cross-cutting values (what channel is tuned, whether the box
// is powered on, how far the viewing clock is shifted) stays in one place.
export const S = {
  config: { channels: [] },
  // Bumped on every known write to S.config — in-place mutation (via
  // saveConfigDebounced, the funnel almost every setup-screen edit already
  // goes through) or wholesale replacement (import/restore/undo/viewer
  // config poll, via bumpConfigGeneration()/resetUndoBaseline()/
  // pushUndoSnapshot()/performUndo()/performRedo() below). Config is
  // mutated in place with no version field of its own (see CLAUDE.md's
  // "Config mutation" section), so this is the one thing a cache can
  // actually key on to know "config hasn't changed since I last computed
  // this" instead of guessing from object identity.
  configGeneration: 0,
  currentNumber: null,
  // Which channel's REAL decoded video the #player element's videoWidth/
  // videoHeight currently, confirmedly, belong to — set only once that
  // channel's own loadedmetadata has actually fired (playback.js), never
  // just from setting player.src (which is async and doesn't update
  // videoWidth/videoHeight until decode). display-mode.js's AUTO
  // aspect/resolution reads this before trusting player.videoWidth/Height
  // as a signal for whichever channel it's currently evaluating — without
  // it, rapid channel-flipping could read a PREVIOUS channel's still-
  // lingering video dimensions as if they belonged to the new one, since
  // applyDisplayMode() gets called from several points in the tune
  // sequence, including ones that fire before the new video's own metadata
  // is ready. Reset to null at the start of every tune (tuneToChannel) so
  // a stale value never outlives the channel it was confirmed for.
  currentPlayerChannelNumber: null,
  // Real decoded video dimensions seen so far, keyed by file path — populated
  // by playback.js's onMeta callbacks the first time each file is actually
  // decoded, read by display-mode.js's AUTO resolution/aspect so a file
  // played before (very common: channels loop the same pool) gets its real,
  // confirmed size immediately on the NEXT tune too, instead of only after
  // that tune's own loadedmetadata fires. In-memory/session-only by design —
  // no persistence, no invalidation needed, since a stale entry only matters
  // if the file on disk changes mid-session, which onMeta immediately
  // overwrites the next time that path plays anyway.
  videoSizeCache: {},
  entryBuffer: '',
  entryTimer: null,
  guideHideTimer: null,
  staticRAF: null,
  endedHandler: null,
  errorHandler: null,
  // True once a LAN viewer (window.__isViewer) may play audible media: after
  // an ordinary browser's first trusted gesture, or immediately in the
  // native Android TV shell whose WebView explicitly allows gesture-free
  // media playback. See applyMuteState (power.js) and initViewerAudioUnlock
  // (app.js). Always stays false on the host, where it's never read.
  viewerAudioUnlocked: false,
  // The player's current pending 'loadedmetadata' listener, if any — tracked
  // just like endedHandler/errorHandler so a new one always replaces the old
  // rather than stacking. Without this, fast channel-surfing or a break
  // transitioning before a previous load's metadata arrived left multiple
  // stale closures attached to the single shared player; when the next
  // loadedmetadata event fired, all of them ran, each seeking to its own
  // stale position/entry.
  metaHandler: null,
  isPoweredOn: true,
  // Set by showSetupScreen/showTvScreen (app.js) — lets any plugin-owned
  // ambient audio know to stop while you're in the setup screen, same as
  // the video itself already pauses there, instead of continuing to play
  // under a screen that isn't the TV anymore.
  isSetupOpen: false,
  idleTimer: null,
  powerAnimTimer: null,
  audioCtx: null,
  sfxGain: null,
  saveConfigTimer: null,
  timeOffsetMs: 0,
  guideWindowStart: 0,
  guideSelRowIdx: 0,
  guideSelTime: 0,
  guideTickTimer: null,
  guideFilterQuery: '',
  guideDocked: true,
  // Ad-break overlay blocks (buildChannelRow, guide.js) are opt-in — off by
  // default since a channel with a busy ad cadence can tile enough of them
  // across a row to read as clutter rather than useful info.
  guideShowBreaks: false,
  // Bumped on every renderGuideGrid() call — lets a chunked lazy-fill pass
  // (rendering rows for channels off-screen) notice it's been superseded by
  // a newer render and stop appending instead of racing it.
  guideRenderGen: 0,
  setupFilterQuery: '',
  // Bulk-select mode on the CHANNELS tab — ephemeral UI state, not part of
  // S.config, cleared whenever the mode is turned off (never persisted).
  bulkSelectMode: false,
  bulkSelectedChannels: new Set(),
  batchFixRunning: null,
  batchFixCancel: false,
  vhsTimestampTimer: null,
  // CRT logo-bug burn-in ghost (applyLogoBugGhost, playback.js) — burnKey
  // identifies "this exact logo, this exact corner" so a channel/position
  // change restarts accumulation instead of inheriting a stale streak;
  // burnStartMs is real wall-clock time (Date.now(), not viewNow()) since
  // burn-in is a physical side effect of real elapsed screen-on time, not
  // simulated broadcast time.
  logoBugBurnKey: null,
  logoBugBurnStartMs: null,
  logoBugBurnTimer: null,
  timeMachineOn: false,
  shuttleDir: 0,
  shuttleSpeedIdx: 0,
  shuttleRAF: null,
  shuttleLastTs: 0,
  shuttlePreviewPath: null,
  shuttleSeekAccum: 0,
  easScheduleTimer: null,
  easEndTimer: null,
  easSafetyTimer: null,
  easOscillators: null,
  easActive: false,
  upNextTimer: null,
  upNextHideTimer: null,
  // End-credits speedup (ch.creditsSpeedup/file.creditsLeadS, playback.js's
  // scheduleCreditsSpeedup/startCreditsSpeedup) — a sibling of the upNext
  // timer above, armed the same way (once per tune/file-load) but its own
  // slot since the two features are independent and can both be armed for
  // the same file at once.
  creditsSpeedupTimer: null,
  // Set only while player.playbackRate is actually elevated for the current
  // file's credits — checked by handleContentEnded to know whether to
  // credit time back to S.contentLostMs, and by the defensive resets in
  // tuneToChannel/powerOff to know whether there's anything to undo.
  creditsSpeedupActive: false,
  creditsSpeedupPrevMuted: false,
  creditsSpeedupRealStartMs: 0,
  creditsSpeedupScheduledRemainingMs: 0,
  blockBoundaryTimer: null,
  broadcastHoursTimer: null,
  breakTimer: null,
  activeBreakKey: null,
  activeBreakInterruptsContent: false,
  // 'commercial' | 'adBreakIn' | 'adBreakOut' | 'upNext' | 'channelId' |
  // 'trivia' | null — which kind of
  // break is currently on screen, so applyVolume (power.js) knows whether to
  // apply the ad-volume multiplier (real video/audio playing through
  // `player`) vs. leave content volume alone (trivia pauses `player`
  // entirely; a text-only channelId doesn't touch it at all).
  activeBreakKind: null,
  // How far live content playback is lagging real time because of breaks
  // it's paused through so far on the current source — see
  // computeLiveContentPosition (playback.js). contentLostKey is the
  // channel+source this applies to; a source change (new day, new block, a
  // channel change) resets it to 0 rather than carrying stale lag forward.
  contentLostMs: 0,
  contentLostKey: null,
  breakEnteredAtMs: 0,
  // What real channel content the player element is currently loaded with —
  // set by playChannelLive (playback-core.js) at the moment it assigns
  // player.src for content (never for a bumper), cleared at the top of every
  // tune. Read only by the schedule-drift watchdog (checkScheduleDrift,
  // playback-core.js), which needs to know that the file still on screen is
  // the same one the schedule says should be airing before it trusts a
  // comparison of player.currentTime against the computed offset. Tracking
  // the path rather than reading it back off player.src avoids re-resolving
  // a mediasource: ref through IPC just to answer "same file?".
  liveContentPath: null,
  liveContentChannel: null,
  driftCheckTimer: null,
  // Non-null while channel SCAN is running (toggleChannelScan,
  // playback-core.js) — also the flag app.js checks to cancel the scan on
  // any other keypress.
  scanTimer: null,
  // Real (not viewNow()) timestamp of the last corrective seek — a plain
  // rate limit so a file that keeps stalling underneath us gets one nudge
  // per cooldown instead of a seek every tick, which on a slow remote
  // source would make the stall worse rather than better.
  lastDriftSeekMs: 0,
  // True while a real-file bumper (commercial/adBreakIn/adBreakOut/upNext/
  // channelId-with-video) is playing and hasn't fired its own 'ended'/'error'
  // yet — lets checkBreakState (playback.js) tell "the probed duration this
  // break's scheduled windowEnd was built from turned out to be too short"
  // apart from "this bumper type doesn't play video at all" (dynamic/trivia/
  // text-only channelId), so only the former gets a grace period instead of
  // being cut off mid-play.
  awaitingBumperEnd: false,
  breakOverrunSince: null,
  volumeHideTimer: null,
  previousNumber: null,
  sleepTimer: null,
  sleepMinutes: 0,
  channelFailStreak: {},
  ratingBugTimer: null,
  movieRatingCardTimer: null,
  episodeStatusBugTimer: null,
  formatDisclaimerCardTimer: null,
  contentAdvisoryCardTimer: null,
  capabilityBadgeTimer: null,
  holdMusicNodes: null,
  contentAdvisoryCueTimers: [],
  hintBarFlashTimer: null,
  pictureModeFlashTimer: null,
  airCheckFlashTimer: null,
  scanFlashTimer: null,
  aspectModeFlashTimer: null,
  sleepTimerFlashTimer: null,
  crtFlashTimer: null,
  crtToggleFlashTimer: null, // returnToLive's own "LIVE" flash (timemachine.js) — distinct from crtFlashTimer above
  // True while the TV screen is showing a setup-screen PREVIEW (see
  // openPreviewModal, setup-channels.js) rather than real live viewing —
  // gates the preview banner and tells showSetupScreen (app.js) to reset
  // S.timeOffsetMs back to 0 on the way out, so a chosen preview date/time
  // never leaks into normal live playback afterward.
  setupPreviewActive: false,
  // Plugin-owned runtime fields used to be declared here even though core
  // never read any of them — each now seeds its own on this shared object
  // from its own renderer.js top level instead, the same pattern
  // config.<pluginId> already uses. A plain JS object doesn't care whether a
  // field was in this literal or added later, so there's nothing else to
  // change for this to work — see [[retro_cable_box_plugin_system]].
  // ---------- Parental PIN lock & VCR Tracking ----------
  pinLockActive: false,
  pinBuffer: '',
  pinTargetCh: null,
  unlockedPinChannels: new Set(),
  vcrTrackingLevel: 0,
  quickJumpSlots: {},
  sapMode: 'stereo',
  activePod: null,
  activePodIndex: 0,
  // {at, applied[], rejected[{section, reason}]} for the most recent
  // settings patch the companion app sent (onCompanionApplySettings,
  // app.js). Read straight back out by pushRemoteState (power.js) so the
  // phone can report what actually happened instead of assuming success —
  // the HTTP route that took the patch has already answered by then.
  lastCompanionSettingsResult: null,
};

export const REDUCE_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
export const POWER_OFF_ANIM_MS = REDUCE_MOTION ? 0 : 380;
export const POWER_ON_ANIM_MS = REDUCE_MOTION ? 0 : 550;
export const GUIDE_SLOT_MS = 30 * 60 * 1000;
export const BADGE_COLORS = ['#f0b429', '#6fe0f2', '#8b93f5', '#ff6b5b', '#5fd68a', '#e0895f'];
export const WEEKDAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
export const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
// Shuttle rates in broadcast-seconds per real second. The old first tier
// (60x) meant even the slowest hold-to-shuttle speed covered a full minute
// of schedule per second of holding the key — fine for getting roughly
// where you want, too coarse to land exactly on e.g. a specific break.
// 5x/15x added below that for real fine-grained control; repeated taps in
// the same direction still step up through the whole ladder same as before.
export const SHUTTLE_SPEEDS = [5, 15, 60, 300, 1800, 7200];
// No channel-number constants live here at all anymore — every one of them
// (AUX/WEATHER/PARTY/HBO/HSN/AREA51/GAME/PPV/SYNTH/TELETEXT) was either dead
// weight or a duplicate of data a plugin already registers for itself via
// registerChannelType(). Core code that needs to know "what's registered at
// this number" asks generically instead of hardcoding a constant per plugin
// — see getVirtualBadge/findLiveViewerLinkChannelType (virtual.js).

// The setup-footer save-state indicator (index.html: #setup-save-state) —
// looked up lazily rather than imported from dom.js, since dom.js resolves
// every element eagerly at module-load time and state.js is imported very
// early (before dom.js's own querySelectors would find a fully-parsed
// document in every load order). A missing element (LAN viewer, no setup
// screen markup) is a silent no-op, not an error.
function setSaveIndicator(state) {
  const el = document.getElementById('setup-save-state');
  if (!el) return;
  const wasSaving = el.dataset.state === 'saving';
  el.dataset.state = state;
  el.textContent = state === 'saving' ? 'SAVING…' : 'SAVED';
  if (wasSaving && state !== 'saving') {
    el.classList.remove('save-pulse');
    void el.offsetWidth;
    el.classList.add('save-pulse');
  }
}

// True while the currently-pending debounced save already has an undo step
// queued for it — lets a plain, incidental write that opts out of undo
// tracking (skipUndo — see below) coalesce into the same pending save as a
// real edit without either losing that edit's undo step or double-pushing.
let pendingIsUndoTracked = false;

// Callers that reassign S.config wholesale outside the undo funnel below
// (a screen-switch or LAN-viewer-poll refetch that isn't a user "edit")
// call this directly right after the reassignment — see app.js.
export function bumpConfigGeneration() {
  S.configGeneration++;
}

// `opts.skipUndo` is for writes that are real config state but not a
// meaningful "edit" to step back through — currently just S.config.
// lastChannel, updated on every single channel tune (playback.js) so the box
// reopens on the same channel next launch. Without this, casually surfing
// channels between setup-screen visits would bury actual setup edits under
// a pile of "last channel changed" undo steps, making Ctrl+Z on the setup
// screen nearly useless after any TV-watching in between.
export function saveConfigDebounced(delay, opts) {
  // Fires synchronously, right when the in-place mutation that triggered
  // this call actually happened — not inside the debounced timeout below,
  // which only runs once, after the last of a burst of edits. A cache keyed
  // on configGeneration needs to see the bump immediately, before whatever
  // re-render the caller does next reads the (already mutated) config.
  bumpConfigGeneration();
  const skipUndo = !!(opts && opts.skipUndo);
  // One "burst" of rapid edits (every keystroke in a text field, a slider
  // being dragged) becomes a single undo step: the snapshot pushed below is
  // always the config as of the *last completed save*, not the last call to
  // this function, and it's only pushed once per debounce window rather than
  // once per keystroke.
  const alreadyPending = !!S.saveConfigTimer;
  clearTimeout(S.saveConfigTimer);
  setSaveIndicator('saving');
  const needsPush = !skipUndo && !(alreadyPending && pendingIsUndoTracked);
  if (needsPush && lastSavedSnapshot != null) {
    undoStack.push(lastSavedSnapshot);
    if (undoStack.length > MAX_UNDO_ENTRIES) undoStack.shift();
    redoStack.length = 0;
    pendingIsUndoTracked = true;
  } else if (!alreadyPending) {
    pendingIsUndoTracked = false;
  }
  S.saveConfigTimer = setTimeout(() => {
    S.saveConfigTimer = null;
    pendingIsUndoTracked = false;
    window.api.saveConfig(S.config).then(() => {
      setSaveIndicator('saved');
      lastSavedSnapshot = JSON.stringify(S.config);
    });
  }, delay || 600);
}

// ---------- Undo/redo ----------
// Tracks config snapshots (JSON strings, so later in-place mutation of
// S.config can never corrupt a stacked entry) around the single funnel point
// almost every setup-screen edit already goes through above. A handful of
// call sites bypass saveConfigDebounced entirely (wholesale config replace on
// import/restore, the DONE button's final flush) — those call
// resetUndoBaseline() instead of pushing a step, since "undo" past a full
// config replacement isn't a meaningful single edit to step back through.
let lastSavedSnapshot = null;
const undoStack = [];
const redoStack = [];
const MAX_UNDO_ENTRIES = 50;

export function resetUndoBaseline() {
  lastSavedSnapshot = JSON.stringify(S.config);
  undoStack.length = 0;
  redoStack.length = 0;
  bumpConfigGeneration();
}

// For the rare call sites that replace S.config wholesale and persist it
// themselves outside saveConfigDebounced (backup restore, which the main
// process writes straight to disk) — pushes the config as of the last known
// snapshot as one undo step, then re-baselines to the just-loaded config.
// Must be called AFTER S.config has been reassigned to the new value.
export function pushUndoSnapshot() {
  if (lastSavedSnapshot != null) {
    undoStack.push(lastSavedSnapshot);
    if (undoStack.length > MAX_UNDO_ENTRIES) undoStack.shift();
    redoStack.length = 0;
  }
  lastSavedSnapshot = JSON.stringify(S.config);
  bumpConfigGeneration();
}

export function canUndo() { return undoStack.length > 0; }
export function canRedo() { return redoStack.length > 0; }

function applySnapshot(snapshot) {
  S.config = JSON.parse(snapshot);
  lastSavedSnapshot = snapshot;
  clearTimeout(S.saveConfigTimer);
  S.saveConfigTimer = null;
  setSaveIndicator('saving');
  bumpConfigGeneration();
  window.api.saveConfig(S.config).then(() => setSaveIndicator('saved'));
}

// Returns true if a step was actually applied — callers use this to decide
// whether to re-render the setup screen (state.js has no notion of the DOM).
export function performUndo() {
  if (!undoStack.length) return false;
  const prev = undoStack.pop();
  redoStack.push(lastSavedSnapshot);
  applySnapshot(prev);
  return true;
}

export function performRedo() {
  if (!redoStack.length) return false;
  const next = redoStack.pop();
  undoStack.push(lastSavedSnapshot);
  applySnapshot(next);
  return true;
}

// Every "what's airing" calculation reads the clock through viewNow() rather
// than Date.now(), so shifting one offset moves playback, the guide,
// dayparting and the on-screen clocks together. Channel anchors deliberately
// keep using real Date.now() — they record when a folder was scanned.
export function viewNow() {
  return Date.now() + S.timeOffsetMs;
}
