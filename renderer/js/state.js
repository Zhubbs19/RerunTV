import { applyCommand, applyPatch, cloneJson, describeCommand, diffJson, itemFieldChanges } from './commands.js';

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
  // Channels multi-selected in the lineup list (Ctrl/Shift+click). Ephemeral
  // UI state, never persisted; more than one entry means multi-select is on.
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

// ---------- Saving, commands and undo/redo ----------
// Every config edit ends up here, one of two ways:
//
//   dispatch(command)          a named command from commands.js. It applies
//                              the change, records its inverse, and saves.
//   mutate + saveConfigDebounced()   the older in-place style most call sites
//                              still use. The burst of changes since the last
//                              settle point becomes one config.patch command
//                              (a structural diff and its inverse) when the
//                              save fires, or sooner if undo/dispatch needs
//                              history to be current.
//
// History holds commands and their inverses, not whole-config JSON snapshots.
// Undo applies inverses to S.config IN PLACE, so object identity survives and
// configGeneration stays the single invalidation signal (CLAUDE.md).
//
// `baseline` is a private deep copy of config as of the last settle point. A
// patch is always baseline -> S.config, and every change that lands in
// history is applied to baseline too, so the next diff only sees newer edits.

const MAX_UNDO_ENTRIES = 50;
// Consecutive dispatches with the same coalesce key this close together (a
// slider drag, typing a name) are one undo step, as a debounced burst was.
const COALESCE_WINDOW_MS = 800;

let baseline = null;
const undoStack = [];
const redoStack = [];
// Edits made through saveConfigDebounced since the last settle point...
let pendingPlain = false;
// ...and whether any of them asked to be undoable (a burst made only of
// skipUndo writes, like lastChannel on every tune, settles without an entry).
let pendingPlainTracked = false;

// Callers that reassign S.config wholesale outside the undo funnel below
// (a screen-switch or LAN-viewer-poll refetch that isn't a user "edit")
// call this directly right after the reassignment — see app.js.
export function bumpConfigGeneration() {
  S.configGeneration++;
}

// One listener (the setup screen's undo/redo buttons) told whenever what
// canUndo/canRedo/undoLabel would return may have changed. state.js stays
// DOM-free; the listener decides what to redraw.
let historyListener = null;
export function onHistoryChange(fn) {
  historyListener = fn;
}
function notifyHistory() {
  if (!historyListener) return;
  try { historyListener(); } catch (e) { console.warn('[history] listener failed', e); }
}

function pushHistory(entry) {
  undoStack.push(entry);
  if (undoStack.length > MAX_UNDO_ENTRIES) undoStack.shift();
  redoStack.length = 0;
}

function inverseOfPatch(patch) {
  return [{ type: 'config.patch', ops: patch.undo, undo: patch.ops }];
}

// Turns pending in-place edits into history. Cheap when nothing is pending.
function settlePlainEdits(label) {
  if (!pendingPlain) return;
  const tracked = pendingPlainTracked;
  pendingPlain = false;
  pendingPlainTracked = false;
  if (baseline == null) {
    baseline = cloneJson(S.config);
    return;
  }
  const { ops, undo } = diffJson(baseline, S.config);
  if (!ops.length) return;
  applyPatch(baseline, ops);
  if (!tracked) return;
  const command = label ? { type: 'config.patch', ops, undo, label } : { type: 'config.patch', ops, undo };
  pushHistory({ label: describeCommand(S.config, command), commands: [command], inverses: inverseOfPatch(command), at: Date.now() });
  notifyHistory();
}

function writeConfigSoon(delay) {
  clearTimeout(S.saveConfigTimer);
  setSaveIndicator('saving');
  S.saveConfigTimer = setTimeout(() => {
    S.saveConfigTimer = null;
    settlePlainEdits();
    window.api.saveConfig(S.config, hostRevision).then(() => setSaveIndicator('saved'));
  }, delay == null ? 600 : delay);
}

