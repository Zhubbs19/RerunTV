import { playChannelClickSound, playConfiguredSound, sfxChannelChange } from './audio.js';
import {
  channelColor, getChannel, isVideoMediaPath, logoBugProfileDimensions, LOGO_MOTION_PRESETS,
  parseMediaRef, pickLogoBugProfile, sortedChannels,
} from './channels.js';
import { clearDynamicOverlaysForBreak, hideDynamicOverlay, triggerDynamicOverlays } from './dynamic-overlays.js';
import {
  crtToggleFlash, dynamicBumperTextEl, guideGrid, guideOverlay, logoBugEl, logoBugGhostEl, noSignalChannelEl, noSignalEl, noSignalMainEl, player,
  ratingBugEl, staticCanvas, staticCtx, stationIdBarEl, stationIdNameEl, testPatternCanvasEl,
  triviaCardEl, triviaTextEl, upNextBarEl, upNextTitleEl,
} from './dom.js';
import { applyDisplayMode, cacheVideoSize, resolveContentDisplayMode, resolveEffectiveDisplayMode } from './display-mode.js';
import { showGuideOverlay } from './guide.js';
import { nextBreakBoundary, resolveBreakAt } from './interstitials.js';
import { tuneTimingEnabled } from './perf.js';
import { applyBlockTheme, applyChannelIdentity, applyTvBezel, applyVhsQuality, applyVolume, powerOff, pushRemoteState } from './power.js';
import { cancelAllInterrupts, getThemePack, runCoreHooks, scheduleAllInterrupts, tuneGateEntries } from './plugins.js';
import {
  computeSourcePosition, isWithinBroadcastHours, nextBlockStartMs, nextBroadcastHoursBoundary, nextSourceBoundary,
  resolveActiveSource,
} from './schedule.js';
import { S, saveConfigDebounced, viewNow } from './state.js';
import { exitTimeMachine, stopShuttle, updateTimeShiftBadge, updateVcrOsd } from './timemachine.js';
import {
  autoHideAfter, formatClock, formatHourLabel, getDisplayTitle, isEnabledByDefault,
} from './util.js';
import { getVirtualBadge, hideVirtualChannels, isVirtualChannel, showVirtualChannel, virtualChannelNumbers } from './virtual.js';
import { waitForMediaSourceReady as waitForProviderMediaSource } from './playback-recovery.js';
import { channelIdentity, effectiveThemeId } from './broadcast-identity.js';

