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
// sync. The server is opt-in and every request is authenticated through a
// short host-visible pairing code before any config, plugin, or media bytes
// leave the machine.
const path = require('path');
const http = require('http');
const { loadConfig } = require('./main-config');
const { serveFile, serveMediaRef, pipeWebResponse } = require('./main-protocol');
const { trackConnection } = require('./main-connections');
const { VIEWER_PORT } = require('./main-lan');
const { isPathContained } = require('./main-path-safety');
const { createLanAccess } = require('./main-lan-security');
const { sanitizeViewerConfig, createViewerProjection } = require('./main-viewer-projection');
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
function startViewerServer(pluginServices, pluginRuntime = {}) {
  const services = pluginServices || {};
  const pluginsDir = pluginRuntime.pluginsDir || null;
  const access = pluginRuntime.access || createLanAccess('viewer', { readLimit: 1200, writeLimit: 30 });
  const projection = pluginRuntime.projection || createViewerProjection();
  const loadViewerConfig = pluginRuntime.loadConfig || loadConfig;
  const port = pluginRuntime.port === undefined ? VIEWER_PORT : pluginRuntime.port;
  const host = pluginRuntime.host || '0.0.0.0';
  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch (e) {
      // An unhandled throw here (a malformed URL/Range header, an fs error
      // that slips past serveFile's own catch, etc.) would otherwise become
      // an unhandled promise rejection with the LAN client left hanging on
      // a response that never comes — respond with a clean 500 instead.
      if (!res.headersSent) res.writeHead(500).end('Internal error');
      else res.destroy();
    }
  });

  async function handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (!(await access.authorize(req, res, url, 'read'))) return;
    if (req.method !== 'GET') {
      res.writeHead(405).end('Method not allowed');
      return;
    }
    trackConnection('viewer', req);
    const range = req.headers.range;

    if (url.pathname === '/api/config') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        .end(JSON.stringify(projection.project(loadViewerConfig())));
      return;
    }

    if (url.pathname === '/api/version') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ version: APP_VERSION }));
      return;
    }

    if (url.pathname === '/api/plugins') {
      const plugins = typeof pluginRuntime.listPlugins === 'function'
        ? pluginRuntime.listPlugins()
        : [];
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(plugins));
      return;
    }

    if (url.pathname === '/api/media-name') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        .end(JSON.stringify({ name: projection.name(url.searchParams.get('id')) }));
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
    // serveMediaRef() (dispatches to a media-source plugin's readRange for a
    // mediasource:<id>:... ref, same as the app:// version, so a LAN viewer
    // watching a plugin-sourced channel streams correctly too — not just
    // the main window). Unlike the app:// version (only ever reachable from
    // this app's own sandboxed renderer), this is a plain LAN HTTP endpoint
    // The browser never receives `p` or another host/provider reference.
    // Only ids registered while projecting the authenticated config resolve.
    if (url.pathname === '/media') {
      const target = projection.resolve(url.searchParams.get('id'));
      if (!target) { res.writeHead(400).end('Bad request'); return; }
      await pipeWebResponse(await serveMediaRef(target, range), res);
      return;
    }

    if (pluginsDir && url.pathname.startsWith('/plugins/')) {
      const rel = decodeURIComponent(url.pathname.slice('/plugins/'.length));
      const resolved = path.normalize(path.join(pluginsDir, rel));
      if (!isPathContained(pluginsDir, resolved)) {
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
    if (!isPathContained(RENDERER_DIR, resolved)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    await pipeWebResponse(await serveFile(resolved, range), res);
  }

  server.on('error', (err) => {
    // Don't crash the app if the port's taken (e.g. a second instance) —
    // LAN viewers just won't be reachable this run.
    console.error(`LAN viewer server failed to start on port ${VIEWER_PORT}:`, err.message);
  });
  server.listen(port, host);
  return { server, access, projection };
}

module.exports = { startViewerServer, sanitizeViewerConfig, createViewerProjection };
