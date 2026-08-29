// The ad-break state machine — deciding when a commercial/station-ID/trivia/
// up-next/preemption/sign-off-or-on window is due (checkBreakState, the
// single unified boundary timer scheduleNextBreak re-arms), entering and
// leaving one (startBreak/endBreak), the "up next" promo bar and per-file
// content-advisory cues that ride alongside normal content playback
// (scheduleUpNextBar/cancelUpNextBar, scheduleContentAdvisoryCues), the
// dynamic-bumper text template resolver (renderDynamicText, plus its
// computeNextTitle/computeDaysUntil/computeEpisodesUntilWrap helpers), and
// the fade-to-black transition helpers used on nearly every cut into or out
// of a break (fadeOutPlayer/fadeInPlayer) — these live here rather than in
// playback-core.js because the break machine is by far their heaviest user.
// Split out of the former monolithic playback.js alongside playback-core.js
// (tune/source resolution) and playback-broadcast-fx.js (static/no-signal
// rendering, credits speedup, and every on-screen bug overlay) — see those
// files' own header comments.
import { playConfiguredSound } from './audio.js';
import { entryWaitMs, nextBreakBoundary, resolveBreakAt } from './interstitials.js';
import { clearDynamicOverlaysForBreak, triggerDynamicOverlays } from './dynamic-overlays.js';
import {
  crtToggleFlash, dynamicBumperTextEl, guideGrid, localAvailCardEl, localAvailTextEl, logoBugEl, player,
  stationIdBarEl, stationIdNameEl, testPatternCanvasEl, triviaCardEl, triviaTextEl, upNextBarEl, upNextTitleEl,
} from './dom.js';
import { applyDisplayMode, cacheVideoSize } from './display-mode.js';
import { applyTvBezel, applyVolume } from './power.js';
import { runCoreHooks } from './plugins.js';
import {
  computeSourcePosition, nextBlockStartMs, nextSourceBoundary, resolveActiveSource,
} from './schedule.js';
import { S, saveConfigDebounced, viewNow } from './state.js';
import { autoHideAfter, formatClock, getDisplayTitle } from './util.js';
import { playChannelLive } from './playback-core.js';
import { flashContentAdvisory, flashLocalAvailCut, updateLogoBug } from './playback-broadcast-fx.js';

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
      // Same preemption exception as endBreak below — a break-to-break
      // transition straight out of a preemption must not credit its time
      // back either.
      if (S.activeBreakKey && S.activeBreakInterruptsContent && S.activeBreakKind !== 'preemption') {
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
  preemption: 'SPECIAL REPORT',
  sweepsPromo: 'A SPECIAL EVENT',
};

// Fade-to-black around a break bumper cut (entering or leaving) — resolves
// once the CSS opacity transition has had time to run, so callers can await
// it before swapping player.src and cutting over. These are the fallback
// durations used whenever a call site has no specific pool entry to read
// fadeOutMs/fadeInMs from (endBreak's own fade back to content, ordinary
// content-to-content cuts) — matches tv.css's own fallback transition-
// duration, so behavior is unchanged for anyone who never touches the new
// per-entry fields (setup-interstitials.js).
const DEFAULT_FADE_OUT_MS = 180;
const DEFAULT_FADE_IN_MS = 220;
// How long checkBreakState will keep deferring a boundary-timer cutoff for a
// real-file bumper whose probed duration undershot its actual length, before
// giving up and cutting it anyway (see S.awaitingBumperEnd above).
const BUMPER_OVERRUN_GRACE_MS = 8000;
export function fadeOutPlayer(ms = DEFAULT_FADE_OUT_MS) {
  return new Promise((resolve) => {
    // Inline style wins over tv.css's class-based transition-duration,
    // letting a per-entry fadeOutMs (startBreak) override the fallback
    // without needing a matching CSS rule per possible value.
    player.style.transitionDuration = `${ms}ms`;
    player.classList.add('screen-fade-out');
    setTimeout(resolve, ms);
  });
}
export function fadeInPlayer(ms = DEFAULT_FADE_IN_MS) {
  player.style.transitionDuration = `${ms}ms`;
  requestAnimationFrame(() => player.classList.remove('screen-fade-out'));
}

