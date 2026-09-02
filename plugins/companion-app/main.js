// ---------- Companion app (Settings + Files + Remote, LAN-only) ----------
// Single backend for the Android companion app AND a plain phone-browser
// remote (remote/, no app install needed) — formerly two separate plugins
// (this one, and universal-remote) with two ports and two pairings; merged
// into one so a device only ever has to pair once. Everything below
// /command, /tune, /channel/flag, /party/trivia/start, /reaction, /state,
// GET /channels, and the remote/ static page is migrated near-verbatim from
// universal-remote/main.js (now deleted) — same routes, same IPC channels
// ('remote:command'/'remote:tune'/'remote:setChannelFlag'/
// 'party:triggerTrivia'/'party:reaction'/'remote:state'), so app.js's
// existing onRemoteCommand/onRemoteTune/onRemoteSetChannelFlag/
// onPartyTriggerTrivia listeners needed no changes at all.
// Same pairing-code + session-cookie auth as every other LAN service — see
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
const REMOTE_DIR = path.join(__dirname, 'remote');
// Cached, not persisted — just enough for the remote page's "NOW WATCHING"
// readout, pushed from the renderer whenever it tunes (see tuneToChannel,
// playback.js).
let latestRemoteState = { number: null, name: null };

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

// Same regex/behavior as core's main-viewer-projection.js's
// sanitizeViewerConfig, duplicated for the same packaged-path reason as
// isPathContained above. Unlike the anonymous LAN viewer, a paired companion
// device is trusted with real channel folder paths (its own Files tab and
// Settings editor need them). Credential fields keep their shape but their
// current values are redacted, allowing replacement without sending an
// existing secret back over the LAN.
const SENSITIVE_CONFIG_KEY = /(?:api.?key|token|secret|password|credential|auth)/i;
function redactSensitiveShape(value) {
  if (Array.isArray(value)) return value.map(redactSensitiveShape);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactSensitiveShape(child)]));
  }
  return null;
}
function sanitizeSensitiveConfig(value) {
  if (Array.isArray(value)) return value.map(sanitizeSensitiveConfig);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .map(([key, child]) => [key, SENSITIVE_CONFIG_KEY.test(key)
      ? redactSensitiveShape(child)
      : sanitizeSensitiveConfig(child)]));
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

// A device that's already entered the pairing code once stays paired across
// restarts (see main-lan-security.js's opts.sessionsFile/opts.sessionTtlMs)
// — 90 days, not the module's short un-persisted default, since the whole
// point of persisting is not asking again for as long as the phone still
// has the box on its LAN.
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

