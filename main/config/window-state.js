const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { atomicWriteFileSync } = require('../util/atomic-write');

function getWindowStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(getWindowStatePath(), 'utf-8'));
  } catch (e) {
    return null;
  }
}

function saveWindowState(state) {
  try {
    atomicWriteFileSync(getWindowStatePath(), JSON.stringify(state), { encoding: 'utf-8' });
  } catch (e) {}
}

module.exports = { loadWindowState, saveWindowState };
