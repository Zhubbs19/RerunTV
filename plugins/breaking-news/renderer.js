// Breaking News Alerts — random or on-demand news-style overlays in four
// visual variants, with a custom headline bank. Migrated as-is from the
// old core news.js. The overlay is a persistent element (not tied to any
// one channel) built once here and appended into .crt, same pattern as the
// eas-alerts plugin's slate.
const DEFAULT_HEADLINES = [
  'BREAKING NEWS: Local Cat Learns How To Open Refrigerator, Demands Unlimited Cheese',
  'SPECIAL REPORT: Scientists Confirm 90s Nostalgia Levels Reaching Unprecedented Highs',
  'NEWS FLASH: Mysterious Glowing Orb Over RerunTV Identified As Ceiling Fan',
  'BREAKING: Local Resident Spends Entire Weekend Fine-Tuning Cable Channel Settings',
  'SPECIAL BULLETIN: Microwave Clock Flashing 12:00 Declared Official Timepiece of Neighborhood',
  'ALERT: VCR Machine Demands Tape Rewind Before Midnight or Will Refuse Cassettes',
  'BREAKING: Retro TV Scanlines Form Uncannily Accurate Map of Local Shopping Mall',
];

// This plugin's own config namespace, seeded here (not by core) — see
// PLUGIN_DEVELOPMENT.md.
if (!S.config.breakingNews) {
  S.config.breakingNews = {
    enabled: false,
    intervalMinutes: 30,
    style: 'retro-lower-third',
    position: 'bottom',
    durationSec: 15,
    soundStinger: true,
    voiceover: true,
    headlines: DEFAULT_HEADLINES.slice(),
  };
}
// This plugin's own runtime state on the shared S object — used to be
// declared in core state.js even though core never reads any of it.
if (S.newsScheduleTimer === undefined) S.newsScheduleTimer = null;
if (S.newsEndTimer === undefined) S.newsEndTimer = null;
if (S.newsSafetyTimer === undefined) S.newsSafetyTimer = null;
if (S.breakingNewsActive === undefined) S.breakingNewsActive = false;

// Per-style badge/title copy shown while an alert is up (runBreakingNewsAlert
// below) — 'retro-lower-third' is also the fallback for any unrecognized
// style value.
const STYLE_COPY = {
  'alien-report': { badge: '⚠️ UNEXPLAINED TRANSMISSION', title: 'DECODED FREQUENCY SIGNAL' },
  'full-slate': { badge: '● LIVE SPECIAL REPORT', title: 'RERUN NEWS NETWORK' },
  'ticker-flash': { badge: 'NEWS FLASH', title: 'LIVE BULLETIN' },
  'retro-lower-third': { badge: '● LIVE', title: 'BREAKING NEWS' },
};

const overlayEl = document.createElement('div');
overlayEl.className = 'news-overlay news-style-retro-lower-third pos-bottom hidden';
overlayEl.innerHTML = `
  <div class="news-container">
    <div class="news-header">
      <div class="news-badge" data-el="badge">● LIVE</div>
      <div class="news-title" data-el="title">BREAKING NEWS</div>
    </div>
    <div class="news-body">
      <div class="news-headline-track">
        <div class="news-headline" data-el="headline"></div>
      </div>
    </div>
  </div>
`;
document.querySelector('.crt').appendChild(overlayEl);
const badgeEl = overlayEl.querySelector('[data-el="badge"]');
const titleEl = overlayEl.querySelector('[data-el="title"]');
const headlineEl = overlayEl.querySelector('[data-el="headline"]');

