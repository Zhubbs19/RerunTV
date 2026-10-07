import { sfxGuideToggle, sfxVolumeTick } from '../core/audio.js';
import { getChannel } from '../core/channels.js';
import {
  crtToggleFlash, dynamicBumperTextEl, player, stationIdBarEl, stationIdNameEl, tapeFxEl, timeShiftBadgeEl,
  triviaCardEl, triviaTextEl, vcrModeEl, vcrOsdEl, vcrProgEl, vcrSpeedEl, vcrTimeEl,
} from '../core/dom.js';
import { nextBreakStart, prevBreakStart, resolveBreakAt } from '../core/interstitials.js';
import { playChannelLive, scheduleBlockBoundaryRetune } from './core.js';
import { cancelUpNextBar, checkBreakState, renderDynamicText, resetActiveBreakState } from './breaks.js';
import { applyTvBezel, flashMessage, pushRemoteState } from './power.js';
import { resetCreditsSpeedup } from './broadcast-fx.js';
import { computeLivePosition } from '../core/schedule.js';
import { MONTHS, S, SHUTTLE_SPEEDS, WEEKDAYS, viewNow } from '../core/state.js';
import { querySchedule } from '../core/schedule-query.js';
import {
  boundaryAfter, boundaryBefore, isFarJump, programAt, scrubStepMs, scrubWindow,
} from '../timeline/scrubber.js';
import { breakMarkEl, spanPercent, timeAtFraction } from '../timeline/render.js';
import { formatClock, formatOffset, getDisplayTitle } from '../core/util.js';
import { isVirtualChannel, virtualChannelSupportsTimeMachine, virtualChannelTimeMachineText } from './virtual.js';
import { Toast } from '../ui/toast.js';

const BREAK_OSD_LABELS = {
  commercial: 'COMMERCIAL BREAK', trivia: 'TRIVIA', channelId: 'STATION ID',
  upNext: 'UP NEXT', adBreakIn: 'COMMERCIAL BREAK', adBreakOut: 'BACK TO THE SHOW',
  promo: 'COMING SOON', signOff: 'SIGNING OFF', signOn: 'SIGNING ON',
  localAvail: 'STATION MESSAGE', preemption: 'SPECIAL REPORT', premiereJingle: 'PREMIERING NOW', sweepsPromo: 'A SPECIAL EVENT',
};

export function timeMachineAvailable() {
  if (!(S.config.timeMachine && S.config.timeMachine.enabled)) return false;
  // A plugin channel can opt in when its own playback is a pure function of
  // a timestamp, exactly like core's schedule.js — scrubbing then works for
  // free, because the plugin re-derives from viewNow() the same way. Without
  // the opt-in, the old "no real channel record, so no time machine" rule
  // still holds.
  if (isVirtualChannel(S.currentNumber)) return virtualChannelSupportsTimeMachine(S.currentNumber);
  return !!getChannel(S.currentNumber);
}

export function updateTimeShiftBadge() {
  const showBadge = !(S.config.timeMachine && S.config.timeMachine.showTimeShiftBadge === false);
  if (!showBadge || Math.abs(S.timeOffsetMs) < 1000) {
    timeShiftBadgeEl.classList.add('hidden');
    return;
  }
  timeShiftBadgeEl.textContent = `TIME SHIFT ${formatOffset(S.timeOffsetMs)}`;
  timeShiftBadgeEl.classList.remove('hidden');
}

export function updateVcrOsd() {
  const ch = getChannel(S.currentNumber);
  if (S.shuttleDir === 0) {
    vcrModeEl.textContent = 'PLAY';
    vcrSpeedEl.textContent = '';
  } else {
    vcrModeEl.textContent = S.shuttleDir < 0 ? '◀◀ REW' : 'FF ▶▶';
    vcrSpeedEl.textContent = `×${SHUTTLE_SPEEDS[S.shuttleSpeedIdx]}`;
  }
  const d = new Date(viewNow());
  const day = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  vcrTimeEl.textContent = `${day}  ${formatClock(d)}   (${formatOffset(S.timeOffsetMs)})`;
  if (ch) {
    // resolveBreakAt is the same pure function live playback uses — this is
    // the literal "time machine remembers past/future commercials" feature:
    // scrubbing to any instant, not just live "now," shows exactly what
    // would/did air there.
    const brk = resolveBreakAt(ch, viewNow());
    if (brk) {
      vcrProgEl.textContent = BREAK_OSD_LABELS[brk.type] || 'BREAK';
    } else {
      const pos = computeLivePosition(ch);
      vcrProgEl.textContent = pos ? getDisplayTitle(pos.file) : '—';
    }
  } else {
    // No channel record means a plugin channel that opted in above; it is
    // the only thing that knows what it is playing at the scrubbed instant.
    vcrProgEl.textContent = virtualChannelTimeMachineText(S.currentNumber, viewNow());
  }
  updateTimeShiftBadge();
  renderScrubber();
}