// Same shape as computeLivePosition, but content playback lags real time by
// however many ms it's been paused through breaks on this source so far
// (S.contentLostMs) — this is what makes a show resume where it left off
// after a commercial instead of skipping ahead by the break's length. Only
// used for the actual live tune-in position; break *timing* itself
// (resolveBreakAt/nextBreakBoundary) deliberately keeps using real wall
// time, so ad cadence doesn't drift.
function computeLiveContentPosition(ch) {
  const source = resolveActiveSource(ch, viewNow());
  const key = `${ch.number}:${source.key}`;
  if (S.contentLostKey !== key) { S.contentLostKey = key; S.contentLostMs = 0; }
  return computeSourcePosition(source, viewNow());
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// Stops and blanks the player element: pause, drop the src, force a real
// reload (removeAttribute alone doesn't make Chromium actually drop its
// last painted frame — found live via the "COMING SOON shows the previous
// channel's frozen frame" bug), and reset loop. Extracted here after the
// same four lines with an identical inline comment turned up copy-pasted
// across five call sites (found in review) — every "nothing to show right
// now" branch in tuneToChannel plus waitForMediaSourceReady.
function clearPlayerToBlank() {
  player.pause();
  player.removeAttribute('src');
  player.load();
  player.loop = false;
}

// Optional, provider-defined verb (mediaSource:<id>:getFetchProgress, called
// via the same generic callMediaSourceHook passthrough CHOOSE SOURCE's
// pickFolder/a plugin's own settings panel already use) — lets a provider
// whose readRange can genuinely take a long time (e.g. a provider that
// lazily caches to local disk before it can serve anything) report a real
// progress fraction instead of the tune just sitting there with no visible
// feedback while readRange blocks underneath. Returns
// { ok:false } for a provider that doesn't implement this, or on any error
// calling it — the caller decides what that means (see waitForMediaSourceReady:
// "not implemented" on the very first call means proceed straight to
// playback, same as always; a transient failure mid-poll must NOT be read
// the same way, or one flaky RPC call turns a file that's still genuinely
// downloading into a premature, wrong failure).
// Called from handleUnplayable below, as a plugin-sourced file's own
// recovery path once a genuine live playback attempt has already failed to
// decode a frame — not an eager pre-check (a live attempt is always tried
// first for every file, local or plugin-sourced, same as any other
// channel). Polls the provider's fetch progress (if it reports any) and
// shows a visible "please wait" card — same cyan, same visual language as
// the local TRANSCODING… card — instead of leaving the screen on static/a
// stale frame with zero explanation for however long caching takes. Clears
// the player first (pause/removeAttribute/load) for the same reason the
// COMING SOON and sign-off/blocked cards do: without it, whatever the
// previous channel was showing sits frozen underneath this card's
// transparent background. Returns false if the tune was abandoned (channel
// changed / powered off) while waiting, so the caller knows not to proceed
// with this now-stale playback attempt.
async function waitForMediaSourceReady(ch, file) {
  return waitForProviderMediaSource(ch, file, {
    clearPlayer: clearPlayerToBlank,
    isActive: () => S.currentNumber === ch.number && S.isPoweredOn,
    markVisualReady: markStaticReady,
    showStatus: showNoSignal,
    clearStatus: () => noSignalEl.classList.add('hidden'),
  });
}

export async function playChannelLive(ch, opts) {
  opts = opts || {};
  window.__tuneT0 = performance.now();
  if (tuneTimingEnabled()) console.log(`[tune] CH${ch.number} start`);
  applyBlockTheme(resolveActiveSource(ch, viewNow()).block);
  applyVhsQuality(ch);
  const pos = computeLiveContentPosition(ch);
  // pos.offset is captured here, before async IPC. Re-read it fresh inside
  // onMeta so the seek lands at the correct position after the round-trip.
  const posFile = pos && pos.file;
  if (!pos || !pos.file) {
    markStaticReady(); // nothing's coming — don't let held static dim out the NO SIGNAL card
    const copy = channelNoSignalCopy(ch, 'NO MEDIA FOUND', 'CH {channel} — NO PLAYABLE FILES IN FOLDER');
    showNoSignal(copy.title, copy.message, 'nosignal');
    return;
  }
  const file = pos.file;

  // Re-applied for real once metadata is confirmed (onMeta below) — this
  // early call exists only to avoid sitting at a STALE previous-channel
  // frame size while this tune's own video is still loading. Unlike a plain
  // guess (which used to live here and caused a visible "jumps to wrong
  // crop, then snaps to right" flash on every tune — found live), this is
  // now safe to call early: AUTO mode's own videoSizeCache (state.js,
  // display-mode.js) means a file that's aired before this session gets its
  // REAL, confirmed size immediately, not a guess. Only a genuinely
  // never-before-seen file can still guess wrong here (falling through to
  // the era/default cascade) — a one-time cost per file, not per tune.
  applyDisplayMode();

  let resolved, url;
  try {
    resolved = await window.api.resolvePlayablePath(file.source || 'local', file.path);
    if (tuneTimingEnabled()) console.log(`[tune] CH${ch.number} resolvePlayablePath +${(performance.now() - window.__tuneT0).toFixed(0)}ms`);
    url = await window.api.toFileUrl(resolved.path);
    if (tuneTimingEnabled()) console.log(`[tune] CH${ch.number} toFileUrl +${(performance.now() - window.__tuneT0).toFixed(0)}ms`);
  } catch (err) {
    markStaticReady();
    showNoSignal('FILE ERROR', `CH ${ch.number} — FAILED TO RESOLVE MEDIA FILE`, 'error');
    return;
  }

  if (S.currentNumber !== ch.number || !S.isPoweredOn) { markStaticReady(); return; }

  if (S.endedHandler) player.removeEventListener('ended', S.endedHandler);
  if (S.errorHandler) player.removeEventListener('error', S.errorHandler);

  // Some bad-codec files (e.g. MPEG-4 Part 2 muxed as .mp4) never raise an
  // `error` event at all — Chromium demuxes the container and reads
  // metadata/duration fine, then just silently produces no decoded video
  // frames. So "no error" doesn't mean "playing"; confirm a frame actually
  // decodes. `handled` guards against the error event and the frame
  // watchdog both firing for the same failure.
  let handled = false;

  async function handleUnplayable() {
    if (handled || S.currentNumber !== ch.number || !S.isPoweredOn) return;
    handled = true;

    // Live playback (the default, first attempt for every file — local or
    // plugin-sourced alike) failed for a plugin-sourced file that hasn't
    // been through caching yet — resolved.transcodable === false is
    // exactly what resolvePlayablePath (main.js) returns for a still-live
    // ref its provider hasn't fully cached to local disk. Try caching as
    // this source's own "fix" (waitForMediaSourceReady shows its own
    // progress card and waits), then retry playback fresh once ready —
    // same idea as a local codec issue triggering auto-transcode below,
    // just a different kind of fix for a different kind of problem.
    // Guarded by opts.cacheRetried so a file that's STILL unplayable even
    // once genuinely cached (a real codec issue on top of everything else,
    // or a provider whose caching itself never succeeds) falls through to
    // the normal transcode-or-give-up logic exactly once, not forever.
    if (!opts.cacheRetried && file.source && file.source !== 'local' && resolved.transcodable === false) {
      const ready = await waitForMediaSourceReady(ch, file);
      if (!ready) return; // tuned away while waiting
      playChannelLive(ch, { ...opts, cacheRetried: true });
      return;
    }

    // Every branch below either shows a NO SIGNAL-style card or a
    // multi-second TRANSCODING… status — none of them are "content is about
    // to appear," so release the static hold immediately rather than
    // dimming over that card until STATIC_MAX_HOLD_MS expires.
    markStaticReady();
    const base = await window.api.basename(file.path);

    // Tracks consecutive failures for this channel across attempts so a
    // single bad file (transient) reads differently from a channel where
    // every file is broken (a real "off the air" state) — resets to 0 the
    // moment any attempt actually decodes a frame (see onMeta below).
    const streak = (S.channelFailStreak[ch.number] || 0) + 1;
    S.channelFailStreak[ch.number] = streak;
    const isPermanent = streak >= 3;

    if (resolved.alreadyFixed) {
      if (isPermanent) {
        showNoSignal('OFF THE AIR', `CH ${ch.number} — TECHNICAL DIFFICULTIES. RUN FIX PLAYBACK IN SETUP.`, 'offair');
      } else {
        showNoSignal('PLAYBACK ERROR', `CH ${ch.number} — ${base.toUpperCase()}`, 'error');
      }
      return;
    }

    // Reached either for opts.cacheRetried (already tried the cache-fallback
    // above once, still no local copy to work with) or a plugin source with
    // no caching support at all (getLocalCachePath unimplemented) — a
    // genuinely last-resort case, not the common path for a working
    // media-source plugin. resolvePlayablePath (main.js) marks this
    // explicitly rather than leaving it to fail inside transcodeVideo — no
    // local file for the transcode rename-swap dance to operate on.
    if (resolved.transcodable === false) {
      showNoSignal('PLAYBACK ERROR', `CH ${ch.number} — ${base.toUpperCase()}: FILE FROM A PLUGIN MEDIA SOURCE CAN'T BE AUTO-FIXED`, 'error');
      return;
    }

    showNoSignal('TRANSCODING…', `CH ${ch.number} — ${base.toUpperCase()} (ONE-TIME FIX, PLEASE WAIT)`, 'transcoding');

    // player.src still points at this exact file — Chromium's media pipeline
    // holds it open even after failing to produce a decodable frame (it did
    // successfully open the container to read metadata). Windows refuses to
    // rename a file with an open handle (unlike POSIX), so main.js's rename
    // of srcPath -> backupPath would intermittently throw here if left
    // pointed at it, leaving a wasted *.transcoded.mp4 sitting on disk with
    // the original never actually fixed. Release the handle first.
    player.removeAttribute('src');
    player.load();

    // window.api.transcode's IPC call can itself reject (a main-process
    // throw outside the handler's own try/catch, e.g. recoverPendingSwap
    // hitting an edge case) — without this, that would leave the
    // TRANSCODING… card on screen forever instead of surfacing an error.
    // resolved.path (not file.path) is what's actually open in the player —
    // for a media-source plugin file resolvePlayablePath (main.js)
    // redirected to a fully cached local copy, that's the real local cache
    // path, not the channel config's original (still-plugin-sourced)
    // reference. The transcodable === false early-return above guarantees
    // resolved.transcodable is true by this point, so this is always a
    // genuine local file — 'local' unconditionally, not file.source.
    let result;
    try {
      result = await window.api.transcode('local', resolved.path);
    } catch (err) {
      result = { error: (err && err.message) || 'transcode call failed' };
    }
    if (S.currentNumber !== ch.number) return; // user tuned away meanwhile

    if (result.error) {
      if (isPermanent) {
        showNoSignal('OFF THE AIR', `CH ${ch.number} — TECHNICAL DIFFICULTIES. RUN FIX PLAYBACK IN SETUP.`, 'offair');
      } else {
        showNoSignal('PLAYBACK ERROR', `CH ${ch.number} — ${base.toUpperCase()}: ${result.error.slice(0, 140)}`, 'error');
      }
      return;
    }

    noSignalEl.classList.add('hidden');
    // Propagate the original opts (fadeInOnReady in particular) — found in
    // review: this retry used to call playChannelLive(ch) bare, silently
    // dropping whatever gate the ORIGINAL tune was called with. A tune that
    // started via a break transition (endBreak's fadeInOnReady: true) and
    // then needed a transcode fix would resume without its fade-in, a
    // real (if narrow) visible-transition regression.
    playChannelLive(ch, opts);
  }

  function watchForDecodedFrame() {
    if (handled || typeof player.requestVideoFrameCallback !== 'function') {
      // No frame-callback support — fall back to revealing right away
      // rather than leaving the screen faded indefinitely.
      if (opts.fadeInOnReady) fadeInPlayer();
      markStaticReady();
      return;
    }
    let gotFrame = false;
    const cbId = player.requestVideoFrameCallback(() => {
      gotFrame = true;
      if (tuneTimingEnabled()) console.log(`[tune] CH${ch.number} first decoded frame +${(performance.now() - window.__tuneT0).toFixed(0)}ms`);
      // First real decoded frame of the resumed content — the actual
      // "ready" signal fadeInOnReady callers (endBreak) want, instead of
      // revealing as soon as src is set while the video is still seeking.
      // Also the tuning static's own "ready" signal — this is the earliest
      // point a channel change actually has something to show.
      if (opts.fadeInOnReady) fadeInPlayer();
      markStaticReady();
    });
    setTimeout(() => {
      if (!gotFrame) {
        try { player.cancelVideoFrameCallback(cbId); } catch (e) {}
        if (opts.fadeInOnReady) fadeInPlayer(); // don't leave the screen stuck faded on failure
        handleUnplayable();
      }
    }, 4000);
  }

  player.loop = false; // clears any loop left set by a virtual channel's background audio
  player.src = url;
  // Real content only (not the bumper/dynamic-background player.src= sites
  // below) — lets a captions plugin know a new file is about to play without
  // core knowing captions exist at all (registerCoreHook, plugins.js).
  runCoreHooks('content-playing', { file, ch });
  triggerDynamicOverlays(ch, 'contentStart');
  if (tuneTimingEnabled()) console.log(`[tune] CH${ch.number} src set +${(performance.now() - window.__tuneT0).toFixed(0)}ms`);
  if (S.metaHandler) player.removeEventListener('loadedmetadata', S.metaHandler);
  const onMeta = () => {
    if (tuneTimingEnabled()) console.log(`[tune] CH${ch.number} loadedmetadata +${(performance.now() - window.__tuneT0).toFixed(0)}ms`);
    if (S.currentNumber !== ch.number || !S.isPoweredOn) return;
    // Recompute the seek position at the exact instant metadata is ready —
    // the IPC round-trips above (resolvePlayablePath + toFileUrl) can take
    // 50-200 ms, so closing over the pre-IPC pos.offset would place the
    // content 50-200 ms behind where it should be every time a file loads.
    // Only resync if we're still in the same file; if a boundary crossed
    // during the IPC wait, contentJustEnded will advance to the next file.
    const freshPos = computeLiveContentPosition(ch);
    const seekOffset = (freshPos && freshPos.file && freshPos.file.path === posFile.path)
      ? freshPos.offset
      : pos.offset;
    player.currentTime = seekOffset;
    player.play().catch(() => {});
    player.removeEventListener('loadedmetadata', onMeta);
    if (S.metaHandler === onMeta) S.metaHandler = null;
    // Safety net: guarantees a break's fade-to-black never gets stuck if the
    // user tunes away (or anything else lands here) mid-transition. Skipped
    // when fadeInOnReady is requested — that caller wants the reveal gated
    // on watchForDecodedFrame's real "a frame actually decoded" signal
    // instead, and tuneToChannel already clears this class synchronously up
    // front for every other tune-away case, so nothing else depends on it
    // firing here.
    if (!opts.fadeInOnReady) player.classList.remove('screen-fade-out');
    noSignalEl.classList.add('hidden');
    S.channelFailStreak[ch.number] = 0;
    if (ch.rating) flashRatingBug(ch);
    // AUTO aspect/resolution's real-video-size signal (display-mode.js) is
    // only trustworthy from here on — player.videoWidth/videoHeight are
    // real now, and confirmed to actually belong to this channel (not a
    // lingering previous one — see S.currentPlayerChannelNumber's own
    // comment, state.js). MUST run before applyTvBezel below, not after —
    // applyTvBezel measures the CURRENT #display-frame/.crt size to compute
    // #player's crop/fit rect, so if AUTO resolution shrinks the frame
    // (SD-shaped content — resolutionFromVideoSize, display-mode.js) after
    // that measurement instead of before it, #player keeps a rect sized
    // for the old, larger frame while its ancestor has already shrunk —
    // #player ends up bigger than its own container, spilling out and
    // reading as a cropped/cut-off picture. Real bug, found live on
    // several SD-content channels.
    S.currentPlayerChannelNumber = ch.number;
    cacheVideoSize((freshPos && freshPos.file && freshPos.file.path) || posFile.path, player.videoWidth, player.videoHeight);
    applyDisplayMode();
    // Re-apply now that player.videoWidth is real (it read 0 at the earlier
    // updateLogoBug call, before src was even set) — lets a resolution-
    // specific logoBugProfiles breakpoint take effect within this same tune
    // instead of only from the next channel change. Placement only (not the
    // full updateLogoBug) — icon/number content doesn't depend on
    // resolution, only x/y/size does.
    applyLogoBugPlacement(ch);
    // Same "resolution only known once metadata loads" reasoning as the
    // logo bug re-apply just above applies to applyTvBezel itself — this is
    // the active theme pack's border/bezel, plus this channel's own
    // aspect-ratio/crop override (ch.aspectRatio), if it has one. Must run
    // AFTER applyDisplayMode() above — see that call's own comment.
    applyTvBezel(player.videoWidth, player.videoHeight, ch);
    watchForDecodedFrame();
    // Schedule "UP NEXT" bar based on fresh position (post-IPC), not the
    // stale pre-IPC pos — remainingMs depends on current offset accuracy.
    scheduleUpNextBar(ch, freshPos || pos);
  };
  S.metaHandler = onMeta;
  player.addEventListener('loadedmetadata', onMeta);

  S.errorHandler = handleUnplayable;
  player.addEventListener('error', S.errorHandler);

  S.endedHandler = () => handleContentEnded(ch);
  player.addEventListener('ended', S.endedHandler);
}

// A show just ended — re-check break state (a pre/post/both-timed break, or
// any other type whose window happens to start right here) before falling
// through to the next piece of content. Routed through the same
// checkBreakState() the boundary timer uses so both triggers agree.
function handleContentEnded(ch) {
  if (!S.isPoweredOn) return;
  checkBreakState(ch, { contentJustEnded: true });
}

// Scoped by channel number — two channels can otherwise resolve identical
// (type, windowStart) pairs, most reliably right after using a channel's own
// DUPLICATE action (setup-channels.js), which deep-clones ch.anchor verbatim
// along with its commercials/flow config: the clone's break windows then land
// at the exact same timestamps as the original. Without the channel number
// here, watching a break through to completion on one channel would mark the
// other's identical window "already completed" too, silently skipping it.
function breakKeyFor(ch, resolved) {
  return `${ch.number}:${resolved.type}:${resolved.windowStart}`;
}

// completedBreakKeys is reset to null on any time-machine jump (see
// shuttlePlay in timemachine.js) — it only ever accumulates during
// uninterrupted live playback, but on a box left running for weeks that's
// still one new entry per completed break window, forever. Set iteration
// order is insertion order, and breaks complete in chronological order
// during live play, so trimming from the front reliably drops the oldest
// entries first without needing to parse a timestamp back out of each key.
const COMPLETED_BREAK_KEYS_MAX = 500;
function markBreakCompleted(key) {
  S.completedBreakKeys = S.completedBreakKeys || new Set();
  S.completedBreakKeys.add(key);
  if (S.completedBreakKeys.size > COMPLETED_BREAK_KEYS_MAX) {
    S.completedBreakKeys.delete(S.completedBreakKeys.values().next().value);
  }
}

// Clears the three fields that track "is a break currently on screen, and
// what kind" — the shared core of a reset every power-off, channel-tune,
// and shuttle-start needs to do before deciding what (if anything) plays
// next. endBreak/tuneToChannel below additionally clear a couple of
// break-*timing*-specific fields (awaitingBumperEnd, breakOverrunSince) of
// their own right after calling this — this only covers the subset every
// caller, including the ones outside this file (power.js, timemachine.js,
// app.js), needs identically.
export function resetActiveBreakState() {
  S.activeBreakKey = null;
  S.activeBreakInterruptsContent = false;
  S.activeBreakKind = null;
}

// One unified boundary timer drives every break type (commercial/channelId/
// trivia/upNext) — replaces the old three independent setTimeout-interval
// systems. Re-arms at exactly the next instant resolveBreakAt's result would
// change, so live playback and the time-machine preview (timemachine.js)
// always agree on what's airing at any given moment, past or future.
export function scheduleNextBreak(ch) {
  clearTimeout(S.breakTimer);
  const boundary = nextBreakBoundary(ch, viewNow());
  if (!isFinite(boundary)) return;
  S.breakTimer = setTimeout(() => checkBreakState(ch), Math.max(0, boundary - viewNow()) + 1);
}

// The single decision point for "what should be showing right now, break or
// content" — called from the boundary timer, from handleContentEnded (a
// natural video end lands on the same instant a pre/post/both break would),
// from a bumper's own early end/error, and from every "resume live playback"
// entry point (tuneToChannel, time-machine shuttlePlay/returnToLive, powerOn)
// so tuning/returning into an already-in-progress break shows it immediately
// instead of waiting for the next scheduled check. opts.contentJustEnded
// tells it to fall through to playChannelLive when nothing's due, since
// otherwise nothing else would advance content to the next file.
export function checkBreakState(ch, opts) {
  opts = opts || {};
  if (!S.isPoweredOn || S.currentNumber !== ch.number) return;
  if (S.easActive || !guideGrid.classList.contains('hidden')) {
    // Don't interrupt EAS or the open guide — check again shortly rather
    // than dropping the break entirely (same policy the old per-system
    // timers used).
    clearTimeout(S.breakTimer);
    S.breakTimer = setTimeout(() => checkBreakState(ch, opts), 5000);
    return;
  }
  const resolved = resolveBreakAt(ch, viewNow());
  if (resolved) {
    const key = breakKeyFor(ch, resolved);
    if (S.completedBreakKeys && S.completedBreakKeys.has(key) && S.activeBreakKey !== key) {
      if (S.activeBreakKey) endBreak(ch);
      scheduleNextBreak(ch);
      return;
    }
    if (S.activeBreakKey !== key) {
      // If a commercial video bumper is currently playing, let it finish playing
      // to its natural 'ended' event instead of cutting it off mid-stream when a
      // boundary timer ticks!
      if (S.awaitingBumperEnd) {
        if (!S.breakOverrunSince) S.breakOverrunSince = viewNow();
        if (viewNow() - S.breakOverrunSince < BUMPER_OVERRUN_GRACE_MS) {
          S.breakTimer = setTimeout(() => checkBreakState(ch, opts), 500);
          return;
        }
      }
      if (S.activeBreakKey && S.activeBreakInterruptsContent) {
        S.contentLostMs += viewNow() - S.breakEnteredAtMs;
      }
      startBreak(ch, resolved, key);
    }
  } else if (S.activeBreakKey) {
    if (S.awaitingBumperEnd) {
      // The scheduled windowEnd passed but the bumper's own 'ended'/'error'
      // hasn't fired — its probed duration (captured once when the file was
      // added, see probeDuration/setup-util.js) ran short of the real file.
      // Keep deferring to the real event instead of cutting the clip off
      // mid-play, bounded so a stuck/broken file can't hang the break
      // forever.
      if (!S.breakOverrunSince) S.breakOverrunSince = viewNow();
      if (viewNow() - S.breakOverrunSince < BUMPER_OVERRUN_GRACE_MS) {
        S.breakTimer = setTimeout(() => checkBreakState(ch, opts), 500);
        return;
      }
    }
    S.breakOverrunSince = null;
    endBreak(ch);
  } else if (opts.contentJustEnded) {
    playChannelLive(ch);
  }
  scheduleNextBreak(ch);
}

const BREAK_LABELS = {
  commercial: 'COMMERCIAL BREAK', upNext: 'UP NEXT', channelId: 'STATION ID',
  adBreakIn: 'COMMERCIAL BREAK', adBreakOut: 'AND NOW, BACK TO THE SHOW',
  signOff: 'SIGNING OFF', signOn: 'SIGNING ON', promo: 'COMING SOON', premiereJingle: 'PREMIERING NOW',
};

// Fade-to-black around a break bumper cut (entering or leaving) — resolves
// once the CSS opacity transition has had time to run, so callers can await
// it before swapping player.src and cutting over.
const BREAK_FADE_MS = 180;
// How long checkBreakState will keep deferring a boundary-timer cutoff for a
// real-file bumper whose probed duration undershot its actual length, before
// giving up and cutting it anyway (see S.awaitingBumperEnd above).
const BUMPER_OVERRUN_GRACE_MS = 8000;
function fadeOutPlayer() {
  return new Promise((resolve) => {
    player.classList.add('screen-fade-out');
    setTimeout(resolve, BREAK_FADE_MS);
  });
}
function fadeInPlayer() {
  requestAnimationFrame(() => player.classList.remove('screen-fade-out'));
}

const DAY_MS = 86400000;

function computeNextTitle(ch) {
  const source = resolveActiveSource(ch, viewNow());
  const pos = computeSourcePosition(source, viewNow());
  if (!pos || !pos.files.length) return '';
  const nextFile = pos.files[(pos.fileIndex + 1) % pos.files.length];
  return getDisplayTitle(nextFile);
}

// Only resolves for a promo entry with a real dateRange target block (see
// eligiblePromoEntries, interstitials.js) — blank for every other type,
// since "days until" only means something when counting down to something.
function computeDaysUntil(ch, entry) {
  if (entry.type !== 'promo' || entry.blockAffinity == null) return '';
  const target = (ch.blocks || []).find((b) => b.id === entry.blockAffinity);
  if (!target) return '';
  const startMs = nextBlockStartMs(target, viewNow());
  if (!isFinite(startMs)) return '';
  return String(Math.max(0, Math.ceil((startMs - viewNow()) / DAY_MS)));
}

// How many more files air in the current lineup before it loops back to the
// start — e.g. an upNext/channelId dynamic bumper reading "2 MORE EPISODES
// TODAY" during a multi-episode ad pod (see ad "pods"/podMin-podMax,
// interstitials.js) makes back-to-back episodes read as an intentional
// programming block instead of just consecutive files. Unlike
// {daysUntil} (a promo counting down to a future block's premiere), this is
// same-lineup, same-day — how much is left before the current rotation
// repeats.
function computeEpisodesUntilWrap(ch) {
  const source = resolveActiveSource(ch, viewNow());
  const pos = computeSourcePosition(source, viewNow());
  if (!pos || !pos.files.length) return '';
  return String(pos.files.length - pos.fileIndex - 1);
}

// A dynamic entry's live text template (see the DYNAMIC checkbox,
// setup-interstitials.js) — {channel}/{time}/{nextTitle}/{daysUntil}/
// {episodesUntil}. {daysUntil} is what makes a High-School-Musical/
// SpongeBob-"Truth or Square"-style escalating countdown campaign work: the
// same promo entry's on-screen number counts down day by day as the
// premiere approaches, rather than being a static copy authored once.
export function renderDynamicText(template, ch, entry) {
  if (!template) return '';
  return template
    .replace(/\{channel\}/g, (ch.name || `CHANNEL ${ch.number}`).toUpperCase())
    .replace(/\{time\}/g, formatClock(new Date(viewNow())))
    .replace(/\{nextTitle\}/g, computeNextTitle(ch))
    .replace(/\{daysUntil\}/g, computeDaysUntil(ch, entry))
    .replace(/\{episodesUntil\}/g, computeEpisodesUntilWrap(ch));
}

function startBreak(ch, resolved, key) {
  const { type, entry, label, windowStart } = resolved;
  const isTextOnlyChannelId = type === 'channelId' && !(entry && entry.file);
  // Unrecognized types (adBreakIn/adBreakOut/premiereJingle/promo/signOff/
  // signOn — see interstitials.js) simply match no configured rule, a safe
  // no-op — see DYNAMIC_OVERLAY_TRIGGERS, channels.js.
  triggerDynamicOverlays(ch, type);
  // How far into the break window the current moment already is. During
  // normal live playback this is ~0 (the timer fired right at windowStart).
  // In time machine mode, shuttlePlay can commit to a time mid-window, so
  // the bumper needs to start at the matching offset instead of 0 — otherwise
  // a 60s commercial whose window has 20s left would play 20s then get cut.
  const windowElapsedS = Math.max(0, (viewNow() - windowStart) / 1000);

  S.activeBreakKey = key;
  S.activeBreakInterruptsContent = !isTextOnlyChannelId;
  S.activeBreakKind = type;
  S.awaitingBumperEnd = false;
  S.breakOverrunSince = null;
  // Marks when content stopped airing so endBreak can credit exactly this
  // much back (see S.contentLostMs) — a text-only station ID never stops
  // content, so it has nothing to credit.
  if (!isTextOnlyChannelId) S.breakEnteredAtMs = viewNow();

  if (isTextOnlyChannelId) {
    // Doesn't pause/replace content — just overlays a bar, same as today's
    // always-on auto "YOU'RE WATCHING <channel>" behavior. Nothing swaps on
    // `player`, so no ad-volume multiplier applies here.
    stationIdNameEl.textContent = (entry && entry.text) || (ch.name || `CHANNEL ${ch.number}`).toUpperCase();
    stationIdBarEl.classList.add('show');
    playConfiguredSound('card', ch.number);
    return;
  }
  if (type === 'trivia') {
    cancelUpNextBar();
    player.pause();
    triviaTextEl.textContent = entry.text;
    triviaCardEl.classList.remove('hidden');
    return;
  }

  // Video-kind (commercial, upNext, channelId-with-video): swap the player
  // to the bumper, at the ad-volume multiplier rather than the channel's own.
  cancelUpNextBar();
  applyVolume();
  if (S.endedHandler) player.removeEventListener('ended', S.endedHandler);
  if (S.errorHandler) player.removeEventListener('error', S.errorHandler);

  if (label === 'post') crtToggleFlash.textContent = 'END OF PROGRAM';
  else if (label === 'pre') crtToggleFlash.textContent = 'UP NEXT';
  else crtToggleFlash.textContent = BREAK_LABELS[type] || 'COMMERCIAL BREAK';
  crtToggleFlash.classList.add('show');

  if (entry.dynamic) {
    (async () => {
      try {
        const filePath = (entry.bgFile && entry.bgFile.path) || '';
        const resolved = await window.api.resolvePlayablePath('local', filePath);
        const [, url] = await Promise.all([fadeOutPlayer(), window.api.toFileUrl(resolved.path)]);
        if (S.currentNumber !== ch.number || !S.isPoweredOn) return;
        player.loop = true;
        player.src = url;
        dynamicBumperTextEl.textContent = renderDynamicText(entry.text, ch, entry);
        dynamicBumperTextEl.classList.remove('hidden');

        if (S.metaHandler) player.removeEventListener('loadedmetadata', S.metaHandler);
        const onMeta = () => {
          if (S.currentNumber !== ch.number || !S.isPoweredOn) return;
          player.currentTime = windowElapsedS;
          player.play().catch(() => {});
          player.removeEventListener('loadedmetadata', onMeta);
          if (S.metaHandler === onMeta) S.metaHandler = null;
          // AUTO resolution (display-mode.js) is per-CHANNEL, not
          // per-content-item — a bumper/ad playing mid-break shouldn't
          // silently leave the channel's own override (or last-detected
          // tier) stale just because it swapped player.src outside
          // playChannelLive/its onMeta, which is where every other
          // resolution re-apply happens. currentPlayerChannelNumber
          // confirms these are THIS channel's real dimensions — see its
          // comment in state.js. Must run before applyTvBezel below — see
          // the matching comment in playChannelLive's own onMeta.
          S.currentPlayerChannelNumber = ch.number;
          cacheVideoSize(filePath, player.videoWidth, player.videoHeight);
          applyDisplayMode();
          applyTvBezel(player.videoWidth, player.videoHeight, ch);
          fadeInPlayer();
        };
        S.metaHandler = onMeta;
        player.addEventListener('loadedmetadata', onMeta);

        const resume = () => checkBreakState(ch);
        S.errorHandler = resume;
        player.addEventListener('error', S.errorHandler);
      } catch (err) {
        console.error('[DYNAMIC BUMPER RESOLVE ERROR]', err);
        checkBreakState(ch);
      }
    })();
    return;
  }

  (async () => {
    try {
      const filePath = (entry.file && entry.file.path) || '';
      const resolved = await window.api.resolvePlayablePath('local', filePath);
      const [, url] = await Promise.all([fadeOutPlayer(), window.api.toFileUrl(resolved.path)]);
      if (S.currentNumber !== ch.number || !S.isPoweredOn) return;
      player.src = url;
      S.awaitingBumperEnd = true;

      if (S.metaHandler) player.removeEventListener('loadedmetadata', S.metaHandler);
      const onMeta = () => {
        if (S.currentNumber !== ch.number || !S.isPoweredOn) return;
        player.currentTime = windowElapsedS;
        player.play().catch(() => {});
        player.removeEventListener('loadedmetadata', onMeta);
        if (S.metaHandler === onMeta) S.metaHandler = null;
        // Same reasoning as the dynamic-bumper onMeta above — a plain
        // commercial/bumper file also swaps player.src outside
        // playChannelLive, so AUTO resolution needs its own re-apply here.
        // Must run before applyTvBezel below — see the matching comment in
        // playChannelLive's own onMeta.
        S.currentPlayerChannelNumber = ch.number;
        cacheVideoSize(filePath, player.videoWidth, player.videoHeight);
        applyDisplayMode();
        applyTvBezel(player.videoWidth, player.videoHeight, ch);
        fadeInPlayer();
      };
      S.metaHandler = onMeta;
      player.addEventListener('loadedmetadata', onMeta);

      const resume = () => {
        player.removeEventListener('ended', resume);
        player.removeEventListener('error', resume);
        S.awaitingBumperEnd = false;
        if (key) markBreakCompleted(key);
        endBreak(ch);
      };
      S.endedHandler = resume;
      S.errorHandler = resume;
      player.addEventListener('ended', S.endedHandler);
      player.addEventListener('error', S.errorHandler);
    } catch (err) {
      console.error('[COMMERCIAL BUMPER RESOLVE ERROR]', err);
      S.awaitingBumperEnd = false;
      if (key) markBreakCompleted(key);
      endBreak(ch);
    }
  })();
}

// Setup's AIR CHECK console uses the same playback path as a naturally
// resolved break, but with an explicit pool entry selected by the user.
// This is a preview-only action; it does not alter schedule state or mark a
// deterministic slot as completed.
export function forceInterstitialPreview(ch, entry) {
  if (!ch || !entry) return false;
  const durationS = entry.dynamic ? (entry.durationS || 15) :
    ((entry.file && entry.file.duration) || (entry.type === 'trivia' ? 8 : 15));
  const windowStart = viewNow();
  startBreak(ch, {
    type: entry.type, entry, label: 'preview', windowStart,
    windowEnd: windowStart + durationS * 1000,
  }, null);
  return true;
}

function endBreak(ch) {
  const shouldResume = S.activeBreakInterruptsContent;
  if (S.activeBreakKey) markBreakCompleted(S.activeBreakKey);
  resetActiveBreakState();
  S.awaitingBumperEnd = false;
  S.breakOverrunSince = null;
  stationIdBarEl.classList.remove('show');
  triviaCardEl.classList.add('hidden');
  crtToggleFlash.classList.remove('show');
  dynamicBumperTextEl.classList.add('hidden');
  clearDynamicOverlaysForBreak();
  player.loop = false;
  applyVolume();
  // Credits back exactly how long content was actually off-screen for this
  // break, so the next computeLiveContentPosition() call resumes right
  // where it left off instead of having skipped ahead by the break length.
  if (shouldResume && S.breakEnteredAtMs) {
    S.contentLostMs += viewNow() - S.breakEnteredAtMs;
    S.breakEnteredAtMs = 0;
  }
  if (shouldResume && S.currentNumber === ch.number && S.isPoweredOn) {
    (async () => {
      await fadeOutPlayer();
      // fadeInOnReady: reveal only once the resumed show has actually
      // decoded a frame, instead of unfading immediately after src is set
      // (which exposed whatever stale/black frame was sitting in the
      // element while the new file was still seeking/decoding — the
      // "prolonged black screen after a commercial" bug).
      await playChannelLive(ch, { fadeInOnReady: true });
    })();
  }
}

// variant: undefined (neutral/no signal), 'error', or 'transcoding' — maps
// to the matching .no-signal-main.is-* color in styles.css.
export function showNoSignal(main, sub, variant) {
  noSignalMainEl.textContent = main;
  noSignalMainEl.className = 'no-signal-main' + (variant ? ` is-${variant}` : '');
  noSignalChannelEl.textContent = sub;
  noSignalEl.classList.remove('hidden');
}

function configuredNoSignalText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveNoSignalCopy(number, identity, fallbackTitle, fallbackMessage) {
  const display = S.config.display || {};
  const title = configuredNoSignalText(identity?.noSignalTitle)
    || configuredNoSignalText(display.noSignalTitle)
    || fallbackTitle;
  const template = configuredNoSignalText(identity?.noSignalMessage)
    || configuredNoSignalText(display.noSignalMessage)
    || fallbackMessage;
  return {
    title,
    message: template.replaceAll('{channel}', String(number)),
  };
}

function channelNoSignalCopy(channel, fallbackTitle, fallbackMessage) {
  return resolveNoSignalCopy(channel.number, channel.broadcastIdentity, fallbackTitle, fallbackMessage);
}

function genericNoSignalCopy(number) {
  return resolveNoSignalCopy(number, null, 'NO SIGNAL', 'CH {channel}');
}

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
}