function writeConfigNow() {
  clearTimeout(S.saveConfigTimer);
  S.saveConfigTimer = null;
  setSaveIndicator('saving');
  return window.api.saveConfig(S.config, hostRevision).then((result) => { setSaveIndicator('saved'); return result; });
}

// For the few places that must reach disk before continuing (first-run
// onboarding, an import, a window-recreating setting) — the same save as the
// debounced path, including the host revision, so the host can replay any
// edit of its own this copy hasn't seen yet instead of losing it.
export function saveConfigNow() {
  return writeConfigNow();
}

// ---------- Host updates ----------
// The host process applies some edits itself (plugin approval, enable/disable,
// uninstall, headless Companion settings — main/config-host.js) and sends each
// one here as { revision, commands }. They are applied to S.config and to the
// baseline (so they never show up as an undoable edit of this screen's), and
// hostRevision records the newest one applied, which every save reports.
//
// hostRevision only ever advances when an update has actually been APPLIED
// here. Taking it from a save's reply instead would be wrong: if that reply
// arrived before the update's own broadcast, the update would then be ignored
// as already seen, and the next save would quietly revert it.
let hostRevision = 0;

export function getHostRevision() {
  return hostRevision;
}

export function applyHostUpdate(update) {
  if (!update || !Number.isInteger(update.revision) || update.revision <= hostRevision) return false;
  (update.commands || []).forEach((cmd) => {
    // Applying a host command twice is harmless (they only set values); one
    // that no longer fits this copy is skipped rather than failing the rest.
    try { applyCommand(S.config, cmd); } catch (e) { console.warn('[host update] skipped for S.config:', e.message); }
    if (baseline) {
      try { applyCommand(baseline, cmd); } catch (e) { /* the baseline is re-derived on the next reset */ }
    }
  });
  hostRevision = update.revision;
  bumpConfigGeneration();
  return true;
}

// After a fresh load, adopt the host's current revision: the loaded config
// already contains every host edit up to it. Only moves forward.
function syncHostRevisionAfterLoad() {
  if (typeof window === 'undefined' || !window.api || typeof window.api.getConfigRevision !== 'function') return;
  Promise.resolve(window.api.getConfigRevision()).then((revision) => {
    if (Number.isInteger(revision) && revision > hostRevision) hostRevision = revision;
  }).catch(() => {});
}

if (typeof window !== 'undefined' && window.api && typeof window.api.onConfigApplied === 'function') {
  window.api.onConfigApplied((update) => applyHostUpdate(update));
}

// `opts.skipUndo` is for writes that are real config state but not a
// meaningful "edit" to step back through — S.config.lastChannel on every tune,
// air checks, library-sync bookkeeping. Without it, casually surfing channels
// between setup-screen visits would bury actual setup edits under a pile of
// "last channel changed" undo steps. A skipUndo write that lands inside the
// same burst as a real edit is part of that edit's step, as before.
export function saveConfigDebounced(delay, opts) {
  // Fires synchronously, right when the in-place mutation that triggered
  // this call actually happened — not inside the debounced timeout below,
  // which only runs once, after the last of a burst of edits. A cache keyed
  // on configGeneration needs to see the bump immediately, before whatever
  // re-render the caller does next reads the (already mutated) config.
  bumpConfigGeneration();
  pendingPlain = true;
  if (!(opts && opts.skipUndo)) pendingPlainTracked = true;
  writeConfigSoon(delay);
  notifyHistory();
}

// For transforms that rewrite many parts of config at once in place — applying
// a curation proposal, renaming a tag on every file, a library resync, an
// imported channel package, a folder relink across channels. What changed since
// the last settle point becomes one config.patch step, named by `label`, right
// away rather than when the save fires. The one sanctioned structural patch
// left in the renderer; per-object edits use named commands (dispatch,
// commitInPlace). opts: skipUndo, delay, as saveConfigDebounced.
export function commitConfigPatch(label, opts = {}) {
  bumpConfigGeneration();
  pendingPlain = true;
  if (!opts.skipUndo) pendingPlainTracked = true;
  settlePlainEdits(label);
  writeConfigSoon(opts.delay);
  notifyHistory();
}

