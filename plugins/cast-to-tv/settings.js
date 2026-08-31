window.RCBPlugins.registerPluginSettings('cast-to-tv', {
  schemaVersion: 1,
  defaults: { deviceHost: '', autoSync: true },
  sections: [{
    id: 'device',
    label: 'CAST TO TV',
    layout: 'stack',
    render(container, ctx) {
      const cfg = ctx.settings;
      container.innerHTML = `
        <div class="panel-body">
          <label class="title-row-input">
            GOOGLE TV / CHROMECAST IP ADDRESS
            <input type="text" data-el="host" placeholder="e.g. 192.168.1.42" value="${cfg.deviceHost || ''}">
          </label>
          <div class="panel-status" data-el="status">Not connected.</div>
          <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px;">
            <button class="btn btn-primary" data-el="connect">CONNECT</button>
            <button class="btn" data-el="disconnect">DISCONNECT</button>
            <button class="btn btn-primary" data-el="castNow">CAST NOW</button>
            <button class="btn" data-el="stop">STOP</button>
          </div>
          <label class="shuffle-toggle" style="margin-top:8px;">
            <input type="checkbox" data-el="autoSync">KEEP IN SYNC WITH THE LIVE SCHEDULE
          </label>
        </div>
      `;
      const hostEl = container.querySelector('[data-el="host"]');
      const statusEl = container.querySelector('[data-el="status"]');
      const autoSyncEl = container.querySelector('[data-el="autoSync"]');
      autoSyncEl.checked = !!cfg.autoSync;

      function describeStatus(s) {
        if (!s || s.state === 'disconnected') return 'Not connected.';
        if (s.state === 'connecting') return `Connecting to ${s.host}…`;
        if (s.state === 'error') return `Error: ${s.error || 'unknown'}`;
        if (s.state === 'connected') return `Connected to ${s.host || cfg.deviceHost}.`;
        if (s.state === 'casting') return `Casting ${s.path ? s.path.split(/[\\/]/).pop() : ''}.`;
        if (s.state === 'media') return `Playing (${s.playerState || 'unknown'}).`;
        return 'Not connected.';
      }

      if (!window.__castToTvStatusHooked) {
        window.__castToTvStatusHooked = true;
        window.api.onCastStatus((s) => {
          const el = document.querySelector('[data-plugin-settings="cast-to-tv"] [data-el="status"]');
          if (el) el.textContent = describeStatus(s);
        });
      }
      container.setAttribute('data-plugin-settings', 'cast-to-tv');
      window.api.castGetStatus().then((s) => { statusEl.textContent = describeStatus(s); });

      hostEl.addEventListener('change', () => ctx.updateSettings({ deviceHost: hostEl.value.trim() }));
      autoSyncEl.addEventListener('change', () => {
        ctx.updateSettings({ autoSync: autoSyncEl.checked });
        window.api.castSetAutoSync(autoSyncEl.checked);
      });
      container.querySelector('[data-el="connect"]').addEventListener('click', async () => {
        const host = hostEl.value.trim();
        if (!host) { statusEl.textContent = 'Enter the device IP address first.'; return; }
        ctx.updateSettings({ deviceHost: host });
        statusEl.textContent = `Connecting to ${host}…`;
        try { await window.api.castConnect(host); } catch (e) { statusEl.textContent = `Error: ${e.message}`; }
      });
      container.querySelector('[data-el="disconnect"]').addEventListener('click', () => window.api.castDisconnect());
      container.querySelector('[data-el="castNow"]').addEventListener('click', async () => {
        try { await window.api.castNow(); } catch (e) { statusEl.textContent = `Error: ${e.message}`; }
      });
      container.querySelector('[data-el="stop"]').addEventListener('click', () => window.api.castStop());
    },
  }],
});
