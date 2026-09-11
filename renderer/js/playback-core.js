// Tune/source resolution — the entry points that decide WHAT plays on a
// channel right now and get the player actually showing it: resolving the
// live schedule position for a channel (computeLiveContentPosition),
// starting real content playback and its unplayable-file recovery ladder
// (playChannelLive), the full tune sequence a channel change runs through
// (tuneToChannel), channel-surfing/favorites/last-channel entry points
// (changeChannel/changeFavoriteChannel/jumpToLastChannel), and the two
// re-tune timers that fire tuneToChannel/playChannelLive again when a
// channel's own broadcast-hours or block-boundary schedule crosses a line
// while it's already tuned in (scheduleBroadcastHoursRetune/
// scheduleBlockBoundaryRetune). Split out of the former monolithic
// playback.js alongside playback-breaks.js (the ad-break state machine) and
// playback-broadcast-fx.js (static/no-signal rendering, credits speedup, and
// every on-screen bug overlay) — see those files' own header comments.
import {
  playChannelClickSound, playDaypartChime,
} from './audio.js';
import {
  getChannel, parseMediaRef, sortedChannels,
} from './channels.js';
import { hideDynamicOverlay, triggerDynamicOverlays } from './dynamic-overlays.js';
import {
  crtToggleFlash, dynamicBumperTextEl, guideOverlay, player,
  ratingBugEl, stationIdBarEl, testPatternCanvasEl, triviaCardEl,
} from './dom.js';
import { applyDisplayMode, cacheVideoSize, resolveContentDisplayMode, resolveEffectiveDisplayMode } from './display-mode.js';
import { showGuideOverlay } from './guide.js';
import { tuneTimingEnabled } from './perf.js';
import { applyBlockTheme, applyChannelIdentity, applyMuteState, applyTvBezel, applyVhsQuality, applyVolume, powerOff, pushRemoteState } from './power.js';
import { cancelAllInterrupts, runCoreHooks, scheduleAllInterrupts, tuneGateEntries } from './plugins.js';
import {
  computeSourcePosition, isWithinBroadcastHours, nextBroadcastHoursBoundary, nextSourceBoundary,
  resolveActiveSource,
} from './schedule.js';
import { S, saveConfigDebounced, viewNow } from './state.js';
import { exitTimeMachine, stopShuttle, updateTimeShiftBadge, updateVcrOsd } from './timemachine.js';
import { isEnabledByDefault } from './util.js';
import { getVirtualBadge, hideVirtualChannels, isVirtualChannel, showVirtualChannel, virtualChannelNumbers } from './virtual.js';
import { waitForMediaSourceReady as waitForProviderMediaSource } from './playback-recovery.js';
import {
  cancelUpNextBar, checkBreakState, fadeInPlayer, resetActiveBreakState, scheduleContentAdvisoryCues,
  scheduleUpNextBar,
} from './playback-breaks.js';
import {
  applyLogoBugPlacement, channelNoSignalCopy, finishCreditsSpeedupIfActive, flashCapabilityBadge,
  flashContentAdvisory, flashEpisodeStatusBug,
  flashFormatDisclaimer, flashRatingBug, genericNoSignalCopy, hideNoSignal, markStaticReady, resetCreditsSpeedup,
  scheduleCreditsSpeedup, showBlockedCard, showMovieRatingCard, showNoSignal, showSignOffCard, showStaticBurst,
  updateLogoBug,
} from './playback-broadcast-fx.js';

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
    clearStatus: () => hideNoSignal(),
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

    // A single failed decode attempt can be a transient stall — a slow disk
    // or network/NAS drive, especially on a mid-file seek (this app's whole
    // point is tuning in partway through a show) — rather than a genuine
    // codec problem. Retry the tune fresh exactly once (same idea as
    // opts.cacheRetried above, just for local files) before reaching for a
    // real, expensive, multi-second ffmpeg transcode. Found live: normal,
    // perfectly playable files on a slow drive were getting transcoded on
    // nearly every tune-in because the very first stall was treated as
    // conclusive. resolved.alreadyFixed skips this — a file whose transcode
    // swap already happened isn't going to start working via a bare retry.
    if (!opts.playRetried && !resolved.alreadyFixed) {
      playChannelLive(ch, { ...opts, playRetried: true });
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

    hideNoSignal();
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

    // Started right after `player.currentTime = seekOffset` (onMeta below),
    // so on a large mid-file seek — the common case here, since tuning in is
    // always "resume wherever this would really be right now" — the seek
    // itself can eat multiple seconds on a slow disk or network/NAS drive
    // before decoding even begins. That used to count directly against the
    // decode-detection window below, so a file with a completely fine codec
    // read as "unplayable" purely because the seek was slow, and got sent
    // through a real ffmpeg transcode for no reason (found live). Wait out
    // the seek itself first — on its own, generous timer, since a slow seek
    // isn't a codec problem no transcode would fix anyway — then only start
    // the actual short decode watchdog once the player has settled at the
    // target position.
    let seekSettled = false;
    // A media-source-plugin file (file.source !== 'local', e.g. Google
    // Drive) is streamed live via a real network round-trip per Range
    // request (readRange), not a local disk read — and the very first
    // decode often needs two sequential ones (moov atom, then the mdat
    // bytes it points at, especially for a non-"faststart" file where moov
    // sits at the end) before Chromium can produce anything. 4s was tuned
    // for a local disk seek and routinely lost that race for a remote
    // source, so live streaming looked "unplayable" on nearly every tune
    // and fell straight through to the full-download cache fallback
    // (waitForMediaSourceReady above) even though nothing was actually
    // wrong — found live: "google drive always having to retrieve from
    // cache" when live streaming should have worked. Local files keep the
    // original tight budget; only remote sources get the longer one.
    const decodeTimeoutMs = (file.source && file.source !== 'local') ? 12000 : 4000;
    function startFrameWatch() {
      if (seekSettled || handled) return;
      seekSettled = true;
      player.removeEventListener('seeked', onSeeked);
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
      }, decodeTimeoutMs);
    }
    function onSeeked() { startFrameWatch(); }

    if (player.seeking) {
      player.addEventListener('seeked', onSeeked);
      // If the seek somehow never resolves, still fall through to the normal
      // decode watch rather than waiting forever — a genuinely wedged player
      // needs to reach handleUnplayable eventually too.
      setTimeout(() => { player.removeEventListener('seeked', onSeeked); startFrameWatch(); }, 10000);
    } else {
      startFrameWatch();
    }
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
    hideNoSignal();
    S.channelFailStreak[ch.number] = 0;
    // A per-file rating (setup-panels.js's TITLES tab) overrides the
    // channel-wide one for mixed-content channels (e.g. a movie channel
    // airing both PG and PG-13 titles) - 'NONE' is an explicit "no bug for
    // this file" distinct from unset (which falls back to ch.rating).
    const effectiveRating = file.rating === 'NONE' ? null : (file.rating || ch.rating);
    // Real rating bugs/cards only reappear for roughly the first 15 minutes
    // of a program (start + the first few commercial breaks) — a 2-hour
    // movie's later breaks don't re-pop it. onMeta runs on every break
    // resume (endBreak -> playChannelLive), so without this cap the bug
    // would flash on every single return from break for the whole runtime.
    const isEarlyInProgram = seekOffset < 900;
    if (effectiveRating && isEarlyInProgram && !ch.hideRatingBug) {
      // Movies got a distinct full-screen "rated X for..." card before the
      // film started on broadcast TV, rather than the small TV Parental
      // Guidelines corner bug regular programs use.
      if (file.facets && file.facets.contentType === 'movie') {
        if (!triggerDynamicOverlays(ch, 'movieRatingCard')) showMovieRatingCard(ch, effectiveRating);
      } else if (!triggerDynamicOverlays(ch, 'contentRating')) {
        flashRatingBug(ch, effectiveRating);
      }
    }
    // "NEW EPISODE"/rerun bug — pos.loopCount (computeSourcePosition,
    // schedule.js) is 0 the first time this content pool has played through
    // since its source's anchor, 1+ once it has looped — a pure derivation
    // from anchor+duration, not a stored play-count log (see that comment
    // for why one isn't kept). Skipped for movies/promos/bumpers, which
    // aren't "episodic" content real syndication bugs apply to.
    const contentType = file.facets && file.facets.contentType;
    if (isEarlyInProgram && !ch.hideEpisodeStatus && typeof pos.loopCount === 'number'
      && contentType !== 'movie' && contentType !== 'promo' && contentType !== 'bumper') {
      const episodeStatus = pos.loopCount > 0 ? 'REPEAT' : 'NEW EPISODE';
      if (!triggerDynamicOverlays(ch, 'episodeStatus')) flashEpisodeStatusBug(ch, episodeStatus);
    }
    // Content advisory — distinct from the rating value, a free-text
    // disclaimer set per file (setup-panels.js's TITLES tab), never
    // auto-generated from anything else.
    if (isEarlyInProgram && file.advisory && !ch.hideContentAdvisory) {
      if (!triggerDynamicOverlays(ch, 'contentAdvisory')) flashContentAdvisory(ch, file.advisory);
    }
    // Mid-program scene-specific cues (file.advisoryCues) — same card as
    // the start-of-program advisory above, just fired at specific offsets
    // instead of once at start. Scheduled fresh on every onMeta (a new
    // file, or a break-resume of the same one), each cue's own setTimeout
    // guards against having fired after a tune-away, same pattern
    // scheduleUpNextBar/scheduleCreditsSpeedup already use instead of
    // needing an explicit cancel wired into every tune-away call site.
    scheduleContentAdvisoryCues(ch, file, seekOffset);
    // CC/SAP/STEREO capability badge — manually curator-tagged per file
    // (file.hasCC/hasSAP/hasStereo, TITLES tab), same "isEarlyInProgram"
    // gate as every other corner bug above.
    if (isEarlyInProgram && !ch.hideCapabilityBadge) {
      // Tri-state file override (null = inherit ch.defaultHasX) — same
      // fallback shape as effectiveRating above, just three fields instead
      // of one value.
      const effectiveHasCC = file.hasCC != null ? file.hasCC : !!ch.defaultHasCC;
      const effectiveHasSAP = file.hasSAP != null ? file.hasSAP : !!ch.defaultHasSAP;
      const effectiveHasStereo = file.hasStereo != null ? file.hasStereo : !!ch.defaultHasStereo;
      const capabilityLabels = [
        effectiveHasCC && 'CC', effectiveHasSAP && 'SAP', effectiveHasStereo && 'STEREO',
      ].filter(Boolean);
      if (capabilityLabels.length) {
        if (!triggerDynamicOverlays(ch, 'capabilityBadge')) flashCapabilityBadge(ch, capabilityLabels);
      }
    }
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
    // "Formatted to fit your screen" disclaimer — real syndicated reruns
    // flash this once when a file's native aspect doesn't match the box's
    // currently-applied one (e.g. a 4:3 pan-and-scan print airing on a
    // 16:9-configured channel, or vice versa). Both sides are pure
    // functions already computed for AUTO display mode (display-mode.js);
    // only trustworthy here, same as the AUTO-resolution comment above,
    // since player.videoWidth/videoHeight are now real and confirmed to
    // belong to this channel.
    if (isEarlyInProgram && !ch.hideFormatDisclaimer) {
      const contentAspect = resolveContentDisplayMode().aspect;
      const effectiveAspect = resolveEffectiveDisplayMode().aspect;
      if (contentAspect !== effectiveAspect) {
        const disclaimer = contentAspect === '4:3'
          ? 'THIS PROGRAM HAS BEEN FORMATTED TO FIT YOUR SCREEN'
          : 'THIS PROGRAM IS PRESENTED IN WIDESCREEN';
        if (!triggerDynamicOverlays(ch, 'formatDisclaimer')) flashFormatDisclaimer(ch, disclaimer);
      }
    }
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
    scheduleCreditsSpeedup(ch, freshPos || pos);
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
  // Before anything else - if credits speedup was running for the file that
  // just ended, it finished for real (this IS the file's own 'ended' event,
  // just fired earlier than the pure schedule expected) - credit the time
  // saved back so computeLiveContentPosition's schedule position catches up
  // to what actually aired, then clear the squeeze visual/audio state.
  finishCreditsSpeedupIfActive();
  checkBreakState(ch, { contentJustEnded: true });
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
  // A hidden channel (setup-channels.js's HIDE FROM TUNING toggle) is
  // treated as if `number` were never configured at all — same NO SIGNAL
  // fallback every branch below already takes for an unknown number, not a
  // separate blocked/gated state. This is the one place that needs to know
  // about ch.hidden for direct/explicit tunes (a typed number, a quick-tap
  // button, a deep link) — filteredChannels()/changeChannel/
  // changeFavoriteChannel (channels.js, playback.js) already keep hidden
  // channels out of the guide and channel-surfing, so this is only ever
  // reached by something bypassing those.
  const rawCh = getChannel(number);
  const ch = (rawCh && rawCh.hidden) ? null : rawCh;
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
  resetCreditsSpeedup();
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
  hideNoSignal();
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