// Applies named command(s) as one undo step and saves.
//   opts.label      overrides the command's own description
//   opts.coalesce   key; merges into the previous step if it had the same key
//                   and was recorded within COALESCE_WINDOW_MS
//   opts.skipUndo   apply and save without a history entry
//   opts.delay      save debounce, as saveConfigDebounced
// Throws, changing nothing, if any command fails validation.
export function dispatch(commandOrList, opts = {}) {
  const commands = Array.isArray(commandOrList) ? commandOrList : [commandOrList];
  settlePlainEdits();
  if (baseline == null) baseline = cloneJson(S.config);
  // A batch is validated against a scratch copy first, so it is all or
  // nothing. A single command needs no copy: applyCommand validates before it
  // touches anything, and cloning the whole config on every keystroke of a
  // rename would be felt.
  if (commands.length > 1) {
    const scratch = cloneJson(S.config);
    commands.forEach((cmd) => applyCommand(scratch, cmd));
  }
  const inverses = [];
  commands.forEach((cmd) => {
    inverses.push(...applyCommand(S.config, cmd));
    applyCommand(baseline, cmd);
  });
  recordApplied(commands, inverses, opts);
  return true;
}

// History, generation, save and listeners for commands already applied to
// S.config and the baseline.
function recordApplied(commands, inverses, opts) {
  bumpConfigGeneration();
  if (!opts.skipUndo) {
    const now = Date.now();
    const top = undoStack[undoStack.length - 1];
    if (opts.coalesce && top && top.coalesce === opts.coalesce && now - top.at < COALESCE_WINDOW_MS && !redoStack.length) {
      top.commands.push(...commands);
      top.inverses.push(...inverses);
      top.at = now;
    } else {
      pushHistory({
        label: opts.label || describeCommand(S.config, commands[0]),
        commands,
        inverses,
        coalesce: opts.coalesce || null,
        at: now,
      });
    }
  }
  writeConfigSoon(opts.delay);
  notifyHistory();
}

// Records edits the UI has already made in place, as named commands. Editors
// that keep references to the live objects they edit (a rule row, a flow's
// cadence, an array they hand back) can't go through dispatch(), which would
// copy the new values in and leave the editor holding detached objects. Here
// S.config is left exactly as it is: each command, describing the value as it
// now stands, is applied only to the baseline, and what that returns is the
// undo. A command that changes nothing in the baseline is dropped. Returns
// whether anything was recorded; if it can't be (no baseline, or the command
// doesn't fit), the edit is saved as a plain edit instead.
export function commitInPlace(commandOrList, opts = {}) {
  const commands = Array.isArray(commandOrList) ? commandOrList : [commandOrList];
  settlePlainEdits();
  if (baseline == null) {
    saveConfigDebounced(opts.delay, { skipUndo: opts.skipUndo });
    return false;
  }
  const inverses = [];
  const kept = [];
  try {
    if (commands.length > 1) {
      const scratch = cloneJson(baseline);
      commands.forEach((cmd) => applyCommand(scratch, cmd));
    }
    commands.forEach((cmd) => {
      const inverse = applyCommand(baseline, cmd);
      if (JSON.stringify(inverse) === JSON.stringify([cmd])) return; // already the baseline's value
      kept.push(cmd);
      inverses.push(...inverse);
    });
  } catch (e) {
    console.warn('[history] in-place edit kept as a plain edit:', e.message);
    saveConfigDebounced(opts.delay, { skipUndo: opts.skipUndo });
    return false;
  }
  if (!kept.length) {
    writeConfigSoon(opts.delay);
    return false;
  }
  recordApplied(kept, inverses, opts);
  return true;
}

