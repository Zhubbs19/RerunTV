const RENAME_DURATION_TOLERANCE = 2.25;

function extension(ref) {
  const clean = String(ref || '').split(/[?#]/)[0];
  const match = /\.([a-z0-9]+)$/i.exec(clean);
  return match ? match[1].toLowerCase() : '';
}

// Match only reciprocal single-candidate pairs. Ambiguous similarly-sized
// episodes remain an addition + missing report instead of inheriting the
// wrong title metadata.
export function detectUnambiguousRenames(missing, added) {
  const candidates = new Map();
  missing.forEach((oldFile) => {
    const matches = added.filter((newFile) => extension(oldFile.path) === extension(newFile.path)
      && Number.isFinite(oldFile.duration) && Number.isFinite(newFile.duration)
      && Math.abs(oldFile.duration - newFile.duration) <= RENAME_DURATION_TOLERANCE);
    candidates.set(oldFile, matches);
  });
  const pairs = [];
  missing.forEach((oldFile) => {
    const matches = candidates.get(oldFile);
    if (matches.length !== 1) return;
    const newFile = matches[0];
    const reverse = missing.filter((candidate) => (candidates.get(candidate) || []).includes(newFile));
    if (reverse.length === 1) pairs.push({ oldFile, newFile });
  });
  return pairs;
}

export function reconcileFolderFiles(files, scanned, folderId, removeMissing) {
  const tracked = files.filter((file) => file.folder === folderId);
  const scannedPaths = new Set(scanned.map((file) => file.path));
  const trackedPaths = new Set(files.map((file) => file.path));
  const missing = tracked.filter((file) => !scannedPaths.has(file.path));
  // A new file whose duration couldn't be probed is left out (and reported as
  // unprobed) rather than stored with a guessed length; the next sync retries it.
  const fresh = scanned.filter((file) => !trackedPaths.has(file.path));
  const unprobed = fresh.filter((file) => !(file.duration > 0));
  const added = fresh.filter((file) => file.duration > 0);
  const renames = detectUnambiguousRenames(missing, added);
  const renamedOld = new Set(renames.map((pair) => pair.oldFile));
  const renamedNew = new Set(renames.map((pair) => pair.newFile));
  const unresolvedMissing = missing.filter((file) => !renamedOld.has(file));
  const unresolvedAdded = added.filter((file) => !renamedNew.has(file));
  const replacements = new Map(renames.map(({ oldFile, newFile }) => [oldFile, {
    ...oldFile, path: newFile.path, source: newFile.source || oldFile.source || 'local', duration: newFile.duration || oldFile.duration,
  }]));
  const next = files.flatMap((file) => {
    if (replacements.has(file)) return [replacements.get(file)];
    if (removeMissing && unresolvedMissing.includes(file)) return [];
    return [file];
  });
  unresolvedAdded.forEach((file) => next.push({
    path: file.path, duration: file.duration, folder: folderId, source: file.source || 'local',
  }));
  return { files: next, added: unresolvedAdded, missing: unresolvedMissing, renames, unprobed };
}
