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

// Walks config for the directories it refers to, WITHOUT touching the
// filesystem: this runs on every browse request on the main thread, and a
// config can hold thousands of paths. Only string values under keys that name a
// folder or a file count (a title that happens to look like a path does not),
// and only absolute paths. A folder key contributes itself; a file key
// contributes its parent directory (a value with no extension is taken to be a
// folder, since guessing it is a file would only ever widen the root to its
// parent).
const FOLDER_KEY = /^(?:folders?|dirs?|directory|directories|roots?|[A-Za-z]*(?:Folders?|Dirs?|Directory))$/;
const FILE_KEY = /^(?:path|file|src|[A-Za-z]*(?:Path|File))$/;

function absolutePathOrNull(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.startsWith('mediasource:')) return null;
  return path.isAbsolute(value) || value.startsWith('\\') ? path.normalize(value) : null;
}

function rootsFromConfig(config) {
  const roots = new Set();
  const addString = (key, value) => {
    const absolute = absolutePathOrNull(value);
    if (!absolute) return;
    if (FOLDER_KEY.test(key)) roots.add(path.resolve(absolute));
    else if (FILE_KEY.test(key)) roots.add(path.resolve(path.extname(absolute) ? path.dirname(absolute) : absolute));
  };
  const visit = (node, key, depth) => {
    if (depth > 12) return;
    if (typeof node === 'string') { addString(key, node); return; }
    if (Array.isArray(node)) { node.forEach((child) => visit(child, key, depth + 1)); return; }
    if (node && typeof node === 'object') Object.entries(node).forEach(([childKey, child]) => visit(child, childKey, depth + 1));
  };
  visit(config, '', 0);
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
  // `network.controlBrowseRoots` is an allow-list when the person at the host
  // has set one: only those trees are browsable, and a directory the lineup
  // happens to reference is offered only if it lies inside one of them. With
  // none set, the lineup's own directories are the roots.
  const declared = configuredRoots(config);
  const derived = [...rootsFromConfig(config)];
  const all = declared.length
    ? [...declared, ...derived.filter((root) => declared.some((allowed) => isPathContained(allowed, root)))]
    : derived;
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
