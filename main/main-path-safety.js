// Tiny path-sandboxing helpers shared by every place in this app that serves
// or writes files scoped to a root directory it doesn't fully trust the
// caller not to try to escape (app://plugins, app://bundle, the LAN
// viewer's static assets, a plugin's own dataDir, a plugin zip's
// extraction target). Pure Node, no Electron dependency — same reasoning
// as main-mime.js/main-http-util.js/main-lan.js, so it can be required
// unchanged from an isolated plugin's own forked process
// (plugin-isolation-runtime.js) as well as the host.
const path = require('path');

// True if `resolved` (an already path.resolve()'d/path.normalize()'d path)
// is `base` itself or somewhere inside it. Every call site independently
// re-derived this exact check by hand before it lived here — comparing
// string prefixes rather than, say, walking `resolved`'s directories, so
// `base` and `resolved` must both already be normalized/resolved by the
// caller (this does no normalization of its own) for the comparison to be
// meaningful.
function isPathContained(base, resolved) {
  return resolved === base || resolved.startsWith(base + path.sep);
}

// Windows executables carry a .exe suffix a manifest author shouldn't have
// to declare twice (once for dev, once for a packaged Windows build) — a
// declared "ffmpeg" matches a spawned "ffmpeg.exe" and vice versa.
function stripExeSuffix(basename) {
  return basename.toLowerCase().endsWith('.exe') ? basename.slice(0, -4).toLowerCase() : basename.toLowerCase();
}

module.exports = { isPathContained, stripExeSuffix };
