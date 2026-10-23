const os = require('os');
const { handoffInfo, saveRemoteProfile } = require('./tv-client');

// LAN-facing server ports — the single source of truth, imported by main.js
// for the actual server.listen() call as well as the URL getter below.
// Companion App's own port (8725, covering remote control + settings +
// files) is NOT here — a plugin can't reliably require() core files by
// relative path once packaged, so plugins/companion-app/main.js hardcodes
// it itself (see that file's isPathContained comment for why), same as
// main-discovery-server.js's own COMPANION_PORT constant.
const VIEWER_PORT = 8724;

// A real machine commonly has several non-internal IPv4 adapters at once —
// VPNs (Tailscale, NordLynx/WireGuard), virtual switches (VirtualBox,
// VMware, Hyper-V), and the actual WiFi/Ethernet a phone on the same LAN
// could reach. "First non-internal" isn't reliable — confirmed on a real
// dev machine where a Tailscale link-local address (169.254.x.x, never
// phone-reachable) enumerated before the real 192.168.x.x WiFi address.
// Rather than guess which single adapter is "the" LAN, filter out what's
// definitely *not* usable (link-local, and adapter names that are obviously
// VPN/virtual by convention) and return every remaining candidate so the
// setup screen can show them all — the user recognizes their own WiFi name.
const NON_LAN_ADAPTER_NAME = /vpn|tailscale|nordlynx|wireguard|zerotier|hyper-v|virtualbox|vmware|loopback|utun|tap\d|tun\d/i;
// Name-based filtering above misses a virtual adapter Windows has renamed to
// something generic ("Ethernet 2", "Ethernet 3", ...) — confirmed live: a
// VirtualBox Host-Only Network adapter showed up as bare "Ethernet 2" (no
// "virtualbox" in the name at all) alongside the real WiFi, which broke
// mDNS/Zeroconf-based device discovery for a plugin that passes every
// address this returns to its own advertising step. The MAC vendor prefix
// (OUI) is a much more reliable signal than the adapter's display name,
// since virtualization software can't rename that away — VirtualBox's is
// 08:00:27 (or the locally-administered variant 0a:00:27, seen on the
// machine that hit this), VMware's are 00:0c:29/00:50:56/00:05:69, Hyper-V's
// default switch is 00:15:5d, Parallels' is 00:1c:42.
const NON_LAN_MAC_OUI = /^(08:00:27|0a:00:27|00:0c:29|00:50:56|00:05:69|00:15:5d|00:1c:42)/i;
function getLanAddresses() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(nets)) {
    if (NON_LAN_ADAPTER_NAME.test(name)) continue;
    for (const net of nets[name]) {
      if (net.family !== 'IPv4' || net.internal) continue;
      if (net.address.startsWith('169.254.')) continue; // link-local, never phone-reachable
      if (net.mac && NON_LAN_MAC_OUI.test(net.mac)) continue;
      candidates.push({ name, address: net.address });
    }
  }
  return candidates;
}
function getViewerUrls() {
  return getLanAddresses().map((c) => ({ name: c.name, url: `http://${c.address}:${VIEWER_PORT}` }));
}

// viewer:getUrl and companion:getUrl both just expose a boot-populated URL
// list back to the renderer — the lists themselves (viewerAccessUrls,
// pluginServicesRef.companionAccessUrls) live as reassignable `let`s in
// main.js, populated inside app.whenReady() well after this handler is
// registered, so accessor functions (not the current value) are what main.js
// hands over here — see CLAUDE.md's registerXIpc note on stale closures.
function registerLanIpc(ipcMain, { getViewerAccessUrls, getViewerControlAccessUrls, getCompanionAccessUrls, getUserDataDir, QRCode }) {
  ipcMain.handle('viewer:getUrl', async () => getViewerAccessUrls());
  // The control pairing code (docs/design/06 §4), for the setup screen's
  // Network services panel — previously visible only on the loopback
  // /server page. getViewerControlAccessUrls is optional so a caller that
  // predates it (there isn't one, but future main-process test doubles
  // might be) degrades to an empty list rather than throwing.
  ipcMain.handle('viewer:getControlUrl', async () => (getViewerControlAccessUrls ? getViewerControlAccessUrls() : []));

  // TV clients (docs/design/01, main-tv-client.js): a Remote-test capture
  // saved under userData/remote-profiles, and the phone/computer handoff.
  ipcMain.handle('tvClient:saveRemoteProfile', async (_event, profile) => saveRemoteProfile(getUserDataDir(), profile));
  // Prefer a control-scope viewer link (docs/design/06 §4) — it already
  // carries a one-time pairing code, so scanning it opens straight into an
  // editable setup screen instead of the Companion page's more limited
  // settings relay. Falls back to Companion when the viewer/control service
  // isn't up (viewer access off, or this build predates it).
  ipcMain.handle('tvClient:getHandoffInfo', async (_event, opts) => {
    const controlUrls = getViewerControlAccessUrls ? getViewerControlAccessUrls() : [];
    if (controlUrls.length) return handoffInfo(controlUrls, QRCode, { ...(opts || {}), writable: true });
    return handoffInfo(getCompanionAccessUrls(), QRCode, opts || {});
  });

  // Companion app (remote control + Settings + Files, all merged into one
  // plugin/port — see plugins/companion-app/main.js), same pattern as
  // viewer:getUrl above.
  // Each candidate also carries a QR of its pairing link for the setup panel; a
  // failed render leaves qrDataUrl empty (the URL and code still work).
  ipcMain.handle('companion:getUrl', async () => Promise.all((getCompanionAccessUrls() || []).map(async (c) => {
    let qrDataUrl = '';
    try { qrDataUrl = await QRCode.toDataURL(c.url, { margin: 1, width: 240 }); } catch (e) { /* text link still works */ }
    return { ...c, qrDataUrl };
  })));
}

module.exports = {
  VIEWER_PORT,
  getLanAddresses, getViewerUrls, registerLanIpc,
};
