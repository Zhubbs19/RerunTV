// Pure path/config helpers for the channel-health relink workflow. Kept out
// of the DOM module so root replacement and reference migration can be
// tested without launching Electron.

function trimTrailingSeparators(value) {
  return String(value || '').replace(/[\\/]+$/, '');
}

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
