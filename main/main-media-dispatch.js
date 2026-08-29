// Media-source abstraction — dispatch layer shared by every IPC/protocol
// handler that used to assume "this ref is always a local filesystem path"
// (fs:scanFolder, media:probeDuration, the app://media protocol handler,
// fs:checkPathsExist, media:resolvePlayablePath/media:transcode). A ref is
// either a bare local path (unchanged, every existing config's files parse
// this way by construction) or a `mediasource:<providerId>:<opaque-ref>`
// string — see parseMediaRef below. Local refs keep the exact pre-existing
// code path in each of those handlers; non-local refs route through here to
// whichever plugin registered that providerId, via the same
// ctx.registerService/ctx.callService RPC main-plugin-isolation.js already
// proves out for cross-process plugin calls (party-channel's route
// dispatch, cross-plugin service calls) — no new IPC mechanism invented.
//
// A media-source plugin's activate(ctx) registers four services, keyed
// `mediaSource:<providerId>:<verb>`:
//   list(folderRef)              -> { refs: string[] } | { error }
//   probe(ref)                   -> { duration } | { error }        (seconds)
//   readRange(ref, start, end)   -> { status, contentType?, totalSize?, chunk: Buffer }
//   checkAvailable(ref)          -> boolean
// All four must be registered together — a plugin declaring the
// `mediaSource` capability but only implementing some of them is a plugin
// bug; this layer does not silently fall back to local behavior for a
// missing verb, it surfaces the call failure.
//
// Flagged, not silently resolved: outbound network calls a provider makes
// to actually fetch media aren't gated by anything today — the existing
// `net` capability only covers a plugin's own inbound listen port, and
// isolated plugins' Node --experimental-permission flags
// (main-plugin-isolation.js's buildExecArgv) only cover fs/child-process,
// not outbound network. Not new to this feature, but worth stating plainly
// here since "reach an arbitrary external host to fetch binary data" is
// this feature's entire point rather than an edge case.
const fs = require('fs');
const { callAnyService } = require('./main-plugin-isolation');
const {
  scanFolderForVideos, recoverPendingSwap, backupPathFor, transcodeVideo,
} = require('./main-media');
const { VIEWER_PORT } = require('./main-lan');

// providerId -> pluginId, for every mediaSource capability entry belonging
// to a plugin that actually activated this boot (set once, right after
// loadMainPlugins() resolves — see main.js). Checked before every dispatch
// call so a `mediasource:<providerId>:...` ref whose providerId was never
// actually declared/approved fails fast with a clear error instead of a
// confusing "no service published" one from deeper in callAnyService, and
// so a malformed/spoofed ref in a hand-edited config can't be used to probe
// for providers that don't exist.
let approvedProviders = {};

function setApprovedMediaSourceProviders(map) {
  approvedProviders = map || {};
}

// A local ref is any string that doesn't match the mediasource: scheme
// prefix — every existing config's raw local path parses as 'local' by
// construction, so this needs no migration flag or version marker of its
// own. `ref` (the opaque part after the second colon) can itself contain
// colons (e.g. a Windows drive letter path, a URL) — captured greedily via
// [\s\S]* rather than a colon-excluding class.
function parseMediaRef(ref) {
  const m = /^mediasource:([a-zA-Z0-9_-]+):([\s\S]*)$/.exec(ref);
  if (!m) return { source: 'local', path: ref };
  return { source: m[1], ref: m[2] };
}

// Wraps a provider's own natural, unprefixed ref (whatever list()/readRange
// etc. work with — e.g. a WebDAV path or a Drive file id) with the
// mediasource: scheme prefix so it round-trips through ch.files[].path and
// back through parseMediaRef correctly. A provider author never constructs
// this themselves — it's applied once, here, at the point a ref first
// enters config (fs:scanFolder's non-local branch, main.js).
function wrapMediaRef(providerId, rawRef) {
  return `mediasource:${providerId}:${rawRef}`;
}

function assertKnownProvider(providerId) {
  if (!approvedProviders[providerId]) {
    throw new Error(`No approved, activated plugin declares media source provider "${providerId}".`);
  }
}

// Generous relative to rpc-channel.js's 20s default — probing/listing is a
// network round-trip to a remote provider, not a local decode, and doesn't
// share probeDuration's (setup-util.js) 4s local-<video>-element budget.
const MEDIA_LIST_TIMEOUT_MS = 20000;
const MEDIA_PROBE_TIMEOUT_MS = 8000;
// Bounds one Range-request round-trip for streaming playback (see
// main-protocol.js's serveFileViaPlugin). Deliberately generous — a
// provider's readRange isn't guaranteed to be a quick live fetch; a
// provider that internally caches to local disk before it can serve
// anything (see PLUGIN_DEVELOPMENT.md's "Media sources" section,
// getFetchProgress/getLocalCachePath) can legitimately need several
// minutes for a large file's first access. A tighter timeout here would
// turn "still preparing, working as intended" into a spurious RPC timeout
// error for exactly the case this generous bound exists to make reliable.
const MEDIA_READRANGE_TIMEOUT_MS = 10 * 60 * 1000;
const MEDIA_CHECK_TIMEOUT_MS = 10000;

