// ---------- Party channel (PARTY_CH) — LAN guest page ----------
// Migrated from core main-party-server.js. A LAN-facing server (independent
// of the remote/viewer ones, same "no auth in v1, LAN trust model" — see
// universal-remote) serving the guest-facing party/ page and its actions:
// posting a photo/video to the bulletin, sending a text-to-speech
// announcement, playing a soundboard sting, trivia, caption contest,
// vote-for-next, check-in, effects, and reactions. All relay to the
// renderer over IPC (mainWindow.webContents.send) — party.js (renderer)
// owns the actual queue and rendering, this is purely the LAN-facing intake
// plus the small bits of read-through-cached state guests poll
// (queue/vote/trivia).
//
// Extension point: ctx.registerPartyRoute(method, pathname, handler) lets a
// dependent plugin (dependsOn: ["party-channel"]) add a guest-facing route
// served on this same port/server, without needing its own HTTP server or a
// code change here — ctx.dispatchPartyRoute() below checks every request
// that doesn't match one of this plugin's own built-in routes against
// whatever's been registered — lets a separate, dependent plugin add a
// guest-facing route on this same server without a code change here.
//
// Both this plugin and a route-registering dependent are typically isolated
// (see manifest.json's "isolated" field), so a registered route's `handler`
// can't be handed the real (req, res) directly the way a same-process
// extension point could: it runs in a DIFFERENT OS process from whichever
// process is holding the live socket. handler is instead a pure function
// `async ({method, pathname, headers, body}) => ({status, headers, body})` —
// this plugin's own dispatchPartyRoute() call buffers the incoming request
// into that plain descriptor, the host process relays it to whichever
// process registered the matching route, and relays the plain response
// descriptor back — see main-plugin-isolation.js's 'party:dispatchRoute'/
// 'party:invokeRoute' handlers for the actual relay. A narrow, accepted race
// exists at boot: unlike the old same-process guarantee ("every plugin's
// activate() finishes within one synchronous tick, before any request can
// arrive"), forking a real process takes real wall-clock time, so a request
// arriving in the first few milliseconds after this server starts listening
// could in theory beat a still-forking dependent plugin's route registration
// and 404. Not worth solving for a LAN-only guest page nobody polls that
// fast — flagged here rather than silently relied on.
const path = require('path');

const PARTY_DIR = path.join(__dirname, 'party');
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024; // generous for a phone video, capped so one guest can't fill the disk
let latestPartyQueueState = { current: null, queueLength: 0 };
let latestPartyVoteTally = {}; // { [channelNumber]: count } — pushed by the renderer (party.js)
// The caption-contest source image — captured on the host from whatever
// frame was on screen (see setup-settings.js's CAPTURE FRAME button + the
// party:captureVideoFrame IPC handler below) and re-served to guests here
// so the CAPTION tab has something to show without needing file:// access.
let currentCaptionImagePath = null;
// Live trivia round state — pushed by the renderer (party.js) whenever a
// round starts/gets answered/reveals, same read-through-caching pattern as
// the queue/vote state above. correctIndex is only ever included once
// party.js itself marks the round revealed, so a guest can't peek the
// answer early by just reading this endpoint.
let latestPartyTriviaState = { active: false };
// Shared with the universal-remote plugin's own /reaction route — published
// onto ctx.services below so both entry points agree on what's actually a
// valid reaction, same as when this lived in one core file together.
const PARTY_REACTION_EMOJI = ['😂', '🎉', '❤️', '🔥', '👀'];

// Maps an upload's declared mimeType to {kind, ext} — deliberately keyed off
// mimeType (what the browser actually says the file is), not the guest-
// supplied filename, since that's attacker/typo-controlled and this ext
// becomes part of a path this process later opens.
const UPLOAD_KIND_BY_MIME = {
  'image/png': { kind: 'image', ext: '.png' }, 'image/jpeg': { kind: 'image', ext: '.jpg' },
  'image/gif': { kind: 'image', ext: '.gif' }, 'image/webp': { kind: 'image', ext: '.webp' },
  'video/mp4': { kind: 'video', ext: '.mp4' }, 'video/webm': { kind: 'video', ext: '.webm' },
  'video/quicktime': { kind: 'video', ext: '.mov' },
};