// intensity (0-100, from S.config.staticEffect.intensity) scales peak opacity.
// tintHex (optional, from the active block's theme.staticTint) blends noise
// toward that color instead of flat grayscale. durationMs controls how quickly
// the static fades IN (the "TUNING TIME" slider) — the effect then holds at
// peak until markStaticReady() fires (first decoded video frame), then fades
// out, so the screen is never black between channels.
//
// Was 3000ms — a slow-loading file (network drive, cold disk cache, a large
// library) would hold the screen at peak static for up to an extra 3s beyond
// the configured tuning time before giving up, which read as "channel
// switching got slower" even though nothing about the tune itself changed.
// Still generous enough to cover normal disk-read variance without forcing a
// release mid-decode.
const STATIC_MAX_HOLD_MS = 1200;
const STATIC_RELEASE_FADE_MS = 300;
// The release phase also brightens #player up from this dim starting point
// to fully lit, in step with static dissolving away — without it, static
// simply peels back off an already-fully-bright picture, which reads as an
// abrupt cut rather than a signal "coming in." Not applied during the
// fade-in/hold phases so a partial static intensity setting still shows its
// intended blend of live picture underneath, same as before.
const PLAYER_REVEAL_START_OPACITY = 0.2;
let staticReady = true;

function markStaticReady() {
  staticReady = true;
}

