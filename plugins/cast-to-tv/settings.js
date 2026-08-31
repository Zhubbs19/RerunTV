window.RCBPlugins.registerPluginSettings('cast-to-tv', {
  schemaVersion: 4,
  defaults: { deviceHost: '', deviceName: '', autoSync: true, mirrorQuality: '1080p60', mirrorSource: 'app' },
  migrations: {
    2(settings) {
      const { deviceHost, autoSync } = settings;
      return { deviceHost: deviceHost || '', deviceName: '', autoSync: autoSync !== false };
    },
    3(settings) {
      return { ...settings, mirrorQuality: settings.mirrorQuality || '1080p60' };
    },
    4(settings) {
      return { ...settings, mirrorSource: settings.mirrorSource || 'app' };
    },
  },
  sections: [{
    id: 'device',
    label: 'CAST TO TV',
    layout: 'wide',
    render(container, ctx) {
      const cfg = ctx.settings;
      container.setAttribute('data-plugin-settings', 'cast-to-tv');
      container.innerHTML = `
        <div class="cast-tv-settings">
          <div class="cast-tv-status" data-el="statusCard" data-state="disconnected" role="status" aria-live="polite">
            <span>RECEIVER STATUS</span>
            <strong data-el="status">NOT CONNECTED</strong>
          </div>
          <div class="cast-tv-receiver-row">
            <label class="cast-tv-receiver-field">
              <span>CAST RECEIVER</span>
              <select data-el="device" aria-label="Cast receiver">
                <option value="">SCAN FOR DEVICES TO CHOOSE A RECEIVER</option>
              </select>
            </label>
            <button type="button" class="btn" data-el="scan">SCAN FOR DEVICES</button>
          </div>
          <div class="panel-status cast-tv-device-count" data-el="deviceCount">Choose one receiver, then mirror RerunTV.</div>
          <div class="cast-tv-capture-options">
            <label class="cast-tv-receiver-field cast-tv-source-field">
              <span>MIRROR SOURCE</span>
              <select data-el="source" aria-label="Mirror source">
                <option value="app">RERUNTV APP WINDOW</option>
              </select>
            </label>
            <label class="cast-tv-receiver-field cast-tv-quality-field">
              <span>MIRROR QUALITY</span>
              <select data-el="quality" aria-label="Mirror quality">
                <option value="1080p60">1080P / 60 FPS</option>
                <option value="4k60">4K / 60 FPS</option>
                <option value="720p30">720P / 30 FPS</option>
              </select>
            </label>
          </div>
          <div class="cast-tv-mode-grid">
            <button type="button" class="cast-tv-mode cast-tv-mode-primary" data-el="mirror" disabled>
              <strong>MIRROR RERUNTV</strong>
              <span>Whole app · selected resolution, guide, OSD, overlays, and playback</span>
            </button>
            <button type="button" class="cast-tv-mode" data-el="castProgram" disabled>
              <strong>CAST PROGRAM ONLY</strong>
              <span>Lower latency · currently airing local video only</span>
            </button>
          </div>
          <div class="cast-tv-actions">
            <button type="button" class="btn" data-el="stop" disabled>STOP CASTING</button>
            <button type="button" class="btn" data-el="disconnect" disabled>DISCONNECT</button>
          </div>
          <label class="shuffle-toggle cast-tv-sync-toggle">
            <input type="checkbox" data-el="autoSync">KEEP PROGRAM-ONLY CASTING IN SYNC WITH THE LIVE SCHEDULE
          </label>
        </div>
      `;

      const statusEl = container.querySelector('[data-el="status"]');
      const statusCardEl = container.querySelector('[data-el="statusCard"]');
      const deviceSelectEl = container.querySelector('[data-el="device"]');
      const deviceCountEl = container.querySelector('[data-el="deviceCount"]');
      const sourceEl = container.querySelector('[data-el="source"]');
      const qualityEl = container.querySelector('[data-el="quality"]');
      const autoSyncEl = container.querySelector('[data-el="autoSync"]');
      const scanBtn = container.querySelector('[data-el="scan"]');
      const mirrorBtn = container.querySelector('[data-el="mirror"]');
      const castProgramBtn = container.querySelector('[data-el="castProgram"]');
      const stopBtn = container.querySelector('[data-el="stop"]');
      const disconnectBtn = container.querySelector('[data-el="disconnect"]');
      let selectedDeviceHost = cfg.deviceHost || '';
      let selectedDeviceName = cfg.deviceName || '';
      let currentStatus = { state: 'disconnected' };
      autoSyncEl.checked = !!cfg.autoSync;
      qualityEl.value = ['720p30', '1080p60', '4k60'].includes(cfg.mirrorQuality) ? cfg.mirrorQuality : '1080p60';
      sourceEl.dataset.savedValue = cfg.mirrorSource || 'app';

      function friendlyError(error, fallback = 'The receiver could not be reached.') {
        const message = error && error.message ? error.message : String(error || fallback);
        return message
          .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, '')
          .replace(/^Error:\s*/i, '') || fallback;
      }

      function isConnected(status = currentStatus) {
        return ['connected', 'casting', 'media', 'mirroring'].includes(status && status.state);
      }

      function describeStatus(status) {
        if (!status || status.state === 'disconnected') return 'NOT CONNECTED';
        if (status.state === 'connecting') return `CONNECTING TO ${selectedDeviceName || status.host || 'RECEIVER'}…`;
        if (status.state === 'error') return friendlyError(status.error).toUpperCase();
        if (status.state === 'mirroring' || status.mode === 'mirror') {
          return `MIRRORING RERUNTV TO ${selectedDeviceName || status.host}${status.quality ? ` · ${status.quality}` : ''}`;
        }
        if (status.state === 'casting') return `CASTING PROGRAM TO ${selectedDeviceName || status.host}`;
        if (status.state === 'media') return `${status.playerState || 'PLAYING'} ON ${selectedDeviceName || status.host}`;
        return `CONNECTED TO ${selectedDeviceName || status.host}`;
      }

      function updateActions() {
        const connecting = currentStatus.state === 'connecting';
        const hasReceiver = !!selectedDeviceHost;
        const active = ['casting', 'media', 'mirroring'].includes(currentStatus.state);
        deviceSelectEl.disabled = connecting;
        sourceEl.disabled = connecting || currentStatus.mode === 'mirror' || currentStatus.state === 'mirroring';
        qualityEl.disabled = connecting || currentStatus.mode === 'mirror' || currentStatus.state === 'mirroring';
        scanBtn.disabled = connecting;
        mirrorBtn.disabled = !hasReceiver || connecting || currentStatus.mode === 'mirror' || currentStatus.state === 'mirroring';
        castProgramBtn.disabled = !hasReceiver || connecting;
        stopBtn.disabled = !active;
        disconnectBtn.disabled = !isConnected() && !connecting;
      }

      function updateMirrorModeCopy() {
        const desktop = sourceEl.value !== 'app';
        mirrorBtn.querySelector('strong').textContent = desktop ? 'MIRROR DESKTOP' : 'MIRROR RERUNTV';
        mirrorBtn.querySelector('span').textContent = desktop
          ? 'Entire selected display · system audio when available'
          : 'Whole app · selected resolution, guide, OSD, overlays, and playback';
      }

      function renderStatus(status) {
        currentStatus = status || { state: 'disconnected' };
        statusCardEl.dataset.state = currentStatus.state || 'disconnected';
        statusEl.textContent = describeStatus(currentStatus);
        if (['disconnected', 'error'].includes(currentStatus.state)
          && window.RCBPlugins.castToTv.isMirroring()) {
          window.RCBPlugins.castToTv.stopMirror({ notifyMain: false }).catch(() => {});
        }
        updateActions();
      }

      function persistSelectedOption() {
        const option = deviceSelectEl.selectedOptions[0];
        selectedDeviceHost = option ? option.value : '';
        selectedDeviceName = option ? option.dataset.deviceName || '' : '';
        ctx.updateSettings({ deviceHost: selectedDeviceHost, deviceName: selectedDeviceName });
      }

      function renderDevices(found) {
        const devices = Array.isArray(found) ? [...found] : [];
        if (selectedDeviceHost && !devices.some((device) => device.host === selectedDeviceHost)) {
          devices.unshift({ name: selectedDeviceName || 'SAVED RECEIVER', host: selectedDeviceHost });
        }
        deviceSelectEl.replaceChildren();
        if (!devices.length) {
          const option = document.createElement('option');
          option.value = '';
          option.textContent = 'NO RECEIVERS FOUND';
          deviceSelectEl.append(option);
          selectedDeviceHost = '';
          selectedDeviceName = '';
          deviceCountEl.textContent = 'No receivers found. Wake the TV, confirm it is on this network, and scan again.';
          updateActions();
          return;
        }
        devices.forEach((device) => {
          const option = document.createElement('option');
          option.value = device.host;
          option.dataset.deviceName = device.name;
          option.textContent = `${device.name} (${device.host})`;
          option.selected = device.host === selectedDeviceHost;
          deviceSelectEl.append(option);
        });
        if (!deviceSelectEl.value) deviceSelectEl.selectedIndex = 0;
        persistSelectedOption();
        deviceCountEl.textContent = `${devices.length} RECEIVER${devices.length === 1 ? '' : 'S'} AVAILABLE · TARGET: ${selectedDeviceName || selectedDeviceHost}`;
        updateActions();
      }

      async function populateMirrorSources() {
        try {
          const sources = await window.api.castListMirrorSources();
          const saved = sourceEl.dataset.savedValue || 'app';
          sourceEl.replaceChildren();
          const appOption = document.createElement('option');
          appOption.value = 'app';
          appOption.textContent = 'RERUNTV APP WINDOW';
          sourceEl.append(appOption);
          (sources || []).filter((source) => source.sourceType === 'screen').forEach((source, index) => {
            const option = document.createElement('option');
            option.value = source.id;
            option.textContent = `ENTIRE ${String(source.name || `DISPLAY ${index + 1}`).toUpperCase()}`;
            sourceEl.append(option);
          });
          sourceEl.value = Array.from(sourceEl.options).some((option) => option.value === saved) ? saved : 'app';
          if (sourceEl.value !== saved) ctx.updateSettings({ mirrorSource: sourceEl.value });
          updateMirrorModeCopy();
        } catch (error) {
          // App capture remains available; screen enumeration can be retried
          // next time settings opens without making the plugin unusable.
          sourceEl.value = 'app';
        }
      }

      if (selectedDeviceHost) renderDevices([{ name: selectedDeviceName || 'SAVED RECEIVER', host: selectedDeviceHost }]);

      if (!window.__castToTvStatusHooked) {
        window.__castToTvStatusHooked = true;
        window.api.onCastStatus((status) => {
          if (typeof window.__castToTvRenderStatus === 'function') window.__castToTvRenderStatus(status);
        });
      }
      window.__castToTvRenderStatus = renderStatus;
      window.api.castGetStatus().then(renderStatus).catch((error) => renderStatus({ state: 'error', error: friendlyError(error) }));
      populateMirrorSources();

      deviceSelectEl.addEventListener('change', () => {
        persistSelectedOption();
        deviceCountEl.textContent = selectedDeviceHost
          ? `TARGET: ${selectedDeviceName || selectedDeviceHost}`
          : 'Choose one receiver before casting.';
        updateActions();
      });

      qualityEl.addEventListener('change', () => {
        ctx.updateSettings({ mirrorQuality: qualityEl.value });
        deviceCountEl.textContent = qualityEl.value === '4k60'
          ? '4K / 60 requires a 4K source window, a VP9-capable receiver, and a fast LAN.'
          : `MIRROR QUALITY: ${qualityEl.selectedOptions[0].textContent}`;
      });

      sourceEl.addEventListener('change', () => {
        sourceEl.dataset.savedValue = sourceEl.value;
        ctx.updateSettings({ mirrorSource: sourceEl.value });
        updateMirrorModeCopy();
        deviceCountEl.textContent = sourceEl.value === 'app'
          ? 'MIRROR SOURCE: RERUNTV APP WINDOW'
          : `MIRROR SOURCE: ${sourceEl.selectedOptions[0].textContent}`;
      });

      scanBtn.addEventListener('click', async () => {
        scanBtn.disabled = true;
        scanBtn.textContent = 'SCANNING…';
        deviceCountEl.textContent = 'Scanning the local network for Cast receivers…';
        try { renderDevices(await window.api.castScan()); }
        catch (error) { deviceCountEl.textContent = `Scan failed: ${friendlyError(error)}`; }
        finally { scanBtn.textContent = 'SCAN FOR DEVICES'; updateActions(); }
      });

      mirrorBtn.addEventListener('click', async () => {
        if (!selectedDeviceHost) return;
        renderStatus({ state: 'connecting', host: selectedDeviceHost, mode: 'mirror' });
        try {
          const capture = await window.RCBPlugins.castToTv.startMirror(qualityEl.value, sourceEl.value);
          const quality = `${capture.sourceName} · ${capture.width}×${capture.height} @ ${Math.round(capture.frameRate)} FPS`;
          renderStatus(await window.api.castStartMirror(selectedDeviceHost, capture.mimeType, quality));
        } catch (error) {
          await window.RCBPlugins.castToTv.stopMirror({ notifyMain: false }).catch(() => {});
          renderStatus({ state: 'error', host: selectedDeviceHost, error: friendlyError(error) });
        }
      });

      castProgramBtn.addEventListener('click', async () => {
        if (!selectedDeviceHost) return;
        await window.RCBPlugins.castToTv.stopMirror({ notifyMain: false }).catch(() => {});
        renderStatus({ state: 'connecting', host: selectedDeviceHost, mode: 'program' });
        try { renderStatus(await window.api.castNow(selectedDeviceHost)); }
        catch (error) { renderStatus({ state: 'error', host: selectedDeviceHost, error: friendlyError(error) }); }
      });

      stopBtn.addEventListener('click', async () => {
        try {
          if (window.RCBPlugins.castToTv.isMirroring()) renderStatus(await window.RCBPlugins.castToTv.stopMirror());
          else renderStatus(await window.api.castStop());
        } catch (error) { renderStatus({ state: 'error', error: friendlyError(error) }); }
      });

      disconnectBtn.addEventListener('click', async () => {
        try {
          await window.RCBPlugins.castToTv.stopMirror({ notifyMain: false }).catch(() => {});
          renderStatus(await window.api.castDisconnect());
        } catch (error) { renderStatus({ state: 'error', error: friendlyError(error) }); }
      });

      autoSyncEl.addEventListener('change', () => {
        ctx.updateSettings({ autoSync: autoSyncEl.checked });
        window.api.castSetAutoSync(autoSyncEl.checked);
      });
      updateActions();
    },
  }],
});