// ---------- Scrubber strip (docs/design/11 §3.1) ----------
// A window of ±3 h around the viewed time along the bottom of the screen:
// programs as segments, break pods as ticks (the same marks as SCHEDULE > ON
// AIR, timeline-render.js), a cursor at the viewed time and a LIVE marker.
// Built from querySchedule, so it's the same pure schedule live playback and
// the guide read; nothing is recorded.
let scrubEl = null;
let scrubWin = null;
let scrubSig = '';
let scrubPrograms = [];
let scrubDragging = false;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function dayClock(ms) {
  const d = new Date(ms);
  return `${WEEKDAYS[d.getDay()].slice(0, 3)} ${MONTHS[d.getMonth()]} ${d.getDate()} ${formatClock(d)}`;
}

function ensureScrubber() {
  if (scrubEl) return scrubEl;
  scrubEl = el('div', 'tm-scrubber');
  const labels = el('div', 'tm-scrub-labels');
  labels.append(el('span', 'tm-scrub-from'), el('span', 'tm-scrub-at'), el('span', 'tm-scrub-to'));
  const track = el('div', 'tm-scrub-track');
  track.setAttribute('role', 'slider');
  track.setAttribute('aria-label', 'Time machine position');
  track.append(el('div', 'tm-scrub-programs'), el('div', 'tm-scrub-breaks'), el('div', 'tm-scrub-live'), el('div', 'tm-scrub-cursor'));
  track.querySelector('.tm-scrub-live').appendChild(el('span', 'tm-scrub-live-label', 'LIVE ▶'));
  const banner = el('div', 'tm-scrub-banner hidden');
  scrubEl.append(labels, track, banner);
  installScrubberPointer(track);
  vcrOsdEl.appendChild(scrubEl);
  return scrubEl;
}

function renderScrubber() {
  if (!S.timeMachineOn) return;
  const strip = ensureScrubber();
  const viewed = viewNow();
  // Held still while a pointer drags, so the strip doesn't slide under it.
  if (!scrubDragging) scrubWin = scrubWindow(viewed, scrubWin);
  const { from, to } = scrubWin;
  const ch = getChannel(S.currentNumber);
  const sig = [from, to, S.currentNumber, S.configGeneration].join('|');
  if (sig !== scrubSig) {
    scrubSig = sig;
    const programsEl = strip.querySelector('.tm-scrub-programs');
    const breaksEl = strip.querySelector('.tm-scrub-breaks');
    programsEl.innerHTML = '';
    breaksEl.innerHTML = '';
    scrubPrograms = [];
    if (ch) {
      let q = null;
      try { q = querySchedule(ch, from, to, { offAir: false }); } catch (e) { console.warn('[time machine] scrubber schedule failed', e); }
      if (q) {
        scrubPrograms = q.programs;
        q.programs.forEach((p, i) => {
          const pos = spanPercent(p.start, p.end, from, to, { minWidthPct: 0.15 });
          if (!pos) return;
          const seg = el('div', `tm-scrub-program${i % 2 ? ' alt' : ''}`);
          seg.style.left = `${pos.left}%`;
          seg.style.width = `${pos.width}%`;
          const title = getDisplayTitle(p.file);
          seg.title = `${formatClock(new Date(p.start))} ${title}`;
          seg.appendChild(el('span', 'tm-scrub-program-label', title));
          programsEl.appendChild(seg);
        });
        q.breaks.forEach((b) => {
          const pos = spanPercent(b.start, b.end, from, to, { minWidthPct: 0.25 });
          if (!pos) return;
          const mark = breakMarkEl(b, { className: 'tm-scrub-break' });
          mark.style.left = `${pos.left}%`;
          mark.style.width = `${pos.width}%`;
          breaksEl.appendChild(mark);
        });
      }
    }
    strip.querySelector('.tm-scrub-from').textContent = dayClock(from);
    strip.querySelector('.tm-scrub-to').textContent = dayClock(to);
  }

  const pct = (ms) => ((ms - from) / (to - from)) * 100;
  const cursor = strip.querySelector('.tm-scrub-cursor');
  cursor.style.left = `${Math.max(0, Math.min(100, pct(viewed)))}%`;
  // The LIVE marker is real now, deliberately Date.now() rather than
  // viewNow(): it marks where "return to live" would land, which the viewed
  // clock by definition isn't.
  const liveMs = Date.now();
  const live = strip.querySelector('.tm-scrub-live');
  live.classList.toggle('hidden', liveMs < from || liveMs > to);
  live.style.left = `${pct(liveMs)}%`;
  const current = programAt(scrubPrograms, viewed);
  const atText = current ? getDisplayTitle(current.file) : vcrProgEl.textContent;
  strip.querySelector('.tm-scrub-at').textContent = `▲ ${formatClock(new Date(viewed))} (${formatOffset(S.timeOffsetMs)})${atText ? ` · ${atText}` : ''}`;
  strip.querySelector('.tm-scrub-track').setAttribute('aria-valuetext', dayClock(viewed));
}

