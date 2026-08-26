import { rearmScreensaverTimer, applyScreensaverVariant } from './renderer.js';

window.RCBPlugins.registerPluginSettings('screensaver', {
  sections: [{
    id: 'general',
  render(container, ctx) {
    if (!ctx.S.config.screensaver) ctx.S.config.screensaver = { enabled: false, intervalMinutes: 5, variant: 'auto' };
    const cfg = ctx.S.config.screensaver;
    if (!cfg.variant) cfg.variant = 'auto';
    container.innerHTML = `
      <label class="panel-toggle"><input type="checkbox" data-el="enabled">IDLE SCREENSAVER</label>
      <div class="panel-body">
        <div class="panel-interval">
          AFTER <input type="number" min="1" data-el="interval"> MIN IDLE
        </div>
        <div class="panel-interval">
          VARIANT
          <select data-el="variant">
            <option value="auto">AUTO (MATCHES ACTIVE THEME ERA)</option>
            <option value="bounce">BOUNCING BRAND MARK</option>
            <option value="testcard">TEST CARD &amp; REFERENCE TONE</option>
            <option value="standby">PLEASE STAND BY SLATE</option>
            <option value="lineup">COMING UP TONIGHT SCROLL</option>
            <option value="diagnostics">SIGNAL DIAGNOSTICS READOUT</option>
          </select>
        </div>
      </div>
      <span class="panel-status">AUTO picks the idle-state style that matches the active guide/OSD theme era. Choosing a specific variant shows it regardless of theme.</span>
    `;
    const q = (sel) => container.querySelector(`[data-el="${sel}"]`);
    const enabledEl = q('enabled');
    const intervalEl = q('interval');
    const variantEl = q('variant');
    enabledEl.checked = !!cfg.enabled;
    intervalEl.value = cfg.intervalMinutes || 5;
    variantEl.value = cfg.variant;
    enabledEl.addEventListener('change', () => {
      cfg.enabled = enabledEl.checked;
      ctx.saveConfigDebounced();
      rearmScreensaverTimer();
    });
    intervalEl.addEventListener('change', () => {
      cfg.intervalMinutes = parseInt(intervalEl.value, 10) || 5;
      ctx.saveConfigDebounced();
      rearmScreensaverTimer();
    });
    variantEl.addEventListener('change', () => {
      cfg.variant = variantEl.value;
      ctx.saveConfigDebounced();
      applyScreensaverVariant();
    });
    },
  }],
});

