window.RCBPlugins.registerPluginSettings('cast-to-tv', {
  schemaVersion: 2,
  defaults: { deviceHost: '', deviceName: '', autoSync: true },
  migrations: {
    2(settings) {
      const { deviceHost, autoSync } = settings;
      return { deviceHost: deviceHost || '', deviceName: '', autoSync: autoSync !== false };
    },
  },
  sections: [{
    id: 'device',
    label: 'CAST TO TV',
    layout: 'stack',
    render(container, ctx) {
      const cfg = ctx.settings;
      container.setAttribute('data-plugin-settings', 'cast-to-tv');
      container.innerHTML = `
        <div class="panel-body">
          <div class="panel-status" data-el="status">Not connected.</div>
          <div style="display:flex; gap:8px; flex-wrap:wrap; margin: 8px 0;">
            <button class="btn btn-primary" data-el="scan">SCAN FOR DEVICES</button>
            <button class="btn" data-el="disconnect">DISCONNECT</button>
            <button class="btn btn-primary" data-el="castNow">CAST NOW</button>
            <button class="btn" data-el="stop">STOP</button>
          </div>
          <div data-el="devices"></div>
          <label class="shuffle-toggle" style="margin-top:8px;">
            <input type="checkbox" data-el="autoSync">KEEP IN SYNC WITH THE LIVE SCHEDULE
          </label>
        </div>
      `;
      const statusEl = container.querySelector('[data-el="status"]');
      const devicesEl = container.querySelector('[data-el="devices"]');
      const autoSyncEl = container.querySelector('[data-el="autoSync"]');
      const scanBtn = container.querySelector('[data-el="scan"]');
      autoSyncEl.checked = !!cfg.autoSync;

      function describeStatus(s) {
        if (!s || s.state === 'disconnected') return 'Not connected.';
        if (s.state === 'connecting') return `Connecting to ${s.host}…`;
        if (s.state === 'error') return `Error: ${s.error || 'unknown'}`;
        if (s.state === 'connected') return `Connected to ${cfg.deviceName || s.host}.`;
        if (s.state === 'casting') return `Casting ${s.path ? s.path.split(/[\\/]/).pop() : ''} to ${cfg.deviceName || cfg.deviceHost}.`;
        if (s.state === 'media') return `Playing (${s.playerState || 'unknown'}) on ${cfg.deviceName || cfg.deviceHost}.`;
        return 'Not connected.';
      }

      function renderDevices(list) {
        if (!list || !list.length) {
          devicesEl.innerHTML = '<div class="panel-status">No devices found. Make sure the TV is on the same network and try again.</div>';
          return;
        }
        devicesEl.innerHTML = list.map((d, i) => `
          <button class="btn" data-device-index="${i}" style="display:block; width:100%; text-align:left; margin-bottom:4px;">
            ${d.name} <span style="opacity:0.6;">(${d.host})</span>
          </button>
        `).join('');
        list.forEach((d, i) => {
          devicesEl.querySelector(`[data-device-index="${i}"]`).addEventListener('click', async () => {
            ctx.updateSettings({ deviceHost: d.host, deviceName: d.name });
            statusEl.textContent = `Connecting to ${d.name}…`;
            try { await window.api.castConnect(d.host); } catch (e) { statusEl.textContent = `Error: ${e.message}`; }
          });
        });
      }

      if (!window.__castToTvStatusHooked) {
        window.__castToTvStatusHooked = true;
        window.api.onCastStatus((s) => {
          const el = document.querySelector('[data-plugin-settings="cast-to-tv"] [data-el="status"]');
          if (el) el.textContent = describeStatus(s);
        });
      }
      window.api.castGetStatus().then((s) => { statusEl.textContent = describeStatus(s); });

      scanBtn.addEventListener('click', async () => {
        scanBtn.disabled = true;
        scanBtn.textContent = 'SCANNING…';
        devicesEl.innerHTML = '<div class="panel-status">Scanning the network…</div>';
        try {
          const found = await window.api.castScan();
          renderDevices(found);
        } catch (e) {
          devicesEl.innerHTML = `<div class="panel-status">Scan failed: ${e.message}</div>`;
        } finally {
          scanBtn.disabled = false;
          scanBtn.textContent = 'SCAN FOR DEVICES';
        }
      });

      autoSyncEl.addEventListener('change', () => {
        ctx.updateSettings({ autoSync: autoSyncEl.checked });
        window.api.castSetAutoSync(autoSyncEl.checked);
      });
      container.querySelector('[data-el="disconnect"]').addEventListener('click', () => window.api.castDisconnect());
      container.querySelector('[data-el="castNow"]').addEventListener('click', async () => {
        try { await window.api.castNow(); } catch (e) { statusEl.textContent = `Error: ${e.message}`; }
      });
      container.querySelector('[data-el="stop"]').addEventListener('click', () => window.api.castStop());
    },
  }],
});
