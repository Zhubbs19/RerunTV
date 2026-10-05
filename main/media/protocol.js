const { protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const { mimeFor, MIME_TYPES } = require('./mime');
const { LAN_MEDIA_EXTENSIONS } = require('./media');
const { isPathContained } = require('../util/path-safety');
const { parseMediaRef, callMediaService, MEDIA_READRANGE_TIMEOUT_MS } = require('./dispatch');

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

// Set once by main.js, right after loadMainPlugins() resolves — the loopback
// ports a currently-activated plugin declared under manifest.json's
// capabilities.net (the same list already shown in the capability-approval
// prompt), plus core's own REMOTE_PORT/VIEWER_PORT. serveFile() below turns
// this into index.html's dynamic media-src CSP allowance, so a plugin that
// declares a port (and gets approved for it) just works — no hand-editing
// the static <meta> CSP in index.html the way this used to require. See
// that file's CSP comment for the full history.
let allowedMediaSrcPortsRef = [];
function setAllowedMediaSrcPorts(ports) { allowedMediaSrcPortsRef = Array.isArray(ports) ? ports : []; }

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
  // Only this one directive — a header CSP that omitted default-src leaves
  // every other resource type unrestricted *by this policy*, so it can only
  // narrow (never widen) index.html's static <meta> CSP, which is what lets
  // this stay dynamic without duplicating/drifting from that tag's other
  // directives. See setAllowedMediaSrcPorts's doc comment above.
  const cspHeaders = path.basename(filePath) === 'index.html'
    ? { 'Content-Security-Policy': `media-src 'self' app: ${allowedMediaSrcPortsRef.map((p) => `http://127.0.0.1:${p}`).join(' ')}` }
    : {};
  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (e) {
    return new Response('Not found', { status: 404, headers: corsHeaders });
  }
  const type = mimeFor(filePath);

  // First range of "bytes=START-END", "bytes=START-" or the suffix form
  // "bytes=-N" (the last N bytes — players use it to find an MP4 moov atom at
  // the end of a file). Anything unsatisfiable or malformed is a 416.
  const match = rangeHeader && /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)/i.exec(rangeHeader);
  if (rangeHeader && /^\s*bytes\s*=/i.test(rangeHeader) && !match) {
    return new Response(null, { status: 416, headers: { ...corsHeaders, 'Content-Range': `bytes */${stat.size}` } });
  }
  if (match) {
    let start;
    let end;
    if (!match[1] && !match[2]) {
      start = NaN;
    } else if (!match[1]) {
      const suffixLength = parseInt(match[2], 10);
      start = suffixLength > 0 ? Math.max(0, stat.size - suffixLength) : NaN;
      end = stat.size - 1;
    } else {
      start = parseInt(match[1], 10);
      end = match[2] ? parseInt(match[2], 10) : stat.size - 1;
    }
    if (Number.isNaN(start) || start >= stat.size || end < start) {
      return new Response(null, { status: 416, headers: { ...corsHeaders, 'Content-Range': `bytes */${stat.size}` } });
    }
    end = Math.min(end, stat.size - 1);
    return new Response(Readable.toWeb(fs.createReadStream(filePath, { start, end })), {
      status: 206,
      headers: {
        ...corsHeaders,
        ...cacheHeaders,
        ...cspHeaders,
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
      ...cspHeaders,
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
// OPEN_ENDED_CHUNK_CAP/BOUNDED_CHUNK_CAP (below) bound a single round-trip's
// payload for the one request shape that ISN'T naturally bounded by the
// caller: a <video> element's very first request, before it has any reason
// to know to send a Range header at all, sometimes asks for the whole
// file — this must not try to pull a multi-gigabyte file through one
// postMessage call.
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
  // A client request with an explicit end (a specific seek target) is
  // honored as-is — no reason to balloon a small, precise request. An
  // OPEN-ENDED request (no end given — "give me from here to EOF", what a
  // <video> element's very first request typically looks like) gets its own
  // cap too, kept SMALL now rather than large: earlier this was pushed up
  // to 32MB on the theory that a single response needed to contain enough
  // for Chromium's demuxer to find the MP4 metadata (moov) atom, since at
  // the time app://media's custom-protocol dispatch never prompted a
  // follow-up Range request for a plugin-backed resource — found live, a
  // real transport-layer issue, since fixed (routing a still-live plugin
  // ref through the LAN viewer's genuine http.Server instead of Electron's
  // protocol.handle — see renderer/js/playback.js's toFileUrl comment).
  // Chromium reliably asks for more now, the same way it already does for
  // any local file, so there's no reason to front-load a big first chunk
  // anymore — a small one gets the first byte on screen faster, at the cost
  // of a few more round-trips as playback ramps up, which is the right
  // trade for startup latency.
  const OPEN_ENDED_CHUNK_CAP = 2 * 1024 * 1024;
  const BOUNDED_CHUNK_CAP = 4 * 1024 * 1024;
  const end = match && match[2]
    ? Math.min(parseInt(match[2], 10), start + BOUNDED_CHUNK_CAP - 1)
    : start + OPEN_ENDED_CHUNK_CAP - 1;

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
  // Once we know the real total size, this is a 206 Partial Content
  // response REGARDLESS of whether the request itself included a Range
  // header — CHUNK_CAP means a chunk this size can never be the complete
  // resource for anything but a tiny file, so answering an unranged first
  // request with status 200 (which means "here is the entire resource")
  // and a Content-Length of only the capped chunk size lies to the
  // requester about how large the file actually is. Chromium's media
  // pipeline reads that as "the whole video is ~4MB," decodes a truncated/
  // corrupt file, and never produces a frame — exactly the local-only
  // serveFile() doesn't have this problem, since an unranged request there
  // really does get the true full Content-Length (the whole file, streamed
  // in one response) rather than a capped stand-in for it.
  // A real stream, not a plain Buffer body — matching serveFile's own
  // pattern exactly (Readable.toWeb(fs.createReadStream(...)) above).
  // Found live: a Buffer-backed Response here worked at the HTTP level
  // (correct status/headers) but Chromium's media pipeline never issued a
  // second Range request through this custom protocol regardless of chunk
  // content or size — only ever the one. serveFile's local path, which
  // Chromium DOES keep making follow-up requests to, has always returned a
  // stream-backed body, never a plain buffer; this is the one concrete
  // implementation difference between "works" and "doesn't," worth
  // matching before concluding live streaming genuinely can't work here.
  const body = Readable.toWeb(Readable.from([chunk]));
  if (result.totalSize != null) {
    headers['Content-Range'] = `bytes ${start}-${start + chunk.length - 1}/${result.totalSize}`;
    return new Response(body, { status: 206, headers });
  }
  // totalSize genuinely unknown (a provider that doesn't report it) — found
  // in review: falling back to `match ? 206 : 200` here reproduces the
  // exact "lies about how large the file actually is" bug just fixed
  // above, for exactly this provider shape. A capped chunk that came back
  // FULL (length >= what was asked for) can't be trusted as "the whole
  // resource" just because we don't know the real total — RFC 7233 allows
  // an unknown total in Content-Range (`bytes start-end/*`), which is the
  // honest thing to say here: partial content, more may exist. Only a
  // response genuinely shorter than requested (this chunk really did hit
  // EOF) is safe to call complete.
  const gotFullCap = chunk.length >= (end - start + 1);
  if (match || gotFullCap) {
    headers['Content-Range'] = `bytes ${start}-${start + chunk.length - 1}/*`;
    return new Response(body, { status: 206, headers });
  }
  return new Response(body, { status: 200, headers });
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
  if (parsed.source === 'local') {
    // Extension allowlist — without it, any script running in the renderer
    // origin (including a compromised/malicious plugin's renderer.js,
    // loaded into this same window) could read an arbitrary file anywhere
    // on disk by absolute path via ?p=. This only means anything for a
    // real local filesystem path.
    if (!LAN_MEDIA_EXTENSIONS.has(path.extname(parsed.path).toLowerCase())) {
      return new Response('Forbidden', { status: 403, headers: corsHeaders });
    }
    return serveFile(path.normalize(parsed.path), rangeHeader, crossOrigin);
  }
  // A plugin-sourced ref has no such thing to protect against: it's an
  // opaque identifier the provider itself defines the meaning of (a Drive
  // file id, a WebDAV path, whatever), not a raw filesystem path this
  // process would ever open directly — dispatch already goes through
  // assertKnownProvider (main-media-dispatch.js, only an approved,
  // activated provider id is ever reachable) and then the provider's own
  // access control (e.g. Drive's OAuth scope only exposes files the signed-
  // in user authorized). Extension-checking `parsed.ref` doesn't add a real
  // boundary here and actively breaks any provider whose refs aren't
  // extension-shaped at all — most cloud/API-based sources' opaque file
  // ids — which is every real provider except a raw-path-shaped one like
  // WebDAV/SMB. Found live: a provider whose ref is a bare opaque file id
  // 403'd unconditionally, since `path.extname(someOpaqueId)` is always ''
  // and can never match the allowlist.
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
  const src = Readable.fromWeb(response.body);
  // A client that aborts (video seeking does this constantly) must release the
  // file handle, and a mid-stream read error must not become an uncaught throw.
  res.on('close', () => src.destroy());
  src.on('error', () => { res.destroy(); });
  src.pipe(res);
}

module.exports = {
  registerAppSchemePrivileges, registerAppProtocol, serveFile, serveMediaRef, setMediaDispatchServices,
  setAllowedMediaSrcPorts, pipeWebResponse, mimeFor, MIME_TYPES,
};