function showScrubBanner(text) {
  const banner = ensureScrubber().querySelector('.tm-scrub-banner');
  banner.textContent = text;
  banner.classList.remove('hidden');
}

function hideScrubBanner() {
  if (scrubEl) scrubEl.querySelector('.tm-scrub-banner').classList.add('hidden');
}

// Desktop pointer: click or drag anywhere on the strip to move there (paused);
// Enter/T plays from it, like OK on a remote.
function installScrubberPointer(track) {
  const moveTo = (event) => {
    if (!scrubWin) return;
    const rect = track.getBoundingClientRect();
    scrubToTime(timeAtFraction((event.clientX - rect.left) / rect.width, scrubWin.from, scrubWin.to));
  };
  track.addEventListener('pointerdown', (event) => {
    if (!S.timeMachineOn) return;
    scrubDragging = true;
    try { track.setPointerCapture(event.pointerId); } catch (e) { /* not capturable */ }
    moveTo(event);
    event.preventDefault();
  });
  track.addEventListener('pointermove', (event) => { if (scrubDragging) moveTo(event); });
  const end = () => {
    if (!scrubDragging) return;
    scrubDragging = false;
    renderScrubber();
  };
  track.addEventListener('pointerup', end);
  track.addEventListener('pointercancel', end);
}

// ---------- Scrubbing ----------
// Paused-and-positioned, not shuttling: S.scrubPending says the viewed time
// was moved and not yet committed. OK/Enter/T commit it (shuttlePlay), Back
// returns to live. Entering it clears break tracking exactly like starting a
// shuttle does (pauseForScrubbing).
let scrubPreviewTimer = null;
let holdStartedAt = 0;
let holdDir = 0;
let lastBoundaryStepAt = 0;
const BOUNDARY_REPEAT_MS = 400;

function queueScrubPreview() {
  if (scrubPreviewTimer) return;
  scrubPreviewTimer = setTimeout(() => {
    scrubPreviewTimer = null;
    if (S.timeMachineOn && S.scrubPending) updateShuttlePreview();
  }, 150);
}

function beginScrub() {
  if (!S.timeMachineOn) return false;
  if (S.shuttleDir !== 0) {
    // From shuttling straight into stepping: keep the tape paused where it is.
    S.shuttleDir = 0;
    S.shuttleSpeedIdx = 0;
    if (S.shuttleRAF) cancelAnimationFrame(S.shuttleRAF);
    S.shuttleRAF = null;
  }
  if (!S.scrubPending) {
    S.scrubPending = true;
    pauseForScrubbing();
  }
  return true;
}

// The moment the picture on screen belongs to. A paused scrub keeps the schedule clock
// running (viewNow() is real time plus a fixed offset), so by the time play is pressed
// the clock is ahead of the frame being watched — a few seconds on a 30 s ad is enough
// to land on the next ad, or back in the show. Committing to this moment instead puts
// play exactly where the screen is. previewOffsetMs says which offset it was taken at, so
// a different writer moving the offset (the guide, an air check) is not overridden.
function holdAt(ms) {
  S.previewMs = ms;
  S.previewOffsetMs = S.timeOffsetMs;
}

