// Virtual CH 51 — a parody classified satellite intercept channel. No
// config, no settings panel, no main-process backend — a rotating log/memo
// card on a timer plus a "decode" button that swaps in a random log early,
// migrated as-is from the old core ppv-hbo.js/virtual.js.
const AREA51_LOGS = [
  { log: 'LOG #4092-B: UNIDENTIFIED FLOWERING CRAFT INTERCEPTED OVER ROSWELL', memo: 'DECODED FREQUENCY KEY 88-X // CLASSIFIED EYES ONLY' },
  { log: 'INTERCEPTED SIGNAL: "WE HAVE BEEN TRYING TO REACH YOU CONCERNING YOUR EXTENDED WARRANTY"', memo: 'ORIGIN POINT: ZETA RETICULI STAR SYSTEM' },
  { log: 'RADAR ALERT: ANOMALOUS HIGH-SPEED FREQUENCY DETECTED IN SECTOR 7G', memo: 'ALERT LEVEL 4: INITIATE SCANLINE DEFENSE PROTOCOL' },
];

// Same sawtooth sweep as the old core audio.js's playAlienSignalSound,
// routed through window.getAudioCtx()/window.S.sfxGain (app.js) since a
// plugin can't import core audio.js directly.
function playAlienSignalSound() {
  const ctx = window.getAudioCtx();
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(300, now);
  osc.frequency.exponentialRampToValueAtTime(1800, now + 0.3);
  osc.frequency.exponentialRampToValueAtTime(150, now + 0.6);

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.linearRampToValueAtTime(0.1, now + 0.05);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.6);

  osc.connect(gain).connect(window.S.sfxGain);
  osc.start(now);
  osc.stop(now + 0.6);
}

window.RCBPlugins.registerChannelType('area-51', {
  number: 51,
  label: 'AREA 51',
  nowText: 'Classified Satellite Intercept',
  badge: { bg: '#22c55e', label: 'A51' },
  render(container, ctx) {
    const slot = Math.floor(ctx.viewNow() / (8 * 60 * 1000));
    const log = AREA51_LOGS[slot % AREA51_LOGS.length];
    container.innerHTML = `
      <div class="area51-channel">
        <div class="area51-static-overlay"></div>
        <div class="area51-radar"></div>
        <div class="area51-box">
          <div class="area51-header">🛸 CLASSIFIED FREQUENCY // AREA 51 SATELLITE INTERCEPT</div>
          <div class="area51-log" data-el="log">${log.log}</div>
          <div class="area51-memo" data-el="memo">${log.memo}</div>
          <button type="button" class="btn area51-decode-btn" data-el="decode" style="margin-top:16px; background:#047857; color:#34d399; border:1px solid #34d399; font-weight:bold;">📡 DECODE ALIEN FREQUENCY</button>
        </div>
      </div>
    `;
    playAlienSignalSound();

    const logEl = container.querySelector('[data-el="log"]');
    const memoEl = container.querySelector('[data-el="memo"]');
    container.querySelector('[data-el="decode"]').addEventListener('click', () => {
      playAlienSignalSound();
      const randomLog = AREA51_LOGS[Math.floor(Math.random() * AREA51_LOGS.length)];
      logEl.textContent = `⚡ UNSCRAMBLED: ${randomLog.log}`;
      memoEl.textContent = `🔓 CLEARANCE GRANTED: ${randomLog.memo}`;
    });
  },
});
