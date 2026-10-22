// LAN viewer / phone remote / startup server status lines and the connected
// devices list (SYSTEM tab). Split out of settings.js.
import { S, dispatch } from '../core/state.js';
import { viewerEnabledEl, viewerUrlStatusEl, controlUrlStatusEl, startupServerEnabledEl, startupServerStatusEl, connectedDevicesListEl, setupScreen } from '../core/dom.js';

// The URL list is a live property of whatever network adapters the machine
// currently has (see getLanUrls, main.js) — not part of S.config, so this
// is a fresh main-process query on demand, same pattern a plugin with its
// own LAN-facing URL panel would use, one port over — see
// startViewerServer/getViewerUrls (main.js). Any browser on the LAN that
// opens one of these URLs gets a fully independent, read-only instance of
// this same app (browser-api-shim.js), tuning its own channel and seeing
// the exact same breaks/bumpers/CRT effects the host does.
export function renderViewerUrlStatus() {
  viewerEnabledEl.checked = !!(S.config.network && S.config.network.viewerEnabled);
  if (!viewerEnabledEl.checked) {
    viewerUrlStatusEl.textContent = 'Off by default. Enable this, save, and restart RerunTV to accept paired viewers.';
    return;
  }
  window.api.getViewerUrl().then((candidates) => {
    if (!candidates || !candidates.length) {
      viewerUrlStatusEl.textContent = 'Viewer access is enabled but not active yet. Restart RerunTV, or connect this computer to WiFi/ethernet.';
      return;
    }
    const list = candidates.map((c) => `${c.url} (${c.name})`).join(', ');
    viewerUrlStatusEl.textContent = `Open a pairing link on the other device. The code is exchanged for a private read-only session: ${list}`;
  });
}

viewerEnabledEl.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['network', 'viewerEnabled'], value: viewerEnabledEl.checked });
  viewerUrlStatusEl.textContent = `${viewerEnabledEl.checked ? 'Viewer access will start' : 'Viewer access will stop'} after RerunTV restarts.`;
  renderViewerControlUrlStatus();
});

// docs/design/06 §4's control pairing code, previously visible only on the
// loopback /server page (host-only IPC — see api-contract.js). Uses the same
// "share with devices" toggle as the read-only viewer above, since /control
// is served by the same LAN process.
export function renderViewerControlUrlStatus() {
  if (!controlUrlStatusEl || typeof window.api.getViewerControlUrl !== 'function') return;
  if (!viewerEnabledEl.checked) {
    controlUrlStatusEl.textContent = 'Off by default. Enable "Share with devices on this network" above, save, and restart RerunTV.';
    return;
  }
  window.api.getViewerControlUrl().then((candidates) => {
    if (!candidates || !candidates.length) {
      controlUrlStatusEl.textContent = 'Not active yet. Restart RerunTV, or connect this computer to WiFi/ethernet.';
      return;
    }
    const list = candidates.map((c) => `${c.url} (${c.name})`).join(', ');
    controlUrlStatusEl.textContent = `Open one of these on a laptop, tablet or phone for the same setup screen — writable there, unlike the read-only viewer link above: ${list}`;
  });
}

// "Open RerunTV when I sign in" (startup-server.js's window entry). Only one
// startup entry is on at a time, so changing either re-reads both.
const startupWindowEnabledEl = document.getElementById('startup-window-enabled');
const startupWindowStatusEl = document.getElementById('startup-window-status');

async function renderStartupWindowStatus(statusOverride = null) {
  if (!startupWindowEnabledEl || !startupWindowStatusEl || typeof window.api.getStartupWindowStatus !== 'function') return;
  let status = statusOverride;
  if (!status) {
    try {
      status = await window.api.getStartupWindowStatus();
    } catch (error) {
      status = { supported: false, enabled: false, error: error.message };
    }
  }
  startupWindowEnabledEl.checked = !!status.enabled;
  startupWindowEnabledEl.disabled = !status.supported;
  startupWindowEnabledEl.closest('.setting-row')?.classList.toggle('is-disabled', !status.supported);
  if (status.reason === 'windows-only') {
    startupWindowStatusEl.textContent = 'Opening at sign-in is currently available on Windows PCs.';
  } else if (status.reason === 'installed-build-only') {
    startupWindowStatusEl.textContent = 'Available in the installed RerunTV build. Development mode will not change Windows startup.';
  } else if (status.error) {
    startupWindowStatusEl.textContent = `Windows could not change the startup setting: ${status.error}`;
  } else if (status.enabled && status.launchAllowed === false) {
    startupWindowStatusEl.textContent = 'Registered, but disabled in Windows Startup Apps. Re-enable RerunTV there to open it at sign-in.';
  } else if (status.enabled) {
    startupWindowStatusEl.textContent = 'At sign-in, RerunTV opens on its screen (see Picture & Sound › Show on screen) and starts the network server too.';
  } else {
    startupWindowStatusEl.textContent = 'Open the box on its screen when you sign in to Windows, like a cable box that’s already on. Replaces the background server below.';
  }
}

