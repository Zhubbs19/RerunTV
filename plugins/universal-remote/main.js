// ---------- Universal remote (phone browser, LAN-only) ----------
// Migrated from core main-remote-server.js. A small local HTTP server
// (Node's built-in `http`, no new dependency) that serves the standalone
// remote/ page and relays button presses into the renderer's existing
// keyboard handler (see handleKey, app.js) via IPC — this is purely a new
// *input* path alongside the keyboard, nothing about playback/scheduling
// changes. Bound to 0.0.0.0 so a phone on the same WiFi can reach it;
// there's no internet exposure since nothing forwards the port, and no auth
// in v1 (same trust model as a physical remote — anyone on the LAN can use
// it, same as anyone who can pick up a remote).
const path = require('path');

const REMOTE_DIR = path.join(__dirname, 'remote');
// Cached, not persisted — just enough for the remote page's "NOW WATCHING"
// readout, pushed from the renderer whenever it tunes (see tuneToChannel,
// playback.js).
let latestRemoteState = { number: null, name: null };

function activate(ctx) {
  const {
    ipcMain, createServer, fs: pluginFs, sendToMainWindow, trackConnection, mimeFor, readJsonBody, loadConfig, remotePort,
  } = ctx;
  // Not a hard dependency (this plugin works fully without it) — just
  // published by the party-channel plugin onto ctx.services if that one's
  // also installed+enabled, so /reaction's allowlist matches the party
  // page's own. dependsOn: ["party-channel"] in the manifest only affects
  // load *order* (so this read sees it if present), not whether this plugin
  // can activate without it.
  const partyReactionEmoji = ctx.services.partyReactionEmoji || null;

  const server = createServer(async (req, res) => {
    trackConnection('remote', req);
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'POST' && url.pathname === '/command') {
      try {
        const body = await readJsonBody(req);
        if (body && typeof body.key === 'string') {
          sendToMainWindow('remote:command', { key: body.key, shift: !!body.shift });
        }
        res.writeHead(204).end();
      } catch (e) {
        res.writeHead(400).end('Bad request');
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(latestRemoteState));
      return;
    }

    // Direct channel jump for the Android companion remote's quick-tap grid
    // (party channel, public-access channel, etc.) — unlike /command's digit
    // keys, this tunes immediately with no entry-buffer debounce, since the
    // app already knows the exact channel number.
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
    // editor — read straight from disk (same tradeoff as the LAN viewer's
    // GET /api/config: a snapshot that can be briefly stale relative to
    // unsaved in-renderer edits, acceptable for a read-only list view).
    if (req.method === 'GET' && url.pathname === '/channels') {
      const cfg = await loadConfig();
      const channels = (cfg.channels || []).map((ch) => ({
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

    // Host-side party control from the Android companion app — mirrors the
    // desktop setup screen's own TRIGGER TRIVIA button (startTriviaRound,
    // party.js), just relayed the same way /command already relays a
    // keypress: this server has no party-state of its own, it just tells
    // the renderer (which owns S.partyQueue/S.config.party) to act. Works
    // even without the party-channel plugin installed — party.js itself
    // just won't be showing anything for it to affect.
    if (req.method === 'POST' && url.pathname === '/party/trivia/start') {
      sendToMainWindow('party:triggerTrivia');
      res.writeHead(204).end();
      return;
    }

    if (req.method === 'GET') {
      const rel = url.pathname === '/' ? '/index.html' : url.pathname;
      const resolved = path.normalize(path.join(REMOTE_DIR, rel));
      // Same containment check as the app:// bundle handler — keep static
      // requests from escaping the remote/ directory via ../.
      if (resolved !== REMOTE_DIR && !resolved.startsWith(REMOTE_DIR + path.sep)) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      pluginFs.readFile(resolved, (err, data) => {
        if (err) { res.writeHead(404).end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': mimeFor(resolved) }).end(data);
      });
      return;
    }

    res.writeHead(405).end('Method not allowed');
  });

  server.on('error', (err) => {
    // Don't crash the app if the port's taken (e.g. a second instance) —
    // the remote just won't be reachable this run.
    console.error(`Remote server failed to start on port ${remotePort}:`, err.message);
  });
  server.listen(remotePort, '0.0.0.0');

  ipcMain.on('remote:state', (event, state) => {
    latestRemoteState = state && typeof state === 'object' ? state : { number: null, name: null };
  });
}

module.exports = { activate };
