// Emergency Alert System — a real, triggerable full-screen interrupt.
// S.easActive existed as dead scaffolding before this plugin (core's
// checkBreakState, and the breaking-news/screensaver plugins, all already
// read it to avoid interrupting an active EAS) but nothing ever set it —
// this plugin is the first and only thing that does. Modeled directly on
// plugins/breaking-news/renderer.js's "own your DOM, overlay on top, never
// touch player.src" shape: a persistent element appended into .crt, shown/
// hidden with a CSS class, registered as a manual+testable interrupt via
// registerInterrupt (plugins.js).
const DEFAULT_MESSAGE = 'THIS IS A TEST OF THE EMERGENCY ALERT SYSTEM. THIS IS ONLY A TEST. BROADCASTERS IN YOUR AREA, IN VOLUNTARY COOPERATION WITH FEDERAL, STATE, AND LOCAL AUTHORITIES, HAVE DEVELOPED THIS SYSTEM TO KEEP YOU INFORMED IN THE EVENT OF AN EMERGENCY.';

// This plugin's own config namespace, seeded here (not by core) — same
// pattern breaking-news uses for S.config.breakingNews.
if (!S.config.easAlerts) {
  S.config.easAlerts = {
    enabled: false, // random self-testing, off by default - real EAS is event/manual-triggered, not ambient
    intervalMinutes: 60,
    toneSec: 8,
    voiceover: true,
    message: DEFAULT_MESSAGE,
  };
}
if (S.easScheduleTimer === undefined) S.easScheduleTimer = null;
if (S.easEndTimer === undefined) S.easEndTimer = null;

const overlayEl = document.createElement('div');
overlayEl.className = 'eas-overlay hidden';
overlayEl.innerHTML = `
  <div class="eas-header">
    <span class="eas-badge">● EMERGENCY ALERT SYSTEM</span>
  </div>
  <div class="eas-crawl-track">
    <div class="eas-crawl" data-el="crawl"></div>
  </div>
`;
document.querySelector('.crt').appendChild(overlayEl);
const crawlEl = overlayEl.querySelector('[data-el="crawl"]');

// The real EAS attention signal is a sustained two-tone 853Hz+960Hz sine
// pair — distinct from every other stinger in this app (all single-
// oscillator sweeps/chords), so this is built directly against
// window.getAudioCtx()/window.S.sfxGain rather than the simpler playTone
// helper (same reasoning breaking-news's playNewsStinger already used for
// its own multi-oscillator chord).
function playAttentionTone(durationSec) {
  const ctx = window.getAudioCtx();
  const now = ctx.currentTime;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.linearRampToValueAtTime(0.16, now + 0.05);
  gain.gain.setValueAtTime(0.16, now + durationSec - 0.1);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + durationSec);
  gain.connect(window.S.sfxGain);

  [853, 960].forEach((freq) => {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, now);
    osc.connect(gain);
    osc.start(now);
    osc.stop(now + durationSec);
  });
}

function speakEasMessage(text, onDone) {
  if (!window.speechSynthesis) { if (onDone) onDone(); return; }
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = 0.95;
  utter.pitch = 0.9;
  utter.volume = window.RCBPlugins.ctx.player.muted ? 0 : (typeof window.S.config.volume === 'number' ? window.S.config.volume : 1);
  utter.onend = onDone || (() => {});
  utter.onerror = onDone || (() => {});
  window.speechSynthesis.speak(utter);
}

export function scheduleNextEasAlert() {
  const S = window.S;
  clearTimeout(S.easScheduleTimer);
  if (!S.config.easAlerts || !S.config.easAlerts.enabled) return;
  const intervalMins = S.config.easAlerts.intervalMinutes || 60;
  const minMs = Math.max(1, intervalMins * 0.75) * 60000;
  const maxMs = Math.max(1, intervalMins * 1.25) * 60000;
  const delayMs = minMs + Math.random() * (maxMs - minMs);
  S.easScheduleTimer = setTimeout(runEasAlert, delayMs);
}

export function runEasAlert(opts) {
  opts = opts || {};
  const S = window.S;

  // Pressing E again while active acts as a dismiss shortcut, same UX as
  // breaking-news's B.
  if (S.easActive && opts.manual) {
    cancelEasAlert();
    return;
  }

  const guideGrid = document.getElementById('guide-grid');
  const isOff = !S.isPoweredOn;
  const onVirtualOrNoChannel = window.isVirtualChannel(S.currentNumber) || !window.getChannel(S.currentNumber);
  const guideIsOpen = !guideGrid.classList.contains('hidden');
  // Never hardcodes another plugin's name or state field — a peer
  // interrupt plugin (breaking-news, or any future one) only counts here if
  // IT chooses to declare its own isActive() (registerInterrupt,
  // plugins.js). This plugin stays fully installable/usable on its own.
  const anotherOverlayIsUp = !!S.activeBreakKey || window.RCBPlugins.anyOtherInterruptActive('eas-alerts');
  const blocked = isOff || onVirtualOrNoChannel || guideIsOpen || anotherOverlayIsUp;

  if (blocked || (!opts.manual && (!S.config.easAlerts || !S.config.easAlerts.enabled))) {
    if (!opts.manual) scheduleNextEasAlert();
    return;
  }

  const cfg = S.config.easAlerts || {};
  const message = opts.message || cfg.message || DEFAULT_MESSAGE;
  const toneSec = Math.max(1, parseInt(opts.toneSec || cfg.toneSec || 8, 10));

  // This is the ONE assignment site for S.easActive in the whole app —
  // checkBreakState (playback.js) and every other plugin that already
  // reads it will now correctly hold off for real, not just in theory.
  S.easActive = true;
  window.cancelUpNextBar();
  crawlEl.textContent = message;
  overlayEl.classList.remove('hidden');
  playAttentionTone(toneSec);

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(S.easEndTimer); S.easEndTimer = null;
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    overlayEl.classList.add('hidden');
    S.easActive = false;
    scheduleNextEasAlert();
  };

  const wantsVoice = (cfg.voiceover !== false) && !!window.speechSynthesis && !opts.silent;
  if (wantsVoice) {
    S.easEndTimer = setTimeout(() => speakEasMessage(message, finish), toneSec * 1000 + 300);
  } else {
    // No voiceover: hold the slate a beat past the tone so the crawl is
    // actually readable, then resume.
    S.easEndTimer = setTimeout(finish, toneSec * 1000 + 6000);
  }
}

export function cancelEasAlert() {
  const S = window.S;
  if (!S.easActive && !S.easEndTimer) return;
  clearTimeout(S.easEndTimer); S.easEndTimer = null;
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  overlayEl.classList.add('hidden');
  S.easActive = false;
}

window.RCBPlugins.registerInterrupt('eas-alerts', {
  label: 'EAS ALERT', hintKey: 'alert-test', hotkey: 'e',
  run: runEasAlert, cancel: cancelEasAlert, scheduleNext: scheduleNextEasAlert,
  cancelScheduled: () => clearTimeout(window.S.easScheduleTimer),
  isActive: () => window.S.easActive,
});

// Starts the random self-test schedule once per session, same timing as
// scheduleNextNewsAlert (breaking-news) — a no-op unless the user opts into
// S.config.easAlerts.enabled from the settings panel.
scheduleNextEasAlert();