export function scheduleBlockBoundaryRetune(ch) {
  clearTimeout(S.blockBoundaryTimer);
  const boundary = nextSourceBoundary(ch, viewNow());
  if (!isFinite(boundary)) return;
  // Captured now (before the boundary) so the timer callback below has
  // something to diff the post-boundary block identity against — see the
  // dayparting-chime comment inside the callback.
  const beforeSource = resolveActiveSource(ch, viewNow());
  const beforeBlockId = beforeSource && beforeSource.block && beforeSource.block.id;
  S.blockBoundaryTimer = setTimeout(() => {
    if (S.currentNumber !== ch.number || !S.isPoweredOn) return;
    // Dayparting transition chime — a short sting when the schedule crosses
    // into a genuinely DIFFERENT block (morning cartoons -> primetime),
    // not on a daily/weekly block's own re-airing of itself the next day
    // (resolveActiveSource's `key` changes on every daily occurrence, but
    // `.block.id` only changes when a different block actually takes over
    // — see resolveActiveSource's own key-suffix comment, schedule.js).
    // Opt-in (box-wide off by default) since it's a new ambient sound;
    // ch.hideDaypartChime lets one channel opt back out even when it's on.
    if (S.config.display && S.config.display.daypartChimeEnabled && !ch.hideDaypartChime) {
      const afterSource = resolveActiveSource(ch, viewNow());
      const afterBlockId = afterSource && afterSource.block && afterSource.block.id;
      if (beforeBlockId !== afterBlockId) playDaypartChime();
    }
    playChannelLive(ch);
    scheduleBlockBoundaryRetune(ch);
  }, boundary - viewNow() + 500);
}

export function changeChannel(direction) {
  const numbers = virtualChannelNumbers()
    .concat(sortedChannels().filter((c) => !c.hidden).map((c) => c.number))
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
  const favs = sortedChannels().filter((c) => c.favorite && !c.hidden).map((c) => c.number);
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