// commitInPlace for list items (ad pool entries, presets, flows — commands.js
// COLLECTIONS) edited directly: `pairs` is [item, before] or a list of them,
// `before` a cloneJson copy taken before the edit, used to find which
// top-level fields changed. Items that changed nothing are skipped.
export function commitItemEdit(collection, pairs, opts = {}) {
  const list = Array.isArray(pairs[0]) ? pairs : [pairs];
  const commands = [];
  list.forEach(([item, before]) => {
    const change = itemFieldChanges(before, item);
    if (!change) return;
    commands.push(opts.channel != null
      ? { type: 'item.set', collection, channel: opts.channel, id: item.id, fields: change.fields }
      : { type: 'item.set', collection, id: item.id, fields: change.fields });
  });
  if (!commands.length) return false;
  return commitInPlace(commands, opts);
}

// Replaces history's starting point with the config as it is now — after an
// import, a restore, or the DONE flush, where "undo" past that point isn't a
// meaningful single edit.
export function resetUndoBaseline() {
  baseline = cloneJson(S.config);
  undoStack.length = 0;
  redoStack.length = 0;
  pendingPlain = false;
  pendingPlainTracked = false;
  bumpConfigGeneration();
  notifyHistory();
  syncHostRevisionAfterLoad();
}

// For the rare call sites that replace S.config wholesale and persist it
// themselves outside saveConfigDebounced (backup restore, which the main
// process writes straight to disk) — records the replacement as one undo
// step. Must be called AFTER S.config has been reassigned to the new value.
export function pushUndoSnapshot() {
  const after = cloneJson(S.config);
  if (baseline != null) {
    // A copy of `after`, never the object itself: it becomes the new baseline,
    // which is patched in place from here on, and a history entry must not
    // change under it. (The old baseline object is retired, so it's safe.)
    const command = { type: 'config.patch', ops: [{ p: [], v: cloneJson(after) }], undo: [{ p: [], v: baseline }], label: 'Restore backup' };
    pushHistory({ label: 'Restore backup', commands: [command], inverses: inverseOfPatch(command), at: Date.now() });
  }
  baseline = after;
  pendingPlain = false;
  pendingPlainTracked = false;
  bumpConfigGeneration();
  notifyHistory();
}

export function canUndo() { return undoStack.length > 0 || (pendingPlain && pendingPlainTracked); }
// A pending undoable edit will clear redo the moment it settles.
export function canRedo() { return redoStack.length > 0 && !(pendingPlain && pendingPlainTracked); }

// "Rename CH 7", for the undo/redo buttons' tooltips; null when there's none.
// Read-only on purpose: settling here would split an in-progress burst of
// edits into several steps, since the buttons refresh on a timer.
export function undoLabel() {
  if (pendingPlain && pendingPlainTracked) return 'Recent edit';
  return undoStack.length ? undoStack[undoStack.length - 1].label : null;
}
export function redoLabel() {
  return redoStack.length ? redoStack[redoStack.length - 1].label : null;
}

// Returns true if a step was actually applied — callers use this to decide
// whether to re-render the setup screen (state.js has no notion of the DOM).
export function performUndo() {
  settlePlainEdits();
  if (!undoStack.length) return false;
  const entry = undoStack.pop();
  for (let i = entry.inverses.length - 1; i >= 0; i--) {
    applyCommand(S.config, entry.inverses[i]);
    applyCommand(baseline, entry.inverses[i]);
  }
  redoStack.push(entry);
  bumpConfigGeneration();
  writeConfigNow();
  notifyHistory();
  return true;
}

export function performRedo() {
  settlePlainEdits();
  if (!redoStack.length) return false;
  const entry = redoStack.pop();
  const inverses = [];
  entry.commands.forEach((cmd) => {
    inverses.push(...applyCommand(S.config, cmd));
    applyCommand(baseline, cmd);
  });
  entry.inverses = inverses;
  undoStack.push(entry);
  bumpConfigGeneration();
  writeConfigNow();
  notifyHistory();
  return true;
}

// Every "what's airing" calculation reads the clock through viewNow() rather
// than Date.now(), so shifting one offset moves playback, the guide,
// dayparting and the on-screen clocks together. Channel anchors deliberately
// keep using real Date.now() — they record when a folder was scanned.
export function viewNow() {
  return Date.now() + S.timeOffsetMs;
}
