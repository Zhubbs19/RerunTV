window.RCBPlugins.registerPluginSettings('smpte-test-pattern', {
  sections: [{
    id: 'general',
  render(container, ctx) {
    if (!ctx.S.config.testPattern) ctx.S.config.testPattern = {};
    const cfg = ctx.S.config.testPattern;
    container.innerHTML = `
      <label class="panel-toggle"><input type="checkbox" data-el="enabled">SMPTE TEST PATTERN</label>
      <span class="panel-status">Shows color bars instead of a plain "NO SIGNAL" card when you tune to a channel number that isn't set up yet.</span>
    `;
    const enabledEl = container.querySelector('[data-el="enabled"]');
    enabledEl.checked = cfg.enabled !== false;
    enabledEl.addEventListener('change', () => {
      cfg.enabled = enabledEl.checked;
      ctx.saveConfigDebounced();
    });
    },
  }],
});

