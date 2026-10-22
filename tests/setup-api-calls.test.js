// Ratchet for bare `await window.api.*` calls in renderer/js/setup/. A rejected
// IPC call there is an unhandled promise rejection and the click just does
// nothing, so new code wraps the call: safeApi(label, () => window.api.x()) for
// one-shot actions (shows an error dialog) or tryApi(fn) when a loop wants to
// continue and report once (both in setup/util.js).
//
// The ceilings below are the sites that existed when the wrapper was added; most
// sit inside a try/catch of their own. Lower a number when you wrap one; never
// raise it -- use the wrapper instead.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SETUP_DIR = path.join(__dirname, '..', 'renderer', 'js', 'setup');
const CEILING = {
  'backups.js': 6,
  'channels-diagnostics.js': 2,
  'channel-sources.js': 4,
  'channel-toolbar.js': 10,
  'channels.js': 4,
  'controls.js': 1,
  'help.js': 3,
  'household.js': 1,
  'lan-status.js': 4,
  'interstitials.js': 5,
  'library.js': 2,
  'media-sources.js': 1,
  'onair.js': 1,
  'panels.js': 1,
  'plugins.js': 2,
  'presets.js': 3,
  'restore-point.js': 1,
  'schedule.js': 1,
  'screens.js': 4,
  'settings.js': 1,
  'sidebar.js': 1,
  'splicer.js': 2,
  'titles-panel.js': 1,
  'util.js': 1,
};

function countBare(file) {
  const text = fs.readFileSync(path.join(SETUP_DIR, file), 'utf8');
  return text.split(/\r?\n/).filter((line) => /await\s+window\.api\./.test(line) && !/^\s*(\/\/|\*)/.test(line)).length;
}

test('setup screens do not add bare await window.api calls', () => {
  const above = [];
  for (const file of fs.readdirSync(SETUP_DIR).filter((f) => f.endsWith('.js'))) {
    const n = countBare(file);
    if (n > (CEILING[file] || 0)) above.push(`${file}: ${n} (ceiling ${CEILING[file] || 0})`);
  }
  assert.deepEqual(above, [], 'Wrap IPC calls in safeApi()/tryApi() from setup/util.js (see this test\'s header).');
});
