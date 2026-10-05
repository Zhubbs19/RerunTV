// Generic helpers shared by the remote/party HTTP servers (main.js) and, via
// ctx.readJsonBody/ctx.serveStatic, by every plugin's own LAN-facing server
// (party-channel, universal-remote, ...). Pure Node, no dependency on
// anything else in this app besides its two Electron-free siblings
// (main-mime.js, main-path-safety.js) — same reasoning as those two: this
// has to be require()-able unchanged from an isolated plugin's own forked
// process (plugin-isolation-runtime.js), not just from the host.
const path = require('path');
const fs = require('fs');
const { mimeFor } = require('../media/mime');
const { isPathContained } = require('./path-safety');

// MAX_JSON_BODY_BYTES caps how much of the body gets buffered before giving
// up — these routes are all short text fields (names, chat-length messages,
// remote commands), never bulk uploads (those go through busboy/multipart
// separately, see party-channel's photo/video intake), so 1MB is already
// generous. Without a cap, any LAN client could send an arbitrarily large
// body and exhaust host memory before JSON.parse ever runs.
const MAX_JSON_BODY_BYTES = 1024 * 1024;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; // decoded once at the end so multi-byte characters survive chunk splits
    let bytes = 0;
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      req.removeAllListeners('data');
      reject(err);
    };
    req.on('data', (chunk) => {
      if (done) return;
      bytes += chunk.length;
      if (bytes > MAX_JSON_BODY_BYTES) {
        req.destroy();
        fail(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      const data = Buffer.concat(chunks).toString('utf8');
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', fail);
  });
}

// Serves one static file out of `baseDir` for a plugin's own small
// browser-facing UI (party-channel's party/ page, universal-remote's own
// remote/ page) — the GET-and-fall-through-to-index.html tail every such
// plugin server ends with, previously hand-copied per plugin (path-
// containment check included). Handles the whole rest of the response
// (method check, 403/404) so a call site is just
// `serveStaticFile(MY_DIR, url.pathname, req, res); return;` once every
// other route above it has already been checked and didn't match.
function serveStaticFile(baseDir, pathname, req, res) {
  if (req.method !== 'GET') { res.writeHead(405).end('Method not allowed'); return; }
  const rel = pathname === '/' ? '/index.html' : pathname;
  const resolved = path.normalize(path.join(baseDir, rel));
  if (!isPathContained(baseDir, resolved)) { res.writeHead(403).end('Forbidden'); return; }
  fs.readFile(resolved, (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mimeFor(resolved) }).end(data);
  });
}

module.exports = { readJsonBody, MAX_JSON_BODY_BYTES, serveStaticFile };
