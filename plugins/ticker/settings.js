import { applyTickerState } from './renderer.js';

window.RCBPlugins.registerPluginSettings('ticker', {
  sections: [{
    id: 'general',
  render(container, ctx) {
    if (!ctx.S.config.ticker) ctx.S.config.ticker = { enabled: false, text: '', speed: 30 };
    const cfg = ctx.S.config.ticker;
    container.innerHTML = `
      <label class="panel-toggle"><input type="checkbox" data-el="enabled">TEXT TICKER</label>
      <div class="panel-body">
        <textarea class="pubaccess-slide-input" rows="2" placeholder="Scrolling ticker text…" data-el="text"></textarea>
        <div class="panel-interval">
          SPEED <input type="number" min="5" max="120" data-el="speed"> SEC/LOOP (LOWER = FASTER)
        </div>
      </div>
    `;
    const q = (sel) => container.querySelector(`[data-el="${sel}"]`);
    const enabledEl = q('enabled');
    const textEl = q('text');
    const speedEl = q('speed');
    enabledEl.checked = !!cfg.enabled;
    textEl.value = cfg.text || '';
    speedEl.value = cfg.speed || 30;
    enabledEl.addEventListener('change', () => {
      cfg.enabled = enabledEl.checked;
      applyTickerState();
      ctx.saveConfigDebounced();
    });
    textEl.addEventListener('input', () => {
      cfg.text = textEl.value;
      applyTickerState();
      ctx.saveConfigDebounced();
    });
    speedEl.addEventListener('change', () => {
      cfg.speed = parseInt(speedEl.value, 10) || 30;
      applyTickerState();
      ctx.saveConfigDebounced();
    });
    },
  }],
});

