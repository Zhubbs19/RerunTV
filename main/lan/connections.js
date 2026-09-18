// ---------- Connected-device tracking (host visibility) ----------
// The remote/viewer/party servers are all plain stateless HTTP — there's no
// persistent connection to count, just requests. A device counts as
// "connected" if it's made a request recently; the viewer/party pages both
// poll on their own (config poll, queue poll) every several seconds while
// open, so a device that's genuinely still there keeps refreshing its own
// entry, and one that's gone (tab closed, phone locked) ages out on its own
// without needing an explicit disconnect signal.
const CONNECTION_STALE_MS = 30 * 1000;
const connectedDevices = new Map(); // key: `${server}:${ip}` -> {server, ip, lastSeenMs, userAgent}

// Split out from trackConnection() so an isolated plugin's own process (which
// has a real `req` but no shared connectedDevices Map of its own) can relay
// just the two plain fields that matter, over RPC, instead of the req object
// itself — see main-plugin-isolation.js's 'trackConnection' handler.
//
// scope ('view'/'control'/'') is optional and only meaningful for the LAN
// viewer server (docs/design/06 §7 presence) — every other caller either has
// no scopes at all (party, the phone remote) or omits it, and a device's
// entry keeps whatever scope its most recent request carried, so a control
// session's still-open GETs (media, config) don't demote it back to blank
// between its writes.
function recordConnection(serverName, ip, userAgent, scope) {
  const key = `${serverName}:${ip}`;
  const previous = connectedDevices.get(key);
  connectedDevices.set(key, {
    server: serverName, ip, lastSeenMs: Date.now(), userAgent: userAgent || '',
    scope: scope || (previous && previous.scope) || '',
  });
}

function trackConnection(serverName, req, scope) {
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  recordConnection(serverName, ip, req.headers['user-agent'] || '', scope);
}

function getConnectedDevices() {
  const now = Date.now();
  const out = [];
  for (const [key, device] of connectedDevices) {
    if (now - device.lastSeenMs > CONNECTION_STALE_MS) { connectedDevices.delete(key); continue; }
    out.push(device);
  }
  return out.sort((a, b) => b.lastSeenMs - a.lastSeenMs);
}

function registerConnectionsIpc(ipcMain) {
  ipcMain.handle('network:getConnections', async () => getConnectedDevices());
}

module.exports = {
  trackConnection, recordConnection, getConnectedDevices, registerConnectionsIpc,
};
