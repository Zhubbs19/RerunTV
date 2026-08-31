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
          <label class="plugin-settings-field" style="margin-top:8px;">
            <span>CAST RECEIVER</span>
            <select data-el="device" aria-label="Cast receiver">
              <option value="">SCAN FOR DEVICES TO CHOOSE A RECEIVER</option>
            </select>
          </label>
          <div class="panel-status" data-el="deviceCount"></div>
          <div style="display:flex; gap:8px; flex-wrap:wrap; margin: 8px 0;">
            <button class="btn btn-primary" data-el="scan">SCAN FOR DEVICES</button>
            <button class="btn btn-primary" data-el="connect" disabled>CONNECT</button>
            <button class="btn" data-el="disconnect">DISCONNECT</button>
            <button class="btn btn-primary" data-el="castNow">CAST NOW</button>
            <button class="btn" data-el="stop">STOP</button>
          </div>
          <label class="shuffle-toggle" style="margin-top:8px;">
            <input type="checkbox" data-el="autoSync">KEEP IN SYNC WITH THE LIVE SCHEDULE
          </label>
        </div>
      `;
      const statusEl = container.querySelector('[data-el="status"]');
      const deviceSelectEl = container.querySelector('[data-el="device"]');
      const deviceCountEl = container.querySelector('[data-el="deviceCount"]');
      const autoSyncEl = container.querySelector('[data-el="autoSync"]');
      const scanBtn = container.querySelector('[data-el="scan"]');
      const connectBtn = container.querySelector('[data-el="connect"]');
      let selectedDeviceHost = cfg.deviceHost || '';
      let selectedDeviceName = cfg.deviceName || '';
      autoSyncEl.checked = !!cfg.autoSync;

      function describeStatus(s) {
        if (!s || s.state === 'disconnected') return 'Not connected.';
        if (s.state === 'connecting') return `Connecting to ${s.host}…`;
        if (s.state === 'error') return `Error: ${s.error || 'unknown'}`;
        if (s.state === 'connected') return `Connected to ${selectedDeviceName || s.host}.`;
        if (s.state === 'casting') return `Casting ${s.path ? s.path.split(/[\\/]/).pop() : ''} to ${selectedDeviceName || selectedDeviceHost}.`;
        if (s.state === 'media') return `Playing (${s.playerState || 'unknown'}) on ${selectedDeviceName || selectedDeviceHost}.`;
        return 'Not connected.';
      }

      function renderDevices(list) {
        deviceSelectEl.replaceChildren();
        if (!list || !list.length) {
          const option = document.createElement('option');
          option.value = selectedDeviceHost;
          option.textContent = selectedDeviceHost
            ? `${selectedDeviceName || 'SAVED RECEIVER'} (${selectedDeviceHost})`
            : 'NO DEVICES FOUND';
          deviceSelectEl.append(option);
          deviceSelectEl.disabled = !selectedDeviceHost;
          connectBtn.disabled = !selectedDeviceHost;
          deviceCountEl.textContent = 'No devices found. Make sure each receiver is on the same network and try again.';
          return;
        }
        list.forEach((d) => {
          const option = document.createElement('option');
          option.value = d.host;
          option.dataset.deviceName = d.name;
          option.textContent = `${d.name} (${d.host})`;
          option.selected = d.host === selectedDeviceHost;
          deviceSelectEl.append(option);
        });
        deviceSelectEl.disabled = false;
        connectBtn.disabled = false;
        deviceCountEl.textContent = `${list.length} DEVICE${list.length === 1 ? '' : 'S'} FOUND — CHOOSE ONE RECEIVER, THEN CONNECT.`;
      }

      if (selectedDeviceHost) renderDevices([{ name: selectedDeviceName || 'SAVED RECEIVER', host: selectedDeviceHost }]);

      if (!window.__castToTvStatusHooked) {
        window.__castToTvStatusHooked = true;
        window.api.onCastStatus((s) => {
          if (typeof window.__castToTvRenderStatus === 'function') window.__castToTvRenderStatus(s);
        });
      }
      window.__castToTvRenderStatus = (s) => { statusEl.textContent = describeStatus(s); };
      window.api.castGetStatus().then((s) => { statusEl.textContent = describeStatus(s); });

      deviceSelectEl.addEventListener('change', () => {
        const option = deviceSelectEl.selectedOptions[0];
        selectedDeviceHost = option ? option.value : '';
        selectedDeviceName = option ? option.dataset.deviceName || '' : '';
        ctx.updateSettings({ deviceHost: selectedDeviceHost, deviceName: selectedDeviceName });
        connectBtn.disabled = !selectedDeviceHost;
      });

      connectBtn.addEventListener('click', async () => {
        const option = deviceSelectEl.selectedOptions[0];
        selectedDeviceHost = option ? option.value : '';
        selectedDeviceName = option ? option.dataset.deviceName || option.textContent : '';
        if (!selectedDeviceHost) return;
        ctx.updateSettings({ deviceHost: selectedDeviceHost, deviceName: selectedDeviceName });
        statusEl.textContent = `Connecting to ${selectedDeviceName}…`;
        try { await window.api.castConnect(selectedDeviceHost); } catch (e) { statusEl.textContent = `Error: ${e.message}`; }
      });

      scanBtn.addEventListener('click', async () => {
        scanBtn.disabled = true;
        scanBtn.textContent = 'SCANNING…';
        deviceCountEl.textContent = 'Scanning the network…';
        try {
          const found = await window.api.castScan();
          renderDevices(found);
        } catch (e) {
          deviceCountEl.textContent = `Scan failed: ${e.message}`;
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
