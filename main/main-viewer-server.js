// ---------- LAN viewer (Jellyfin-style multi-device watching) ----------
// A LAN-facing server, independent from the remote-control server, that
// serves the *entire renderer bundle* to any browser on the network — not
// just button-press relaying. A connecting device becomes a second, fully
// independent instance of the same renderer code (see
// renderer/js/browser-api-shim.js, loaded only when Electron's own
// preload-provided window.api isn't present), computing its own live
// schedule state from the same config rather than the host proxying
// frames/decisions to it — so every existing feature (breaks, bumpers, CRT
// effects, time machine) works identically with nothing new to keep in
// sync. Always starts, no separate enable toggle — same "no auth in v1,
// LAN trust model" as the remote server (anyone on the LAN can watch, same
// as anyone who could pick up a physical remote).
const path = require('path');
const http = require('http');
const { loadConfig } = require('./main-config');
const { serveFile, pipeWebResponse } = require('./main-protocol');
const { trackConnection } = require('./main-connections');
const { VIEWER_PORT } = require('./main-lan');
const { LAN_MEDIA_EXTENSIONS } = require('./main-media');
const { version: APP_VERSION } = require('../package.json');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');

// `pluginServices` is the same shared, mutated-in-place object every
// plugin's ctx.services already is (see main-plugins.js) — core has no
// business knowing which plugin, if any, wants to offer a "watch live"
// link on the LAN viewer page, so it just reads whatever's published under
// this one generic key instead of calling a party-specific URL builder
// directly. This server starts (see main.js's app.whenReady()) before
// loadMainPlugins() has run, but that's fine: the object reference is
// captured once here and read fresh on every actual request, which only
// ever arrives well after boot has finished populating it.
function startViewerServer(pluginServices) {
  const services = pluginServices || {};
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405).end('Method not allowed');
      return;
    }
    trackConnection('viewer', req);
    const url = new URL(req.url, `http://${req.headers.host}`);
    const range = req.headers.range;

    if (url.pathname === '/api/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(loadConfig()));
      return;
    }

    if (url.pathname === '/api/version') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ version: APP_VERSION }));
      return;
    }

    // Cross-link to whatever plugin (if any) published a "watch live"
    // link — a viewer already has the whole config via /api/config above,
    // so it knows locally whether that plugin's feature is even enabled;
    // this just supplies the URL to link to when it is.
    if (url.pathname === '/api/viewer-live-link') {
      const urls = services.viewerLiveLinkUrls || [];
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ urls }));
      return;
    }

    // Same semantics as the app://media/?p=... handler in
    // registerAppProtocol — just reachable over the LAN port instead of
    // only Electron's internal scheme, reusing the exact same Range-aware
    // serveFile(). Unlike the app:// version (only ever reachable from this
    // app's own sandboxed renderer), this is a plain LAN HTTP endpoint with
    // no auth — any device on the network can request any `p`. Restricted to
    // known media extensions so it can only ever be used to read the same
    // kinds of files this app itself points channels/icons/audio at, not
    // arbitrary files on the host (channels.json, OS files, etc.).
    if (url.pathname === '/media') {
      const target = url.searchParams.get('p');
      if (!target) { res.writeHead(400).end('Bad request'); return; }
      const resolved = path.normalize(decodeURIComponent(target));
      if (!LAN_MEDIA_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      await pipeWebResponse(await serveFile(resolved, range), res);
      return;
    }

    // Everything else is a static asset out of renderer/ (index.html, the
    // JS modules, CSS, fonts) — same containment check as every other
    // static handler in this file, keeping requests from escaping
    // renderer/ via ../.
    const rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const resolved = path.normalize(path.join(RENDERER_DIR, rel));
    if (resolved !== RENDERER_DIR && !resolved.startsWith(RENDERER_DIR + path.sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    await pipeWebResponse(await serveFile(resolved, range), res);
  });

  server.on('error', (err) => {
    // Don't crash the app if the port's taken (e.g. a second instance) —
    // LAN viewers just won't be reachable this run.
    console.error(`LAN viewer server failed to start on port ${VIEWER_PORT}:`, err.message);
  });
  server.listen(VIEWER_PORT, '0.0.0.0');
}

module.exports = { startViewerServer };
