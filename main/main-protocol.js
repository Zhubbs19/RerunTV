const { protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const { mimeFor, MIME_TYPES } = require('./main-mime');

// The renderer is served over a custom app:// scheme rather than file://
// because Chromium refuses to load ES modules from a file:// origin. That
// choice cascades: a non-file:// page also can't load file:// media, so
// video is streamed through the same handler (see serveFile's Range
// support — the schedule math seeks constantly, so partial requests are
// not optional here).
function registerAppSchemePrivileges() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'app',
      // corsEnabled: true is what actually lets fetch()/dynamic import() on
      // an app://bundle page load a resource from a *different* app:
      // hostname (app://plugins) — each hostname under this scheme is its
      // own origin, same as any other URL. Without this, cross-hostname
      // fetch/import fails with a bare "Failed to fetch" regardless of any
      // Access-Control-Allow-Origin response header (see serveFile).
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
    },
  ]);
}

// crossOrigin adds Access-Control-Allow-Origin so fetch()/dynamic import()
// from the page's own app://bundle origin can load resources served from a
// *different* app: hostname (app://plugins is its own origin, distinct from
// app://bundle, by ordinary same-origin rules) — a <link rel="stylesheet">
// isn't CORS-gated so plugin CSS loaded fine without this, but a plugin's
// renderer entry (imported as an ES module) silently failed with "Failed to
// fetch" until this was added. Local-only content, so an open '*' is fine.
async function serveFile(filePath, rangeHeader, crossOrigin, noCache) {
  // Every app://bundle and app://plugins response (the app's own JS/CSS/
  // HTML/SVG source, not a user's media file) had NO cache header at all
  // until this — meaning Chromium was free to apply its own heuristic
  // caching, with no explicit signal either way. In active development,
  // where source files get edited and the app relaunched to see the
  // result, an unpredictable stale-cache hit reads exactly like "I
  // relaunched and it's still broken" when the actual code IS already
  // fixed on disk. app://media (real video/audio playback) deliberately
  // keeps no override here — caching genuinely helps there and there's no
  // "am I seeing stale code" risk for a file the user picked themselves.
  const cacheHeaders = noCache ? { 'Cache-Control': 'no-store' } : {};
  const corsHeaders = crossOrigin ? { 'Access-Control-Allow-Origin': '*' } : {};
  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (e) {
    return new Response('Not found', { status: 404, headers: corsHeaders });
  }
  const type = mimeFor(filePath);

  const match = rangeHeader && /bytes=(\d*)-(\d*)/.exec(rangeHeader);
  if (match) {
    const start = match[1] ? parseInt(match[1], 10) : 0;
    let end = match[2] ? parseInt(match[2], 10) : stat.size - 1;
    if (Number.isNaN(start) || start >= stat.size) {
      return new Response(null, { status: 416, headers: { ...corsHeaders, 'Content-Range': `bytes */${stat.size}` } });
    }
    end = Math.min(end, stat.size - 1);
    return new Response(Readable.toWeb(fs.createReadStream(filePath, { start, end })), {
      status: 206,
      headers: {
        ...corsHeaders,
        ...cacheHeaders,
        'Content-Type': type,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
      },
    });
  }

  return new Response(Readable.toWeb(fs.createReadStream(filePath)), {
    status: 200,
    headers: {
      ...corsHeaders,
      ...cacheHeaders,
      'Content-Type': type,
      'Content-Length': String(stat.size),
      'Accept-Ranges': 'bytes',
    },
  });
}

// app://bundle/...        -> files shipped with the app (sandboxed to appRootDir)
// app://media/?p=<path>   -> a user-chosen media file anywhere on disk
// app://plugins/...       -> plugin files (sandboxed to pluginsDir) — see main-plugins.js
// appRootDir is passed in (rather than this module's own __dirname) so the
// containment check is always against the real app directory regardless of
// where this file itself lives on disk.
function registerAppProtocol(appRootDir, pluginsDir) {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    const range = request.headers.get('range');

    if (url.hostname === 'media') {
      const target = url.searchParams.get('p');
      if (!target) return new Response('Bad request', { status: 400 });
      return serveFile(path.normalize(decodeURIComponent(target)), range);
    }

    if (url.hostname === 'plugins') {
      if (!pluginsDir) return new Response('Not found', { status: 404 });
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const resolved = path.normalize(path.join(pluginsDir, rel));
      if (resolved !== pluginsDir && !resolved.startsWith(pluginsDir + path.sep)) {
        return new Response('Forbidden', { status: 403 });
      }
      return serveFile(resolved, range, true, true);
    }

    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const resolved = path.normalize(path.join(appRootDir, rel));
    // Keep bundle requests from escaping the app directory via ../
    if (resolved !== appRootDir && !resolved.startsWith(appRootDir + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }
    return serveFile(resolved, range, false, true);
  });
}

// serveFile() returns a web-standard Response (built for protocol.handle's
// Fetch-API contract) — Node's classic http.createServer callback needs a
// (req, res) pair instead, so this bridges the two: copy headers/status
// across, then pipe the Response's body (a web ReadableStream, uniformly
// present whether the original body was a string or a file stream) into
// the Node response via Readable.fromWeb.
async function pipeWebResponse(response, res) {
  const headers = {};
  response.headers.forEach((v, k) => { headers[k] = v; });
  res.writeHead(response.status, headers);
  if (!response.body) { res.end(); return; }
  Readable.fromWeb(response.body).pipe(res);
}

module.exports = {
  registerAppSchemePrivileges, registerAppProtocol, serveFile, pipeWebResponse, mimeFor, MIME_TYPES,
};
