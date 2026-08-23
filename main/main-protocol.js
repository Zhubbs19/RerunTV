const { protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const { mimeFor, MIME_TYPES } = require('./main-mime');
const { LAN_MEDIA_EXTENSIONS } = require('./main-media');
const { isPathContained } = require('./main-path-safety');
const { parseMediaRef, callMediaService, MEDIA_READRANGE_TIMEOUT_MS } = require('./main-media-dispatch');

// Set once by main.js, right after the same `pluginServices` object handed
// to loadMainPlugins()/startViewerServer() exists — serveFileViaPlugin below
// needs it to resolve a media-source provider's readRange service, exactly
// like every other callMediaService call site (main.js's fs:scanFolder/
// media:probeDuration/fs:checkPathsExist handlers already do the same
// dance with their own module-scope reference for the same reason: this
// module's protocol.handle('app', ...) registration happens once, outside
// any per-request scope that could otherwise thread the object through).
let pluginServicesRef = {};
function setMediaDispatchServices(services) { pluginServicesRef = services || {}; }

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

// Streams one Range request's worth of a plugin-sourced media ref through
// that provider's readRange service — the non-local counterpart to
// serveFile above. Every real caller of this is a seeking <video> element,
// which already requests successive bounded byte ranges rather than a whole
// file in one shot (the same reason serveFile supports Range at all), so
// treating each Range request as its own bounded request/response call
// matches the real access pattern rather than compromising it — no
// streaming primitive needs to cross the plugin-process RPC boundary, only
// bounded chunks, exactly like readRange's own contract already promises.
// CHUNK_CAP bounds a single round-trip's payload for the one request that
// ISN'T naturally bounded by the caller: a <video> element's very first
// request, before it has any reason to know to send a Range header at all,
// sometimes asks for the whole file — this must not try to pull a
// multi-gigabyte file through one postMessage call. 4MB is enough for
// Chromium to read container metadata and start requesting real ranges.
// Known cost, not fully solved here: every chunk crosses a structured-clone
// boundary twice (plugin process -> host via postMessage, host -> Response
// body) — for sustained high-bitrate streaming over a slow provider link,
// this could bottleneck before the network itself does. Acceptable for a
// first cut; the documented escape hatch (not implemented) is a plugin
// running its own loopback HTTP proxy server (ctx.createServer) that this
// module proxies straight to instead of calling a service, trading "every
// provider author reimplements Range handling" for real, uncapped
// streaming.
async function serveFileViaPlugin(providerId, ref, rangeHeader, crossOrigin) {
  const corsHeaders = crossOrigin ? { 'Access-Control-Allow-Origin': '*' } : {};
  const match = rangeHeader && /bytes=(\d*)-(\d*)/.exec(rangeHeader);
  const start = match && match[1] ? parseInt(match[1], 10) : 0;
  const CHUNK_CAP = 4 * 1024 * 1024;
  const end = match && match[2] ? Math.min(parseInt(match[2], 10), start + CHUNK_CAP - 1) : start + CHUNK_CAP - 1;

  let result;
  try {
    result = await callMediaService(pluginServicesRef, providerId, 'readRange', [ref, start, end], MEDIA_READRANGE_TIMEOUT_MS);
  } catch (e) {
    // Covers both "no such provider/it's not activated" (assertKnownProvider,
    // main-media-dispatch.js) and a genuine provider-side failure (the RPC
    // call itself rejects, e.g. the plugin's process died mid-request —
    // childRpc.dispose() in main-plugin-isolation.js rejects any in-flight
    // call immediately rather than hanging) — either way, a clean 502
    // rather than an uncaught rejection reaching protocol.handle's own
    // catch-all 500.
    return new Response('Upstream error', { status: 502, headers: corsHeaders });
  }
  if (!result || result.status === 404 || !result.chunk) {
    return new Response('Not found', { status: 404, headers: corsHeaders });
  }
  const chunk = Buffer.isBuffer(result.chunk) ? result.chunk : Buffer.from(result.chunk);
  const headers = {
    ...corsHeaders,
    'Content-Type': result.contentType || 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Content-Length': String(chunk.length),
  };
  if (result.totalSize != null) headers['Content-Range'] = `bytes ${start}-${start + chunk.length - 1}/${result.totalSize}`;
  return new Response(chunk, { status: match ? 206 : 200, headers });
}

// Unified entry point for anything that used to hand a bare local path
// straight to serveFile — app://media (handleAppRequest below) and the LAN
// viewer's own /media route (main-viewer-server.js) both go through this
// instead now, so a plugin-sourced channel streams correctly to either
// consumer rather than only the main window. serveFile itself stays
// local-file-only and is still called directly for bundle/plugins static
// assets (app.js/CSS/plugin files), which are never anything but local.
async function serveMediaRef(ref, rangeHeader, crossOrigin) {
  const parsed = parseMediaRef(ref);
  const corsHeaders = crossOrigin ? { 'Access-Control-Allow-Origin': '*' } : {};
  // Same extension allowlist for both branches — without it, any script
  // running in the renderer origin (including a compromised/malicious
  // plugin's renderer.js, loaded into this same window) could use a
  // provider's readRange to read back arbitrary opaque data by feeding it a
  // ref with an unexpected extension.
  const extCheckTarget = parsed.source === 'local' ? parsed.path : parsed.ref;
  if (!LAN_MEDIA_EXTENSIONS.has(path.extname(extCheckTarget).toLowerCase())) {
    return new Response('Forbidden', { status: 403, headers: corsHeaders });
  }
  if (parsed.source === 'local') return serveFile(path.normalize(parsed.path), rangeHeader, crossOrigin);
  return serveFileViaPlugin(parsed.source, parsed.ref, rangeHeader, crossOrigin);
}

// app://bundle/...        -> files shipped with the app (sandboxed to appRootDir)
// app://media/?p=<path>   -> a user-chosen media file anywhere on disk
// app://plugins/...       -> plugin files (sandboxed to pluginsDir) — see main-plugins.js
// appRootDir is passed in (rather than this module's own __dirname) so the
// containment check is always against the real app directory regardless of
// where this file itself lives on disk.
function registerAppProtocol(appRootDir, pluginsDir) {
  protocol.handle('app', async (request) => {
    try {
      return await handleAppRequest(request, appRootDir, pluginsDir);
    } catch (e) {
      // An uncaught throw here (a malformed URL, an fs error slipping past
      // serveFile's own catch, etc.) would otherwise reject the Promise
      // protocol.handle is waiting on with no clean Response ever produced
      // — respond with a plain 500 instead.
      return new Response('Internal error', { status: 500 });
    }
  });
}

async function handleAppRequest(request, appRootDir, pluginsDir) {
  const url = new URL(request.url);
  const range = request.headers.get('range');

  if (url.hostname === 'media') {
    const target = url.searchParams.get('p');
    if (!target) return new Response('Bad request', { status: 400 });
    // `target` is either a raw local path (unchanged, every existing
    // config's files parse this way by construction) or a
    // mediasource:<providerId>:<opaque-ref> string (see main-media-
    // dispatch.js's parseMediaRef) — serveMediaRef dispatches accordingly.
    return serveMediaRef(decodeURIComponent(target), range);
  }

  if (url.hostname === 'plugins') {
    if (!pluginsDir) return new Response('Not found', { status: 404 });
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const resolved = path.normalize(path.join(pluginsDir, rel));
    if (!isPathContained(pluginsDir, resolved)) {
      return new Response('Forbidden', { status: 403 });
    }
    return serveFile(resolved, range, true, true);
  }

  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const resolved = path.normalize(path.join(appRootDir, rel));
  // Keep bundle requests from escaping the app directory via ../
  if (!isPathContained(appRootDir, resolved)) {
    return new Response('Forbidden', { status: 403 });
  }
  return serveFile(resolved, range, false, true);
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
  registerAppSchemePrivileges, registerAppProtocol, serveFile, serveMediaRef, setMediaDispatchServices, pipeWebResponse, mimeFor, MIME_TYPES,
};
