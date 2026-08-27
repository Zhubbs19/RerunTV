import { runEasAlert, scheduleNextEasAlert } from './renderer.js';

window.RCBPlugins.registerPluginSettings('eas-alerts', {
  sections: [{
    id: 'general',
    render(container, ctx) {
      if (!ctx.S.config.easAlerts) ctx.S.config.easAlerts = {};
      const cfg = ctx.S.config.easAlerts;
      container.innerHTML = `
        <label class="panel-toggle"><input type="checkbox" data-el="enabled">RANDOM SELF-TEST ALERTS</label>
        <div class="panel-body">
          <div class="panel-interval">
            RANDOM TESTS: EVERY <input type="number" data-el="interval" min="1" max="1440" value="60"> MIN
          </div>
          <div class="panel-interval">
            ATTENTION TONE LENGTH <input type="number" data-el="tone" min="1" max="25" value="8"> SEC
          </div>
          <label class="shuffle-toggle"><input type="checkbox" data-el="voiceover">VOICEOVER (TEXT-TO-SPEECH)</label>
        </div>
        <span class="panel-status">Press E while watching to trigger a test EAS alert on demand — full-screen slate, the real two-tone attention signal, and an optional spoken readout. Random self-tests are off by default; real EAS is event-driven, not ambient.</span>
        <div style="margin-top: 12px;">
          <div class="panel-toggle" style="cursor:default">ALERT MESSAGE</div>
          <textarea data-el="message" class="pubaccess-slide-input" rows="4" style="width:100%"></textarea>
          <div class="block-row" style="margin-top:8px;">
            <button type="button" data-el="test" class="btn">&#9654; TEST EAS ALERT NOW</button>
          </div>
        </div>
      `;
      const q = (sel) => container.querySelector(`[data-el="${sel}"]`);
      const enabledEl = q('enabled');
      const intervalEl = q('interval');
      const toneEl = q('tone');
      const voiceoverEl = q('voiceover');
      const messageEl = q('message');

      enabledEl.checked = !!cfg.enabled;
      intervalEl.value = cfg.intervalMinutes || 60;
      toneEl.value = cfg.toneSec || 8;
      voiceoverEl.checked = cfg.voiceover !== false;
      messageEl.value = cfg.message || '';

      enabledEl.addEventListener('change', () => {
        cfg.enabled = enabledEl.checked;
        scheduleNextEasAlert();
        ctx.saveConfigDebounced();
      });
      intervalEl.addEventListener('change', () => {
        const n = parseInt(intervalEl.value, 10);
        cfg.intervalMinutes = (Number.isFinite(n) && n > 0) ? n : 60;
        scheduleNextEasAlert();
        ctx.saveConfigDebounced();
      });
      toneEl.addEventListener('change', () => {
        const n = parseInt(toneEl.value, 10);
        cfg.toneSec = (Number.isFinite(n) && n > 0) ? n : 8;
        ctx.saveConfigDebounced();
      });
      voiceoverEl.addEventListener('change', () => { cfg.voiceover = voiceoverEl.checked; ctx.saveConfigDebounced(); });
      messageEl.addEventListener('input', () => { cfg.message = messageEl.value; ctx.saveConfigDebounced(); });
      q('test').addEventListener('click', () => runEasAlert({ manual: true }));
    },
  }],
});
