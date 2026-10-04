// Idle screensaver — migrated as-is from the old core power.js. Builds its
// own DOM (same "own your DOM" pattern as eas-alerts) and appends into
// .crt, replacing the old core-owned #screensaver markup. A bouncing brand
// mark by default; four theme eras (tokens.css) swap this for an
// era-appropriate idle state instead via the html[data-theme] rules in
// style.css — a test pattern, a stand-by slate, a promo scroll, or a
// signal-diagnostics readout.
// This plugin's own config namespace, seeded here (not by core) — see
// [[retro_cable_box_plugin_system]].
if (!S.config.screensaver) S.config.screensaver = { enabled: false, intervalMinutes: 5, variant: 'auto' };
if (!S.config.screensaver.variant) S.config.screensaver.variant = 'auto';

const VALID_VARIANTS = ['bounce', 'testcard', 'standby', 'lineup', 'diagnostics'];

// Called on show() (so a freshly-armed screensaver always reflects the
// current setting) and by settings.js whenever the VARIANT picker changes,
// so switching it while the screensaver's already up updates immediately
// instead of waiting for the next idle cycle.
export function applyScreensaverVariant() {
  const variant = S.config.screensaver && S.config.screensaver.variant;
  VALID_VARIANTS.forEach((v) => screensaverEl.classList.remove(`ss-force-${v}`));
  if (variant && variant !== 'auto' && VALID_VARIANTS.includes(variant)) {
    screensaverEl.classList.add(`ss-force-${variant}`);
  }
}

const screensaverEl = document.createElement('div');
screensaverEl.id = 'screensaver';
screensaverEl.className = 'screensaver hidden';
screensaverEl.innerHTML = `
  <div class="screensaver-bounce" id="screensaver-bounce">RETRO CABLE BOX</div>

  <div class="screensaver-variant screensaver-testcard">
    <div class="testcard-bars">
      <span></span><span></span><span></span><span></span><span></span><span></span><span></span>
    </div>
    <div class="testcard-label">RETRO CABLE BOX &middot; 1 kHz REFERENCE TONE</div>
  </div>

  <div class="screensaver-variant screensaver-standby">
    <div class="standby-slate">PLEASE STAND BY</div>
  </div>

  <div class="screensaver-variant screensaver-lineup">
    <div class="lineup-eyebrow">COMING UP TONIGHT</div>
    <div class="lineup-list">
      <span>STAY TUNED FOR MORE GREAT PROGRAMMING</span>
      <span>PRIMETIME CONTINUES AFTER THIS BREAK</span>
      <span>THANKS FOR WATCHING THE RETRO CABLE BOX</span>
      <span>WE'LL BE RIGHT BACK</span>
    </div>
  </div>

  <div class="screensaver-variant screensaver-diagnostics">
    <div class="diag-title">SIGNAL DIAGNOSTICS</div>
    <div class="diag-row"><span>TRANSPONDER</span><span>14 (11.727 GHz)</span></div>
    <div class="diag-row"><span>C/N RATIO</span><span>14.8 dB</span></div>
    <div class="diag-row"><span>SIGNAL LOCK</span><span class="diag-locked">LOCKED</span></div>
  </div>
`;
document.querySelector('.crt').appendChild(screensaverEl);

let screensaverTimer = null;

function hide() {
  screensaverEl.classList.add('hidden');
}

// Interrupt guards read straight off window.S (the live app-state object
// core already exposes — see [[retro_cable_box_plugin_system]]) and query
// the core-owned #guide-grid element directly, same as any other DOM on
// this page — no dedicated core-state-accessor API needed since both are
// already reachable this way.
function show() {
  const S = window.S;
  const tvScreen = document.getElementById('tv-screen');
  const guideGrid = document.getElementById('guide-grid');
  if (!S.isPoweredOn || tvScreen.classList.contains('hidden')) return;
  // anyOtherInterruptActive (plugins.js) covers eas-alerts/breaking-news/any
  // future interrupt plugin generically - screensaver never hardcodes
  // another plugin's name or private state field.
  if (!guideGrid.classList.contains('hidden') || S.activeBreakKey || S.timeMachineOn || window.RCBPlugins.anyOtherInterruptActive('screensaver')) {
    // Any of these count as "in use" — check again next interval instead of
    // popping up mid-browse/mid-break.
    scheduleTimer();
    return;
  }
  // Plugin channels (the music channel, weather, the test pattern…) are
  // meant to be watched without touching anything, so the screensaver can be
  // told to leave them alone (SETTINGS › Plug-ins › Idle screensaver).
  const cfg = S.config.screensaver || {};
  const onRealChannel = (S.config.channels || []).some((c) => c.number === S.currentNumber);
  if (cfg.skipPluginChannels && !onRealChannel) { scheduleTimer(); return; }
  applyScreensaverVariant();
  applyScreensaverText();
  screensaverEl.classList.remove('hidden');
}

// The words on the bouncing mark and the stand-by slate: yours instead of the
// stock ones when set. Blank puts the stock text back.
export function applyScreensaverText() {
  const text = String((S.config.screensaver && S.config.screensaver.text) || '').trim().toUpperCase();
  const bounce = screensaverEl.querySelector('.screensaver-bounce');
  const slate = screensaverEl.querySelector('.standby-slate');
  if (bounce) bounce.textContent = text || 'RETRO CABLE BOX';
  if (slate) slate.textContent = text || 'PLEASE STAND BY';
}

function scheduleTimer() {
  clearTimeout(screensaverTimer);
  const S = window.S;
  const ss = S.config.screensaver;
  if (!ss || !ss.enabled) return;
  const ms = Math.max(1, ss.intervalMinutes || 5) * 60000;
  screensaverTimer = setTimeout(show, ms);
}

function cancelTimer() {
  clearTimeout(screensaverTimer);
  screensaverTimer = null;
  hide();
}

// Called by settings.js whenever the ENABLED toggle or interval changes, so
// a disable takes effect immediately instead of waiting for the already-
// pending timer to fire (show() has no enabled check of its own) or an
// interval edit only applying to the next idle-armed cycle.
export function rearmScreensaverTimer() {
  cancelTimer();
  scheduleTimer();
}

// Core fires these generic events (registerCoreHook, plugins.js) instead of
// calling into this plugin by name — power.js's resetIdleTimer/powerOff and
// app.js's setup-screen-open path all just want "cancel any pending
// screensaver" or "arm one," with no idea this plugin is the one listening.
window.RCBPlugins.registerCoreHook('power-off', cancelTimer);
window.RCBPlugins.registerCoreHook('enter-setup', cancelTimer);
window.RCBPlugins.registerCoreHook('idle-reset', cancelTimer);
window.RCBPlugins.registerCoreHook('idle-armed', scheduleTimer);
