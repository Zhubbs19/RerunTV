// Pure update-history transformations. Kept free of Electron/filesystem
// dependencies so the important old-version -> new-version behavior can be
// exercised without launching or installing the app.
function releaseNotesText(notes) {
  if (typeof notes === 'string') return notes.trim();
  const list = Array.isArray(notes) ? notes : (notes && typeof notes === 'object' ? [notes] : []);
  return list.map((note) => {
    if (typeof note === 'string') return note;
    if (!note || typeof note !== 'object') return '';
    const heading = note.version ? `Version ${note.version}` : '';
    return [heading, note.note || ''].filter(Boolean).join('\n');
  }).filter(Boolean).join('\n\n').trim();
}

function prepareVersionTransition(state, currentVersion) {
  if (!state.lastSeenVersion) {
    state.lastSeenVersion = currentVersion;
    return state;
  }
  if (state.lastSeenVersion === currentVersion) return state;
  const downloaded = state.downloadedRelease && state.downloadedRelease.version === currentVersion
    ? state.downloadedRelease : null;
  state.pendingNotice = {
    fromVersion: state.lastSeenVersion,
    toVersion: currentVersion,
    name: downloaded && downloaded.name,
    notes: downloaded && downloaded.notes,
    publishedAt: downloaded && downloaded.publishedAt,
  };
  state.lastSeenVersion = currentVersion;
  delete state.downloadedRelease;
  return state;
}

function rememberDownloadedRelease(state, info) {
  state.downloadedRelease = {
    version: info.version,
    name: info.releaseName || `RerunTV v${info.version}`,
    notes: releaseNotesText(info.releaseNotes),
    publishedAt: info.releaseDate || null,
  };
  return state;
}

module.exports = { prepareVersionTransition, rememberDownloadedRelease, releaseNotesText };
