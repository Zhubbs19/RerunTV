import { playPinUnlockSound } from './audio.js';
import { getChannel } from './channels.js';
import { pinDotsEl, pinLockModalEl, pinNoticeEl } from './dom.js';
import { registerTuneGate } from './plugins.js';
import { S } from './state.js';

export function isPinLocked(number) {
  if (!S.config.pinLock || !S.config.pinLock.enabled) return false;
  const lockedChs = S.config.pinLock.channels || [];
  const lockedRatings = S.config.pinLock.ratings || [];
  const ch = getChannel(number);
  const isChannelLocked = lockedChs.includes(number);
  const isRatingLocked = ch && ch.rating && lockedRatings.includes(ch.rating);
  if (!isChannelLocked && !isRatingLocked) return false;
  return !S.unlockedPinChannels.has(number);
}

export function showPinLockScreen(number) {
  S.pinLockActive = true;
  S.pinTargetCh = number;
  S.pinBuffer = '';
  updatePinDisplay();
  if (pinNoticeEl) pinNoticeEl.textContent = `PARENTAL LOCK // CH ${String(number).padStart(2, '0')} RESTRICTED`;
  if (pinLockModalEl) pinLockModalEl.classList.remove('hidden');
}

export function hidePinLockScreen() {
  S.pinLockActive = false;
  S.pinTargetCh = null;
  S.pinBuffer = '';
  if (pinLockModalEl) pinLockModalEl.classList.add('hidden');
}

export function updatePinDisplay() {
  if (!pinDotsEl) return;
  const dots = '•'.repeat(S.pinBuffer.length) + '_'.repeat(4 - S.pinBuffer.length);
  pinDotsEl.textContent = dots;
}

export function pushPinDigit(d) {
  if (S.pinBuffer.length >= 4) return;
  S.pinBuffer += d;
  updatePinDisplay();
  if (S.pinBuffer.length === 4) {
    setTimeout(checkPinSubmit, 200);
  }
}

export function popPinDigit() {
  if (S.pinBuffer.length > 0) {
    S.pinBuffer = S.pinBuffer.slice(0, -1);
    updatePinDisplay();
  }
}

window.pushPinDigit = pushPinDigit;
window.popPinDigit = popPinDigit;

export function checkPinSubmit() {
  const correct = (S.config.pinLock && S.config.pinLock.code) || '1234';
  if (S.pinBuffer === correct) {
    playPinUnlockSound();
    if (S.pinTargetCh !== null) S.unlockedPinChannels.add(S.pinTargetCh);
    const target = S.pinTargetCh;
    hidePinLockScreen();
    // Tune to channel now that it's unlocked!
    if (target !== null && window.tuneToChannel) {
      window.tuneToChannel(target, { bypassGateIds: ['pin-lock'] });
    }
  } else {
    if (pinNoticeEl) pinNoticeEl.textContent = '❌ INVALID PASSCODE — TRY AGAIN';
    S.pinBuffer = '';
    updatePinDisplay();
    if (pinDotsEl) {
      pinDotsEl.classList.remove('pin-shake');
      void pinDotsEl.offsetWidth;
      pinDotsEl.classList.add('pin-shake');
    }
  }
}

export function clearPinBuffer() {
  S.pinBuffer = '';
  updatePinDisplay();
}

// Core's own reference registerTuneGate registration (plugins.js) — the
// same generic gate a third-party plugin (a bedtime lock, a PPV-credit
// gate) would use, so playback.js's tuneToChannel no longer hardcodes this
// module by name.
registerTuneGate('pin-lock', { isBlocked: isPinLocked, onBlocked: showPinLockScreen });
