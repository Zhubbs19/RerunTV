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
const { callAnyService } = require('./main-plugin-isolation');

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
// main-protocol.js's serveFileViaPlugin) — a slow remote fetch can
// legitimately take longer than rpc-channel.js's 20s default.
const MEDIA_READRANGE_TIMEOUT_MS = 45000;
const MEDIA_CHECK_TIMEOUT_MS = 10000;

// `pluginServices` is the same shared object every other cross-process
// plugin call already resolves against (main.js's `services`) — passed in
// by each call site rather than imported, since main-media-dispatch.js has
// no reason to hold its own reference to it.
function callMediaService(pluginServices, providerId, verb, args, timeoutMsOverride) {
  assertKnownProvider(providerId);
  return callAnyService(pluginServices, `mediaSource:${providerId}:${verb}`, args, timeoutMsOverride);
}

module.exports = {
  parseMediaRef,
  wrapMediaRef,
  setApprovedMediaSourceProviders,
  callMediaService,
  MEDIA_LIST_TIMEOUT_MS,
  MEDIA_PROBE_TIMEOUT_MS,
  MEDIA_READRANGE_TIMEOUT_MS,
  MEDIA_CHECK_TIMEOUT_MS,
};
