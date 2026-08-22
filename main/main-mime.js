// File-extension -> Content-Type lookup. Split out of main-protocol.js
// (which needs `electron` for the app:// scheme itself) so this one function
// has zero Electron dependency — that's what lets it be require()'d directly
// from an isolated plugin's own forked utilityProcess (main-plugin-isolation.js),
// which never gets the `electron` module, instead of round-tripping every
// static-file request back to the host process just to look up a MIME type.
const path = require('path');

const MIME_TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
  '.mov': 'video/quicktime', '.ogv': 'video/ogg',
};

function mimeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

module.exports = { mimeFor, MIME_TYPES };
