window.RCBPlugins.registerPluginSettings('universal-remote', {
  sections: [{
    id: 'general',
  render(container, ctx) {
    if (!ctx.S.config.network) ctx.S.config.network = { viewerEnabled: false, remoteEnabled: false };
    container.innerHTML = `
      <label class="panel-toggle"><input type="checkbox" data-el="enabled"> PHONE REMOTE LAN ACCESS</label>
      <div class="panel-body">
        <span data-el="status" class="panel-status">Checking for a network connection…</span>
      </div>
    `;
    const enabledEl = container.querySelector('[data-el="enabled"]');
    const statusEl = container.querySelector('[data-el="status"]');
    enabledEl.checked = !!ctx.S.config.network.remoteEnabled;
    enabledEl.addEventListener('change', () => {
      ctx.S.config.network.remoteEnabled = enabledEl.checked;
      ctx.saveConfigDebounced();
      statusEl.textContent = `${enabledEl.checked ? 'Remote access will start' : 'Remote access will stop'} after RerunTV restarts.`;
    });
    if (!enabledEl.checked) {
      statusEl.textContent = 'Off by default. Enable this, save, and restart RerunTV to accept paired phone remotes.';
      return;
    }
    window.api.getRemoteUrl().then((candidates) => {
      if (!candidates || !candidates.length) {
        statusEl.textContent = 'Remote access is enabled but not active yet. Restart RerunTV, or connect this computer to WiFi/ethernet.';
        return;
      }
      const list = candidates.map((c) => `${c.url} (${c.name})`).join(', ');
      statusEl.textContent = `Open a pairing link on your phone (same WiFi). The code is exchanged for a private session: ${list}`;
    });
    },
  }],
});
