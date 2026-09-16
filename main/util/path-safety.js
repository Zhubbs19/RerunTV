// Tiny path-sandboxing helpers shared by every place in this app that serves
// or writes files scoped to a root directory it doesn't fully trust the
// caller not to try to escape (app://plugins, app://bundle, the LAN
// viewer's static assets, a plugin's own dataDir, a plugin zip's
// extraction target). Pure Node, no Electron dependency — same reasoning
// as main-mime.js/main-http-util.js/main-lan.js, so it can be required
// unchanged from an isolated plugin's own forked process
// (plugin-isolation-runtime.js) as well as the host.
const path = require('path');

// True if `resolved` is `base` itself or somewhere inside it. A string-prefix
// check, not a directory walk — caller must pass already path.resolve()'d/
// normalize()'d paths, since this does no normalization of its own.
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
