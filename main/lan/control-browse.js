// Host folder browsing for the LAN control panel (docs/design/06 §5).
//
// A control client has no native file dialog: it is a browser in another room.
// Adding a folder channel there means asking the HOST what is on its disks. So
// this is a directory listing API, and the whole of its design is about what it
// refuses to list.
//
// Two ideas do the work:
//
//   * ROOTS. Nothing outside a root is listable, ever. Roots are the
//     directories this config already refers to — a control client can already
//     see those paths in /api/control/config, so listing inside them tells it
//     nothing new — plus whatever the person at the host has explicitly added
//     under `network.controlBrowseRoots`. That setting is itself in the
//     remote-denied list (main/config/host.js), so a remote editor cannot widen
//     its own reach.
//   * CONTAINMENT. Every requested path is resolved and then checked against
//     the roots with isPathContained, after normalization, so `..`, a symlink's
//     textual name, or a UNC path cannot walk out.
//
// Electron-free, so it can be tested directly.
const fs = require('fs');
const path = require('path');
const { isPathContained } = require('../util/path-safety');

// A listing never returns more than this many entries. A media folder with
// tens of thousands of files should not become a single enormous JSON body on
// a LAN link; the client sees the cap and the count it was truncated from.
const MAX_ENTRIES = 2000;

// rootsFromConfig runs on every browse request and used to stat every path in
// the config synchronously on the main thread. Whether a path is a directory
// rarely changes, so remember the answer briefly, keyed by the path string
// itself (a different config or a renamed path is simply a different key).
const DIR_CACHE_TTL_MS = 30 * 1000;
const DIR_CACHE_MAX = 5000;
const dirCache = new Map(); // normalized path -> { isDir: boolean|null, at }

function isDirectoryCached(candidate) {
  const now = Date.now();
  const hit = dirCache.get(candidate);
  if (hit && now - hit.at < DIR_CACHE_TTL_MS) return hit.isDir;
  let isDir = null; // null: could not stat (missing, unreadable)
  try { isDir = fs.statSync(candidate).isDirectory(); } catch (e) { /* leave null */ }
  if (dirCache.size >= DIR_CACHE_MAX) dirCache.clear();
  dirCache.set(candidate, { isDir, at: now });
  return isDir;
}

// Walks config for every path-shaped string and keeps the directories they
// live in. A file contributes its parent; a folder entry contributes itself.
function rootsFromConfig(config) {
  const roots = new Set();
  const looksLikePath = (value) => typeof value === 'string'
    && (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/'));
  const visit = (node, key) => {
    if (typeof node === 'string') {
      if (!looksLikePath(node)) return;
      // `folders` entries are directories; everything else is a file whose
      // directory is what matters. Guessing wrong only ever adds the parent of
      // a directory, so resolve it by asking the filesystem when it is cheap
      // to, and fall back to the parent when it is not.
      let candidate = path.normalize(node);
      const isDir = isDirectoryCached(candidate);
      if (isDir === false || (isDir === null && key !== 'folders')) candidate = path.dirname(candidate);
      roots.add(path.resolve(candidate));
      return;
    }
    if (Array.isArray(node)) { node.forEach((child) => visit(child, key)); return; }
    if (node && typeof node === 'object') Object.entries(node).forEach(([childKey, child]) => visit(child, childKey));
  };
  visit(config, '');
  return roots;
}

// Explicit roots the person at the host added. Only absolute paths count; a
// relative one would resolve against wherever the process happens to be.
function configuredRoots(config) {
  const declared = config && config.network && config.network.controlBrowseRoots;
  if (!Array.isArray(declared)) return [];
  return declared
    .filter((entry) => typeof entry === 'string' && path.isAbsolute(entry))
    .map((entry) => path.resolve(path.normalize(entry)));
}

// The roots a control client may browse, with any root that is inside another
// dropped — keeping both would list the same tree twice and make the top level
// read as if there were more separate places than there are.
function browseRoots(config) {
  const all = [...configuredRoots(config), ...rootsFromConfig(config)];
  return all
    .filter((root, index) => all.every((other, otherIndex) => otherIndex === index || !isPathContained(other, root) || other === root))
    .filter((root, index, list) => list.indexOf(root) === index)
    .sort();
}

function withinRoots(roots, target) {
  return roots.some((root) => isPathContained(root, target));
}

// Lists one directory. `target` null means "the roots themselves", which is the
// top level a client starts at — there is no single filesystem root here on
// purpose, because there is no single place a lineup's media lives.
function listDirectory(config, target, { extensions = null } = {}) {
  const roots = browseRoots(config);
  if (!target) {
    return {
      path: null,
      parent: null,
      roots,
      entries: roots.map((root) => ({ name: root, path: root, directory: true })),
      truncated: false,
    };
  }
  const resolved = path.resolve(path.normalize(target));
  if (!withinRoots(roots, resolved)) {
    // Deliberately the same answer for "outside the roots" and "does not
    // exist": a client must not be able to map the host's disks by probing.
    return { error: 'That folder is not one this host shares.' };
  }
  let dirents;
  try {
    dirents = fs.readdirSync(resolved, { withFileTypes: true });
  } catch (e) {
    return { error: 'That folder could not be read.' };
  }
  const all = dirents
    .filter((entry) => !entry.name.startsWith('.'))
    .map((entry) => {
      const directory = entry.isDirectory();
      return { name: entry.name, path: path.join(resolved, entry.name), directory };
    })
    .filter((entry) => entry.directory || !extensions || extensions.has(path.extname(entry.name).toLowerCase()))
    .sort((a, b) => (a.directory === b.directory ? a.name.localeCompare(b.name) : (a.directory ? -1 : 1)));

  // Only offer a parent while it is still inside a root, so the listing cannot
  // be used to climb out one level at a time.
  const parent = path.dirname(resolved);
  return {
    path: resolved,
    parent: parent !== resolved && withinRoots(roots, parent) ? parent : null,
    roots,
    entries: all.slice(0, MAX_ENTRIES),
    truncated: all.length > MAX_ENTRIES,
    total: all.length,
  };
}

module.exports = { listDirectory, browseRoots, rootsFromConfig, configuredRoots, MAX_ENTRIES };