// Static animation: fade IN from 0→peak over durationMs (signal locking in),
// hold at peak until markStaticReady() fires (first decoded video frame),
// then fade OUT over STATIC_RELEASE_FADE_MS while the picture underneath
// brightens up in sync — dissolving into the show like a signal locking in,
// not a hard cut. This keeps the screen covered with static — never black —
// from the instant the channel changes until the video is actually ready to
// be seen.
// Per-theme channel-change look — same fade-in/hold/release timing and
// canvas element as the default random-noise burst below, just a different
// per-frame pixel fill (registerThemePack's `staticStyle` field,
// plugins.js) so each era's "something's happening while it tunes" moment
// reads differently, not only its colors. A color-only pack simply omits
// it — their static behavior stays the plain default 'noise' burst.
export function showStaticBurst(durationMs, tintHex) {
  sfxChannelChange();
  staticCanvas.width = staticCanvas.clientWidth;
  staticCanvas.height = staticCanvas.clientHeight;
  // A minimized window, a hidden audit surface, or a theme transition can
  // briefly leave the canvas with no layout box. createImageData(0, 0)
  // throws and used to turn an otherwise harmless hidden tuning burst into
  // an uncaught renderer error. There is nothing visible to animate in this
  // state, so finish the burst immediately and let the next real tune draw
  // once the TV surface has dimensions again.
  if (staticCanvas.width < 1 || staticCanvas.height < 1) {
    staticReady = true;
    staticCanvas.style.opacity = '0';
    player.style.opacity = '';
    return;
  }
  const se = S.config.staticEffect;
  let peakOpacity = (se && se.intensity != null ? se.intensity : 100) / 100;
  const tint = hexToRgb(tintHex);
  const identity = channelIdentity(S.config, S.currentNumber);
  const pack = getThemePack(effectiveThemeId(S.config, S.currentNumber));
  const staticStyle = (identity && identity.staticStyle) || (pack && pack.staticStyle) || 'noise';
  // Network broadcast didn't cut to visible tuning noise between its own
  // channels the way cable/UHF did — a quick, low-opacity blip instead of a
  // full static burst.
  if (staticStyle === 'quiet') peakOpacity *= 0.3;
  let rollOffset = 0;

  staticReady = false;
  // Reset in case a previous burst was interrupted mid-release (rapid
  // channel surfing) and left the player dimmed partway through its brighten-up.
  player.style.opacity = '';
  const start = performance.now();
  let releaseStart = null;

  function draw(now) {
    const elapsed = now - start;
    let currentOpacity;
    let finished = false;

    if (releaseStart !== null) {
      // Phase 3 — fade out: peak→0 over STATIC_RELEASE_FADE_MS, while the
      // picture brightens dim→full in lockstep.
      const releaseProgress = Math.min(1, (now - releaseStart) / STATIC_RELEASE_FADE_MS);
      currentOpacity = peakOpacity * (1 - releaseProgress);
      player.style.opacity = String(PLAYER_REVEAL_START_OPACITY + (1 - PLAYER_REVEAL_START_OPACITY) * releaseProgress);
      if (releaseProgress >= 1) finished = true;
    } else if (staticReady) {
      // Phase 2 — frame decoded (or cap hit), begin release fade
      releaseStart = now;
      currentOpacity = peakOpacity;
      player.style.opacity = String(PLAYER_REVEAL_START_OPACITY);
    } else {
      // Phase 1 — fade in 0→peak over durationMs, then hold at peak
      // until the video is ready. Cap: force release after STATIC_MAX_HOLD_MS
      // beyond the fade-in so a broken tune doesn't hold forever.
      const fadeInProgress = Math.min(1, elapsed / Math.max(1, durationMs));
      // Ease-in-out (smoothstep) so it ramps up like a signal locking in
      const eased = fadeInProgress * fadeInProgress * (3 - 2 * fadeInProgress);
      currentOpacity = peakOpacity * eased;
      // If we've been holding well past durationMs with no ready signal, force release
      if (elapsed > durationMs + STATIC_MAX_HOLD_MS) {
        releaseStart = now;
      }
    }

    if (!finished) {
      staticCanvas.style.opacity = String(currentOpacity);
      const w = staticCanvas.width, h = staticCanvas.height;

      if (staticStyle === 'acquire') {
        // Digital-satellite: no snow at all — a near-black field with a
        // bright horizontal band sweeping downward (searching for a lock)
        // and a text readout, instead of the analog eras' noise.
        staticCtx.fillStyle = '#01050d';
        staticCtx.fillRect(0, 0, w, h);
        rollOffset = (rollOffset + h * 0.025) % (h + 80);
        const grad = staticCtx.createLinearGradient(0, rollOffset - 40, 0, rollOffset + 40);
        grad.addColorStop(0, 'rgba(0,191,255,0)');
        grad.addColorStop(0.5, 'rgba(0,191,255,0.85)');
        grad.addColorStop(1, 'rgba(0,191,255,0)');
        staticCtx.fillStyle = grad;
        staticCtx.fillRect(0, rollOffset - 40, w, 80);
        staticCtx.fillStyle = 'rgba(160,225,255,0.9)';
        staticCtx.font = `${Math.max(12, Math.round(h * 0.045))}px monospace`;
        staticCtx.textAlign = 'center';
        staticCtx.textBaseline = 'middle';
        staticCtx.fillText('ACQUIRING SIGNAL…', w / 2, h / 2);
      } else {
        const imgData = staticCtx.createImageData(w, h);
        const buf = imgData.data;
        if (staticStyle === 'roll') rollOffset = (rollOffset + 2) % h;
        for (let i = 0; i < buf.length; i += 4) {
          let v = Math.random() * 255 | 0;
          if (staticStyle === 'roll') {
            const y = Math.floor((i / 4) / w);
            const band = Math.sin(((y + rollOffset) / h) * Math.PI * 6);
            v = Math.min(255, Math.max(0, v * 0.55 + (band > 0.6 ? 140 : 0)));
          }
          if (tint) {
            buf[i] = (v + tint[0]) / 2; buf[i + 1] = (v + tint[1]) / 2; buf[i + 2] = (v + tint[2]) / 2;
          } else {
            buf[i] = v; buf[i + 1] = v; buf[i + 2] = v;
          }
          buf[i + 3] = 255;
        }
        staticCtx.putImageData(imgData, 0, 0);
        if (staticStyle === 'tear') {
          // A few short horizontal bands redrawn with a slight x-offset —
          // the "bad tracking" look of a signal that can't quite hold.
          for (let b = 0; b < 3; b++) {
            const bandY = Math.floor(Math.random() * h);
            const bandH = 2 + Math.floor(Math.random() * 6);
            const xShift = (Math.random() * 30 - 15) | 0;
            staticCtx.drawImage(staticCanvas, 0, bandY, w, bandH, xShift, bandY, w, bandH);
          }
        }
      }
      S.staticRAF = requestAnimationFrame(draw);
    } else {
      staticCanvas.style.opacity = '0';
      // Clear the inline opacity this burst set — an inline style outlives
      // this burst and would otherwise out-rank .screen-fade-out's CSS rule
      // (used for break-bumper transitions) on every tune after this one.
      player.style.opacity = '';
      if (S.staticRAF) cancelAnimationFrame(S.staticRAF);
    }
  }
  if (S.staticRAF) cancelAnimationFrame(S.staticRAF);
  S.staticRAF = requestAnimationFrame(draw);
}

