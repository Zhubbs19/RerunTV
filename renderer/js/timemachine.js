import { sfxGuideToggle, sfxVolumeTick } from './audio.js';
import { getChannel } from './channels.js';
import {
  crtToggleFlash, player, stationIdBarEl, stationIdNameEl, tapeFxEl, timeShiftBadgeEl, triviaCardEl,
  triviaTextEl, vcrModeEl, vcrOsdEl, vcrProgEl, vcrSpeedEl, vcrTimeEl,
} from './dom.js';
import { nextBreakStart, prevBreakStart, resolveBreakAt } from './interstitials.js';
import {
  cancelUpNextBar, checkBreakState, playChannelLive, resetActiveBreakState, scheduleBlockBoundaryRetune,
} from './playback.js';
import { applyTvBezel, pushRemoteState } from './power.js';
import { computeLivePosition } from './schedule.js';
import { MONTHS, S, SHUTTLE_SPEEDS, viewNow } from './state.js';
import { formatClock, formatOffset, getDisplayTitle } from './util.js';
import { isVirtualChannel } from './virtual.js';

const BREAK_OSD_LABELS = {
  commercial: 'COMMERCIAL BREAK', trivia: 'TRIVIA', channelId: 'STATION ID',
  upNext: 'UP NEXT', adBreakIn: 'COMMERCIAL BREAK', adBreakOut: 'BACK TO THE SHOW',
  promo: 'COMING SOON', signOff: 'SIGNING OFF', signOn: 'SIGNING ON',
};

export function timeMachineAvailable() {
  return S.config.timeMachine && S.config.timeMachine.enabled &&
    !isVirtualChannel(S.currentNumber) && !!getChannel(S.currentNumber);
}

export function updateTimeShiftBadge() {
  if (Math.abs(S.timeOffsetMs) < 1000) {
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
    vcrProgEl.textContent = '';
  }
  updateTimeShiftBadge();
}

function hideShuttleBreakOverlays() {
  triviaCardEl.classList.add('hidden');
  stationIdBarEl.classList.remove('show');
}

// While shuttling the player is paused and scrubbed like a tape: seek
// within the current file (or bumper, if scrubbed into a break window),
// reload only when the schedule crosses into a different one. Deliberately
// bypasses playChannelLive's decode watchdog and transcode path — this is a
// preview, not a tune-in.
export async function updateShuttlePreview() {
  const ch = getChannel(S.currentNumber);
  if (!ch) return;

  const brk = resolveBreakAt(ch, viewNow());
  if (brk && brk.entry && brk.entry.file) {
    // Video-kind break — preview the bumper itself, seeked to the same
    // point within it the scrubbed instant falls at.
    hideShuttleBreakOverlays();
    const offsetS = (viewNow() - brk.windowStart) / 1000;
    const previewKey = `break:${brk.entry.file.path}`;
    if (previewKey !== S.shuttlePreviewPath) {
      S.shuttlePreviewPath = previewKey;
      try {
        const resolved = await window.api.resolvePlayablePath(brk.entry.file.path);
        const url = await window.api.toFileUrl(resolved.path);
        if (!S.timeMachineOn || S.shuttlePreviewPath !== previewKey) return;
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
      resolved = await window.api.resolvePlayablePath(pos.file.path);
      url = await window.api.toFileUrl(resolved.path);
    } catch (err) {
      return; // file moved/missing while shuttling — nothing to preview
    }
    if (!S.timeMachineOn || S.shuttlePreviewPath !== pos.file.path) return;
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
  cancelUpNextBar();
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
  S.shuttleLastTs = 0;
  if (S.shuttleRAF) cancelAnimationFrame(S.shuttleRAF);
  S.shuttleRAF = requestAnimationFrame(shuttleTick);
  updateVcrOsd();
  pushRemoteState();
}

export function stopShuttle() {
  S.shuttleDir = 0;
  S.shuttleSpeedIdx = 0;
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
  await shuttlePlay();
}

export async function jumpToPrevBreak() {
  if (!S.timeMachineOn) return;
  const ch = getChannel(S.currentNumber);
  if (!ch) return;
  const target = prevBreakStart(ch, viewNow());
  if (!isFinite(target)) return;
  S.timeOffsetMs = target - Date.now();
  await shuttlePlay();
}

// Commit wherever the shuttle landed: resume normal playback at the
// shifted time. Everything downstream reads viewNow(), so the channel
// simply behaves as if that were the current moment.
export async function shuttlePlay() {
  stopShuttle();
  S.shuttlePreviewPath = null;
  const ch = getChannel(S.currentNumber);
  if (ch) {
    // A time jump means any break that already played in live-viewing mode
    // should be eligible to play again at the newly committed position.
    // completedBreakKeys exists only to stop a still-active break window from
    // re-firing immediately after its bumper ends — it has no meaning across
    // a jump to a different point in time.
    S.completedBreakKeys = null;
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
    // signOff/signOn/a video upNext or promo) actually compete for
    // player.src/screen-fade-out, so only those need the content load
    // skipped; text-only breaks (channelId's station-id bar, trivia) never
    // touch either, so loading content first is harmless there and keeps
    // it correctly positioned underneath the overlay as before.
    const dueBreak = resolveBreakAt(ch, viewNow());
    const dueVideoBreak = dueBreak && dueBreak.entry && dueBreak.entry.file;
    if (!dueVideoBreak) {
      await playChannelLive(ch, { fadeInOnReady: true });
    }
    checkBreakState(ch);
    scheduleBlockBoundaryRetune(ch);
  }
  updateVcrOsd();
  sfxGuideToggle(true);
  pushRemoteState();
}

export async function returnToLive() {
  S.timeOffsetMs = 0;
  stopShuttle();
  S.shuttlePreviewPath = null;
  updateTimeShiftBadge();
  const ch = getChannel(S.currentNumber);
  if (ch) {
    await playChannelLive(ch, { fadeInOnReady: true });
    checkBreakState(ch);
    scheduleBlockBoundaryRetune(ch);
  }
  if (S.timeMachineOn) updateVcrOsd();
  crtToggleFlash.textContent = 'LIVE';
  crtToggleFlash.classList.add('show');
  clearTimeout(returnToLive._t);
  returnToLive._t = setTimeout(() => crtToggleFlash.classList.remove('show'), 1200);
  pushRemoteState();
}

export function enterTimeMachine() {
  if (!timeMachineAvailable()) return;
  S.timeMachineOn = true;
  S.shuttlePreviewPath = null;
  vcrOsdEl.classList.remove('hidden');
  updateVcrOsd();
  pushRemoteState();
}

export async function exitTimeMachine(opts) {
  opts = opts || {};
  S.timeMachineOn = false;
  stopShuttle();
  S.shuttlePreviewPath = null;
  vcrOsdEl.classList.add('hidden');
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
  // shifted time.
  const ch = getChannel(S.currentNumber);
  if (ch) {
    await playChannelLive(ch, { fadeInOnReady: true });
    checkBreakState(ch);
    scheduleBlockBoundaryRetune(ch);
  }
}