// Same stinger/speech as the old core audio.js's playNewsStinger/
// speakNewsMessage/cancelNewsSpeech — playNoiseBurst is exposed on window
// (core primitive, 22+ other usages, too foundational to duplicate).
function playNewsStinger(style) {
  const ctx = window.getAudioCtx();
  const now = ctx.currentTime;

  if (style === 'alien-report') {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(300, now);
    osc.frequency.exponentialRampToValueAtTime(1600, now + 0.3);
    osc.frequency.exponentialRampToValueAtTime(400, now + 0.6);
    osc.frequency.exponentialRampToValueAtTime(1200, now + 0.9);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.15, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.0);
    osc.connect(gain).connect(window.S.sfxGain);
    osc.start(now);
    osc.stop(now + 1.0);
    return;
  }

  const notes = [
    { freq: 196.00, time: 0, duration: 0.14 },
    { freq: 261.63, time: 0.15, duration: 0.14 },
    { freq: 329.63, time: 0.30, duration: 0.14 },
    { freq: 392.00, time: 0.45, duration: 0.60 },
  ];

  notes.forEach((n) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(n.freq, now + n.time);

    const osc2 = ctx.createOscillator();
    osc2.type = 'sawtooth';
    osc2.frequency.setValueAtTime(n.freq * 2, now + n.time);

    const gain2 = ctx.createGain();

    gain.gain.setValueAtTime(0.0001, now + n.time);
    gain.gain.linearRampToValueAtTime(0.18, now + n.time + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + n.time + n.duration);

    gain2.gain.setValueAtTime(0.0001, now + n.time);
    gain2.gain.linearRampToValueAtTime(0.06, now + n.time + 0.02);
    gain2.gain.exponentialRampToValueAtTime(0.0001, now + n.time + n.duration);

    osc.connect(gain).connect(window.S.sfxGain);
    osc2.connect(gain2).connect(window.S.sfxGain);
    osc.start(now + n.time);
    osc.stop(now + n.time + n.duration);
    osc2.start(now + n.time);
    osc2.stop(now + n.time + n.duration);
  });

  for (let i = 0; i < 8; i++) {
    setTimeout(() => {
      window.playNoiseBurst({ duration: 20, gain: 0.08, filterFreq: 2200 });
    }, 650 + i * 85);
  }
}

function speakNewsMessage(text, onDone) {
  if (!window.speechSynthesis) { if (onDone) onDone(); return null; }
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = 1.05;
  utter.pitch = 0.95;
  utter.volume = window.RCBPlugins.ctx.player.muted ? 0 : (typeof window.S.config.volume === 'number' ? window.S.config.volume : 1);
  utter.onend = onDone || (() => {});
  utter.onerror = onDone || (() => {});
  window.speechSynthesis.speak(utter);
  return utter;
}

function cancelNewsSpeech() {
  if (window.speechSynthesis) window.speechSynthesis.cancel();
}

export function scheduleNextNewsAlert() {
  const S = window.S;
  clearTimeout(S.newsScheduleTimer);
  if (!S.config.breakingNews || !S.config.breakingNews.enabled) return;
  const intervalMins = S.config.breakingNews.intervalMinutes || 30;
  // Variance +/- 25% to keep random popups feeling dynamic
  const minMs = Math.max(1, intervalMins * 0.75) * 60000;
  const maxMs = Math.max(1, intervalMins * 1.25) * 60000;
  const delayMs = minMs + Math.random() * (maxMs - minMs);
  S.newsScheduleTimer = setTimeout(runBreakingNewsAlert, delayMs);
}

export function runBreakingNewsAlert(opts) {
  opts = opts || {};
  const S = window.S;

  // If active, pressing B again acts as a dismiss shortcut
  if (S.breakingNewsActive && opts.manual) {
    cancelNewsAlert();
    return;
  }

  const guideGrid = document.getElementById('guide-grid');
  const isOff = !S.isPoweredOn;
  const onVirtualOrNoChannel = window.isVirtualChannel(S.currentNumber) || !window.getChannel(S.currentNumber);
  const guideIsOpen = !guideGrid.classList.contains('hidden');
  // anyOtherInterruptActive (plugins.js) generically covers any other
  // registered interrupt plugin (eas-alerts, or a future one) that declares
  // its own isActive() - this plugin never has to know another plugin's
  // name or private state field by heart.
  const anotherOverlayIsUp = !!S.activeBreakKey || S.breakingNewsActive || window.RCBPlugins.anyOtherInterruptActive('breaking-news');
  const blocked = isOff || onVirtualOrNoChannel || guideIsOpen || anotherOverlayIsUp;

  if (blocked || (!opts.manual && (!S.config.breakingNews || !S.config.breakingNews.enabled))) {
    if (!opts.manual) scheduleNextNewsAlert();
    return;
  }

  const cfg = S.config.breakingNews || {};
  const headlines = (cfg.headlines && cfg.headlines.length) ? cfg.headlines : DEFAULT_HEADLINES;

  // opts.real is a genuine NOAA/NWS alert object (noaa-weather/renderer.js's
  // real-alert poll, see getInterrupt('breaking-news').run({real}) there) —
  // its own .headline is what should show, not a random canned one.
  let headlineText = opts.headline || (opts.real && opts.real.headline);
  if (!headlineText) {
    const idx = Math.floor(Math.random() * headlines.length);
    headlineText = headlines[idx];
  }

  S.breakingNewsActive = true;
  window.cancelUpNextBar();

  const style = opts.style || cfg.style || 'retro-lower-third';
  const position = opts.position || cfg.position || 'bottom';
  const durationSec = Math.max(3, parseInt(opts.duration || cfg.durationSec || 15, 10));

  overlayEl.className = 'news-overlay hidden';
  overlayEl.classList.add(`news-style-${style}`);
  overlayEl.classList.add(`pos-${position}`);

  const copy = STYLE_COPY[style] || STYLE_COPY['retro-lower-third'];
  badgeEl.textContent = copy.badge;
  titleEl.textContent = copy.title;

  headlineEl.textContent = headlineText;
  overlayEl.classList.remove('hidden');

  if (cfg.soundStinger !== false && !opts.silent) {
    playNewsStinger(style);
  }

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(S.newsEndTimer); S.newsEndTimer = null;
    clearTimeout(S.newsSafetyTimer); S.newsSafetyTimer = null;
    cancelNewsSpeech();
    overlayEl.classList.add('hidden');
    S.breakingNewsActive = false;
    scheduleNextNewsAlert();
  };

  const wantsVoice = (cfg.voiceover !== false) && !!window.speechSynthesis;
  if (wantsVoice) {
    const delayBeforeSpeech = (style === 'alien-report') ? 600 : 800;
    S.newsEndTimer = setTimeout(() => {
      speakNewsMessage(headlineText, () => {
        S.newsEndTimer = setTimeout(finish, 1500);
      });
    }, delayBeforeSpeech);

    S.newsSafetyTimer = setTimeout(finish, (durationSec + 5) * 1000);
  } else {
    S.newsEndTimer = setTimeout(finish, durationSec * 1000);
  }
}

