import { applyCommand, applyPatch, cloneJson, describeCommand, diffJson, hostCommandsFor, itemFieldChanges } from './commands.js';
import { StatusBar } from '../ui/toast.js';

// Shared mutable runtime state. Modules read and write through S so the
// ownership of cross-cutting values (what channel is tuned, whether the box
// is powered on, how far the viewing clock is shifted) stays in one place.
export const S = {
  config: { channels: [] },
  personalProfile: null,
  personalProfiles: [],
  personalClients: [],
  sharedSession: null,
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
  // The time machine's scrubber moved the viewed time (◀▶/▲▼ in TV mode, a
  // pointer on the strip, a Go to… jump) and it hasn't been committed with
  // OK/Enter/T yet. Cleared by stopShuttle (timemachine.js).
  scrubPending: false,
  guideWindowStart: 0,
  // The guide's selected row, as a channel number (special channels included)
  // rather than a row index, so filtering or the specials moving never shifts
  // the highlight onto a different channel (guide-model.js).
  guideSelNumber: null,
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
let saveStatusBar = null;
function setSaveIndicator(state) {
  if (!saveStatusBar) {
    const el = document.getElementById('setup-save-state');
    if (!el) return;
    saveStatusBar = StatusBar({ saveEl: el });
  }
  saveStatusBar.setSaveState(state);
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

// Told whenever any config-changing operation lands — a named command, a
// whole-config patch, or a plain debounced save — so a listener can redraw
// whatever it owns. state.js stays DOM-free; every listener decides what to
// redraw. Originally just the setup screen's undo/redo buttons; eras.js
// (docs/design/10) also needs it, since a hand-edit of one of the active
// era's own settings (say, toggling CRT off) only reaches an era-level
// "override" through the generic settings.set path, not through eras.js's
// own apply/clear, so the ERA panel has no other way to notice.
const historyListeners = new Set();
export function onHistoryChange(fn) {
  historyListeners.add(fn);
  return () => historyListeners.delete(fn);
}
function notifyHistory() {
  historyListeners.forEach((fn) => { try { fn(); } catch (e) { console.warn('[history] listener failed', e); } });
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
  const command = label ? { type: 'config.patch', ops, undo, label } : { type: 'config.patch', ops, undo };
  // Built whether or not it becomes an undo step: `tracked` says whether the
  // user should be able to step back through this burst, not whether the host
  // needs to hear about it. A skipUndo burst (last channel, air checks) is
  // still a real config change that has to reach disk.
  enqueueOutbound([command]);
  if (!tracked) return;
  pushHistory({ label: describeCommand(S.config, command), commands: [command], inverses: inverseOfPatch(command), at: Date.now() });
  notifyHistory();
}

// ---------- Sending edits to the host (docs/design/05 §2.2, step 6) ----------
// The host process owns config. This renderer applies each edit to S.config
// optimistically — that is what every screen reads — and then posts the
// command(s) that made it, with the revision they were built against and an
// id of this client's own. The host is the single writer: it decides whether
// a batch merges with what another editor did, and every client (this one
// included) hears the result on config:applied.
//
// A whole-config save survives for the few edits no command describes: an
// import, a backup restore, the DONE flush, a setting that recreates the
// window. It is also how a session FIRST agrees with the host, which matters
// because this renderer runs applyConfigDefaults() over the config it loads
// and the host does not: until those defaults have reached disk once, a
// command naming a defaulted section would not find it there. So the first
// write of a session is a whole-config save (exactly what every write used to
// be), and every write after it is commands.
const clientId = `r${Math.random().toString(36).slice(2, 10)}`;
export function getClientId() { return clientId; }

// Commands applied locally and not yet acknowledged by the host.
let outbound = [];
// The batch currently posted, kept so a failed post can be retried with the
// same id — the host answers a redelivery instead of applying it twice.
let inFlight = null;
let hostAgreed = false;
let resyncing = null;

// Told whenever S.config changed because of something that did not happen on
// this screen: another editor's command arriving over config:applied, or this
// client being resynced after the host refused a batch. The open screen
// re-renders from it; state.js itself stays DOM-free.
//
//   reason: 'host-update'  another client (or the host) edited config
//           'conflict' | 'stale-reset' | 'stale-window' | 'invalid' | 'read-only'
//                          this client was rebuilt from the host's copy, and
//                          its undo history is gone with it
let remoteChangeListener = null;
export function onRemoteConfigChange(fn) {
  remoteChangeListener = fn;
}

function notifyRemoteChange(reason) {
  if (!remoteChangeListener) return;
  try { remoteChangeListener(reason); } catch (e) { console.warn('[config] remote-change listener failed', e); }
}

function nextBatchId() {
  return `${clientId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// Records commands for the host. They are already applied to S.config, which is
// why the translation below can read the result: a plugin's own command travels
// as the settings it produced, because the host has no plugin renderers and
// would not know the type (commands.js's hostCommandsFor).
function enqueueOutbound(commands) {
  if (!commands || !commands.length) return;
  commands.forEach((cmd) => outbound.push(...hostCommandsFor(S.config, cmd)));
}

// The host refused a batch, or answered something this client can't reconcile
// against. Its copy is authoritative, so take it whole, drop the local history
// (the steps in it describe a config that no longer exists) and let the open
// screen redraw. Deliberately not a fine-grained rollback: touch-set conflict
// detection does not promise that the intervening commands commute with the
// refused ones, so unwinding around them would be guesswork.
export function resyncFromHost(reason) {
  if (resyncing) return resyncing;
  resyncing = Promise.resolve(window.api.getConfigSnapshot()).then((snapshot) => {
    const fresh = snapshot && snapshot.config;
    if (!fresh || fresh._configLoadError) return false;
    outbound = [];
    inFlight = null;
    hostAgreed = false;
    S.config = fresh;
    baseline = cloneJson(S.config);
    undoStack.length = 0;
    redoStack.length = 0;
    pendingPlain = false;
    pendingPlainTracked = false;
    // From the same reply as the config, so no update is applied twice or
    // skipped across the gap a second round trip would open.
    hostRevision = Number.isInteger(snapshot.revision) ? snapshot.revision : 0;
    bumpConfigGeneration();
    notifyHistory();
    notifyRemoteChange(reason);
    return true;
  }).catch((e) => {
    console.error('[config] could not resync from the host:', e);
    return false;
  }).finally(() => { resyncing = null; });
  return resyncing;
}

function handleRefusal(result) {
  console.warn(`[config] the host refused an edit (${result.reason}): ${result.message}`);
  setSaveIndicator('saved');
  return resyncFromHost(result.reason).then(() => false);
}

// Sends everything applied since the last flush. One batch is in flight at a
// time, so the host sees this client's edits in the order they were made.
function flushCommands() {
  if (inFlight || resyncing) return Promise.resolve(false);
  settlePlainEdits();
  if (!outbound.length) return Promise.resolve(true);

  // First write of the session (or the first after a resync): send the whole
  // config, which carries these commands' effects along with any defaults the
  // host's copy has never been told about. See the note above.
  if (!hostAgreed) {
    const pending = outbound;
    outbound = [];
    setSaveIndicator('saving');
    return Promise.resolve(window.api.saveConfig(S.config, hostRevision, clientId)).then((result) => {
      if (result && result.ok === false) {
        // A client that has no whole-config save at all — the LAN control
        // panel, which only has the command endpoint — cannot do this step.
        // Send the commands instead. It does not need it either: it loaded its
        // config from the host, so there are no locally-applied defaults the
        // host has never seen.
        if (result.reason === 'unsupported') {
          hostAgreed = true;
          outbound = pending.concat(outbound);
          return flushCommands();
        }
        return handleRefusal(result);
      }
      hostAgreed = true;
      setSaveIndicator('saved');
      return true;
    }).catch((e) => {
      console.error('[config] save failed:', e);
      setSaveIndicator('saved');
      return false;
    });
  }

  inFlight = { id: nextBatchId(), commands: outbound };
  outbound = [];
  setSaveIndicator('saving');
  return Promise.resolve(window.api.applyConfigCommands(inFlight.commands, {
    id: inFlight.id, baseRevision: hostRevision, client: clientId, source: 'renderer',
  })).then((result) => {
    inFlight = null;
    if (result && result.ok === false) return handleRefusal(result);
    // The revision itself is adopted from the config:applied echo rather than
    // from here — see applyHostUpdate.
    setSaveIndicator('saved');
    return outbound.length ? flushCommands() : true;
  }).catch((e) => {
    // The post never completed. Put it back at the front with the same id;
    // if it did in fact reach the host, the redelivery is deduped there.
    console.error('[config] could not send an edit to the host:', e);
    if (inFlight) outbound = inFlight.commands.concat(outbound);
    inFlight = null;
    setSaveIndicator('saved');
    return false;
  });
}

function writeConfigSoon(delay) {
  clearTimeout(S.saveConfigTimer);
  setSaveIndicator('saving');
  S.saveConfigTimer = setTimeout(() => {
    S.saveConfigTimer = null;
    flushCommands();
  }, delay == null ? 600 : delay);
}

// Sends pending edits right now rather than on the debounce. Used by undo and
// redo, where what the user does next may depend on the edit having landed.
function writeConfigNow() {
  clearTimeout(S.saveConfigTimer);
  S.saveConfigTimer = null;
  return flushCommands();
}

// For the few places that must reach disk as a WHOLE config before continuing
// (first-run onboarding, an import, a restore, the DONE flush, a setting that
// recreates the window). Pending commands settle into it first so nothing is
// sent twice, then the whole object goes over, carrying any edit no command
// describes. The host replays its own edits onto it, and refuses it outright
// if it would bury another client's command.
export function saveConfigNow() {
  clearTimeout(S.saveConfigTimer);
  S.saveConfigTimer = null;
  settlePlainEdits();
  outbound = [];
  setSaveIndicator('saving');
  return Promise.resolve(window.api.saveConfig(S.config, hostRevision, clientId)).then((result) => {
    if (result && result.ok === false) {
      // Nothing to fall back to here: these callers (import, restore, the DONE
      // flush) genuinely need the whole object to land.
      if (result.reason === 'unsupported') {
        console.warn('[config] this client cannot save a whole config; the edit stays local until it is made on the host.');
        setSaveIndicator('saved');
        return result;
      }
      return handleRefusal(result);
    }
    hostAgreed = true;
    setSaveIndicator('saved');
    return result;
  });
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
  // This client's own batch, coming back around. It was applied optimistically
  // before it was ever sent, and not every command is idempotent — an
  // item.insert applied twice inserts twice — so take only the revision from
  // it (docs/design/05 §6, "double application").
  if (update.client && update.client === clientId) {
    hostRevision = update.revision;
    return false;
  }
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
  notifyRemoteChange('host-update');
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
  enqueueOutbound(commands);
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
  outbound = [];
  hostAgreed = false;
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
  // The host wrote this config itself (a backup restore) and noted the reset,
  // so anything still queued here was built against the config it replaced.
  outbound = [];
  hostAgreed = false;
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
  const applied = [];
  for (let i = entry.inverses.length - 1; i >= 0; i--) {
    applyCommand(S.config, entry.inverses[i]);
    applyCommand(baseline, entry.inverses[i]);
    applied.push(entry.inverses[i]);
  }
  // Undo is itself a batch of commands sent to the host, in the order it
  // applied them, so another editor sees the step come back out (docs/design/05 §2.5).
  enqueueOutbound(applied);
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
  enqueueOutbound(entry.commands);
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
