window.RCBPlugins.registerPluginSettings('screensaver', {
  sections: [{
    id: 'general',
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
  }],
});