export async function tuneToChannel(number, opts) {
  opts = opts || {};
  window.tuneToChannel = tuneToChannel;
  const bypassGateIds = opts.bypassGateIds || [];
  for (const gate of tuneGateEntries()) {
    if (bypassGateIds.includes(gate.id)) continue;
    if (gate.isBlocked(number)) {
      gate.onBlocked(number);
      return;
    }
  }
  playChannelClickSound();
  const ch = getChannel(number);
  const prevNumber = S.currentNumber;
  if (prevNumber != null && prevNumber !== number) S.previousNumber = prevNumber;
  S.currentNumber = number;
  window.applyTheme?.();
  applyChannelIdentity(ch);
  // Universal remote's "NOW WATCHING" readout (and full status snapshot,
  // see pushRemoteState) — one call here covers every path below (virtual
  // channel, no signal, coming soon, sign-off, normal playback) instead of
  // scattering a push at each branch's return.
  pushRemoteState();
  clearTimeout(S.breakTimer);
  clearTimeout(S.blockBoundaryTimer);
  clearTimeout(S.broadcastHoursTimer);
  cancelUpNextBar();
  cancelAllInterrupts();
  resetActiveBreakState();
  S.awaitingBumperEnd = false;
  S.breakOverrunSince = null;
  triviaCardEl.classList.add('hidden');
  stationIdBarEl.classList.remove('show');
  crtToggleFlash.classList.remove('show');
  ratingBugEl.classList.remove('show');
  dynamicBumperTextEl.classList.add('hidden');
  hideDynamicOverlay();
  testPatternCanvasEl.classList.add('hidden');
  noSignalEl.classList.add('hidden');
  guideOverlay.classList.add('hidden');
  if (S.endedHandler) { player.removeEventListener('ended', S.endedHandler); S.endedHandler = null; }
  if (S.errorHandler) { player.removeEventListener('error', S.errorHandler); S.errorHandler = null; }
  if (S.metaHandler) { player.removeEventListener('loadedmetadata', S.metaHandler); S.metaHandler = null; }
  player.pause();
  player.loop = false;
  // Reset here so a themed block's colors never bleed into a channel that
  // doesn't reach playChannelLive this tune (virtual channel, no signal,
  // coming soon, sign-off) — playChannelLive re-applies the right theme
  // for any tune that does play content.
  applyBlockTheme(null);
  applyVhsQuality(null);
  // AUTO aspect/resolution's real-video-size signal (display-mode.js) must
  // never trust a lingering PREVIOUS channel's videoWidth/videoHeight as if
  // they belonged to this new tune — reset here, confirmed again (set to
  // this tune's own ch.number) only once ITS OWN loadedmetadata actually
  // fires, same reset-then-reapply discipline as the calls just above.
  S.currentPlayerChannelNumber = null;
  // Display mode is channel-scoped too, including virtual plugin channels.
  // Apply it before any branch below can return: plugin channels never enter
  // playChannelLive(), which is where regular channels used to pick up their
  // aspect/resolution override, so they otherwise retained the previous
  // channel's frame indefinitely. The later playChannelLive() call remains
  // useful for regular channels because metadata can refine AUTO detection.
  applyDisplayMode();
  // Display mode changes #display-frame geometry, so reset the bezel only
  // after the new channel-scoped frame has been applied.
  applyTvBezel(0, 0); // 0,0 reads as "unknown" (see applyTvBezel) — resets #player/bezel to default
  applyVolume();
  player.classList.remove('screen-fade-out');
  // Surfing keeps the time offset (so you can see what else was on at
  // that moment) but always drops out of shuttle back into play.
  stopShuttle();
  S.shuttlePreviewPath = null;
  hideVirtualChannels();

  const se = S.config.staticEffect;
  if (!opts.silent && isEnabledByDefault(se)) {
    const durationMs = se && se.durationMs != null ? se.durationMs : 150;
    if (durationMs > 0) {
      const activeBlock = ch && !isVirtualChannel(number) ? resolveActiveSource(ch, viewNow()).block : null;
      // Color comes from whichever plugin registered this channel number
      // (getVirtualBadge, virtual.js), not a hardcoded per-channel map here —
      // core has no business knowing which specific plugins exist or what
      // color each one picked for itself.
      const tint = (activeBlock && activeBlock.theme && activeBlock.theme.staticTint)
        || (ch && ch.broadcastIdentity && ch.broadcastIdentity.staticTint)
        || (isVirtualChannel(number) ? getVirtualBadge(number).bg : undefined);
      showStaticBurst(durationMs, tint);
    }
  }

  if (isVirtualChannel(number)) {
    markStaticReady(); // virtual channels have their own playback path, not gated by playChannelLive's frame watchdog
    S.config.lastChannel = number;
    saveConfigDebounced(600, { skipUndo: true });
    updateLogoBug(null);
    window.applyTickerState?.();
    // The virtual channels have no schedule to shuttle through.
    if (S.timeMachineOn) exitTimeMachine();
    showVirtualChannel(number);
    return;
  }

  if (!ch) {
    markStaticReady();
    clearPlayerToBlank();
    updateLogoBug(null);
    window.applyTickerState?.();
    const tp = S.config.testPattern;
    if (isEnabledByDefault(tp)) {
      runCoreHooks('draw-test-pattern');
      testPatternCanvasEl.classList.remove('hidden');
    }
    const copy = genericNoSignalCopy(number);
    showNoSignal(copy.title, copy.message);
    showGuideOverlay(number, null);
    return;
  }

  S.config.lastChannel = number;
  saveConfigDebounced(600, { skipUndo: true });

  updateLogoBug(ch);
  // ch.tickerContent (per-channel override, null = inherit) — re-evaluate on
  // every tune, same as updateLogoBug just above, so a channel-specific
  // crawl message/speed/on-off state takes effect immediately.
  window.applyTickerState?.();

  // A channel deliberately marked not-subscribed — checked before every
  // other content/schedule branch below since it overrides them entirely,
  // same as the broadcastHours gate just after it. Simpler sibling to the
  // scrambled PPV gag: no video treatment, just a static "please call your
  // cable company" card, for a channel the user wants blocked outright.
  if (ch.notSubscribed) {
    markStaticReady();
    clearPlayerToBlank();
    showBlockedCard(ch);
    showGuideOverlay(number, ch);
    return;
  }

  // A whole-channel, block-independent "off the air" window (see
  // isWithinBroadcastHours, schedule.js) — checked before the coming-soon/
  // content checks below since it overrides them entirely: a channel with a
  // full schedule still shows nothing outside its broadcast day.
  if (ch.broadcastHours && ch.broadcastHours.enabled && !isWithinBroadcastHours(ch, viewNow())) {
    markStaticReady();
    clearPlayerToBlank();
    showSignOffCard(ch);
    showGuideOverlay(number, ch);
    scheduleBroadcastHoursRetune(ch);
    return;
  }

  // A channel the user has named/reserved but hasn't pointed at any content
  // yet — reuses the no-signal overlay with distinct copy instead of the
  // generic "NO SIGNAL" card, and skips all the playback scheduling below
  // since there's nothing to schedule. Clears the player the same way the
  // sign-off branch above does — .no-signal has no background of its own
  // (by design, so the static-canvas noise shows through behind its text on
  // every other no-signal variant), so without this the previous channel's
  // last decoded frame just sits there frozen underneath the COMING SOON
  // text instead of the static that's supposed to be there.
  if (!ch.files || ch.files.length === 0) {
    markStaticReady();
    clearPlayerToBlank();
    // Same test-pattern treatment as the !ch ("NO SIGNAL") branch above —
    // an empty channel is conceptually the same "nothing to show" state,
    // just with a name/number already reserved for it.
    const tp = S.config.testPattern;
    if (isEnabledByDefault(tp)) {
      runCoreHooks('draw-test-pattern');
      testPatternCanvasEl.classList.remove('hidden');
    }
    const copy = channelNoSignalCopy(ch, 'COMING SOON', `CH {channel} — ${ch.name ? ch.name.toUpperCase() : 'NEW CHANNEL'}`);
    showNoSignal(copy.title, copy.message, 'comingsoon');
    showGuideOverlay(number, ch);
    return;
  }

  await playChannelLive(ch);
  if (tuneTimingEnabled()) console.log(`[tune] CH${number} playChannelLive returned +${(performance.now() - window.__tuneT0).toFixed(0)}ms`);
  triggerDynamicOverlays(ch, 'tuneIn');
  showGuideOverlay(number, ch);
  checkBreakState(ch);
  scheduleBlockBoundaryRetune(ch);
  if (tuneTimingEnabled()) console.log(`[tune] CH${number} scheduleBlockBoundaryRetune done +${(performance.now() - window.__tuneT0).toFixed(0)}ms`);
  scheduleBroadcastHoursRetune(ch);
  scheduleAllInterrupts();
  if (S.timeMachineOn) updateVcrOsd();
  updateTimeShiftBadge();
}

