// Reads and writes window-state.json (the main window's bounds and maximized flag) in userData.

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { atomicWriteFileSync } = require('../util/atomic-write');

/**
 * Path of window-state.json in the current userData folder.
 * @returns {string} Absolute path of window-state.json.
 */
function getWindowStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

/**
 * Reads the saved window state.
 * @returns {?object} The saved state, or null when missing or unreadable.
 */
function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(getWindowStatePath(), 'utf-8'));
  } catch (e) {
    return null;
  }
}

/**
 * Writes the window state atomically. Errors are ignored.
 * @param {object} state The state to save.
 */
function saveWindowState(state) {
  try {
    atomicWriteFileSync(getWindowStatePath(), JSON.stringify(state), { encoding: 'utf-8' });
  } catch (e) {}
}

module.exports = { loadWindowState, saveWindowState };