async function activate(ctx) {
  const {
    ipcMain, createServer, getMainWindow, trackConnection, readJsonBody, serveStatic, loadConfig, mimeFor,
    getLanAddresses, createLanAccess, isLanServiceEnabled, getInstalledThemes,
  } = ctx;
  // Same-process plugin, so unlike an isolated plugin's proxied
  // ctx.sendToMainWindow (main-plugin-isolation.js), this talks to the real
  // window directly.
  function sendToMainWindow(channel, data) {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send(channel, data);
      return true;
    }
    // A headless process has no Electron renderer. Route core remote events
    // through the paired LAN viewer instead, where browser-api-shim.js polls
    // and dispatches them into the same app.js listeners.
    const bridge = ctx.services.viewerRemoteBridge;
    return !!(bridge && typeof bridge.publish === 'function' && bridge.publish(channel, data));
  }

  function currentRemoteState() {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      return latestRemoteState;
    }
    const bridge = ctx.services.viewerRemoteBridge;
    return bridge && typeof bridge.getState === 'function' ? bridge.getState() : latestRemoteState;
  }
  // Not a hard dependency (this plugin works fully without it) — just
  // published by the party-channel plugin onto ctx.services if that one's
  // also installed+enabled, so /reaction's allowlist matches the party
  // page's own. manifest.json's dependsOn only affects load *order* (so
  // this read sees it if present), not whether this plugin can activate
  // without it.
  const partyReactionEmoji = ctx.services.partyReactionEmoji || null;

  ipcMain.on('remote:state', (event, state) => {
    latestRemoteState = state && typeof state === 'object' ? state : { number: null, name: null };
  });

  const config = await loadConfig();
  if (!isLanServiceEnabled(config, 'companion')) {
    ctx.services.companionAccessUrls = [];
    return;
  }
  const access = createLanAccess('companion', {
    readLimit: 600, writeLimit: 60,
    sessionsFile: path.join(ctx.fs.dataDir, 'sessions.json'),
    sessionTtlMs: SESSION_TTL_MS,
  });
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
        .end(JSON.stringify(sanitizeSensitiveConfig(await loadConfig())));
      return;
    }

    // Installed theme-pack ids/labels, for the companion app's theme picker
    // to render a real dropdown instead of free text — see
    // preload.js's reportInstalledThemes / renderer/js/plugins.js's
    // reportInstalledThemes for how this gets kept current. Can be empty
    // (nothing pushed yet — e.g. the renderer hasn't finished its first
    // plugin load), in which case the app falls back to a text field.
    if (req.method === 'GET' && url.pathname === '/api/themes') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        .end(JSON.stringify(getInstalledThemes ? getInstalledThemes() : []));
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
        if (!body || !body.patch || typeof body.patch !== 'object' || Array.isArray(body.patch)) {
          res.writeHead(400).end('A settings patch object is required');
          return;
        }
        if (!sendToMainWindow('companion:applySettings', body.patch)) {
          res.writeHead(503).end('RerunTV is not ready to apply settings');
          return;
        }
        // The renderer owns the live in-memory config and queues its normal
        // autosave immediately. 202 accurately describes that handoff; the
        // previous unconditional 204 claimed success even when there was no
        // renderer window to receive the change.
        res.writeHead(202).end();
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

    // ---- Remote control (migrated from universal-remote/main.js) ----

    if (req.method === 'POST' && url.pathname === '/command') {
      try {
        const body = await readJsonBody(req);
        if (body?.action === 'watch-tv') {
          sendToMainWindow('remote:command', { action: 'watch-tv' });
        } else if (body && typeof body.key === 'string') {
          sendToMainWindow('remote:command', {
            key: body.key,
            shift: !!body.shift,
            ctrl: !!body.ctrl,
            alt: !!body.alt,
          });
        }
        res.writeHead(204).end();
      } catch (e) {
        res.writeHead(400).end('Bad request');
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/state') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        .end(JSON.stringify(currentRemoteState()));
      return;
    }

    // Direct channel jump for the companion app's quick-tap grid (party
    // channel, public-access channel, etc.) — unlike /command's digit keys,
    // this tunes immediately with no entry-buffer debounce, since the app
    // already knows the exact channel number.
    if (req.method === 'POST' && url.pathname === '/tune') {
      try {
        const body = await readJsonBody(req);
        if (body && Number.isFinite(body.number)) {
          sendToMainWindow('remote:tune', { number: body.number });
        }
        res.writeHead(204).end();
      } catch (e) {
        res.writeHead(400).end('Bad request');
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/reaction') {
      try {
        const body = await readJsonBody(req);
        const emoji = body && body.emoji;
        if (!partyReactionEmoji || typeof emoji !== 'string' || !partyReactionEmoji.includes(emoji)) {
          res.writeHead(400).end('Bad request');
          return;
        }
        sendToMainWindow('party:reaction', { emoji });
        res.writeHead(204).end();
      } catch (e) {
        res.writeHead(400).end('Bad request');
      }
      return;
    }

    // Channel list for the companion app's quick-tap grid and channel
    // editor — read straight from disk (same tradeoff as GET /api/config
    // above: a snapshot that can be briefly stale relative to unsaved
    // in-renderer edits, acceptable for a read-only list view). Excludes
    // ch.hidden (setup-channels.js's HIDE FROM TUNING toggle) — same rule
    // the guide/channel-surf already apply (channels.js/playback.js).
    if (req.method === 'GET' && url.pathname === '/channels') {
      const cfg = await loadConfig();
      const channels = (cfg.channels || []).filter((ch) => !ch.hidden).map((ch) => ({
        number: ch.number, name: ch.name, favorite: !!ch.favorite, quickAccess: !!ch.quickAccess,
      })).sort((a, b) => a.number - b.number);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(channels));
      return;
    }

    // Toggle a channel's FAVORITE/quickAccess flag from the companion app —
    // relayed through the renderer (which owns the live, unsaved config in
    // memory) rather than written to disk directly here, so it goes through
    // the same debounced-autosave path as every other in-app edit instead of
    // risking a stale in-memory renderer state overwriting this write on its
    // next save.
    if (req.method === 'POST' && url.pathname === '/channel/flag') {
      try {
        const body = await readJsonBody(req);
        const validField = body && (body.field === 'favorite' || body.field === 'quickAccess');
        if (validField && Number.isFinite(body.number)) {
          sendToMainWindow('remote:setChannelFlag', {
            number: body.number, field: body.field, value: !!body.value,
          });
        }
        res.writeHead(204).end();
      } catch (e) {
        res.writeHead(400).end('Bad request');
      }
      return;
    }

    // Host-side party control from the companion app — mirrors the desktop
    // setup screen's own TRIGGER TRIVIA button (startTriviaRound, party.js),
    // relayed the same way /command already relays a keypress: this server
    // has no party-state of its own, it just tells the renderer (which owns
    // S.partyQueue/S.config.party) to act. Works even without the
    // party-channel plugin installed — party.js itself just won't be
    // showing anything for it to affect.
    if (req.method === 'POST' && url.pathname === '/party/trivia/start') {
      sendToMainWindow('party:triggerTrivia');
      res.writeHead(204).end();
      return;
    }

    // Fires the breaking-news plugin's interrupt (same as pressing its
    // hotkey — see REMOTE tab's FUNCTIONS grid — but as a dedicated action
    // that also accepts an optional custom headline, which a raw keypress
    // can't carry). No-ops on the renderer side if that plugin isn't
    // installed (app.js's onCompanionTriggerNews).
    if (req.method === 'POST' && url.pathname === '/news/trigger') {
      try {
        const body = await readJsonBody(req);
        sendToMainWindow('companion:triggerNews', { headline: typeof body?.headline === 'string' ? body.headline : undefined });
        res.writeHead(204).end();
      } catch (e) {
        res.writeHead(400).end('Bad request');
      }
      return;
    }

    // Sets the box-wide static ticker message live (renderer's
    // onCompanionSetTicker both saves it and immediately refreshes the
    // visible bar) — distinct from a generic /api/settings edit, which
    // would only take effect on the ticker plugin's own next natural
    // re-render, not right away.
    if (req.method === 'POST' && url.pathname === '/ticker/set') {
      try {
        const body = await readJsonBody(req);
        sendToMainWindow('companion:setTicker', {
          text: typeof body?.text === 'string' ? body.text : undefined,
          enabled: typeof body?.enabled === 'boolean' ? body.enabled : undefined,
        });
        res.writeHead(204).end();
      } catch (e) {
        res.writeHead(400).end('Bad request');
      }
      return;
    }

    serveStatic(REMOTE_DIR, url.pathname, req, res);
  });

  server.on('error', (err) => {
    console.error(`Companion app server failed to start on port ${PORT}:`, err.message);
  });
  server.listen(PORT, '0.0.0.0');
}

module.exports = { activate };