// `pluginServices` is the same shared object every other cross-process
// plugin call already resolves against (main.js's `services`) — passed in
// by each call site rather than imported, since main-media-dispatch.js has
// no reason to hold its own reference to it.
function callMediaService(pluginServices, providerId, verb, args, timeoutMsOverride) {
  assertKnownProvider(providerId);
  return callAnyService(pluginServices, `mediaSource:${providerId}:${verb}`, args, timeoutMsOverride);
}

// `deps.getPluginServicesRef`/`deps.getViewerProjectionRef` are accessors,
// not raw values — both are `let`s in main.js reassigned once inside
// app.whenReady() (pluginServicesRef right away, viewerProjectionRef only if
// the LAN viewer service is enabled), well after this is called, so a
// snapshot taken at registration time would silently stay stale forever.
function registerMediaDispatchIpc(ipcMain, { getPluginServicesRef, getViewerProjectionRef }) {
  // Local stays the exact pre-existing implementation, unchanged. A
  // non-local source dispatches to that plugin's registered `list` service
  // instead — see this file's header comment for the full contract. The
  // plugin's own raw refs are wrapped with the mediasource:<id>: prefix
  // here, once, so a provider author never has to think about that
  // bookkeeping.
  ipcMain.handle('fs:scanFolder', async (event, source, folderRef) => {
    if (!source || source === 'local') return scanFolderForVideos(folderRef);
    const result = await callMediaService(getPluginServicesRef(), source, 'list', [folderRef], MEDIA_LIST_TIMEOUT_MS);
    if (!result || result.error) return [];
    return (result.refs || []).map((r) => wrapMediaRef(source, r));
  });

  // A plugin-sourced ref can't be probed via the renderer's <video>-element
  // trick (setup-util.js's probeDuration), since there's no playback
  // dispatch path for it independent of this call in the first place. Local
  // returns null, which setup-util.js's probeDurationForEntry reads as "fall
  // back to the existing renderer-side <video> probe" — the local path is
  // untouched by this feature at all, not just unchanged in behavior.
  ipcMain.handle('media:probeDuration', async (event, source, ref) => {
    if (!source || source === 'local') return null;
    try {
      const result = await callMediaService(getPluginServicesRef(), source, 'probe', [ref], MEDIA_PROBE_TIMEOUT_MS);
      return (result && typeof result.duration === 'number') ? result.duration : 180;
    } catch (e) { return 180; } // same fallback probeDuration already uses for a local decode timeout/error
  });

  // Cheap existence-only check (no decode, no ffprobe) — used by the setup
  // screen's CHECK CHANNELS health scan to flag files whose paths no longer
  // resolve (moved/renamed/deleted media), distinct from FIX PLAYBACK's much
  // heavier per-file decode probe which only ever runs one channel at a
  // time. `entries` is [{source, ref}] — a non-local entry's "still there"
  // check is necessarily a network round-trip per provider's own
  // checkAvailable, so a provider being unreachable/disabled is treated the
  // same as a missing local file (an honest "not available" here) rather
  // than surfacing as a distinct error state the setup UI has no way to
  // show anyway.
  ipcMain.handle('fs:checkPathsExist', async (event, entries) => {
    // Async + concurrent rather than a serial existsSync loop — a library
    // with dozens-to-hundreds of files would otherwise block this whole
    // process (window, every LAN request, every other IPC call) for the
    // scan's entire duration, one blocking syscall at a time.
    return Promise.all((entries || []).map(async (e) => {
      const source = e && e.source;
      const ref = e && typeof e === 'object' ? e.ref : e; // tolerate a bare path string too
      if (!source || source === 'local') {
        try { await fs.promises.access(ref); return true; } catch (err) { return false; }
      }
      try { return !!(await callMediaService(getPluginServicesRef(), source, 'checkAvailable', [ref], MEDIA_CHECK_TIMEOUT_MS)); } catch (err) { return false; }
    }));
  });

  // Media goes through the app:// media host rather than file://, since the
  // renderer's origin is no longer file:// and Chromium won't load file://
  // subresources from it.
  ipcMain.handle('path:toFileUrl', async (event, filePath) => {
    // A media-source-plugin ref (still-prefixed, i.e. not yet resolved to a
    // real local cache path by resolvePlayablePath) is routed through the
    // LAN viewer's own already-running, genuine http.Server
    // (main-viewer-server.js — same /media route a LAN viewer device
    // already uses, which happens to already dispatch through
    // serveMediaRef the exact same way app://media does) instead of
    // Electron's custom app:// protocol.handle. Found live: Chromium's
    // <video> element never issues a follow-up Range request through
    // app://media for a plugin-backed resource, no matter what's in the
    // response — but does for a genuine local file through that same
    // handler, and (this is what's being tested) may behave like any other
    // ordinary HTTP video URL when the exact same data is served through a
    // real loopback HTTP connection instead of Electron's Response-based
    // custom-protocol dispatch. Local refs are untouched — zero behavior
    // change, same app://media path proven reliable for every local
    // channel.
    if (parseMediaRef(filePath).source !== 'local') {
      // The /media route only recognizes opaque viewer: ids minted via the
      // projection map (main-viewer-projection.js) — it does not accept a
      // raw path/ref under ?p=. Register this ref the same way
      // project()ing a config for a LAN viewer would, so the host window's
      // own request resolves instead of always 400ing.
      const viewerProjectionRef = getViewerProjectionRef();
      const id = viewerProjectionRef ? viewerProjectionRef.registerRef(filePath) : filePath;
      return `http://127.0.0.1:${VIEWER_PORT}/media?id=${encodeURIComponent(id)}`;
    }
    return `app://media/?p=${encodeURIComponent(filePath)}`;
  });

  // Cheap check only — never spawns ffmpeg. srcPath is always the path to
  // play; alreadyFixed tells the caller whether it's already the swapped-in
  // H.264 copy (a backup exists), so a further playback failure is a real
  // error rather than something a transcode could fix. Explicit no-op for a
  // non-local source, per media-source-abstraction design: there's no local
  // file to rename-swap a transcoded copy into, so `transcodable: false`
  // here tells playback.js's handleUnplayable() not to attempt the FIX
  // PLAYBACK flow at all rather than trying and failing at it.
  ipcMain.handle('media:resolvePlayablePath', async (event, source, srcPath) => {
    if (source && source !== 'local') {
      // Once a media-source plugin has a file fully cached to local disk
      // (getLocalCachePath, an optional verb alongside getFetchProgress —
      // see PLUGIN_DEVELOPMENT.md's "Media sources" section), redirect
      // playback to that real local path instead of continuing to serve it
      // as a live plugin stream. Found live: Chromium's <video> element
      // never issues a follow-up Range request through the app://media
      // custom protocol for a plugin-backed resource — exactly one
      // request, regardless of what's in the response — even though it
      // happily makes many for a genuine local file through that same
      // protocol. Rather than keep chasing that, once the bytes are
      // actually on disk there's no reason to route through the
      // RPC-per-chunk path at all: toFileUrl'ing a real local path here
      // means main-protocol.js's parseMediaRef sees it as source:'local'
      // and serves it via serveFile — the exact, already-proven-reliable
      // code path every local channel already uses.
      try {
        const { ref } = parseMediaRef(srcPath);
        const localPath = await callMediaService(getPluginServicesRef(), source, 'getLocalCachePath', [ref], MEDIA_CHECK_TIMEOUT_MS);
        if (localPath) {
          // Genuinely a local file now (in the plugin's own cache dir, but
          // a real file on this disk ffmpeg can read/write same as any
          // other) — full local-file treatment, auto-fix included, not the
          // can't-be-auto-fixed messaging that's still correct for a file
          // that's actually still a live plugin stream.
          recoverPendingSwap(localPath);
          return { path: localPath, alreadyFixed: fs.existsSync(backupPathFor(localPath)), transcodable: true };
        }
      } catch (e) { /* provider doesn't implement getLocalCachePath, or isn't cached yet — fall through */ }
      return { path: srcPath, alreadyFixed: false, transcodable: false };
    }
    recoverPendingSwap(srcPath);
    return { path: srcPath, alreadyFixed: fs.existsSync(backupPathFor(srcPath)), transcodable: true };
  });

  // The actual transcode/swap logic (spawning ffmpeg, the backup-then-promote
  // rename dance, retrying a Windows rename that loses a race with a still-
  // closing file handle) lives in main-media.js's transcodeVideo() — this
  // handler is just the IPC surface for it. A non-local source has no local
  // file for that rename dance to operate on at all — surfaced as a clear,
  // specific error rather than attempting local rename semantics against an
  // opaque plugin ref (which would just throw confusingly inside
  // transcodeVideo instead).
  ipcMain.handle('media:transcode', async (event, source, srcPath) => {
    if (source && source !== 'local') {
      return { error: "This file is served by a plugin media source and can't be codec-fixed in place — try re-encoding it at the source, or copying it locally first." };
    }
    return transcodeVideo(srcPath);
  });
}

module.exports = {
  parseMediaRef,
  wrapMediaRef,
  setApprovedMediaSourceProviders,
  callMediaService,
  registerMediaDispatchIpc,
  MEDIA_LIST_TIMEOUT_MS,
  MEDIA_PROBE_TIMEOUT_MS,
  MEDIA_READRANGE_TIMEOUT_MS,
  MEDIA_CHECK_TIMEOUT_MS,
};