export function scrubToTime(targetMs) {
  if (!Number.isFinite(targetMs) || !beginScrub()) return;
  hideScrubBanner();
  S.timeOffsetMs = targetMs - Date.now();
  holdAt(targetMs);
  updateVcrOsd();
  queueScrubPreview();
}

export function scrubBy(deltaMs) {
  scrubToTime(viewNow() + deltaMs);
}

// ◀▶ in TV mode: 10 s, then 30 s, then 2 min, then whole programs the longer
// the key is held (scrubber-model.js). repeat is the key's auto-repeat flag;
// a fresh press restarts the ramp. Hold time is UI gesture timing, so
// performance.now(), not the viewed clock.
export function scrubStep(direction, { repeat = false } = {}) {
  if (!S.timeMachineOn) return;
  const now = performance.now();
  if (!repeat || holdDir !== direction) {
    holdStartedAt = now;
    holdDir = direction;
  }
  const step = scrubStepMs(now - holdStartedAt);
  if (step === 'boundary') {
    if (now - lastBoundaryStepAt < BOUNDARY_REPEAT_MS) return;
    lastBoundaryStepAt = now;
    scrubProgramBoundary(direction);
    return;
  }
  scrubBy(direction * step);
}

// ▲▼ in TV mode: the previous/next program start (replacing [ and ] on a
// remote that has no such buttons).
export function scrubProgramBoundary(direction) {
  if (!S.timeMachineOn) return;
  const ch = getChannel(S.currentNumber);
  if (!ch) return;
  const viewed = viewNow();
  let programs = [];
  try {
    programs = querySchedule(ch, viewed - 6 * 3600000, viewed + 6 * 3600000, { breaks: false, offAir: false }).programs;
  } catch (e) {
    return;
  }
  const target = direction > 0 ? boundaryAfter(programs, viewed) : boundaryBefore(programs, viewed);
  if (target != null) scrubToTime(target);
}

// TV menu › Time Machine › Go to… (§3.2). A jump inside the strip's window
// plays straight away; a far one lands paused on a banner and plays on OK.
export async function timeMachineGoTo(targetMs, label) {
  if (!Number.isFinite(targetMs)) return;
  if (!S.timeMachineOn) enterTimeMachine();
  if (!S.timeMachineOn) return;
  const far = isFarJump(viewNow(), targetMs);
  if (!beginScrub()) return;
  S.timeOffsetMs = targetMs - Date.now();
  holdAt(targetMs);
  if (!far) {
    await shuttlePlay();
    return;
  }
  scrubWin = null;
  updateVcrOsd();
  updateShuttlePreview();
  showScrubBanner(`${label} · ${dayClock(targetMs)} — OK TO PLAY`);
}

// What's airing at the viewed time on this channel (for "Start of this show").
export function currentProgramStart() {
  const ch = getChannel(S.currentNumber);
  if (!ch) return null;
  const viewed = viewNow();
  try {
    const p = programAt(querySchedule(ch, viewed - 3600000, viewed + 60000, { breaks: false, offAir: false }).programs, viewed);
    return p ? p.start : null;
  } catch (e) {
    return null;
  }
}

function hideShuttleBreakOverlays() {
  triviaCardEl.classList.add('hidden');
  stationIdBarEl.classList.remove('show');
  dynamicBumperTextEl.classList.add('hidden');
}