const DAY_MS = 86400000;

export function computeNextTitle(ch) {
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
  const {
    type, entry, label, windowStart, preemptionLabel,
  } = resolved;
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
  // Some real networks drop their corner bug during breaks, some keep it up
  // through them — a per-channel opt-in (default off, today's "always
  // visible" behavior unchanged). Only for breaks that actually take over
  // the screen — not the text-only "you're watching" station-ID bar, which
  // doesn't interrupt content and coexists with the bug in real practice.
  if (ch.logoBugHidesOnBreak && !isTextOnlyChannelId) logoBugEl.classList.add('hidden');
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
  if (type === 'localAvail') {
    // Same boundary-driven (not 'ended'-event-driven) resume model as
    // trivia above — nothing plays on `player`, so checkBreakState's own
    // periodic boundary check is what ends this once viewNow() passes
    // windowEnd (which already includes this entry's waitMs, if any).
    cancelUpNextBar();
    player.pause();
    // A brief noise-flash right at the cut, mimicking real cable head-end
    // equipment switching feeds for a local ad insertion — distinct from a
    // national commercial's clean cut. Shown by default; ch.hideLocalAvailGlitch
    // opts a channel out, same "hideX" convention as the rating/episode-
    // status/format-disclaimer toggles above.
    if (!ch.hideLocalAvailGlitch) flashLocalAvailCut();
    localAvailTextEl.textContent = (entry && entry.text) || 'ONE MOMENT, PLEASE.';
    localAvailCardEl.classList.remove('hidden');
    return;
  }

  // Built-in default sign-off/sign-on visual — a real station's test
  // pattern, for the slot's whole window, rather than a silent cut straight
  // from content to the persistent SIGN-OFF card (showSignOffCard). Only
  // reached when no custom bumper media is configured for this slot (see
  // resolveBreakAt's synthetic-window fallback, interstitials.js) — a
  // configured video always wins via the normal video-kind path below.
  if ((type === 'signOff' || type === 'signOn') && !entry) {
    cancelUpNextBar();
    player.pause();
    runCoreHooks('draw-test-pattern');
    testPatternCanvasEl.classList.remove('hidden');
    crtToggleFlash.textContent = BREAK_LABELS[type];
    crtToggleFlash.classList.add('show');
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
  else if (type === 'preemption') crtToggleFlash.textContent = preemptionLabel;
  else crtToggleFlash.textContent = BREAK_LABELS[type] || 'COMMERCIAL BREAK';
  crtToggleFlash.classList.add('show');

  // Per-entry transition timing (setup-interstitials.js's FADE IN/FADE OUT/
  // WAIT AFTER fields) — null/unset falls back to the same defaults every
  // entry used before these fields existed, so an untouched entry's on-air
  // look doesn't change at all.
  const entryFadeOutMs = entry.fadeOutMs != null ? entry.fadeOutMs : DEFAULT_FADE_OUT_MS;
  const entryFadeInMs = entry.fadeInMs != null ? entry.fadeInMs : DEFAULT_FADE_IN_MS;
  const entryWaitAfterMs = entryWaitMs(entry);

  if (entry.dynamic) {
    (async () => {
      try {
        const filePath = (entry.bgFile && entry.bgFile.path) || '';
        const resolved = await window.api.resolvePlayablePath('local', filePath);
        const [, url] = await Promise.all([fadeOutPlayer(entryFadeOutMs), window.api.toFileUrl(resolved.path)]);
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
          fadeInPlayer(entryFadeInMs);
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
      const [, url] = await Promise.all([fadeOutPlayer(entryFadeOutMs), window.api.toFileUrl(resolved.path)]);
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
        fadeInPlayer(entryFadeInMs);
      };
      S.metaHandler = onMeta;
      player.addEventListener('loadedmetadata', onMeta);

      // The video itself ends the instant its own content runs out — a
      // configured WAIT AFTER (entryWaitAfterMs) holds on the now-ended
      // frame for that much longer before actually resuming, matching the
      // extended windowEnd buildPod/windowFor compute for this same entry
      // (interstitials.js) so live playback and the pure schedule-window
      // model (time machine, other channels) agree on when this break
      // really ends.
      const resume = () => {
        player.removeEventListener('ended', resume);
        player.removeEventListener('error', resume);
        const finish = () => {
          S.awaitingBumperEnd = false;
          if (key) markBreakCompleted(key);
          // Re-resolve instead of unconditionally calling endBreak: a
          // multi-segment pod (bumpIn -> commercial -> bumpOut) has this
          // same entry-ended event fire at every segment boundary, not just
          // the pod's real end. Calling endBreak here unconditionally used
          // to resume real content for a frame or two before checkBreakState's
          // own next tick corrected course into the next segment — a visible
          // flash of the show between commercials. checkBreakState resolves
          // fresh: if another segment is due right now it transitions
          // straight into it (no content in between); only when nothing's
          // due does it fall through to endBreak, exactly as before.
          checkBreakState(ch);
        };
        if (entryWaitAfterMs > 0) setTimeout(finish, entryWaitAfterMs);
        else finish();
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
    windowEnd: windowStart + durationS * 1000 + entryWaitMs(entry),
  }, null);
  return true;
}

function endBreak(ch) {
  const shouldResume = S.activeBreakInterruptsContent;
  // Preemption is the one break type that must NOT credit its time back —
  // see resolveBreakAt's comment (interstitials.js). Captured before
  // resetActiveBreakState() clears S.activeBreakKind below, same as
  // shouldResume above.
  const skipResumeLag = S.activeBreakKind === 'preemption';
  if (S.activeBreakKey) markBreakCompleted(S.activeBreakKey);
  resetActiveBreakState();
  S.awaitingBumperEnd = false;
  S.breakOverrunSince = null;
  stationIdBarEl.classList.remove('show');
  triviaCardEl.classList.add('hidden');
  localAvailCardEl.classList.add('hidden');
  crtToggleFlash.classList.remove('show');
  dynamicBumperTextEl.classList.add('hidden');
  // Cleans up the default sign-off/sign-on test-pattern visual (above) if
  // that's what was showing — a no-op otherwise, since every other break
  // path already hides this itself once its own content is ready.
  testPatternCanvasEl.classList.add('hidden');
  clearDynamicOverlaysForBreak();
  player.loop = false;
  applyVolume();
  // Credits back exactly how long content was actually off-screen for this
  // break, so the next computeLiveContentPosition() call resumes right
  // where it left off instead of having skipped ahead by the break length.
  // Preemption deliberately skips this: content resumes via the plain,
  // un-lagged live schedule position instead, matching real broadcast TV
  // where the rest of the world's schedule didn't wait for the interruption
  // to end.
  if (shouldResume && S.breakEnteredAtMs) {
    if (!skipResumeLag) S.contentLostMs += viewNow() - S.breakEnteredAtMs;
    S.breakEnteredAtMs = 0;
  }
  if (shouldResume && S.currentNumber === ch.number && S.isPoweredOn) {
    if (ch.logoBugHidesOnBreak) updateLogoBug(ch);
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

// Schedules file.advisoryCues (array of { offsetS, text }, setup-panels.js's
// TITLES tab) — one setTimeout per cue still ahead of the current position,
// each guarded the same way scheduleUpNextBar's callback is (bails if the
// user tuned away or powered off before it fired). Re-scheduling on every
// onMeta call clears the previous file's cues automatically, same
// self-cleanup shape as scheduleUpNextBar/scheduleCreditsSpeedup.
export function scheduleContentAdvisoryCues(ch, file, seekOffsetS) {
  (S.contentAdvisoryCueTimers || []).forEach((t) => clearTimeout(t));
  S.contentAdvisoryCueTimers = [];
  if (ch.hideContentAdvisory || !file.advisoryCues || !file.advisoryCues.length) return;
  file.advisoryCues.forEach((cue) => {
    const delayMs = (cue.offsetS - seekOffsetS) * 1000;
    if (delayMs < 0) return; // already past this cue's point in the file
    const timer = setTimeout(() => {
      if (S.currentNumber !== ch.number || !S.isPoweredOn) return;
      if (!triggerDynamicOverlays(ch, 'contentAdvisory')) flashContentAdvisory(ch, cue.text);
    }, delayMs);
    S.contentAdvisoryCueTimers.push(timer);
  });
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
