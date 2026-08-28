// ---------- Companion app (Settings + Files tabs, LAN-only) ----------
// Backend for the Android companion app's remote-settings editor and file
// browser. Same pairing-code + session-cookie auth as every other LAN
// service (universal-remote, the LAN viewer, party-channel) — see
// main-lan-security.js's createLanAccess, which also serves the pairing page
// itself, so this file only has to handle already-authenticated requests.
//
// Deliberately NOT "isolated": true (see manifest.json's description) — an
// isolated plugin's fs-read permission is scoped to this app's own install
// dir + the plugin's own folder (main-plugin-isolation.js's buildExecArgv),
// which can't include the user's channel folders since those live wherever
// the user's media library actually is. Running same-process instead means
// this file can use Node's real fs directly, same trust boundary every other
// same-process plugin already has (see main-plugin-capabilities.js's comment
// on createCheckedSpawn: "a same-process plugin could still require(...)
// directly and bypass this entirely" — true of fs too, not just spawn).
// Browsing is scoped in code, not by the OS, to each channel's own folder —
// see buildRoots() below.
const fs = require('fs');
const path = require('path');

const PORT = 8725;

// Same one-liner as core's main-path-safety.js, duplicated rather than
// require()'d — a plugin's on-disk location isn't stable relative to the
// app root (a packaged install seeds plugins under userData/plugins, not
// alongside main/), so a relative require('../../main/main-path-safety')
// resolves at dev time but throws "Cannot find module" once packaged. True
// if `resolved` is `base` itself or somewhere inside it; caller must pass
// already path.resolve()'d/normalize()'d paths.
function isPathContained(base, resolved) {
  return resolved === base || resolved.startsWith(base + path.sep);
}

// One root per distinct local channel folder — ch.folders[] entries are
// {id, source, ref, label} (see normalizeChannel, renderer/js/channels.js);
// `ref` IS the folder's real filesystem path for a source: 'local' entry
// (a plugin-sourced folder's ref is an opaque provider reference, not a
// path on this disk at all, so those are skipped). Deduped by resolved path
// so multiple channels sharing a folder collapse into one browsable root.
// This is the whole access-control model for the Files tab: only
// directories the user already pointed a channel at are reachable, nothing
// else on disk.
function buildRoots(config) {
  const seen = new Map(); // resolved dir -> {id, label, path}
  (config.channels || []).forEach((ch) => {
    (ch && ch.folders || []).forEach((entry) => {
      if (!entry || entry.source !== 'local' || typeof entry.ref !== 'string') return;
      const dir = path.resolve(entry.ref);
      if (seen.has(dir)) return;
      seen.set(dir, { id: String(seen.size), label: entry.label || path.basename(dir) || dir, path: dir });
    });
  });
  return [...seen.values()];
}

function resolveWithinRoot(root, relPath) {
  const rel = String(relPath || '').replace(/^[/\\]+/, '');
  const resolved = path.normalize(path.join(root.path, rel));
  if (!isPathContained(root.path, resolved)) return null;
  return resolved;
}

function listDirectory(absDir) {
  return fs.readdirSync(absDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() || entry.isDirectory())
    .map((entry) => {
      const full = path.join(absDir, entry.name);
      let size = null;
      let mtime = null;
      try {
        const stat = fs.statSync(full);
        size = entry.isFile() ? stat.size : null;
        mtime = stat.mtimeMs;
      } catch (e) { /* race with a file disappearing mid-listing — just omit stats */ }
      return { name: entry.name, isDir: entry.isDirectory(), size, mtime };
    })
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
}

// Range-aware file download, same semantics as the core LAN viewer's /media
// route — lets the companion app's file browser scrub/resume large video
// files instead of only supporting whole-file GETs.
function streamFile(absPath, req, res, mimeFor) {
  const stat = fs.statSync(absPath);
  const range = req.headers.range;
  const headers = {
    'Content-Type': mimeFor(absPath),
    'Content-Disposition': `attachment; filename="${encodeURIComponent(path.basename(absPath))}"`,
    'Accept-Ranges': 'bytes',
  };
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    const start = match && match[1] ? parseInt(match[1], 10) : 0;
    const end = match && match[2] ? parseInt(match[2], 10) : stat.size - 1;
    if (!match || start > end || end >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end();
      return;
    }
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Content-Length': end - start + 1,
    });
    fs.createReadStream(absPath, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  fs.createReadStream(absPath).pipe(res);
}

async function activate(ctx) {
  const {
    createServer, getMainWindow, trackConnection, readJsonBody, loadConfig, mimeFor,
    getLanAddresses, createLanAccess, isLanServiceEnabled,
  } = ctx;
  // Same-process plugin, so unlike an isolated plugin's proxied
  // ctx.sendToMainWindow (main-plugin-isolation.js), this talks to the real
  // window directly.
  function sendToMainWindow(channel, data) {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
  }

  const config = await loadConfig();
  if (!isLanServiceEnabled(config, 'companion')) {
    ctx.services.companionAccessUrls = [];
    return;
  }
  const access = createLanAccess('companion', { readLimit: 600, writeLimit: 60 });
  ctx.services.companionAccessUrls = getLanAddresses().map((entry) => ({
    name: entry.name, url: access.pairingUrl(`http://${entry.address}:${PORT}`),
  }));

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const kind = req.method === 'GET' ? 'read' : 'write';
    if (!(await access.authorize(req, res, url, kind))) return;
    trackConnection('companion', req);

    if (req.method === 'GET' && url.pathname === '/api/config') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        .end(JSON.stringify(await loadConfig()));
      return;
    }

    // Relayed into the renderer's in-memory config + debounced autosave
    // rather than written to disk here directly — see app.js's
    // onCompanionApplySettings and this app's config-mutation-in-place note
    // in CLAUDE.md (a same-process write here would race the renderer's own
    // unsaved edits and its next autosave could clobber this one).
    if (req.method === 'POST' && url.pathname === '/api/settings') {
      try {
        const body = await readJsonBody(req);
        if (body && body.patch && typeof body.patch === 'object') {
          sendToMainWindow('companion:applySettings', body.patch);
        }
        res.writeHead(204).end();
      } catch (e) {
        res.writeHead(400).end('Bad request');
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/roots') {
      const roots = buildRoots(await loadConfig());
      res.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify(roots.map(({ id, label }) => ({ id, label }))));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/files') {
      const roots = buildRoots(await loadConfig());
      const root = roots.find((r) => r.id === url.searchParams.get('root'));
      const resolved = root && resolveWithinRoot(root, url.searchParams.get('path') || '');
      if (!resolved) { res.writeHead(400).end('Bad request'); return; }
      try {
        const entries = listDirectory(resolved);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ entries }));
      } catch (e) {
        res.writeHead(404).end('Not found');
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/files/download') {
      const roots = buildRoots(await loadConfig());
      const root = roots.find((r) => r.id === url.searchParams.get('root'));
      const resolved = root && resolveWithinRoot(root, url.searchParams.get('path') || '');
      if (!resolved) { res.writeHead(400).end('Bad request'); return; }
      try {
        if (!fs.statSync(resolved).isFile()) { res.writeHead(400).end('Not a file'); return; }
        streamFile(resolved, req, res, mimeFor);
      } catch (e) {
        if (!res.headersSent) res.writeHead(404).end('Not found');
        else res.destroy();
      }
      return;
    }

    res.writeHead(404).end('Not found');
  });

  server.on('error', (err) => {
    console.error(`Companion app server failed to start on port ${PORT}:`, err.message);
  });
  server.listen(PORT, '0.0.0.0');
}

module.exports = { activate };