// While shuttling the player is paused and scrubbed like a tape: seek
// within the current file (or bumper, if scrubbed into a break window),
// reload only when the schedule crosses into a different one. Deliberately
// bypasses playChannelLive's decode watchdog and transcode path — this is a
// preview, not a tune-in.
export async function updateShuttlePreview() {
  const ch = getChannel(S.currentNumber);
  if (!ch) return;
  holdAt(viewNow());

  const brk = resolveBreakAt(ch, viewNow());
  // A dynamic entry (looping background clip + templated text — see the
  // DYNAMIC checkbox, setup-interstitials.js) has no entry.file of its own
  // (its content lives in entry.bgFile instead — see entryDurationS,
  // interstitials.js), but startBreak's own dynamic branch (playback.js)
  // still swaps player.src to that background clip just like an ordinary
  // video bumper. Without also matching it here, scrubbing across a dynamic
  // break used to fall through to the plain-content preview below, showing
  // the underlying show instead of any indication a bumper is airing there.
  const previewFile = brk && brk.entry && (brk.entry.dynamic ? brk.entry.bgFile : brk.entry.file);
  if (brk && previewFile) {
    // Video-kind break — preview the bumper itself, seeked to the same
    // point within it the scrubbed instant falls at.
    hideShuttleBreakOverlays();
    const offsetS = (viewNow() - brk.windowStart) / 1000;
    const previewKey = `break:${previewFile.path}`;
    // {time}/{daysUntil}-style placeholders keep advancing while scrubbing
    // stays inside the same dynamic entry (previewKey, keyed on the bg clip's
    // path alone, doesn't change tick to tick the way offsetS does) — so this
    // refreshes every tick regardless of whether the src reload below runs.
    if (brk.entry.dynamic) {
      dynamicBumperTextEl.textContent = renderDynamicText(brk.entry.text, ch, brk.entry);
      dynamicBumperTextEl.classList.remove('hidden');
    }
    if (previewKey !== S.shuttlePreviewPath) {
      S.shuttlePreviewPath = previewKey;
      try {
        const resolved = await window.api.resolvePlayablePath(previewFile.source || 'local', previewFile.path);
        const url = await window.api.toFileUrl(resolved.path);
        if (!S.timeMachineOn || S.shuttlePreviewPath !== previewKey) return;
        player.loop = !!brk.entry.dynamic;
        player.src = url;
      } catch (err) {
        return;
      }
      if (S.metaHandler) player.removeEventListener('loadedmetadata', S.metaHandler);
      const onMeta = () => {
        player.removeEventListener('loadedmetadata', onMeta);
        if (S.metaHandler === onMeta) S.metaHandler = null;
        applyTvBezel(player.videoWidth, player.videoHeight, ch);
        try { player.currentTime = offsetS; } catch (e) {}
      };
      S.metaHandler = onMeta;
      player.addEventListener('loadedmetadata', onMeta);
    } else if (player.readyState >= 1) {
      try { player.currentTime = offsetS; } catch (e) {}
    }
    return;
  }

  if (brk && brk.type === 'trivia') {
    hideShuttleBreakOverlays();
    triviaTextEl.textContent = brk.entry.text;
    triviaCardEl.classList.remove('hidden');
  } else if (brk && brk.type === 'channelId') {
    // Text-only — doesn't interrupt content, so the underlying video
    // preview below still tracks live content position as usual.
    hideShuttleBreakOverlays();
    stationIdNameEl.textContent = (brk.entry && brk.entry.text) || (ch.name || `CHANNEL ${ch.number}`).toUpperCase();
    stationIdBarEl.classList.add('show');
  } else {
    hideShuttleBreakOverlays();
  }

  const pos = computeLivePosition(ch);
  if (!pos) return;

  if (pos.file.path !== S.shuttlePreviewPath) {
    S.shuttlePreviewPath = pos.file.path;
    let resolved, url;
    try {
      resolved = await window.api.resolvePlayablePath(pos.file.source || 'local', pos.file.path);
      url = await window.api.toFileUrl(resolved.path);
    } catch (err) {
      return; // file moved/missing while shuttling — nothing to preview
    }
    if (!S.timeMachineOn || S.shuttlePreviewPath !== pos.file.path) return;
    player.loop = false; // a countdown/dynamic bumper previewed just before leaves the loop flag on
    player.src = url;
    if (S.metaHandler) player.removeEventListener('loadedmetadata', S.metaHandler);
    const onMeta = () => {
      player.removeEventListener('loadedmetadata', onMeta);
      if (S.metaHandler === onMeta) S.metaHandler = null;
      applyTvBezel(player.videoWidth, player.videoHeight, ch);
      try { player.currentTime = pos.offset; } catch (e) {}
    };
    S.metaHandler = onMeta;
    player.addEventListener('loadedmetadata', onMeta);
  } else if (player.readyState >= 1) {
    try { player.currentTime = pos.offset; } catch (e) {}
  }
}

export function shuttleTick(ts) {
  if (!S.timeMachineOn || S.shuttleDir === 0) return;
  const dt = S.shuttleLastTs ? (ts - S.shuttleLastTs) : 16;
  S.shuttleLastTs = ts;

  S.timeOffsetMs += S.shuttleDir * SHUTTLE_SPEEDS[S.shuttleSpeedIdx] * dt;

  // The OSD readout resolves the current program, which walks the whole
  // file list — far too costly to redo every frame on a 1000-file channel,
  // and the clock only needs tenth-of-a-second granularity anyway.
  S.shuttleSeekAccum += dt;
  if (S.shuttleSeekAccum > 180) {
    S.shuttleSeekAccum = 0;
    updateVcrOsd();
    updateShuttlePreview();
  }
  S.shuttleRAF = requestAnimationFrame(shuttleTick);
}

