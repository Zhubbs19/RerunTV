// Host-only fallback for streaming media-source-plugin content into the
// main window when the LAN viewer service is off.
//
// path:toFileUrl (main-media-dispatch.js) routes a mediaSource-plugin ref
// through a real loopback http.Server rather than Electron's app://
// protocol.handle, because Chromium's <video> element was found to never
// issue a follow-up Range request through app://media for a plugin-backed
// resource (see that file's own comment for the full story) — a real HTTP
// connection doesn't have that problem. Before this file existed, the only
// such server in the process was main-viewer-server.js's LAN viewer, which
// only starts when the user has explicitly turned on network.viewerEnabled
// — so a mediaSource channel (gdrive, or any other provider) would silently
// fail to play in the host window on a totally default config, for a
// reason ("turn on LAN viewer access") that has nothing to do with LAN
// viewing at all.
//
// This server exists purely to close that gap: it's the same /media route
// (same serveMediaRef dispatch, same createViewerProjection id scheme) but
// bound to 127.0.0.1 only, on an OS-assigned ephemeral port, with no
// pairing/session auth — main-lan-security.js's pairing flow exists to
// gate a service reachable from other devices on the LAN, which this
// never is. Only main.js's own host window (via the id this module itself
// mints, never guessable ahead of time) ever talks to it. main.js starts
// this instead of the real LAN viewer server when network.viewerEnabled is
// off, and uses the real LAN viewer's own server (and its already-public
// port) for this exact purpose when it's on — see main.js's whenReady.
const http = require('http');
const { serveMediaRef, pipeWebResponse } = require('./protocol');
const { createViewerProjection } = require('../lan/viewer-projection');

function startMediaBridge() {
  const projection = createViewerProjection();
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method !== 'GET' || url.pathname !== '/media') {
        res.writeHead(404).end('Not found');
        return;
      }
      const target = projection.resolve(url.searchParams.get('id'));
      if (!target) { res.writeHead(400).end('Bad request'); return; }
      await pipeWebResponse(await serveMediaRef(target, req.headers.range), res);
    } catch (e) {
      // Same rationale as main-viewer-server.js's own top-level catch: don't
      // let a malformed request turn into an unhandled rejection with the
      // host window's <video> element left hanging on a response that never
      // arrives.
      if (!res.headersSent) res.writeHead(500).end('Internal error');
      else res.destroy();
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Port 0 = let the OS pick a free ephemeral port — this server is never
    // advertised anywhere (no QR code, no LAN discovery entry), so there's
    // no fixed port for another device or process to need in advance.
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      server.on('error', (err) => {
        console.error('Internal media bridge server error:', err.message);
      });
      resolve({ server, port: server.address().port, projection });
    });
  });
}

module.exports = { startMediaBridge };
