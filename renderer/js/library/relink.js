// Pure path/config helpers for the channel-health relink workflow. Kept out
// of the DOM module so root replacement and reference migration can be
// tested without launching Electron.

/**
 * Removes trailing path separators.
 * @param {*} value A path.
 * @returns {string} The path without trailing slashes or backslashes.
 */
function trimTrailingSeparators(value) {
  return String(value || '').replace(/[\\/]+$/, '');
}

/**
 * Moves a path from one root folder to another, case-insensitively.
 * @param {string} filePath The path to move.
 * @param {string} oldRoot The root it should sit under.
 * @param {string} newRoot The root to move it to.
 * @returns {?string} The new path, or `null` when it is not under `oldRoot`.
 */
export function replaceLocalRoot(filePath, oldRoot, newRoot) {
  const path = String(filePath || '');
  const oldBase = trimTrailingSeparators(oldRoot);
  const newBase = trimTrailingSeparators(newRoot);
  if (!path || !oldBase || !newBase) return null;
  const lowerPath = path.toLocaleLowerCase();
  const lowerRoot = oldBase.toLocaleLowerCase();
  if (lowerPath !== lowerRoot && !lowerPath.startsWith(`${lowerRoot}\\`) && !lowerPath.startsWith(`${lowerRoot}/`)) return null;
  const suffix = path.slice(oldBase.length).replace(/^[\\/]+/, '');
  const separator = newBase.includes('\\') ? '\\' : '/';
  return suffix ? `${newBase}${separator}${suffix.replace(/[\\/]+/g, separator)}` : newBase;
}

/**
 * Points every reference to a local folder at a new root, in place.
 * Walks the whole config: folder entries with the old id and root, and file entries in that folder.
 * @param {object} config The box config, changed in place.
 * @param {object} relink The relink.
 * @param {string} relink.oldId The folder entry's current id.
 * @param {string} relink.oldRoot The folder's current path.
 * @param {string} relink.newId The folder entry's new id.
 * @param {string} relink.newRoot The folder's new path.
 * @returns {object} `{ folderEntries, fileReferences }` counts.
 */
export function applyLocalFolderRelink(config, { oldId, oldRoot, newId, newRoot }) {
  let folderEntries = 0;
  let fileReferences = 0;
  const seen = new Set();

  function visit(value) {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);

    if (value.id === oldId && value.source === 'local' && value.ref === oldRoot) {
      value.id = newId;
      value.ref = newRoot;
      folderEntries += 1;
    }
    if (value.folder === oldId && (value.source == null || value.source === 'local') && typeof value.path === 'string') {
      const replacement = replaceLocalRoot(value.path, oldRoot, newRoot);
      if (replacement) {
        value.path = replacement;
        value.folder = newId;
        fileReferences += 1;
      }
    }
    Object.values(value).forEach(visit);
  }

  visit(config);
  return { folderEntries, fileReferences };
}
