// Pure update-history transformations. Kept free of Electron/filesystem
// dependencies so the important old-version -> new-version behavior can be
// exercised without launching or installing the app.
/**
 * Flattens electron-updater's release notes (a string, or a list of `{ version, note }`) into plain text.
 * @param {*} notes The release notes.
 * @returns {string} The text, possibly empty.
 */
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

/**
 * Records a version change as a pending post-update notice, using the downloaded release's notes when they match; a first run only sets the baseline.
 * @param {object} state The update state, changed in place.
 * @param {string} currentVersion The running app version.
 * @returns {object} The same state.
 */
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

/**
 * Stores a downloaded release's name, notes and date for the notice after it installs.
 * @param {object} state The update state, changed in place.
 * @param {object} info electron-updater's update info.
 * @returns {object} The same state.
 */
function rememberDownloadedRelease(state, info) {
  state.downloadedRelease = {
    version: info.version,
    name: info.releaseName || `RerunTV v${info.version}`,
    notes: releaseNotesText(info.releaseNotes),
    publishedAt: info.releaseDate || null,
  };
  return state;
}

const UPDATE_STRATEGIES = Object.freeze([
  'startup-auto',
  'background-auto',
  'background-notify',
  'manual',
  'off',
]);

/**
 * One update policy describes both when a check happens and what happens
 * after download. Older configs used two overlapping fields (mode and
 * showLaunchPopup); preserve their exact behavior when migrating instead of
 * silently turning an existing user's background check into a launch gate.
 * @param {?object} updates The config's `updates` section.
 * @returns {string} One of `UPDATE_STRATEGIES`.
 */
function normalizeUpdateStrategy(updates) {
  const value = updates && updates.strategy;
  if (UPDATE_STRATEGIES.includes(value)) return value;
  const legacyMode = updates && updates.mode;
  if (legacyMode === 'off') return 'off';
  if (legacyMode === 'manual') return 'manual';
  if (legacyMode === 'auto') {
    return updates.showLaunchPopup === false ? 'background-auto' : 'background-notify';
  }
  return 'startup-auto';
}

/**
 * Why this build can't auto-update, or null when it can.
 * Only the Windows NSIS installer is published with update metadata
 * (latest.yml). Other packaged builds, such as the experimental Linux
 * AppImage, would ask GitHub for a feed that doesn't exist and report an
 * error on every launch.
 * @param {object} opts Build facts.
 * @param {boolean} opts.isPackaged Whether this is a packaged build.
 * @param {string} opts.platform `process.platform`.
 * @returns {?string} 'dev-mode', 'unsupported-platform', or null.
 */
function updateUnavailableReason({ isPackaged, platform }) {
  if (!isPackaged) return 'dev-mode';
  if (platform !== 'win32') return 'unsupported-platform';
  return null;
}

module.exports = {
  updateUnavailableReason,
  UPDATE_STRATEGIES,
  normalizeUpdateStrategy,
  prepareVersionTransition,
  rememberDownloadedRelease,
  releaseNotesText,
};
