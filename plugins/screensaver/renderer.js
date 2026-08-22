// Idle screensaver — migrated as-is from the old core power.js. Builds its
// own DOM (same "own your DOM" pattern as eas-alerts) and appends into
// .crt, replacing the old core-owned #screensaver markup. A bouncing brand
// mark by default; four theme eras (tokens.css) swap this for an
// era-appropriate idle state instead via the html[data-theme] rules in
// style.css — a test pattern, a stand-by slate, a promo scroll, or a
// signal-diagnostics readout.
// This plugin's own config namespace, seeded here (not by core) — see
// [[retro_cable_box_plugin_system]].
if (!S.config.screensaver) S.config.screensaver = { enabled: false, intervalMinutes: 5 };

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
  if (!guideGrid.classList.contains('hidden') || S.easActive || S.activeBreakKey || S.timeMachineOn) {
    // Any of these count as "in use" — check again next interval instead of
    // popping up mid-browse/mid-break.
    scheduleTimer();
    return;
  }
  screensaverEl.classList.remove('hidden');
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

// Core fires these generic events (registerCoreHook, plugins.js) instead of
// calling into this plugin by name — power.js's resetIdleTimer/powerOff and
// app.js's setup-screen-open path all just want "cancel any pending
// screensaver" or "arm one," with no idea this plugin is the one listening.
window.RCBPlugins.registerCoreHook('power-off', cancelTimer);
window.RCBPlugins.registerCoreHook('enter-setup', cancelTimer);
window.RCBPlugins.registerCoreHook('idle-reset', cancelTimer);
window.RCBPlugins.registerCoreHook('idle-armed', scheduleTimer);

window.RCBPlugins.registerSettingsPanel('screensaver', {
  render(container, ctx) {
    if (!ctx.S.config.screensaver) ctx.S.config.screensaver = { enabled: false, intervalMinutes: 5 };
    const cfg = ctx.S.config.screensaver;
    container.innerHTML = `
      <label class="panel-toggle"><input type="checkbox" data-el="enabled">IDLE SCREENSAVER</label>
      <div class="panel-body">
        <div class="panel-interval">
          AFTER <input type="number" min="1" data-el="interval"> MIN IDLE
        </div>
      </div>
    `;
    const q = (sel) => container.querySelector(`[data-el="${sel}"]`);
    const enabledEl = q('enabled');
    const intervalEl = q('interval');
    enabledEl.checked = !!cfg.enabled;
    intervalEl.value = cfg.intervalMinutes || 5;
    enabledEl.addEventListener('change', () => {
      cfg.enabled = enabledEl.checked;
      ctx.saveConfigDebounced();
    });
    intervalEl.addEventListener('change', () => {
      cfg.intervalMinutes = parseInt(intervalEl.value, 10) || 5;
      ctx.saveConfigDebounced();
    });
  },
});