export function cancelNewsAlert() {
  const S = window.S;
  if (!S.breakingNewsActive && !S.newsEndTimer) return;
  clearTimeout(S.newsEndTimer); S.newsEndTimer = null;
  clearTimeout(S.newsSafetyTimer); S.newsSafetyTimer = null;
  cancelNewsSpeech();
  overlayEl.classList.add('hidden');
  S.breakingNewsActive = false;
}

// registerInterrupt (plugins.js) is the generic version of what used to be
// a one-off `window.RCBPlugins.breakingNews` escape hatch — core's keyboard
// handler, TV menu, and tune-cleanup now iterate every registered interrupt
// instead of hardcoding this plugin's id (see
// PLUGIN_DEVELOPMENT.md). app.js's party-triggered alerts
// (bingo/caption-contest headlines) still reach this plugin specifically
// via getInterrupt('breaking-news').run(...) since they pass alert-specific
// payloads, not a generic trigger.
window.RCBPlugins.registerInterrupt('breaking-news', {
  label: 'NEWS ALERT', hintKey: 'news-alert', hotkey: 'b',
  run: runBreakingNewsAlert, cancel: cancelNewsAlert, scheduleNext: scheduleNextNewsAlert,
  cancelScheduled: () => clearTimeout(window.S.newsScheduleTimer),
  isActive: () => window.S.breakingNewsActive,
});

// Starts the random-alert schedule once per session (S.config is already
// set by the time plugins load — see app.js's init()) instead of relying on
// core to call this after loadPlugins(), which isn't awaited there. A
// no-op if breaking news isn't configured/enabled.
scheduleNextNewsAlert();

export function renderHeadlinesList(container, cfg, saveConfigDebounced) {
  const listEl = container.querySelector('[data-el="headlines-list"]');
  listEl.innerHTML = '';
  const headlines = cfg.headlines || [];
  headlines.forEach((text, idx) => {
    const row = document.createElement('div');
    row.className = 'pubaccess-slide-row';
    const input = document.createElement('textarea');
    input.className = 'pubaccess-slide-input';
    input.rows = 2;
    input.value = text;
    input.placeholder = 'Headline text…';
    input.addEventListener('input', () => {
      cfg.headlines[idx] = input.value;
      saveConfigDebounced();
    });
    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn remove-btn';
    removeBtn.textContent = 'X';
    removeBtn.title = 'REMOVE';
    removeBtn.setAttribute('aria-label', 'Remove headline');
    removeBtn.addEventListener('click', () => {
      cfg.headlines.splice(idx, 1);
      renderHeadlinesList(container, cfg, saveConfigDebounced);
      saveConfigDebounced();
    });
    row.appendChild(input);
    row.appendChild(removeBtn);
    listEl.appendChild(row);
  });
}