// Persistent off-air card shown outside a channel's broadcastHours window —
// distinct copy from the generic NO SIGNAL/COMING SOON cards so it reads as
// "this channel is fine, it's just not on right now" rather than broken.
function showSignOffCard(ch) {
  const returns = formatHourLabel(ch.broadcastHours.startHour);
  showNoSignal('SIGN-OFF', `CH ${ch.number}${ch.name ? ' — ' + ch.name.toUpperCase() : ''} — RETURNS AT ${returns}`, 'signoff');
}

// A deliberately blocked channel (ch.notSubscribed) — reads as a billing
// message, not a failure, so it gets its own copy and CSS variant distinct
// from both the technical OFF THE AIR card and the scheduled SIGN-OFF card.
function showBlockedCard(ch) {
  showNoSignal('CHANNEL NOT AVAILABLE', `CH ${ch.number}${ch.name ? ' — ' + ch.name.toUpperCase() : ''} — PLEASE CALL YOUR CABLE COMPANY TO SUBSCRIBE`, 'blocked');
}

// Re-tunes exactly when the broadcast-hours gate flips — sign-off (going
// off the air mid-content) and sign-on (coming back) are both just "run
// tuneToChannel again," so one retune driven by nextBroadcastHoursBoundary
// handles both directions instead of needing separate mechanisms.
export function scheduleBroadcastHoursRetune(ch) {
  clearTimeout(S.broadcastHoursTimer);
  if (!ch.broadcastHours || !ch.broadcastHours.enabled) return;
  const boundary = nextBroadcastHoursBoundary(ch, viewNow());
  if (!isFinite(boundary)) return;
  S.broadcastHoursTimer = setTimeout(() => {
    if (S.currentNumber !== ch.number || !S.isPoweredOn) return;
    tuneToChannel(ch.number, { silent: true });
  }, Math.max(0, boundary - viewNow()) + 500);
}