export function startShuttle(dir) {
  if (!S.timeMachineOn) return;
  if (S.shuttleDir === dir) {
    // Same direction again steps up the speed, like tapping FF on a VCR.
    S.shuttleSpeedIdx = Math.min(S.shuttleSpeedIdx + 1, SHUTTLE_SPEEDS.length - 1);
  } else {
    S.shuttleDir = dir;
    S.shuttleSpeedIdx = 0;
  }
  sfxVolumeTick(dir > 0);
  if (S.scrubPending) {
    S.scrubPending = false;
    hideScrubBanner();
  }
  pauseForScrubbing();
  S.shuttleLastTs = 0;
  if (S.shuttleRAF) cancelAnimationFrame(S.shuttleRAF);
  S.shuttleRAF = requestAnimationFrame(shuttleTick);
  updateVcrOsd();
  pushRemoteState();
}

// Everything that has to stop the moment the tape leaves live playback,
// whether it's shuttling (startShuttle) or stepping/dragging (beginScrub).
function pauseForScrubbing() {
  cancelUpNextBar();
  // Restores rate/mute/squeeze panel if a credits speedup was mid-flight.
  resetCreditsSpeedup();
  clearTimeout(S.breakTimer);
  clearTimeout(S.blockBoundaryTimer);
  // The shuttle preview (updateShuttlePreview) tracks break overlays itself
  // as the scrubbed time moves, independent of this — so once shuttling
  // starts, activeBreakKey just goes stale (frozen at whatever it was when
  // shuttling began) for the whole session. Left alone, shuttlePlay/
  // returnToLive would later see that stale key, think a break the length
  // of the whole shuttle session just ended, and credit that entire span to
  // S.contentLostMs while also firing a redundant, racing playChannelLive.
  // Clearing it here means resuming always re-evaluates fresh at wherever
  // the shuttle actually landed.
  resetActiveBreakState();
  crtToggleFlash.classList.remove('show');
  hideShuttleBreakOverlays();
  player.pause();
  tapeFxEl.classList.remove('hidden');
}

export function stopShuttle() {
  S.shuttleDir = 0;
  S.shuttleSpeedIdx = 0;
  S.scrubPending = false;
  clearTimeout(scrubPreviewTimer);
  scrubPreviewTimer = null;
  scrubDragging = false;
  hideScrubBanner();
  if (S.shuttleRAF) cancelAnimationFrame(S.shuttleRAF);
  S.shuttleRAF = null;
  tapeFxEl.classList.add('hidden');
  hideShuttleBreakOverlays();
}

// Jump straight to the next/previous break's start instead of shuttling
// through content to find one by eye. Unlike ordinary shuttling (which
// leaves the player paused on a scrubbed preview frame until T/Enter commits
// it — updateShuttlePreview), this commits and starts real playback
// immediately via shuttlePlay: landing exactly on a break is the whole
// point, so there's nothing meaningful left to preview, and leaving it
// paused just means a frozen frame (occasionally a visibly stuck/stale one,
// since a paused <video> doesn't always repaint promptly after a seek) with
// no indication anything happened. Silent no-op outside the time machine or
// when there's genuinely nothing to find (Infinity/-Infinity), rather than
// jumping to a nonsense timestamp.
export async function jumpToNextBreak() {
  if (!S.timeMachineOn) return;
  const ch = getChannel(S.currentNumber);
  if (!ch) return;
  const target = nextBreakStart(ch, viewNow());
  if (!isFinite(target)) return;
  S.timeOffsetMs = target - Date.now();
  holdAt(target);
  await shuttlePlay();
}

export async function jumpToPrevBreak() {
  if (!S.timeMachineOn) return;
  const ch = getChannel(S.currentNumber);
  if (!ch) return;
  const target = prevBreakStart(ch, viewNow());
  if (!isFinite(target)) return;
  S.timeOffsetMs = target - Date.now();
  holdAt(target);
  await shuttlePlay();
}

