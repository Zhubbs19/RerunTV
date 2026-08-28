const os = require('os');

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
function getLanAddresses() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(nets)) {
    if (NON_LAN_ADAPTER_NAME.test(name)) continue;
    for (const net of nets[name]) {
      if (net.family !== 'IPv4' || net.internal) continue;
      if (net.address.startsWith('169.254.')) continue; // link-local, never phone-reachable
      candidates.push({ name, address: net.address });
    }
  }
  return candidates;
}
function getViewerUrls() {
  return getLanAddresses().map((c) => ({ name: c.name, url: `http://${c.address}:${VIEWER_PORT}` }));
}

module.exports = {
  VIEWER_PORT,
  getLanAddresses, getViewerUrls,
};