export function cancelUpNextBar() {
  clearTimeout(S.upNextTimer); S.upNextTimer = null;
  clearTimeout(S.upNextHideTimer); S.upNextHideTimer = null;
  upNextBarEl.classList.remove('show');
}

// Show "UP NEXT: <title>" for ~8s starting ~45s before the current file
// ends — a network promo, never interrupting content. Skipped near daypart
// boundaries (the next thing airing would come from a different source,
// and computing its first program up front isn't worth the complexity).
export function scheduleUpNextBar(ch, pos) {
  cancelUpNextBar();
  if (!S.config.upNext || S.config.upNext.enabled === false) return;
  const remainingMs = (pos.file.duration - pos.offset) * 1000;
  if (remainingMs < 60000) return;
  const boundary = nextSourceBoundary(ch, viewNow());
  if (isFinite(boundary) && boundary - viewNow() < remainingMs + 45000) return;

  const nextFile = pos.files[(pos.fileIndex + 1) % pos.files.length];
  S.upNextTimer = setTimeout(() => {
    if (S.currentNumber !== ch.number || !S.isPoweredOn) return;
    upNextTitleEl.textContent = getDisplayTitle(nextFile);
    upNextBarEl.classList.add('show');
    playConfiguredSound('card', ch.number);
    const duration = (S.config.upNext && S.config.upNext.duration) || 8000;
    S.upNextHideTimer = autoHideAfter(S.upNextHideTimer, duration, () => upNextBarEl.classList.remove('show'));
  }, remainingMs - 45000);
}

// Fallback used only if a config somehow has no profiles at all (shouldn't
// happen once foldLogoBugCorner has run — see channels.js/app.js migration
// — but keeps this function total rather than placing at 0,0/size 0 on a
// malformed config).
const FALLBACK_LOGO_BUG_PROFILE = { x: 94, y: 90, size: 46 };

// The profiles a channel actually draws from — its own override array if it
// has one, else the box-wide default (S.config.display.logoBugProfiles).
function activeLogoBugProfiles(ch) {
  return (ch && ch.logoBugProfiles) || (S.config.display && S.config.display.logoBugProfiles) || [];
}

function activeLogoBugContext() {
  return S.config.display && S.config.display.logoBugAutoAdjust
    ? resolveContentDisplayMode()
    : resolveEffectiveDisplayMode();
}

// Position + size are resolution-aware now (S.config.display.logoBugProfiles
// / ch.logoBugProfiles — see pickLogoBugProfile, channels.js), keyed off the
// actively-playing video's own width. `player.videoWidth` reads 0 before
// `loadedmetadata` fires, which pickLogoBugProfile treats as "unknown" (any
// non-catch-all breakpoint is skipped, falling through to the DEFAULT
// profile) — playChannelLive's onMeta handler re-calls this once the real
// width is known, so a resolution-specific profile still gets a chance to
// apply within the same tune, not just on the next one.
export function applyLogoBugPlacement(ch) {
  const profile = pickLogoBugProfile(activeLogoBugProfiles(ch), activeLogoBugContext()) || FALLBACK_LOGO_BUG_PROFILE;
  const { width, height } = logoBugProfileDimensions(profile);
  logoBugEl.style.left = `${profile.x}%`;
  logoBugEl.style.top = `${profile.y}%`;
  // --logo-bug-size kept for backward compat with any legacy CSS still
  // referencing it; --logo-bug-width/height are the canonical dimensions.
  logoBugEl.style.setProperty('--logo-bug-size', `${profile.size}px`);
  logoBugEl.style.setProperty('--logo-bug-width', `${width}px`);
  logoBugEl.style.setProperty('--logo-bug-height', `${height}px`);
  // Absent opacity falls back to the CSS default (55%) via the var()
  // fallback in overlays.css, so profiles without it round-trip unchanged.
  if (Number.isFinite(profile.opacity)) logoBugEl.style.setProperty('--logo-bug-opacity', profile.opacity / 100);
  else logoBugEl.style.removeProperty('--logo-bug-opacity');
}