// Commit wherever the shuttle landed: resume normal playback at the
// shifted time. Everything downstream reads viewNow(), so the channel
// simply behaves as if that were the current moment.
export async function shuttlePlay() {
  // Play where the picture is, not where the clock has run on to (see holdAt). While
  // shuttling the preview lags the clock by up to a tick; while parked it lags by however
  // long the tape has sat there.
  const scrubbing = S.shuttleDir !== 0 || S.scrubPending;
  const held = scrubbing && Number.isFinite(S.previewMs)
    && (S.shuttleDir !== 0 || Math.abs(S.timeOffsetMs - S.previewOffsetMs) < 2000) ? S.previewMs : null;
  stopShuttle();
  if (held != null) S.timeOffsetMs = held - Date.now();
  S.previewMs = null;
  S.shuttlePreviewPath = null;
  const ch = getChannel(S.currentNumber);
  if (ch) {
    // A time jump means any break that already played in live-viewing mode
    // should be eligible to play again at the newly committed position.
    // completedBreakKeys exists only to stop a still-active break window from
    // re-firing immediately after its bumper ends — it has no meaning across
    // a jump to a different point in time.
    S.completedBreakKeys = null;
    // Same reasoning as completedBreakKeys above: awaitingBumperEnd/
    // breakOverrunSince track "a real video bumper is mid-play, defer up to
    // BUMPER_OVERRUN_GRACE_MS of REAL wall-clock time for its own 'ended'
    // event instead of cutting it off" (checkBreakState, playback.js) — set
    // by startBreak and normally cleared by that same bumper's natural end.
    // A time-machine jump abandons whatever was playing before it without
    // ever firing that event, so left alone this stale flag makes
    // checkBreakState defer starting the NEWLY jumped-to break for up to 8
    // real seconds, and overlapping deferrals from repeated ']'/'[' presses
    // race each other — the visible symptom was player.src staying stuck on
    // the previous break's bumper for one or more presses before catching up.
    S.awaitingBumperEnd = false;
    S.breakOverrunSince = null;
    // S.activeBreakKey/S.breakEnteredAtMs describe whatever break was
    // showing BEFORE this jump. checkBreakState/endBreak (playback.js) both
    // credit `viewNow() - S.breakEnteredAtMs` into S.contentLostMs when
    // moving off an active break — correct for live playback (both
    // timestamps advance together in real time), but after a time-machine
    // jump viewNow() has just moved by however far the jump went while
    // breakEnteredAtMs is still stamped from the OLD position, so that
    // credit becomes a huge bogus delta. That corrupted S.contentLostMs is
    // shared, global state, so it then throws off the LIVE position too —
    // "the LIVE button doesn't return to what the guide says is playing,"
    // worse the further repeated ']'/'[' presses had jumped beforehand.
    // resetActiveBreakState() clears the two fields both credit sites gate
    // on, the same protection startShuttle() already gives ordinary
    // scrubbing — jumpToNextBreak/jumpToPrevBreak/returnToLive need it too
    // since they commit straight to shuttlePlay without going through
    // startShuttle first.
    resetActiveBreakState();
    // If a break is already due exactly where we landed, skip loading
    // content at all — starting it first (even faded) races startBreak's
    // own async chain: content's loadedmetadata/decoded-frame watchers are
    // still pending when checkBreakState's startBreak kicks off a moment
    // later, and awaiting playChannelLive first only guarantees the *src
    // assignments* land in order, not that content's still-pending
    // 'loadedmetadata' (which can fire any time after) doesn't land after
    // startBreak has already begun fading out for the break. When that
    // happens, content's watcher's own fade-in call is the last thing to
    // run and the screen is left stuck on whatever the fade-out left it at —
    // most visible right after a jump-to-break, which by design always
    // lands inside a break. Skipping content playback when a break is
    // already active removes the race outright: startBreak fades cleanly
    // from whatever was already on screen (or nothing) instead of from a
    // content load still in flight. jumpToNextBreak/jumpToPrevBreak
    // (interstitials.js) always land here; an ordinary shuttle-then-commit
    // only sometimes does, and behaves exactly as before otherwise.
    // Only video-kind breaks (entry.file — commercial/adBreakIn/adBreakOut/
    // signOff/signOn/a video upNext or promo — OR entry.dynamic, a looping
    // background clip: startBreak's dynamic branch swaps player.src to
    // entry.bgFile exactly like an ordinary video bumper) actually compete
    // for player.src/screen-fade-out, so only those need the content load
    // skipped; text-only breaks (channelId's station-id bar, trivia) never
    // touch either, so loading content first is harmless there and keeps
    // it correctly positioned underneath the overlay as before.
    const dueBreak = resolveBreakAt(ch, viewNow());
    const dueVideoBreak = dueBreak && dueBreak.entry && (dueBreak.entry.file || dueBreak.entry.dynamic);
    if (!dueVideoBreak) {
      await playChannelLive(ch, { fadeInOnReady: true });
    }
    checkBreakState(ch);
    if (S.currentNumber === ch.number) scheduleBlockBoundaryRetune(ch); // tuned away during the awaits
  }
  updateVcrOsd();
  sfxGuideToggle(true);
  pushRemoteState();
}

