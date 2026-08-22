const { app, screen } = require('electron');
const path = require('path');
const fs = require('fs');

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
    fs.writeFileSync(getWindowStatePath(), JSON.stringify(state), 'utf-8');
  } catch (e) {}
}

// A saved position can point at a monitor that's since been unplugged —
// only trust it if it still lands on a real display.
function boundsOnScreen(bounds) {
  if (!bounds || typeof bounds.x !== 'number' || typeof bounds.y !== 'number') return false;
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return bounds.x < a.x + a.width && bounds.x + bounds.width > a.x &&
      bounds.y < a.y + a.height && bounds.y + bounds.height > a.y;
  });
}

module.exports = { loadWindowState, saveWindowState, boundsOnScreen };