export function updateLogoBug(ch) {
  logoBugEl.innerHTML = '';
  logoBugEl.style.background = '';
  applyLogoBugPlacement(ch);
  if (!ch) {
    logoBugEl.classList.add('hidden');
  } else if (ch.icon) {
    // A GIF/APNG icon already animates for free through a plain <img> — only
    // an actual video file (mp4/webm/etc) needs the <video> element instead.
    if (isVideoMediaPath(ch.icon)) {
      const video = document.createElement('video');
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      window.api.toFileUrl(ch.icon).then((url) => { video.src = url; video.play().catch(() => {}); });
      logoBugEl.appendChild(video);
    } else {
      const img = document.createElement('img');
      img.alt = String(ch.number);
      window.api.toFileUrl(ch.icon).then((url) => { img.src = url; });
      logoBugEl.appendChild(img);
    }
    // See buildChannelBadge (channels.js) — same "icon otherwise hides the
    // number entirely" fix, same shared .badge-num chip (overlays.css).
    const numChip = document.createElement('span');
    numChip.className = 'badge-num';
    numChip.textContent = String(ch.number);
    logoBugEl.appendChild(numChip);
    logoBugEl.classList.remove('hidden');
  } else {
    logoBugEl.style.background = channelColor(ch);
    logoBugEl.textContent = String(ch.number);
    logoBugEl.classList.remove('hidden');
  }
  applyLogoBugGhost(ch);
  applyLogoBugMotion();
}

// Box-wide only (S.config.display.logoBugMotion) — a CSS animation preset
// applied to the real logo bug (never the burn-in ghost, which has its own
// separate fade-based animation already). 'slide-in' is one-shot and needs
// to replay on every call (a fresh tune, or any other updateLogoBug trigger)
// — forcing a reflow between remove and add is the same trick
// attachSliderReadout's pulse uses (setup-util.js); 'pulse'/'glow' are
// persistent CSS @keyframes loops that don't need replaying.
export function applyLogoBugMotion() {
  const preset = (S.config.display && S.config.display.logoBugMotion) || 'none';
  LOGO_MOTION_PRESETS.forEach((p) => logoBugEl.classList.remove(`logo-motion-${p}`));
  if (preset === 'none') return;
  void logoBugEl.offsetWidth;
  logoBugEl.classList.add(`logo-motion-${preset}`);
}

// Full ghost strength (the crtIntensity.burnIn slider's own cap, applied on
// top of this) reached after this many continuous ms of the same logo
// sitting in the same corner — a real CRT burns in over a much longer real-
// world timescale, compressed here so the effect is actually observable
// during a normal viewing session instead of only in theory.
const BURN_IN_FULL_MS = 30 * 60000;

function logoBugBurnKeyFor(ch) {
  if (!ch) return null;
  const profile = pickLogoBugProfile(activeLogoBugProfiles(ch), activeLogoBugContext()) || FALLBACK_LOGO_BUG_PROFILE;
  return `${ch.number}:${profile.id || `${profile.x},${profile.y}`}`;
}

function tickLogoBugGhost() {
  const cap = ((S.config.crtIntensity && S.config.crtIntensity.burnIn) || 0) / 100 * 0.35;
  if (cap <= 0 || !S.logoBugBurnStartMs) {
    logoBugGhostEl.style.setProperty('--logo-bug-burn-opacity', 0);
    return;
  }
  const elapsedMs = Date.now() - S.logoBugBurnStartMs;
  const opacity = Math.min(1, elapsedMs / BURN_IN_FULL_MS) * cap;
  logoBugGhostEl.style.setProperty('--logo-bug-burn-opacity', opacity);
}

// Tracks how long the CURRENT logo bug (same channel, same corner) has sat
// on screen continuously and renders a matching faint ghost of it — the
// ghost is its OWN element (#logo-bug-ghost, separate from the real
// #logo-bug) so it keeps showing through breaks/virtual channels/anything
// else that hides the real logo bug, which is the entire point of "burn-in"
// (a real CRT doesn't know or care that the show cut to a commercial).
// Real wall-clock time (Date.now()), not viewNow() — burn-in tracks actual
// screen-on time, unaffected by the time machine scrubbing simulated
// broadcast time back and forth.
// Re-applies the ghost for whatever's currently tuned — for the DISPLAY
// settings screen's LOGO BURN-IN slider (setup-settings.js) to get instant
// feedback on drag instead of waiting for the next channel change.
export function refreshLogoBugGhost() {
  applyLogoBugGhost(getChannel(S.currentNumber));
}

function applyLogoBugGhost(ch) {
  const burnIn = (S.config.crtIntensity && S.config.crtIntensity.burnIn) || 0;
  clearInterval(S.logoBugBurnTimer);
  S.logoBugBurnTimer = null;
  if (!burnIn) {
    S.logoBugBurnKey = null;
    S.logoBugBurnStartMs = null;
    logoBugGhostEl.classList.add('hidden');
    logoBugGhostEl.style.setProperty('--logo-bug-burn-opacity', 0);
    return;
  }

  const key = logoBugBurnKeyFor(ch);
  if (key !== S.logoBugBurnKey) {
    // A different logo (or the same logo in a different corner) took over
    // this spot — restart accumulation and re-render the ghost's own
    // content to match, rather than leaving a stale ghost of whatever used
    // to be there.
    S.logoBugBurnKey = key;
    S.logoBugBurnStartMs = key ? Date.now() : null;
    logoBugGhostEl.innerHTML = '';
    logoBugGhostEl.style.background = '';
    if (ch) {
      const profile = pickLogoBugProfile(activeLogoBugProfiles(ch), activeLogoBugContext()) || FALLBACK_LOGO_BUG_PROFILE;
      const { width, height } = logoBugProfileDimensions(profile);
      logoBugGhostEl.style.left = `${profile.x}%`;
      logoBugGhostEl.style.top = `${profile.y}%`;
      logoBugGhostEl.style.setProperty('--logo-bug-size', `${profile.size}px`);
      logoBugGhostEl.style.setProperty('--logo-bug-width', `${width}px`);
      logoBugGhostEl.style.setProperty('--logo-bug-height', `${height}px`);
      if (ch.icon) {
        const img = document.createElement('img');
        img.alt = String(ch.number);
        window.api.toFileUrl(ch.icon).then((url) => { img.src = url; });
        logoBugGhostEl.appendChild(img);
        // Mirrors the real logo bug (updateLogoBug above) — the ghost should
        // show the same content it's an afterimage of, chip included.
        const numChip = document.createElement('span');
        numChip.className = 'badge-num';
        numChip.textContent = String(ch.number);
        logoBugGhostEl.appendChild(numChip);
      } else {
        logoBugGhostEl.style.background = channelColor(ch);
        logoBugGhostEl.textContent = String(ch.number);
      }
      logoBugGhostEl.classList.remove('hidden');
    } else {
      logoBugGhostEl.classList.add('hidden');
    }
  }

  if (key) {
    tickLogoBugGhost();
    S.logoBugBurnTimer = setInterval(tickLogoBugGhost, 15000);
  } else {
    logoBugGhostEl.style.setProperty('--logo-bug-burn-opacity', 0);
  }
}

// TV content-rating bug — flashed briefly whenever a program starts, mirrors
// the logo bug's show/hide but auto-hides on a timer like the up-next bar.
export function flashRatingBug(ch) {
  ratingBugEl.textContent = ch.rating;
  ratingBugEl.classList.add('show');
  playConfiguredSound('card', ch.number);
  S.ratingBugTimer = autoHideAfter(S.ratingBugTimer, 6000, () => ratingBugEl.classList.remove('show'));
}

export function scheduleBlockBoundaryRetune(ch) {
  clearTimeout(S.blockBoundaryTimer);
  const boundary = nextSourceBoundary(ch, viewNow());
  if (!isFinite(boundary)) return;
  S.blockBoundaryTimer = setTimeout(() => {
    if (S.currentNumber !== ch.number || !S.isPoweredOn) return;
    playChannelLive(ch);
    scheduleBlockBoundaryRetune(ch);
  }, boundary - viewNow() + 500);
}

export function changeChannel(direction) {
  const numbers = virtualChannelNumbers()
    .concat(sortedChannels().map((c) => c.number))
    .sort((a, b) => a - b);
  if (numbers.length === 0) return;
  let idx = numbers.indexOf(S.currentNumber);
  if (idx === -1) idx = 0;
  else idx = (idx + direction + numbers.length) % numbers.length;
  tuneToChannel(numbers[idx]);
}

// Jumps between only the channels marked as favorites — a no-op (not a
// fallback to the full channel list) when none are set, since silently
// surfing everything would defeat the point of a dedicated favorites key.
export function changeFavoriteChannel(direction) {
  const favs = sortedChannels().filter((c) => c.favorite).map((c) => c.number);
  if (favs.length === 0) return;
  let idx = favs.indexOf(S.currentNumber);
  if (idx === -1) idx = 0;
  else idx = (idx + direction + favs.length) % favs.length;
  tuneToChannel(favs[idx]);
}

// Real-remote-style "LAST" button: jumps back to whatever channel you were
// on before the current one. Pressing it twice returns you to where you
// started, same as a real cable box.
export function jumpToLastChannel() {
  if (S.previousNumber == null) return;
  tuneToChannel(S.previousNumber);
}

window.tuneToChannel = tuneToChannel;