export async function returnToLive() {
  S.timeOffsetMs = 0;
  stopShuttle();
  S.shuttlePreviewPath = null;
  // Same reasoning as shuttlePlay's own reset above — jumping back to live
  // "now" is itself a jump to a (potentially already-visited) point in time,
  // most concretely after previewing forward into an upcoming break: without
  // this, real wall-clock time later catching up to that same break window
  // would find its key already "completed" from the earlier preview and
  // silently skip it, even though it was never actually watched live.
  S.completedBreakKeys = null;
  // Same reasoning as shuttlePlay's own reset — see its comment. Returning
  // to live is itself a jump away from wherever the preview left off.
  S.awaitingBumperEnd = false;
  S.breakOverrunSince = null;
  // See shuttlePlay's own resetActiveBreakState() call above — same
  // S.contentLostMs corruption risk applies here.
  resetActiveBreakState();
  updateTimeShiftBadge();
  const ch = getChannel(S.currentNumber);
  if (ch) {
    await playChannelLive(ch, { fadeInOnReady: true });
    checkBreakState(ch);
    if (S.currentNumber === ch.number) scheduleBlockBoundaryRetune(ch); // tuned away during the awaits
  }
  if (S.timeMachineOn) updateVcrOsd();
  Toast('LIVE', { element: crtToggleFlash, key: 'returnToLive', duration: 1200 });
  pushRemoteState();
}

// J: back to the start of the show on screen, the way a DVR's "start over"
// does. Uses the time machine's own jump (so the schedule stays honest: you
// are watching it as it aired, L returns to live) and says so when the time
// machine is off, since that is the one thing it needs.
export async function restartCurrentShow() {
  if (!timeMachineAvailable()) {
    flashMessage('START OVER NEEDS THE TIME MACHINE — TURN IT ON IN SETTINGS', 'restartShowFlashTimer');
    return;
  }
  const start = currentProgramStart();
  if (start == null) return;
  await timeMachineGoTo(start, 'START OF THIS SHOW');
}

export function enterTimeMachine() {
  if (!timeMachineAvailable()) return;
  S.timeMachineOn = true;
  S.shuttlePreviewPath = null;
  scrubWin = null;
  scrubSig = '';
  vcrOsdEl.classList.add('has-scrubber');
  vcrOsdEl.classList.remove('hidden');
  document.documentElement.classList.add('time-machine-on');
  updateVcrOsd();
  pushRemoteState();
}

export async function exitTimeMachine(opts) {
  opts = opts || {};
  S.timeMachineOn = false;
  stopShuttle();
  S.shuttlePreviewPath = null;
  vcrOsdEl.classList.add('hidden');
  document.documentElement.classList.remove('time-machine-on');
  if (opts.toLive) {
    returnToLive();
    return;
  }
  updateTimeShiftBadge();
  pushRemoteState();
  // Exiting mid-shuttle leaves the player paused on whatever frame the
  // scrub preview last seeked to (updateShuttlePreview never calls play())
  // — without this, nothing else ever resumes it. Same commit shuttlePlay
  // does, just without forcing the VCR OSD back open or resetting the
  // shifted time — including the same completedBreakKeys reset, for the
  // same "resuming at a possibly already-visited instant" reason.
  S.completedBreakKeys = null;
  const ch = getChannel(S.currentNumber);
  if (ch) {
    await playChannelLive(ch, { fadeInOnReady: true });
    checkBreakState(ch);
    if (S.currentNumber === ch.number) scheduleBlockBoundaryRetune(ch); // tuned away during the awaits
  }
}
