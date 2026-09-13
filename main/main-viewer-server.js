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
const crypto = require('crypto');
const { loadConfig } = require('./main-config');
const { serveFile, serveMediaRef, pipeWebResponse } = require('./main-protocol');
const { trackConnection } = require('./main-connections');
const { VIEWER_PORT } = require('./main-lan');
const { isPathContained } = require('./main-path-safety');
const { createLanAccess, requestIp } = require('./main-lan-security');
const { sanitizeViewerConfig, createViewerProjection } = require('./main-viewer-projection');
const { version: APP_VERSION } = require('../package.json');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const VIEWER_REMOTE_EVENT_LIMIT = 128;
const VIEWER_REMOTE_CHANNELS = new Set([
  'remote:command',
  'remote:tune',
  'remote:setChannelFlag',
  'companion:configChanged',
  // The host wrote a config change a viewer would see (config-host.js's
  // change announcer). Carries no data; the viewer refetches /api/config.
  'config:changed',
  // Companion app's party/alerts relays (plugins/companion-app/main.js).
  // In headless/server mode there's no mainWindow to receive these over
  // IPC at all — a paired LAN viewer is the only possible display, so
  // these must also be publishable to the viewer bridge, not just
  // whitelisted for the (host-only, in normal mode) mainWindow path.
  'party:reaction',
  'party:triggerTrivia',
  'companion:triggerNews',
  'companion:setTicker',
]);