// Reads a POST/PUT request body into a single Buffer without parsing it —
// unlike ctx.readJsonBody (used for this plugin's own built-in routes,
// running natively in-process against a live req), an extension-point route
// owned by a DIFFERENT isolated plugin can't stream-read this
// process's own `req` object across the process boundary, so the whole body
// has to be buffered up front and handed across as plain data instead — see
// ctx.dispatchPartyRoute() below.
//
// Capped like ctx.readJsonBody — a dependent plugin's route is expected to
// be a small text-shaped payload, not a bulk upload (those go through
// busboy in this plugin's own /upload route), so an unbounded buffer here
// would let any LAN guest exhaust host memory before a route handler ever
// sees the body.
const MAX_RAW_BODY_BYTES = 4 * 1024 * 1024;

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      bytes += c.length;
      if (bytes > MAX_RAW_BODY_BYTES) {
        done = true;
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) resolve(Buffer.concat(chunks)); });
    req.on('error', (err) => { if (!done) { done = true; reject(err); } });
  });
}

// This plugin's own port, same "declare it locally" pattern other plugins
// use for theirs — core has no reason to know this number exists at all,
// let alone hand it out by name.
const PARTY_PORT = 8726;

function activate(ctx) {
  const {
    ipcMain, spawn, createServer, fs: pluginFs, sendToMainWindow, trackConnection, mimeFor, readJsonBody,
    loadConfig, busboy, QRCode, getLanAddresses, getViewerUrls,
  } = ctx;
  const partyPort = PARTY_PORT;
  const getPartyUrls = () => getLanAddresses().map((c) => ({ name: c.name, url: `http://${c.address}:${partyPort}` }));

  // ctx.fs.dataDir (buildCheckedCtx, main-plugins.js) is this plugin's
  // declared "party-uploads" dataDir, already resolved to an absolute
  // path — core ensures it exists before activate() runs.
  function partyUploadsDir() {
    return pluginFs.dataDir;
  }

  function handlePartyPost(req, res) {
    const bb = busboy({ headers: req.headers, limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
    let caption = '';
    let saved = null; // {kind, path}
    let fileTooBig = false;
    // busboy's own 'close' fires once the incoming multipart body has been
    // fully *read*, which can race ahead of the file's writeStream actually
    // finishing its flush to disk (confirmed live — a small test upload
    // consistently 400'd with "no file received" even though a valid file
    // was sent, because `saved` was still null when 'close' checked it).
    // Every 'file' event's disk-write completion gets its own promise here,
    // and 'close' below awaits all of them before deciding what was
    // actually saved.
    const writesFinished = [];

    bb.on('field', (name, val) => {
      if (name === 'caption') caption = String(val).slice(0, 140);
    });

    bb.on('file', (name, fileStream, info) => {
      const mapped = UPLOAD_KIND_BY_MIME[info.mimeType];
      if (!mapped) {
        fileStream.resume(); // drain and discard — unsupported type
        return;
      }
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${mapped.ext}`;
      const destPath = path.join(partyUploadsDir(), filename);
      const writeStream = pluginFs.createWriteStream(filename);
      fileStream.on('limit', () => { fileTooBig = true; });
      fileStream.pipe(writeStream);
      writesFinished.push(new Promise((resolve) => {
        writeStream.on('close', () => {
          if (fileTooBig) { pluginFs.unlink(filename, () => {}); resolve(); return; }
          saved = { kind: mapped.kind, path: destPath };
          resolve();
        });
      }));
    });

    bb.on('close', async () => {
      await Promise.all(writesFinished);
      if (!saved) {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'No supported image/video file received' }));
        return;
      }
      sendToMainWindow('party:post', {
        id: `post-${Date.now()}`, kind: saved.kind, path: saved.path, caption,
      });
      res.writeHead(204).end();
    });

    bb.on('error', () => {
      res.writeHead(400).end('Bad request');
    });

    req.pipe(bb);
  }

  async function partySoundFiles() {
    const cfg = await loadConfig();
    const folder = cfg.party && cfg.party.soundboardFolder;
    if (!folder) return [];
    try {
      return pluginFs.readdirSync(folder)
        .filter((f) => /\.(mp3|wav|m4a|ogg|flac)$/i.test(f))
        .sort((a, b) => a.localeCompare(b));
    } catch (e) {
      return []; // folder moved/unmounted since it was configured
    }
  }

  // Caption contest — grabs a still frame at the given file/timestamp via
  // the bundled ffmpeg (ctx.services.ffmpegPath, published by the
  // ffmpeg-transcode plugin — not a hard dependency, just null-checked),
  // rather than canvas.drawImage(player, ...) in the renderer. That was the
  // first approach tried; it throws "Tainted canvases may not be exported"
  // because #player's src and the page itself are served from different
  // app:// custom-protocol *hosts* (app://media/... vs app://bundle/...) —
  // different origins per the browser's same-origin rules even though it's
  // the same custom scheme, so the canvas is cross-origin-tainted the
  // instant a frame from it is drawn. Fixing that properly would mean
  // adding crossorigin to the single shared #player element every piece of
  // content in this app plays through — too wide a blast radius for one
  // feature. Re-deriving the frame from the source file directly sidesteps
  // the whole issue.
  function captureVideoFrame(filePath, timeSeconds) {
    const ffmpegPath = ctx.services.ffmpegPath;
    if (!filePath || !pluginFs.existsSync(filePath) || !ffmpegPath) return Promise.resolve(null);
    const destPath = path.join(partyUploadsDir(), `caption-${Date.now()}.jpg`);
    const ss = Math.max(0, timeSeconds || 0);
    return new Promise((resolve) => {
      // Neither stdout nor stderr is read here — 'ignore' avoids opening
      // pipes nothing drains, which could otherwise fill and block ffmpeg
      // indefinitely on unusually verbose output (see main.js's transcode
      // spawn for the same reasoning).
      const ff = spawn(ffmpegPath, ['-y', '-ss', String(ss), '-i', filePath, '-frames:v', '1', '-q:v', '3', destPath], { stdio: 'ignore' });
      ff.on('error', () => resolve(null));
      ff.on('close', (code) => {
        if (code === 0 && pluginFs.existsSync(destPath)) {
          currentCaptionImagePath = destPath;
          resolve(destPath);
        } else {
          resolve(null);
        }
      });
    });
  }

  // Picks the first LAN candidate the same way the setup screen's remote/
  // viewer URL panels do — genuinely ambiguous which of several NICs a
  // guest's phone can actually reach, but a QR code can only encode one
  // URL, so this is the same "just pick one, the setup screen SETTINGS
  // panel lists every candidate for the rare case this guess is wrong"
  // tradeoff, now also baked into the on-screen idle card.
  async function getPartyJoinInfo() {
    const urls = getPartyUrls();
    if (!urls.length) return { url: '', qrDataUrl: '' };
    const url = urls[0].url;
    try {
      const qrDataUrl = await QRCode.toDataURL(url, { margin: 1, width: 320 });
      return { url, qrDataUrl };
    } catch (e) {
      return { url, qrDataUrl: '' };
    }
  }

  const server = createServer(async (req, res) => {
    trackConnection('party', req);
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'POST' && url.pathname === '/post') {
      handlePartyPost(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/announce') {
      try {
        const body = await readJsonBody(req);
        const text = body && typeof body.text === 'string' ? body.text.trim().slice(0, 280) : '';
        if (!text) { res.writeHead(400).end('Bad request'); return; }
        sendToMainWindow('party:announce', { id: `announce-${Date.now()}`, text });
        res.writeHead(204).end();
      } catch (e) {
        res.writeHead(400).end('Bad request');
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/news') {
      try {
        const body = await readJsonBody(req);
        const text = body && typeof body.text === 'string' ? body.text.trim().slice(0, 280) : '';
        sendToMainWindow('party:news', { text });
        res.writeHead(204).end();
      } catch (e) {
        res.writeHead(400).end('Bad request');
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/bingo') {
      try {
        const body = await readJsonBody(req);
        const name = body && typeof body.name === 'string' ? body.name.trim().slice(0, 40) : 'Party Guest';
        sendToMainWindow('party:bingo', { name });
        res.writeHead(204).end();
      } catch (e) {
        res.writeHead(400).end('Bad request');
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/soundboard') {
      const files = await partySoundFiles();
      const sounds = files.map((filename) => ({ id: filename, label: path.parse(filename).name }));
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(sounds));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/soundboard/play') {
      try {
        const body = await readJsonBody(req);
        const id = body && typeof body.id === 'string' ? body.id : '';
        // Re-derive from the live folder listing rather than trusting the
        // id as a path directly — path.basename below also strips any
        // directory traversal a crafted id might carry.
        const files = await partySoundFiles();
        const match = files.find((f) => f === path.basename(id));
        if (!match) { res.writeHead(404).end('Not found'); return; }
        const cfg = await loadConfig();
        const fullPath = path.join(cfg.party.soundboardFolder, match);
        sendToMainWindow('party:soundboardPlay', { path: fullPath });
        res.writeHead(204).end();
      } catch (e) {
        res.writeHead(400).end('Bad request');
      }
      return;
    }

    // Cross-link to the LAN viewer (a full, independent replica of the box)
    // so a guest on the party page can also just watch the actual channel
    // lineup without hunting down a second URL from the host.
    if (req.method === 'GET' && url.pathname === '/viewer-url') {
      const urls = getViewerUrls();
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ urls }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/queue') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(latestPartyQueueState));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/trivia') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(latestPartyTriviaState));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/trivia/answer') {
      try {
        const body = await readJsonBody(req);
        const index = body && Number.isInteger(body.index) ? body.index : null;
        if (index == null || index < 0 || index > 3) { res.writeHead(400).end('Bad request'); return; }
        sendToMainWindow('party:triviaAnswer', { index });
        res.writeHead(204).end();
      } catch (e) {
        res.writeHead(400).end('Bad request');
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/caption') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ hasImage: !!currentCaptionImagePath }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/caption/image') {
      if (!currentCaptionImagePath) { res.writeHead(404).end('Not found'); return; }
      pluginFs.readFile(currentCaptionImagePath, (err, data) => {
        if (err) { res.writeHead(404).end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': mimeFor(currentCaptionImagePath) }).end(data);
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/caption') {
      try {
        const body = await readJsonBody(req);
        const text = body && typeof body.text === 'string' ? body.text.trim().slice(0, 140) : '';
        if (!text || !currentCaptionImagePath) { res.writeHead(400).end('Bad request'); return; }
        sendToMainWindow('party:caption', { text });
        res.writeHead(204).end();
      } catch (e) {
        res.writeHead(400).end('Bad request');
      }
      return;
    }

    // Vote-for-next-channel — candidates are whichever channels are tagged
    // REMOTE QUICK-TAP (channels.js's quickAccess field, added for the
    // Android companion remote — reused here rather than a separate list so
    // there's only one place to curate "channels worth jumping straight
    // to"). Tally lives in the renderer (party.js owns the auto-tune-to-
    // winner timer, only relevant while PARTY_CH is actually showing); this
    // is just read-through caching, same as GET /queue.
    if (req.method === 'GET' && url.pathname === '/vote') {
      const cfg = await loadConfig();
      const options = (cfg.channels || []).filter((ch) => ch.quickAccess).map((ch) => ({
        number: ch.number, name: ch.name, votes: latestPartyVoteTally[ch.number] || 0,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ options }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/vote') {
      try {
        const body = await readJsonBody(req);
        const number = body && Number.isFinite(body.number) ? body.number : null;
        if (number == null) { res.writeHead(400).end('Bad request'); return; }
        sendToMainWindow('party:vote', { number });
        res.writeHead(204).end();
      } catch (e) {
        res.writeHead(400).end('Bad request');
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/checkin') {
      try {
        const body = await readJsonBody(req);
        const name = body && typeof body.name === 'string' ? body.name.trim().slice(0, 24) : '';
        if (!name) { res.writeHead(400).end('Bad request'); return; }
        sendToMainWindow('party:checkin', { name });
        res.writeHead(204).end();
      } catch (e) {
        res.writeHead(400).end('Bad request');
      }
      return;
    }

    // Visual effects (confetti/flash/applause) — see effects.js. Works over
    // whatever's tuned, not just PARTY_CH, so it's a flat allowlist rather
    // than anything queue-related.
    if (req.method === 'POST' && url.pathname === '/effect') {
      try {
        const body = await readJsonBody(req);
        const type = body && body.type;
        if (type !== 'confetti' && type !== 'flash' && type !== 'applause') {
          res.writeHead(400).end('Bad request');
          return;
        }
        sendToMainWindow('party:effect', { type });
        res.writeHead(204).end();
      } catch (e) {
        res.writeHead(400).end('Bad request');
      }
      return;
    }

    // Floats a reaction emoji over whatever's on screen (renderFloatingReaction,
    // party.js) — same underlying feature as the universal-remote plugin's
    // own POST /reaction, just also reachable from a guest's own phone here
    // since a party guest never has that other app installed. Fixed
    // allowlist rather than accepting any string a guest sends, same
    // reasoning as /effect just above.
    if (req.method === 'POST' && url.pathname === '/reaction') {
      try {
        const body = await readJsonBody(req);
        const emoji = body && body.emoji;
        if (typeof emoji !== 'string' || !PARTY_REACTION_EMOJI.includes(emoji)) {
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

    // Extension point — see the comment at the top of this file. Checked
    // after every built-in route above (so a plugin can't shadow a
    // built-in) and before the static-file fallback below. The body is
    // buffered up front (readRawBody) rather than left as a live stream,
    // since dispatchPartyRoute() may be relaying this to a different OS
    // process entirely.
    let dispatched = null;
    try {
      const body = (req.method === 'POST' || req.method === 'PUT') ? await readRawBody(req) : null;
      dispatched = await ctx.dispatchPartyRoute({
        method: req.method, pathname: url.pathname, headers: req.headers, body,
      });
    } catch (e) {
      if (!res.writableEnded) res.writeHead(500).end('Internal error');
      return;
    }
    if (dispatched) {
      res.writeHead(dispatched.status, dispatched.headers || {});
      res.end(dispatched.body);
      return;
    }

    if (req.method === 'GET') {
      const rel = url.pathname === '/' ? '/index.html' : url.pathname;
      const resolved = path.normalize(path.join(PARTY_DIR, rel));
      if (resolved !== PARTY_DIR && !resolved.startsWith(PARTY_DIR + path.sep)) {
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
    console.error(`Party server failed to start on port ${partyPort}:`, err.message);
  });
  server.listen(partyPort, '0.0.0.0');

  ctx.services.partyReactionEmoji = PARTY_REACTION_EMOJI;
  // Generic "watch live" link capability (see renderer.js's viewerLink on
  // this channel's registerChannelType call, and main-viewer-server.js's
  // /api/viewer-live-link) — core's LAN viewer server has no idea this is
  // the party channel specifically, it just reads whatever URL(s) got
  // published here.
  ctx.services.viewerLiveLinkUrls = getPartyUrls();

  ipcMain.on('party:queueState', (event, state) => {
    latestPartyQueueState = state && typeof state === 'object' ? state : { current: null, queueLength: 0 };
  });
  ipcMain.on('party:voteState', (event, tally) => {
    latestPartyVoteTally = tally && typeof tally === 'object' ? tally : {};
  });
  ipcMain.on('party:triviaState', (event, state) => {
    latestPartyTriviaState = state && typeof state === 'object' ? state : { active: false };
  });
  ipcMain.handle('party:captureVideoFrame', async (event, { filePath, timeSeconds }) => captureVideoFrame(filePath, timeSeconds));
  ipcMain.handle('party:getJoinInfo', async () => getPartyJoinInfo());
}

// Called by core (registerFallbackHandlers, main-plugins.js) instead of
// activate() when this plugin is disabled/missing. Matches
// browser-api-shim.js's own fallback shape exactly (the LAN viewer runs
// with no party server either) — neither caller (the party-channel
// renderer.js, setup-settings.js) has a .catch, so these resolve rather
// than reject.
function registerFallback(ipcMain) {
  ipcMain.handle('party:captureVideoFrame', async () => null);
  ipcMain.handle('party:getJoinInfo', async () => ({ url: '', qrDataUrl: '' }));
}

module.exports = { activate, registerFallback };
