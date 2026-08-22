// Settings panel for the Universal Remote plugin — just a status readout of
// the LAN URL(s) a phone can open to use this box as a remote. No enable/
// disable toggle (the remote server always runs when this plugin's
// installed+enabled, same as before this was a plugin at all).
window.RCBPlugins.registerSettingsPanel('universal-remote', {
  render(container) {
    container.innerHTML = `
      <div class="panel-toggle">REMOTE CONTROL</div>
      <div class="panel-body">
        <span data-el="status" class="panel-status">Checking for a network connection…</span>
      </div>
    `;
    const statusEl = container.querySelector('[data-el="status"]');
    window.api.getRemoteUrl().then((candidates) => {
      if (!candidates || !candidates.length) {
        statusEl.textContent = 'No network connection found — connect this computer to WiFi/ethernet to use the phone remote.';
        return;
      }
      const list = candidates.map((c) => `${c.url} (${c.name})`).join(', ');
      statusEl.textContent = `Open one of these on your phone's browser (same WiFi) to use it as a remote: ${list}`;
    });
  },
});
