window.RCBPlugins.registerPluginSettings('companion-app', {
  sections: [{
    id: 'general',
    render(container, ctx) {
      if (!ctx.S.config.network) ctx.S.config.network = {};
      container.innerHTML = `
        <label class="panel-toggle"><input type="checkbox" data-el="enabled"> COMPANION APP LAN ACCESS (SETTINGS + FILES)</label>
        <div class="panel-body">
          <span data-el="status" class="panel-status">Checking for a network connection…</span>
          <div data-el="pairing" class="hidden">
            <span class="panel-status">Pairing code (enter this in the Android app's SETTINGS tab, or open the link on a phone browser):</span>
            <div data-el="code" style="font-size:28px;font-weight:700;letter-spacing:.2em;text-align:center;margin:8px 0;"></div>
            <span data-el="urls" class="panel-status"></span>
          </div>
        </div>
      `;
      const enabledEl = container.querySelector('[data-el="enabled"]');
      const statusEl = container.querySelector('[data-el="status"]');
      const pairingEl = container.querySelector('[data-el="pairing"]');
      const codeEl = container.querySelector('[data-el="code"]');
      const urlsEl = container.querySelector('[data-el="urls"]');
      enabledEl.checked = !!ctx.S.config.network.companionEnabled;
      enabledEl.addEventListener('change', () => {
        ctx.S.config.network.companionEnabled = enabledEl.checked;
        ctx.saveConfigDebounced();
        pairingEl.classList.add('hidden');
        statusEl.textContent = `${enabledEl.checked ? 'Companion access will start' : 'Companion access will stop'} after RerunTV restarts.`;
      });
      if (!enabledEl.checked) {
        statusEl.textContent = 'Off by default. Enable this, save, and restart RerunTV to accept paired companion-app devices.';
        return;
      }
      window.api.getCompanionUrl().then((candidates) => {
        if (!candidates || !candidates.length) {
          statusEl.textContent = 'Companion access is enabled but not active yet. Restart RerunTV, or connect this computer to WiFi/ethernet.';
          return;
        }
        const code = new URL(candidates[0].url).searchParams.get('pair') || '';
        statusEl.textContent = 'Same WiFi as this computer. Open the link below on a phone browser, or enter the code in the Android app.';
        codeEl.textContent = code;
        urlsEl.textContent = candidates.map((c) => `${c.url} (${c.name})`).join(', ');
        pairingEl.classList.remove('hidden');
      });
    },
  }],
});