startupWindowEnabledEl?.addEventListener('change', async () => {
  if (typeof window.api.setStartupWindowEnabled !== 'function') return;
  startupWindowEnabledEl.disabled = true;
  startupWindowStatusEl.textContent = startupWindowEnabledEl.checked
    ? 'Adding RerunTV to Windows startup…'
    : 'Removing RerunTV from Windows startup…';
  try {
    await renderStartupWindowStatus(await window.api.setStartupWindowEnabled(startupWindowEnabledEl.checked));
  } catch (error) {
    await renderStartupWindowStatus({ supported: true, enabled: false, error: error.message });
  }
  renderStartupServerStatus();
});

export async function renderStartupServerStatus(statusOverride = null) {
  if (!startupServerEnabledEl || !startupServerStatusEl) return;
  renderStartupWindowStatus();
  const panel = startupServerEnabledEl.closest('.panel');
  if (typeof window.api.getStartupServerStatus !== 'function') {
    // The LAN viewer uses the same renderer files but intentionally receives
    // no host-only OS controls through browser-api-shim.js.
    panel?.classList.add('hidden');
    return;
  }
  panel?.classList.remove('hidden');
  let status = statusOverride;
  if (!status) {
    try {
      status = await window.api.getStartupServerStatus();
    } catch (error) {
      status = { supported: false, enabled: false, error: error.message };
    }
  }
  startupServerEnabledEl.checked = !!status.enabled;
  startupServerEnabledEl.disabled = !status.supported;
  startupServerEnabledEl.closest('.setting-row')?.classList.toggle('is-disabled', !status.supported);

  if (status.reason === 'windows-only') {
    startupServerStatusEl.textContent = 'Automatic server startup is currently available on Windows PCs.';
  } else if (status.reason === 'installed-build-only') {
    startupServerStatusEl.textContent = 'Available in the installed RerunTV build. Development mode will not change Windows startup.';
  } else if (status.error) {
    startupServerStatusEl.textContent = `Windows could not change the startup setting: ${status.error}`;
  } else if (status.enabled && status.launchAllowed === false) {
    startupServerStatusEl.textContent = 'Registered, but disabled in Windows Startup Apps. Re-enable RerunTV Server there to run it at sign-in.';
  } else if (status.enabled) {
    startupServerStatusEl.textContent = 'At sign-in, RerunTV checks for updates in its updater box, then opens the local server control site.';
  } else {
    startupServerStatusEl.textContent = 'Start the paired viewer server and open its local control site automatically when you sign in to Windows.';
  }
}

startupServerEnabledEl?.addEventListener('change', async () => {
  if (typeof window.api.setStartupServerEnabled !== 'function') return;
  startupServerEnabledEl.disabled = true;
  startupServerStatusEl.textContent = startupServerEnabledEl.checked
    ? 'Adding RerunTV Server to Windows startup…'
    : 'Removing RerunTV Server from Windows startup…';
  try {
    const status = await window.api.setStartupServerEnabled(startupServerEnabledEl.checked);
    await renderStartupServerStatus(status);
    renderStartupWindowStatus();
  } catch (error) {
    await renderStartupServerStatus({ supported: true, enabled: false, error: error.message });
  }
});

// Host visibility into who's actually on the LAN right now — see
// trackConnection/getConnectedDevices (main.js). Polled on an interval
// rather than one-shot like renderViewerUrlStatus above, since who's
// connected genuinely changes while the settings screen
// sits open; the interval itself is cheap (one small IPC call every 5s) and
// self-gates on the settings screen actually being visible, so it's a no-op
// once you leave setup instead of needing a matching stop call wired into
// every place setup can close.
const CONNECTED_DEVICES_POLL_MS = 5000;
const SERVER_LABELS = { remote: 'PHONE REMOTE', viewer: 'LAN VIEWER', party: 'PARTY GUEST' };
let connectedDevicesPollStarted = false;
let connectedDevicesInFlight = false; // a slow IPC reply must not stack up further polls

export function renderConnectedDevices() {
  if (connectedDevicesInFlight) return;
  connectedDevicesInFlight = true;
  window.api.getConnectedDevices().then((devices) => {
    connectedDevicesListEl.innerHTML = '';
    if (!devices || !devices.length) {
      const empty = document.createElement('div');
      empty.className = 'titles-empty';
      empty.textContent = 'NO DEVICES CONNECTED RIGHT NOW.';
      connectedDevicesListEl.appendChild(empty);
      return;
    }
    devices.forEach((d) => {
      const row = document.createElement('div');
      row.className = 'block-row';
      const label = document.createElement('span');
      label.className = 'block-count';
      // Scope (docs/design/06 §7 presence) only means something for the LAN
      // viewer server — a view session can only watch, a control session can
      // also write, and everything else (party, phone remote) has no scopes
      // to report at all.
      const scopeSuffix = d.server === 'viewer' && d.scope ? ` (${d.scope === 'control' ? 'EDITING' : 'WATCHING'})` : '';
      label.textContent = `${SERVER_LABELS[d.server] || d.server.toUpperCase()} — ${d.ip}${scopeSuffix}`;
      row.appendChild(label);
      connectedDevicesListEl.appendChild(row);
    });
  }).catch((error) => {
    console.warn('[setup] connected devices unavailable:', error);
  }).finally(() => { connectedDevicesInFlight = false; });
  if (!connectedDevicesPollStarted) {
    connectedDevicesPollStarted = true;
    setInterval(() => {
      if (setupScreen.classList.contains('hidden')) return;
      renderConnectedDevices();
    }, CONNECTED_DEVICES_POLL_MS);
  }
}