function readJsonBody(req, maxBytes = 8192) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function createViewerRemoteBridge() {
  let latestState = { number: null, name: null };
  let sequence = 0;
  const events = [];
  return {
    publish(channel, data) {
      if (!VIEWER_REMOTE_CHANNELS.has(channel)) return false;
      sequence += 1;
      events.push({ sequence, channel, data });
      if (events.length > VIEWER_REMOTE_EVENT_LIMIT) events.shift();
      return true;
    },
    updateState(state) {
      if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
      latestState = { ...state };
      return true;
    },
    getState: () => ({ ...latestState }),
    read(after) {
      const hasCursor = after !== null && after !== undefined && after !== '';
      const cursor = Number(after);
      return {
        cursor: sequence,
        events: hasCursor && Number.isSafeInteger(cursor)
          ? events.filter((event) => event.sequence > cursor)
          : [],
      };
    },
  };
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function isLoopbackRequest(req) {
  const ip = requestIp(req);
  return ip === '::1' || ip === '127.0.0.1' || ip.startsWith('127.')
    || ip.startsWith('::ffff:127.');
}

function controlPage({ access, state, controlToken, canStop }) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const viewerUrls = Array.isArray(state.viewerUrls) ? state.viewerUrls : [];
  const companionUrls = Array.isArray(state.companionUrls) ? state.companionUrls : [];
  const linkRows = viewerUrls.map((entry) => `
    <a class="url-card" href="${escapeHtml(entry.url)}" target="_blank" rel="noopener">
      <strong>${escapeHtml(entry.name || 'Network adapter')}</strong><span>${escapeHtml(entry.url)}</span>
    </a>`).join('') || '<p class="muted">No LAN adapter is currently available.</p>';
  const companionRows = companionUrls.map((entry) => `
    <a class="url-card compact" href="${escapeHtml(entry.url)}" target="_blank" rel="noopener">
      <strong>${escapeHtml(entry.name || 'Companion')}</strong><span>${escapeHtml(entry.url)}</span>
    </a>`).join('');
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'">
<title>RerunTV Server</title><style>
:root{color-scheme:dark;font-family:Inter,Segoe UI,system-ui,sans-serif;background:#050913;color:#f4f7ff}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 50% 0,#182d5b 0,#081124 42%,#03060d 100%)}
main{width:min(760px,calc(100% - 32px));margin:0 auto;padding:42px 0 64px}.eyebrow{color:#63d9f5;font:800 12px/1.2 monospace;letter-spacing:.2em}
h1{margin:8px 0 4px;color:#ffd447;font:900 clamp(34px,7vw,58px)/1 'Arial Narrow',sans-serif;letter-spacing:.06em;text-shadow:3px 3px #02040a}
.status{display:inline-flex;align-items:center;gap:8px;margin:10px 0 28px;color:#9ff3b0;font-weight:800}.dot{width:10px;height:10px;border-radius:50%;background:#42dc71;box-shadow:0 0 14px #42dc71}
.panel{margin:14px 0;padding:22px;background:linear-gradient(180deg,#152b59,#0b1936);border:1px solid #345486;box-shadow:3px 3px #02050b}
h2{margin:0 0 10px;color:#f4f7ff;font:800 18px/1.2 'Arial Narrow',sans-serif;letter-spacing:.08em}.pair{display:flex;align-items:center;justify-content:space-between;gap:20px}
.code{color:#ffd447;font:900 clamp(34px,8vw,56px)/1 monospace;letter-spacing:.16em}.muted{color:#aebbd4;line-height:1.55}.url-card{display:block;margin-top:10px;padding:14px 16px;color:#fff;text-decoration:none;background:#07152f;border:2px solid #416ba1}
.url-card:hover,.url-card:focus{color:#07111f;background:#ffd447;border-color:#fff;outline:3px solid #63d9f5}.url-card strong,.url-card span{display:block}.url-card span{margin-top:4px;font:600 13px/1.35 monospace;overflow-wrap:anywhere}.compact{padding:10px 14px}
.steps{margin:0;padding-left:22px;color:#d9e1f1;line-height:1.65}button{width:100%;min-height:52px;margin-top:12px;color:#fff;background:#8b2530;border:2px solid #ff6b72;font:800 16px monospace;letter-spacing:.08em;cursor:pointer}
button:hover,button:focus{background:#cf3442;outline:3px solid #fff}.stopped{color:#ffd447;font-weight:800}@media(max-width:560px){main{padding-top:24px}.panel{padding:17px}.pair{align-items:flex-start;flex-direction:column}}
</style></head><body><main><div class="eyebrow">HEADLESS VIEWER CONTROL</div><h1>RERUNTV SERVER</h1><div class="status"><span class="dot"></span>ONLINE // PORT ${VIEWER_PORT}</div>
<section class="panel"><div class="pair"><div><h2>TV PAIRING CODE</h2><p class="muted">Enter this once when the Android TV viewer asks to pair.</p></div><div class="code">${escapeHtml(access.pairingCode)}</div></div></section>
<section class="panel"><h2>CONNECT THE ANDROID TV APP</h2><ol class="steps"><li>Open RerunTV on the TV.</li><li>Choose SCAN. The headless server is advertised automatically.</li><li>Press CONNECT, then enter the pairing code above.</li></ol></section>
<section class="panel"><h2>VIEWER ADDRESSES</h2>${linkRows}</section>
${companionRows ? `<section class="panel"><h2>COMPANION / REMOTE</h2>${companionRows}</section>` : ''}
${canStop ? '<section class="panel"><h2>SERVER POWER</h2><p class="muted">Stops playback and disconnects every viewer cleanly.</p><button id="stop" type="button">STOP RERUNTV SERVER</button><p id="stop-status" class="stopped" hidden>Server is stopping. You may close this page.</p></section>' : ''}
</main>${canStop ? `<script nonce="${nonce}">document.getElementById('stop').addEventListener('click',async()=>{const b=document.getElementById('stop');b.disabled=true;b.textContent='STOPPING…';try{await fetch('/server/stop',{method:'POST',headers:{'X-RerunTV-Control':'${controlToken}'}});document.getElementById('stop-status').hidden=false}catch(e){b.disabled=false;b.textContent='STOP RERUNTV SERVER'}});</script>` : ''}</body></html>`;
}

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
  const remoteBridge = services.viewerRemoteBridge || createViewerRemoteBridge();
  services.viewerRemoteBridge = remoteBridge;
  const pluginsDir = pluginRuntime.pluginsDir || null;
  const access = pluginRuntime.access || createLanAccess('viewer', { readLimit: 1200, writeLimit: 30 });
  const projection = pluginRuntime.projection || createViewerProjection();
  const loadViewerConfig = pluginRuntime.loadConfig || loadConfig;
  const port = pluginRuntime.port === undefined ? VIEWER_PORT : pluginRuntime.port;
  const host = pluginRuntime.host || '0.0.0.0';
  const controlToken = crypto.randomBytes(32).toString('base64url');
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
    // A small server dashboard for the PC that launched headless mode. It
    // deliberately bypasses viewer pairing only for loopback sockets; LAN
    // clients receive a plain 404 and cannot learn the pairing code or stop
    // the process. The stop request also needs an unguessable page-embedded
    // header, so an unrelated local webpage cannot submit it cross-origin.
    if (url.pathname === '/server' || url.pathname === '/server/stop') {
      if (!isLoopbackRequest(req)) { res.writeHead(404).end('Not found'); return; }
      if (url.pathname === '/server' && req.method === 'GET') {
        const state = typeof pluginRuntime.getControlState === 'function'
          ? pluginRuntime.getControlState() : {};
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Frame-Options': 'DENY',
          'X-Content-Type-Options': 'nosniff',
        }).end(controlPage({
          access, state, controlToken,
          canStop: typeof pluginRuntime.requestStop === 'function',
        }));
        return;
      }
      if (url.pathname === '/server/stop' && req.method === 'POST'
          && req.headers['x-reruntv-control'] === controlToken
          && typeof pluginRuntime.requestStop === 'function') {
        res.writeHead(202, { 'Content-Type': 'application/json' }).end('{"stopping":true}');
        setImmediate(pluginRuntime.requestStop);
        return;
      }
      res.writeHead(405).end('Method not allowed');
      return;
    }
    const requestKind = req.method === 'GET' ? 'read' : 'write';
    if (!(await access.authorize(req, res, url, requestKind))) return;

    // In headless mode there is no Electron renderer to connect the PC-side
    // Companion service to what is playing. The authenticated TV viewer
    // reports its state here, and polls the sibling event route for remote
    // commands queued by that Companion service through viewerRemoteBridge.
    if (url.pathname === '/api/remote-state' && req.method === 'POST') {
      try {
        const state = await readJsonBody(req);
        if (!remoteBridge.updateState(state)) { res.writeHead(400).end('Bad request'); return; }
        res.writeHead(204, { 'Cache-Control': 'no-store' }).end();
      } catch (e) {
        if (!res.writableEnded) res.writeHead(400).end('Bad request');
      }
      return;
    }

    if (url.pathname === '/api/remote-events' && req.method === 'GET') {
      const result = remoteBridge.read(url.searchParams.has('after') ? url.searchParams.get('after') : null);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        .end(JSON.stringify(result));
      return;
    }

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
  // Explicit values instead of relying on Node's built-in defaults — this is
  // a LAN-facing server, and elsewhere in this subsystem (readFormBody's
  // 1024-byte cap, main-lan-security.js's rate limits) request/response
  // bounds are deliberate, not incidental. headersTimeout/requestTimeout
  // only bound how long a client can take to SEND a request — they don't
  // apply to how long a response takes to stream out, so a long-lived Range
  // video stream to an actively-watching viewer is unaffected. maxConnections
  // caps concurrent sockets against a connection-flood DoS; 200 is far more
  // than any real home LAN's simultaneous viewer/API traffic needs.
  server.headersTimeout = 15000;
  server.requestTimeout = 30000;
  server.maxConnections = 200;
  const ready = new Promise((resolve) => {
    server.once('listening', () => resolve(true));
    server.once('error', () => resolve(false));
  });
  server.listen(port, host);
  return { server, access, projection, ready };
}

module.exports = { startViewerServer, sanitizeViewerConfig, createViewerProjection, createViewerRemoteBridge };
